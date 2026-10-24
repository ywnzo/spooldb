import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir,cpus } from 'node:os';
import { join,resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { ShardedEngine } from '../src/index.js';
import { RelayServer,SyncClient,createCredential } from '../src/relay/index.js';
import { digest } from '../src/adapters/contract.js';
import { diskProfile } from './disk.js';
const option=(name,fallback)=>process.argv.find(v=>v.startsWith(`--${name}=`))?.slice(name.length+3)??fallback;
const count=Number(option('clients',10));const rounds=Number(option('rounds',5));
if(!Number.isSafeInteger(count)||count<2||count>32||!Number.isSafeInteger(rounds)||rounds<1||rounds>100) throw new Error('Use 2–32 clients and 1–100 rounds');
const output=resolve(option('output','benchmarks/relay-results.json'));const dir=mkdtempSync(join(tmpdir(),'spool-relay-benchmark-'));const engines=[];let relay;let phase='setup';
const start=performance.now();const report={measuredAt:new Date().toISOString(),node:process.version,cpu:cpus()[0]?.model,clients:count,rounds,
  methodology:'Independent file-backed client databases and a file-backed relay over real loopback HTTP, in one Node process. Concurrent fetches; synchronous engine work shares the event loop. TLS, WAN latency, packet shaping, independent CPU hosts and high-availability failover are not modeled. Relay restarted midway; every round begins with offline edits, followed by concurrent sync and a catch-up pass.',phases:[]};
const submit=(e,operations)=>e.submit('main',{actor:'relay-benchmark',requestId:crypto.randomUUID(),expectedHeads:e.ref('main').heads,operations});
try {
  for(let i=0;i<count;i++) engines.push(new ShardedEngine(join(dir,`client-${i}.sqlite`)));
  engines[0].create();
  for(let at=0;at<100;at+=5) submit(engines[0],Array.from({length:5},(_,j)=>({type:'file.create',fileId:`f-${at+j}`,path:`src/${at+j}.txt`,text:'original source\n'.repeat(64)})));
  const room=engines[0].ref('main').room;const auth=engines.map((_,i)=>createCredential(`client-${i}`,{[room]:'write'}));
  const open=async port=>{relay=new RelayServer(join(dir,'relay.sqlite'),{credentials:auth.map(a=>a.credential),maxPageBytes:256*1024});return relay.listen({port});};
  let url=await open(0);const clients=engines.map((e,i)=>new SyncClient(e,{url,room,token:auth[i].token}));const stats=[];
  phase='initial-sync';stats.push(await clients[0].sync());stats.push(...await Promise.all(clients.slice(1).map(c=>c.sync())));
  const anchor=engines[0].anchor('main','f-0',0,8);
  for(let round=0;round<rounds;round++) {
    phase=`round-${round}`;
    if(round===Math.floor(rounds/2)) {const port=Number(new URL(url).port);await relay.close();url=await open(port);report.relayRestarts=1;}
    for(const [i,e] of engines.entries()) submit(e,[...Array.from({length:10},()=>({type:'file.splice',fileId:'f-0',index:0,deleteCount:0,insert:String.fromCharCode(65+i)})),
      {type:'file.splice',fileId:`f-${i+1}`,index:0,deleteCount:0,insert:`round-${round} `},
      {type:'message.add',messageId:`m-${round}-${i}`,role:'assistant',text:`Offline client ${i}, round ${round}`}]);
    const began=performance.now();stats.push(...await Promise.all(clients.map(c=>c.sync())));stats.push(...await Promise.all(clients.map(c=>c.sync())));
    const expected=engines[0].read('main');for(const e of engines) {assert.deepEqual(e.read('main'),expected);assert.equal(e.resolve('main',anchor).text,'original');}
    const result={round,convergedClients:count,milliseconds:performance.now()-began,heads:expected.heads.length,stateDigest:digest(expected)};report.phases.push(result);console.error(JSON.stringify(result));
  }
  phase='no-op-resume';const noOp=await clients[0].sync();assert.equal(noOp.pushPages,0);assert.equal(noOp.pullPages,0);report.noOpResume=noOp;
  report.totals=Object.fromEntries(['requests','retries','uploadedBytes','downloadedBytes','pushPages','pullPages','resets'].map(key=>[key,stats.reduce((total,r)=>total+r[key],0)]));
  report.logicalOfflineOperations=count*rounds*12;report.relayStats=relay.engine.storageStats();report.relayDisk=diskProfile(relay.engine);
  report.auditRows=relay.engine.db.prepare('SELECT count(*) AS n FROM relay_audit').get().n;report.status='completed';report.verified=true;
} catch(error) {report.status='failed';report.verified=false;report.phase=phase;report.reason=error.stack;process.exitCode=1;}
finally {
  report.totalWallMs=performance.now()-start;report.peakCombinedProcessRssBytes=process.resourceUsage().maxRSS*1024;
  writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(output);if(relay)await relay.close();engines.forEach(e=>e.close());rmSync(dir,{recursive:true,force:true});
}
