import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, cpus, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const large = process.argv.includes('--large');
const collect = !process.argv.includes('--no-gc');
const output = resolve(process.argv.find(a => a.startsWith('--output='))?.slice(9) ?? 'benchmarks/results.json');
const dir = mkdtempSync(join(tmpdir(), 'spool-benchmark-'));
const cases = large ? [{ layout: 'sharded', checkpointEvery: 128, files: 10000, messages: 1000, edits: 2000, textBytes: 256 }]
  : [ { layout: 'legacy', checkpointEvery: 0 }, { layout: 'sharded', checkpointEvery: 0 }, { layout: 'sharded', checkpointEvery: 32 }]
    .map(c => ({ files: 100, messages: 200, edits: 200, textBytes: 1024, ...c }));
const results = [];
try {
  for (const [i, spec] of cases.entries()) {
    console.error(`Benchmark ${i + 1}/${cases.length}: ${spec.layout}, ${spec.files} files, ${spec.edits} edits, checkpoints ${spec.checkpointEvery}`);
    const config = { ...spec, collect, filename: join(dir, `case-${i}.sqlite`) };
    const child = spawn(process.execPath, ['--expose-gc', fileURLToPath(new URL('./worker.js', import.meta.url)), JSON.stringify(config)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 180000);
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); }); clearTimeout(timeout);
    if (code !== 0 && !stdout.trim()) throw new Error(`Benchmark failed: ${stderr || `exit ${code}`}`);
    const result = JSON.parse(stdout.trim()); results.push(result);
    if (result.verified) console.error(`Verified: read p50 ${result.coldFileRead.medianMs.toFixed(3)} ms, write p50 ${result.writes.medianMs.toFixed(3)} ms, peak RSS ${(result.peakRssBytes / 1048576).toFixed(1)} MiB`);
    else console.error(`Failed at ${result.phase}: ${result.reason}`);
  }
  const report = { measuredAt: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch,
    cpu: cpus()[0]?.model, logicalCpus: cpus().length, hostMemoryBytes: totalmem(),
    methodology: `Separate worker per case; SQLite WAL/FULL; ${collect ? 'explicit GC and event-loop yield between every timed call for both layouts (GC excluded from call times, included in total wall time)' : 'no explicit GC and no event-loop yield between synchronous calls'}; five application-cache-cold reads with warm OS cache, thirty hot reads; one run, not a throughput SLA. Temporary databases removed after completion.`, results };
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); console.log(output);
} finally { rmSync(dir, { recursive: true, force: true }); }
