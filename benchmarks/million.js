import { ShardedEngine } from '../src/index.js';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { diskProfile } from './disk.js';

const option = (name, fallback) => process.argv.find(v => v.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? fallback;
const operations = Number(option('operations',1000000));
const files = Number(option('files',1000));
const batchSize = Number(option('batch-size',100));
if (![operations,files,batchSize].every(v => Number.isSafeInteger(v) && v > 0) || batchSize > 10000 || operations % (files*batchSize)) throw new Error('Workload must contain complete rounds of files × batch-size; max batch-size 10000');
const output = resolve(option('output','benchmarks/million-results.json'));
const dir = mkdtempSync(join(tmpdir(),'spool-million-')); const filename = join(dir,'db.sqlite');
let engine; let phase = 'setup'; let completed = 0; const start = performance.now(); const samples = []; const progress = [];
const initial = i => Array.from({ length: 4 },(_,j) => createHash('sha256').update(`file-${i}-${j}`).digest('hex')).join('');
const expected = Array.from({ length: files },(_,i) => initial(i));
const anchors = new Map(); let historical; let historicalText;
const submit = (requestId, ops) => engine.submit('main',{ actor:'million-benchmark',requestId,expectedHeads:engine.ref('main').heads,operations:ops });
const summary = values => { const a=[...values].sort((x,y)=>x-y); return { medianMs:a[Math.floor(a.length*.5)],p95Ms:a[Math.min(a.length-1,Math.floor(a.length*.95))] }; };
const report = { measuredAt:new Date().toISOString(),node:process.version,cpu:cpus()[0]?.model,
  workload:{ operations,files,batchSize,rounds:operations/(files*batchSize),initialTextBytes:256,checkpointEvery:128,checkpointKeep:2 },
  methodology:'One local SQLite WAL/FULL writer. Each logical operation is a distinct Automerge change, replacing the first character. Batches visit files round-robin; bounded visible text, retained edit history. No explicit GC; event-loop yield after each committed batch. Setup operations excluded from the edit count. No network or concurrent clients.' };
try {
  engine = new ShardedEngine(filename); engine.create();
  for (let i=0;i<files;i+=1000) submit(`create-${i}`,expected.slice(i,i+1000).map((text,j)=>({type:'file.create',fileId:`f-${i+j}`,path:`src/${i+j}.txt`,text})));
  for (let i=0;i<Math.min(files,16);i++) anchors.set(i,engine.anchor('main',`f-${i}`,16,32));
  phase='edits'; const writeStart=performance.now();
  for (let batch=0;completed<operations;batch++) {
    const f=batch%files; const ops=Array.from({length:batchSize},(_,j)=>({type:'file.splice',fileId:`f-${f}`,index:0,deleteCount:1,insert:String.fromCharCode(65+(completed+j)%26)}));
    const began=performance.now(); submit(`edit-${batch}`,ops); samples.push(performance.now()-began);
    expected[f]=ops.at(-1).insert+expected[f].slice(1); completed+=batchSize;
    if (!historical && completed>=operations/2) { historical=engine.ref('main').heads;historicalText=expected.slice(0,16);engine.fork('main','midpoint'); }
    if (completed%Math.max(batchSize,Math.floor(operations/20/batchSize)*batchSize)===0 || completed===operations) {
      const sample={completed,elapsedSeconds:(performance.now()-writeStart)/1000,rssBytes:process.memoryUsage().rss}; progress.push(sample);console.error(JSON.stringify(sample));
    }
    await new Promise(resolve=>setImmediate(resolve));
  }
  report.writeWallMs=performance.now()-writeStart; report.batchLatency=summary(samples);
  phase='verify';
  for (let i=0;i<files;i++) if(engine.readFile('main',`f-${i}`).file.text!==expected[i]) throw new Error(`Final text mismatch ${i}`);
  for (const [i,anchor] of anchors) {
    if(engine.resolve('main',anchor).text!==initial(i).slice(16,32)) throw new Error(`Anchor mismatch ${i}`);
    if(engine.readFile('main',`f-${i}`,historical).file.text!==historicalText[i]) throw new Error(`Historical mismatch ${i}`);
  }
  const changes=engine.storageStats().changes;
  if(changes!==operations+files*2) throw new Error(`Expected ${operations+files*2} CRDT changes, got ${changes}`);
  const reads=[];
  for(let i=0;i<20;i++) { engine.clearCache();const began=performance.now();engine.readFile('main',`f-${i%files}`);reads.push(performance.now()-began); }
  report.coldFileRead=summary(reads);report.stats=engine.storageStats();report.diskBeforeMaintenance=diskProfile(engine);
  phase='maintenance';const maintenanceStart=performance.now();report.compaction=engine.compact({vacuum:true});report.compactionMs=performance.now()-maintenanceStart;report.diskAfterMaintenance=diskProfile(engine);
  const heads=engine.ref('main').heads;engine.close();engine=new ShardedEngine(filename);
  phase='reopen';
  if(JSON.stringify(engine.ref('main').heads)!==JSON.stringify(heads)) throw new Error('Reopened heads mismatch');
  for(let i=0;i<files;i++) if(engine.readFile('main',`f-${i}`).file.text!==expected[i]) throw new Error(`Reopened state mismatch ${i}`);
  for(const [i,anchor] of anchors) if(engine.resolve('midpoint',anchor).text!==initial(i).slice(16,32)) throw new Error(`Reopened historical anchor mismatch ${i}`);
  if(engine.db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok') throw new Error('SQLite integrity check failed');
  report.verified={finalFiles:files,reopenedFiles:files,historicalFiles:anchors.size,anchors:anchors.size,changeCount:changes,sqliteIntegrity:'ok'};
  report.status='completed';
} catch(error) { report.status='failed';report.phase=phase;report.reason=error.stack;process.exitCode=1; }
finally {
  report.completedOperations=completed;report.progress=progress;report.totalWallMs=performance.now()-start;report.peakRssBytes=process.resourceUsage().maxRSS*1024;
  writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(output);engine?.close();rmSync(dir,{recursive:true,force:true});
}
