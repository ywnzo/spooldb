#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { Engine } from './index.js';
import { Bridge } from './bridge.js';
import { AdapterIngress, runHarness } from './adapters/index.js';

if(process.argv.length===2||['init','plugin','deploy','discovery','workspace','project','server','service','memory','status'].includes(process.argv[2])||process.argv[2]==='--help'||process.argv[2]==='help'){const {runManagement}=await import('./management-cli.js');try{await runManagement(process.argv[2]==='help'?['--help']:process.argv.slice(2));}catch(error){console.error(error.message);process.exitCode=1;}process.exit(process.exitCode??0);}

if (process.argv.includes('--help')) {
  console.log('Usage: node src/cli.js [database.sqlite] [--sharded]\n       node src/cli.js database.sqlite watch /git/root [interval-ms] [--sharded]\n       node src/cli.js database.sqlite run codex|claude /git/root [branch] [--write] [--sharded] < prompt.txt\nUse --sharded only for a separate new-format database; legacy data is not migrated.\nReads one JSON request per line; writes one JSON response per line.\nCommands: init, refs, read, file.read, files.list, records.read, storage.checkpoint, storage.compact, storage.stats, storage.clearCache, submit, history, trace, fork, merge, anchor, resolve, export, import, git.attach, git.capture, git.sources, snapshot.create, snapshot.recover, snapshot.list, adapter.open, adapter.ingest, adapter.close, adapter.streams.\nSee docs/storage.md, docs/protocol.md and docs/adapters.md for examples.');
  process.exit(0);
}
const sharded = process.argv.includes('--sharded');
if (sharded) process.argv = process.argv.filter(arg => arg !== '--sharded');
const engine = new Engine(process.argv[2] ?? 'spool.sqlite', { layout: sharded ? 'sharded' : 'legacy' });
const bridge = new Bridge(engine);
const ingress = new AdapterIngress(engine);
function advanced(method, ...args) {
  if (engine.layout !== 'sharded') throw new Error(`${method} requires a sharded database opened with --sharded`);
  return engine[method](...args);
}
function dispatch(r) {
  switch (r.command) {
    case 'init': return engine.create(r.branch);
    case 'refs': return engine.refs();
    case 'read': return engine.read(r.branch, r.heads);
    case 'file.read': return engine.readFile(r.branch, r.fileId, r.heads);
    case 'files.list': return advanced('listFiles', r.branch, r.options);
    case 'records.read': return advanced('readRecords', r.branch, r.options);
    case 'storage.checkpoint': return advanced('checkpoint', r.branch, r.options);
    case 'storage.stats': return advanced('storageStats', r.options);
    case 'storage.compact': return advanced('compact', r.options);
    case 'storage.clearCache': advanced('clearCache'); return { cleared: true };
    case 'submit': return engine.submit(r.branch, r.input);
    case 'history': return engine.history(r.branch, r.options);
    case 'trace': return engine.trace(r.branch, r.fileId);
    case 'fork': return engine.fork(r.source, r.target, r.heads);
    case 'merge': return engine.merge(r.target, r.source);
    case 'anchor': return engine.anchor(r.branch, r.fileId, r.start, r.end);
    case 'resolve': return engine.resolve(r.branch, r.anchor, r.heads);
    case 'export': return engine.export(r.branch, r.since);
    case 'import': return engine.import(r.branch, r.bundle);
    case 'git.attach': return bridge.attach(r.branch ?? 'main', r.root);
    case 'git.capture': return bridge.capture(r.root);
    case 'git.sources': return bridge.sources();
    case 'snapshot.create': return bridge.materialize(r.branch, r.target, r.heads);
    case 'snapshot.recover': return bridge.recover(r.snapshotId);
    case 'snapshot.list': return bridge.snapshots();
    case 'adapter.open': return ingress.open(r.options);
    case 'adapter.ingest': return ingress.ingest(r.streamId, r.sequence, r.nativeEvent);
    case 'adapter.close': return ingress.close(r.streamId, r.result);
    case 'adapter.streams': return ingress.list();
    default: throw new Error('Unknown command');
  }
}
if (process.argv[3] === 'run') {
  const controller = new AbortController(); const cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    const tail = process.argv.slice(6); const names = tail.filter(a => a !== '--write');
    if (!process.argv[4] || !process.argv[5] || names.length > 1 || names.some(a => a.startsWith('--'))) throw new Error('Invalid run arguments; see --help');
    let prompt = ''; const decoder = new TextDecoder('utf-8', { fatal: true });
    for await (const chunk of process.stdin) { prompt += decoder.decode(chunk, { stream: true }); if (prompt.length > 1_000_000) throw new Error('Prompt too large'); }
    prompt += decoder.decode();
    const result = await runHarness(engine, { harness: process.argv[4], root: process.argv[5], branch: names[0] ?? 'main',
      prompt, write: tail.includes('--write'), signal: controller.signal,
      onRecord: record => console.log(JSON.stringify(record)) });
    console.log(JSON.stringify({ event: 'adapter.finished', result }));
    process.exitCode = result.status === 'completed' ? 0 : result.reason === 'cancelled' ? 130 : result.exitCode || 1;
  } catch (error) { console.log(JSON.stringify({ event: 'adapter.error', error: error.message })); process.exitCode = 1; }
  finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); engine.close(); }
} else if (process.argv[3] === 'watch') {
  const interval = Number(process.argv[5] ?? 1000);
  if (!process.argv[4] || !Number.isSafeInteger(interval) || interval < 200 || interval > 60000) {
    console.error('Watch requires a Git root and interval of 200–60000 ms'); engine.close(); process.exit(1);
  }
  let timer; let stopped = false;
  const stop = () => { if (stopped) return; stopped = true; clearInterval(timer); engine.close(); };
  const tick = () => {
    try {
      const result = bridge.capture(process.argv[4]);
      if (result.operations) console.log(JSON.stringify({ event: 'capture', result }));
    } catch (error) { console.log(JSON.stringify({ event: 'error', error: error.message })); process.exitCode = 1; stop(); }
  };
  timer = setInterval(tick, interval); tick();
  if (!stopped) console.log(JSON.stringify({ event: 'watching', root: process.argv[4], intervalMs: interval }));
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
} else try {
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    let r;
    try {
      if (Buffer.byteLength(line) > 16_000_000) throw new Error('Request too large');
      r = JSON.parse(line);
      if (!r || typeof r !== 'object') throw new Error('Invalid request');
      console.log(JSON.stringify({ id: r.id ?? null, ok: true, result: dispatch(r) }));
    } catch (error) {
      console.log(JSON.stringify({ id: r?.id ?? null, ok: false, error: error.message }));
    }
  }
} finally { engine.close(); }
