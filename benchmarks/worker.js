import { Engine } from '../src/index.js';
import { performance } from 'node:perf_hooks';
import { statSync } from 'node:fs';
import { diskProfile } from './disk.js';
const config = JSON.parse(process.argv[2]);
const engine = new Engine(config.filename, { layout: config.layout, checkpointEvery: config.checkpointEvery, cacheEntries: 64 });
const startRss = process.memoryUsage().rss;
const began = performance.now();
let phase = 'initial-files'; let completedEdits = 0;
process.on('uncaughtException', error => {
  const failure = { layout: config.layout, checkpointEvery: config.checkpointEvery, files: config.files, messages: config.messages, edits: config.edits,
    textBytes: config.textBytes, status: 'failed', phase, completedEdits, reason: error.message,
    peakRssBytes: process.resourceUsage().maxRSS * 1024, verified: false };
  process.stdout.write(JSON.stringify(failure) + '\n', () => process.exit(1));
});
// Give legacy finalizers a chance to run, as in an event-driven CLI. GC time is
// excluded from per-call samples but included in total wall time for both layouts.
const collect = async () => { if (config.collect) { global.gc?.(); await new Promise(resolve => setImmediate(resolve)); } };
const timed = fn => { const start = performance.now(); const value = fn(); return { milliseconds: performance.now() - start, value }; };
const submit = (requestId, operations) => engine.submit('main', { actor: 'benchmark', requestId, expectedHeads: engine.ref('main').heads, operations });
const summary = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return { medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] };
};
try {
  engine.create();
  const initial = timed(() => submit('files', Array.from({ length: config.files }, (_, i) => ({ type: 'file.create', fileId: `f-${i}`, path: `src/file-${i}.txt`, text: 'a'.repeat(config.textBytes) }))));
  phase = 'initial-messages';
  const messages = timed(() => {
    if (config.messages) submit('messages', Array.from({ length: config.messages }, (_, i) => ({ type: 'message.add', messageId: `m-${i}`, role: 'assistant', text: 'c'.repeat(config.textBytes) })));
  });
  const anchor = engine.anchor('main', 'f-0', 0, 10); const editTimes = [];
  phase = 'writes';
  for (let i = 0; i < config.edits; i++) {
    editTimes.push(timed(() => submit(`edit-${i}`, [{ type: 'file.splice', fileId: 'f-0', index: 0, deleteCount: 0, insert: 'x' }])).milliseconds);
    completedEdits++;
    await collect();
  }
  const cold = []; let replayMetrics;
  phase = 'reads';
  for (let i = 0; i < 5; i++) {
    engine.clearCache?.(); engine.storageStats?.({ resetMetrics: true });
    cold.push(timed(() => engine.readFile('main', 'f-0')).milliseconds);
    replayMetrics = engine.storageStats?.();
    await collect();
  }
  const hot = [];
  for (let i = 0; i < 30; i++) { hot.push(timed(() => engine.readFile('main', 'f-0')).milliseconds); await collect(); }
  const fork = timed(() => engine.fork('main', 'benchmark-fork'));
  const final = engine.readFile('main', 'f-0');
  if (final.file.text !== 'x'.repeat(config.edits) + 'a'.repeat(config.textBytes)) throw new Error('Benchmark final state mismatch');
  // A zero cursor anchors to the original first character, so inserts should shift it.
  const resolved = engine.resolve('main', anchor);
  if (resolved.text !== 'a'.repeat(10)) throw new Error('Benchmark anchor mismatch');
  const stats = engine.storageStats?.();
  const diskBytes = ['', '-wal', '-shm'].reduce((total, suffix) => { try { return total + statSync(config.filename + suffix).size; } catch { return total; } }, 0);
  const totalWallMs = performance.now() - began;
  const beforeMaintenance = config.layout === 'sharded' ? diskProfile(engine) : null;
  let maintenance = null;
  if (config.layout === 'sharded') {
    const start = performance.now(); const result = engine.compact({ vacuum: true });
    maintenance = { ...result, milliseconds: performance.now() - start, diskProfile: diskProfile(engine) };
    if (engine.readFile('main','f-0').file.text !== final.file.text || engine.resolve('main',anchor).text !== resolved.text) throw new Error('Maintenance changed benchmark state');
  }
  console.log(JSON.stringify({ layout: config.layout, checkpointEvery: config.checkpointEvery, files: config.files, edits: config.edits, messages: config.messages,
    textBytes: config.textBytes, initialFilesMs: initial.milliseconds, initialMessagesMs: messages.milliseconds,
    writes: summary(editTimes), coldFileRead: summary(cold), hotFileRead: summary(hot), forkMs: fork.milliseconds,
    rssAtStartBytes: startRss, peakRssBytes: process.resourceUsage().maxRSS * 1024, finalRssBytes: process.memoryUsage().rss,
    totalWallMs, diskBytes, diskProfile: beforeMaintenance, maintenance, replayMetrics: replayMetrics ?? null, stats: stats ?? null, status: 'completed', verified: true }));
} finally { engine.close(); }
