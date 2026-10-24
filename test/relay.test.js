import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,writeFileSync,copyFileSync,statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { ShardedEngine } from '../src/index.js';
import { RelayServer,SyncClient,createCredential } from '../src/relay/index.js';
const submit=(e,ops)=>e.submit('main',{actor:'test',requestId:crypto.randomUUID(),expectedHeads:e.ref('main').heads,operations:ops});
const create=(id)=>({type:'file.create',fileId:id,path:`${id}.txt`,text:'hello world'});
const edit=(id,insert)=>({type:'file.splice',fileId:id,index:0,deleteCount:0,insert});
async function fixture(t,{count=3,maxPageBytes=1024*1024}={}) {
  const dir=mkdtempSync(join(tmpdir(),'spool-relay-'));const engines=[];const a=new ShardedEngine(join(dir,'a.sqlite'));engines.push(a);a.create();submit(a,[create('shared')]);
  const room=a.ref('main').room;const auth=Array.from({length:count},(_,i)=>createCredential(`client-${i}`,{[room]:'write'}));
  let relay=new RelayServer(join(dir,'relay.sqlite'),{credentials:auth.map(a=>a.credential),maxPageBytes});let url=await relay.listen();
  const open=()=>{const e=new ShardedEngine(join(dir,`client-${engines.length}.sqlite`));engines.push(e);return e;};
  const client=(e,i=0,options={})=>new SyncClient(e,{url,room,token:auth[i].token,...options});
  t.after(async()=>{await relay.close();engines.forEach(e=>e.close());rmSync(dir,{recursive:true,force:true});});
  return {dir,a,room,auth,open,client,get relay(){return relay;},get url(){return url;},async restart({empty=false,backup}={}) {const port=Number(new URL(url).port);await relay.close();if(empty||backup) rmSync(join(dir,'relay.sqlite'));if(backup)copyFileSync(backup,join(dir,'relay.sqlite'));relay=new RelayServer(join(dir,'relay.sqlite'),{credentials:auth.map(a=>a.credential),maxPageBytes});url=await relay.listen({port});}};
}

test('ten HTTP clients converge after offline concurrent code, messages and comments, then resume after relay restart',async t=>{
  const f=await fixture(t,{count:10});await f.client(f.a).sync();const peers=[f.a,...Array.from({length:9},()=>f.open())];
  await Promise.all(peers.slice(1).map((e,i)=>f.client(e,i+1).sync()));const anchor=f.a.anchor('main','shared',6,11);
  for(const [i,e] of peers.entries()) submit(e,[edit('shared',`[${i}]`),create(`f-${i}`),{type:'message.add',messageId:`m-${i}`,role:'assistant',text:`client ${i}`},{type:'comment.add',commentId:`c-${i}`,fileId:'shared',start:9,end:14,text:'word'}]);
  await Promise.all(peers.map((e,i)=>f.client(e,i).sync()));await Promise.all(peers.map((e,i)=>f.client(e,i).sync()));
  const expected=peers[0].read('main');for(const e of peers) {assert.deepEqual(e.read('main'),expected);assert.equal(e.resolve('main',anchor).text,'world');}
  assert.equal(expected.files.length,11);assert.equal(Object.keys(expected.messages).length,10);assert.equal(Object.keys(expected.comments).length,10);
  const count=f.relay.engine.storageStats().changes;await f.restart();
  const noOp=await f.client(f.a).sync();assert.equal(noOp.pushPages,0);assert.equal(noOp.pullPages,0);assert.equal(f.relay.engine.storageStats().changes,count);
  submit(peers[9],[edit('shared','after-restart ')]);await f.client(peers[9],9).sync();await f.client(peers[0]).sync();assert.deepEqual(peers[0].read('main'),peers[9].read('main'));
});

test('room grants, read-only tokens and revoked credentials are enforced before data access',async t=>{
  const f=await fixture(t);await f.client(f.a).sync();const read=createCredential('reader',{[f.room]:'read'});const outsider=createCredential('outsider',{'other-room':'write'});
  f.relay.setCredentials([...f.auth.map(a=>a.credential),read.credential,outsider.credential]);
  const b=f.open();await f.client(b,0,{token:read.token}).sync({mode:'pull'});assert.equal(b.readFile('main','shared').file.text,'hello world');
  submit(b,[edit('shared','denied ')]);await assert.rejects(f.client(b,0,{token:read.token}).sync(),e=>e.code==='FORBIDDEN');
  await assert.rejects(f.client(f.open(),0,{token:outsider.token}).sync(),e=>e.code==='FORBIDDEN');
  await assert.rejects(f.client(f.open(),0,{token:'x'.repeat(43)}).sync(),e=>e.code==='UNAUTHORIZED');
  f.relay.setCredentials([]);await assert.rejects(f.client(f.a).sync(),e=>e.code==='UNAUTHORIZED');
  assert.equal(f.relay.engine.readFile(`relay-${f.room}`,'shared').file.text,'hello world');
});

test('bounded pages resume after a client page budget and preserve complete multi-file batches',async t=>{
  const f=await fixture(t,{maxPageBytes:12000});for(let i=0;i<45;i++) submit(f.a,[edit('shared',`${i},`),{type:'message.add',messageId:`m-${i}`,role:'assistant',text:'context'.repeat(30)}]);
  const partial=f.client(f.a,0,{maxPages:1});await assert.rejects(partial.sync(),e=>e.code==='PAGE_BUDGET');
  assert.ok(partial.cursor().push.length);const result=await f.client(f.a).sync();assert.ok(result.pushPages>1);
  const b=f.open();const pull=await f.client(b).sync();assert.ok(pull.pullPages>1);assert.deepEqual(b.read('main'),f.a.read('main'));
  assert.equal(f.relay.engine.storageStats().changes,f.a.storageStats().changes);
});

test('missing dependencies and malformed cross-room bundles cannot publish partial data',async t=>{
  const f=await fixture(t);await f.client(f.a).sync();const before=f.relay.engine.read(`relay-${f.room}`);const counts=f.relay.engine.storageStats();
  const base=f.a.ref('main').heads;submit(f.a,[create('second')]);const bundle=f.a.export('main',base);bundle.documents=[];
  const post=async value=>{const r=await fetch(`${f.url}/v1/rooms/${f.room}/push`,{method:'POST',headers:{authorization:`Bearer ${f.auth[0].token}`,'content-type':'application/json'},body:JSON.stringify({bundle:value})});return [r.status,await r.json()];};
  assert.equal((await post(bundle))[0],409);assert.deepEqual(f.relay.engine.read(`relay-${f.room}`),before);assert.equal(f.relay.engine.storageStats().changes,counts.changes);
  bundle.room='other-room';assert.equal((await post(bundle))[0],403);
  await f.client(f.a).sync();assert.equal(f.relay.engine.readFile(`relay-${f.room}`,'second').file.text,'hello world');
});

test('a relay restored without history causes one bounded cursor reset and a full causal replay',async t=>{
  const f=await fixture(t);await f.client(f.a).sync();submit(f.a,[edit('shared','offline ')]);await f.restart({empty:true});
  const result=await f.client(f.a).sync();assert.equal(result.resets,1);assert.deepEqual(f.relay.engine.read(`relay-${f.room}`),f.a.read('main'));
});

test('lost post-commit response retries idempotently; local edits during fetch are never acknowledged accidentally',async t=>{
  const f=await fixture(t);await f.client(f.a).sync();const b=f.open();await f.client(b).sync();submit(f.a,[edit('shared','one ')]);
  const original=f.relay.send.bind(f.relay);let dropped=false;
  f.relay.send=(res,status,value)=>{if(value.acceptedHeads&&!dropped){dropped=true;res.destroy();return;}original(res,status,value);};
  const result=await f.client(f.a).sync();assert.equal(result.retries,1);assert.ok(dropped);
  const client=f.client(b);const request=client.request.bind(client);let local=false;
  client.request=async(...args)=>{const data=await request(...args);if(args[0]==='pull'&&!local){local=true;submit(b,[edit('shared','during-fetch ')]);}return data;};
  await client.sync();await f.client(b).sync();await f.client(f.a).sync();assert.deepEqual(b.read('main'),f.a.read('main'));assert.ok(f.a.readFile('main','shared').file.text.includes('during-fetch '));
});

test('HTTP parser limits and atomic oversized-batch rejection leave the relay usable',async t=>{
  const f=await fixture(t,{maxPageBytes:2000});const client=f.client(f.a);await assert.rejects(client.sync(),/atomic batch exceeds/);
  assert.equal(f.relay.engine.storageStats().changes,0);assert.equal(f.relay.engine.read(`relay-${f.room}`).files.length,0); // The earlier genesis page is valid and complete.
  const response=await fetch(`${f.url}/v1/rooms/${f.room}/push`,{method:'POST',headers:{authorization:`Bearer ${f.auth[0].token}`,'content-type':'application/json'},body:'{'});assert.equal(response.status,400);
  const health=await fetch(`${f.url}/healthz`);assert.equal(health.status,200);
  assert.throws(()=>new SyncClient(f.a,{url:'http://example.com',room:f.room,token:f.auth[0].token}),/HTTPS/);
});

test('sync cancellation and concurrent calls preserve resumable cursors',async t=>{
  const f=await fixture(t);const client=f.client(f.a);const controller=new AbortController();controller.abort();await assert.rejects(client.sync({signal:controller.signal}),e=>e.name==='AbortError');
  const original=client.request.bind(client);let resume;let entered;
  const ready=new Promise(r=>entered=r);client.request=async(...args)=>{entered();await new Promise(r=>resume=r);client.request=original;return original(...args);};
  const pending=client.sync();await ready;await assert.rejects(client.sync(),e=>e.code==='BUSY');resume();await pending;
  assert.ok(client.cursor().pull.length);
});

test('two populated rooms cannot read or inject each other\'s causal history',async t=>{
  const f=await fixture(t);await f.client(f.a).sync();const other=f.open();other.create();submit(other,[create('private')]);const room2=other.ref('main').room;
  const auth=createCredential('other-tenant',{[room2]:'write'});f.relay.setCredentials([...f.auth.map(a=>a.credential),auth.credential]);
  await new SyncClient(other,{url:f.url,room:room2,token:auth.token}).sync();
  const denied=await fetch(`${f.url}/v1/rooms/${room2}/state`,{headers:{authorization:`Bearer ${f.auth[0].token}`}});assert.equal(denied.status,403);assert.ok(!(await denied.text()).includes('private'));
  const bad=await fetch(`${f.url}/v1/rooms/${f.room}/push`,{method:'POST',headers:{authorization:`Bearer ${f.auth[0].token}`,'content-type':'application/json'},body:JSON.stringify({bundle:other.export('main')})});assert.equal(bad.status,403);
  assert.equal(f.relay.engine.read(`relay-${f.room}`).files.length,1);assert.equal(f.relay.engine.read(`relay-${room2}`).files[0].fileId,'private');
});

test('credentials revoked while an upload body is arriving cannot commit that upload',async t=>{
  const f=await fixture(t);const body=JSON.stringify({bundle:f.a.export('main')});
  const response=new Promise((resolve,reject)=>{
    const req=httpRequest(`${f.url}/v1/rooms/${f.room}/push`,{method:'POST',headers:{authorization:`Bearer ${f.auth[0].token}`,'content-type':'application/json'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.write(body.slice(0,1));
    const revoke=async()=>{for(let i=0;i<100&&f.relay.active===0;i++) await new Promise(r=>setTimeout(r,5));assert.equal(f.relay.active,1);f.relay.setCredentials([]);req.end(body.slice(1));};revoke().catch(reject);
  });
  assert.equal(await response,401);assert.equal(f.relay.engine.refs().length,0);
});

test('consistent backup restores historical data and recovers a newer client tail without overwriting a backup',async t=>{
  const f=await fixture(t);await f.client(f.a).sync();const path=join(f.dir,'backup.sqlite');const snapshot=f.relay.engine.read(`relay-${f.room}`);
  f.relay.backup(path);assert.equal(statSync(path).mode&0o777,0o600);assert.throws(()=>f.relay.backup(path),/EEXIST/);
  submit(f.a,[edit('shared','newer ')]);await f.client(f.a).sync();await f.restart({backup:path});assert.deepEqual(f.relay.engine.read(`relay-${f.room}`),snapshot);
  submit(f.a,[edit('shared','offline ')]);const result=await f.client(f.a).sync();assert.equal(result.resets,1);assert.deepEqual(f.a.read('main'),f.relay.engine.read(`relay-${f.room}`));
});

test('chunked uploads beyond the HTTP byte limit are rejected before JSON parsing',async t=>{
  const f=await fixture(t);
  const result=await new Promise((resolve,reject)=>{
    const req=httpRequest(`${f.url}/v1/rooms/${f.room}/push`,{method:'POST',headers:{authorization:`Bearer ${f.auth[0].token}`,'content-type':'application/json','transfer-encoding':'chunked'}},res=>{let body='';res.setEncoding('utf8');res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,body}));});
    req.on('error',reject);req.end(Buffer.alloc(16_000_001,0x20));
  });
  assert.equal(result.status,413);assert.equal(JSON.parse(result.body).error.code,'BODY_TOO_LARGE');assert.equal(f.relay.engine.refs().length,0);
});

test('polling reconnects after a temporary outage and shuts down with an abort signal',async t=>{
  const f=await fixture(t);await f.client(f.a).sync();const b=f.open();const client=f.client(b);await client.sync();const controller=new AbortController();let completions=0;
  const watched=client.watch({intervalMs:100,signal:controller.signal,onSync:()=>{completions++;if(b.readFile('main','shared').file.text.startsWith('polled '))controller.abort();}});
  await f.restart();submit(f.a,[edit('shared','polled ')]);await f.client(f.a).sync();
  const timeout=setTimeout(()=>controller.abort(),5000);await watched;clearTimeout(timeout);assert.ok(completions>0);assert.ok(b.readFile('main','shared').file.text.startsWith('polled '));
});

function child(args,env={}) {
  const p=spawn(process.execPath,args,{cwd:new URL('..',import.meta.url),env:{...process.env,...env},stdio:['ignore','pipe','pipe']});let out='';let err='';
  p.stdout.on('data',chunk=>out+=chunk);p.stderr.on('data',chunk=>err+=chunk);
  const done=new Promise((resolve,reject)=>{p.on('error',reject);p.on('exit',(code,signal)=>resolve({code,signal,get stdout(){return out;},get stderr(){return err;}}));});
  return {p,done,get stdout(){return out;},get stderr(){return err;}};
}
async function stop(proc) {if(proc.p.exitCode===null&&proc.p.signalCode===null) {proc.p.kill('SIGTERM');await proc.done;}}
async function waitLine(proc) {
  for(let i=0;i<500;i++) {if(proc.stdout.includes('\n')) return JSON.parse(proc.stdout.split('\n')[0]);if(proc.p.exitCode!==null) throw new Error(proc.stderr);await new Promise(r=>setTimeout(r,10));}
  throw new Error('Child startup timed out');
}

test('standalone relay and three CLI client processes sync offline edits and survive relay process restart',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'spool-relay-cli-'));let service;const dbs=['a','b','c'].map(name=>join(dir,`${name}.sqlite`));
  const a=new ShardedEngine(dbs[0]);a.create();submit(a,[create('shared')]);const room=a.ref('main').room;a.close();
  const auth=createCredential('cli-member',{[room]:'write'});const config=join(dir,'config.json');writeFileSync(config,JSON.stringify({credentials:[auth.credential]}));
  t.after(async()=>{if(service)await stop(service);rmSync(dir,{recursive:true,force:true});});
  const start=async(port=0)=>{service=child(['src/relay-cli.js',join(dir,'relay.sqlite'),config,`--port=${port}`]);return (await waitLine(service)).url;};
  let url=await start();
  const sync=async file=>{const proc=child(['src/sync-cli.js',file,url,room],{SPOOL_RELAY_TOKEN:auth.token});const result=await proc.done;assert.equal(result.code,0,result.stderr);assert.ok(!result.stdout.includes(auth.token));assert.ok(!result.stderr.includes(auth.token));return JSON.parse(result.stdout.trim()).result;};
  await sync(dbs[0]);await Promise.all(dbs.slice(1).map(sync));
  await stop(service);
  for(const [i,file] of dbs.entries()) {const e=new ShardedEngine(file);submit(e,[edit('shared',`[process-${i}]`)]);e.close();}
  const port=Number(new URL(url).port);url=await start(port);
  await Promise.all(dbs.map(sync));await Promise.all(dbs.map(sync));
  const states=dbs.map(file=>{const e=new ShardedEngine(file);const s=e.read('main');e.close();return s;});for(const state of states)assert.deepEqual(state,states[0]);
  for(let i=0;i<3;i++)assert.ok(states[0].files[0].text.includes(`[process-${i}]`));
  const noOp=await sync(dbs[0]);assert.equal(noOp.pushPages,0);assert.equal(noOp.pullPages,0);
  const backup=child(['src/relay-cli.js','backup',join(dir,'relay.sqlite'),join(dir,'cli-backup.sqlite')]);const saved=await backup.done;assert.equal(saved.code,0,saved.stderr);
  const restored=new ShardedEngine(join(dir,'cli-backup.sqlite'));assert.deepEqual(restored.read(`relay-${room}`),states[0]);restored.close();
});
