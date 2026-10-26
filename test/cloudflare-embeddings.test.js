import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cloudflareEmbeddings} from '../src/memory/cloudflare-embeddings.js';
import {RetrievalSettings} from '../src/memory/settings.js';
import {ShardedEngine} from '../src/index.js';
import {MemoryStore} from '../src/memory/store.js';
const accountId='a'.repeat(32),token='test-token-'.repeat(4),model='@cf/baai/bge-m3';
const vector=()=>Array.from({length:1024},(_,i)=>i===0?1:0);
function response(texts){return Response.json({success:true,result:{data:texts.map(vector)}});}
test('Cloudflare adapter fixes the destination, validates vectors and never exposes upstream secrets',async()=>{
 const calls=[],provider=cloudflareEmbeddings({accountId,token,fetch:async(url,input)=>{calls.push({url,input});return response(JSON.parse(input.body).text);}});
 assert.equal((await provider.embed(['Finding']))[0].length,1024);assert.equal(calls[0].url,`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`);assert.equal(calls[0].input.redirect,'error');assert.equal(calls[0].input.headers.Authorization,'Bearer '+token);
 await provider.dispose();await assert.rejects(()=>provider.embed(['Again']),/disconnected/);
 for(const code of [401,403,429,500]){const bad=cloudflareEmbeddings({accountId,token,fetch:async()=>new Response(token,{status:code})});await assert.rejects(()=>bad.embed(['test']),error=>!error.message.includes(token)&&/Cloudflare/.test(error.message));}
 for(const data of [[[1,0]],[Array(1024).fill(0)],[],[Array(1024).fill('x')]]){const bad=cloudflareEmbeddings({accountId,token,fetch:async()=>Response.json({success:true,result:{data}})});await assert.rejects(()=>bad.embed(['test']),/Invalid Cloudflare/);}
 const oversized=cloudflareEmbeddings({accountId,token,fetch:async()=>new Response('x'.repeat(1048577))});await assert.rejects(()=>oversized.embed(['test']),/Invalid Cloudflare/);
 assert.throws(()=>cloudflareEmbeddings({accountId:'https://evil',token}),/valid Cloudflare/);assert.throws(()=>cloudflareEmbeddings({accountId,token,model:'https://evil'}),/valid Cloudflare/);
});
test('Cloudflare timeouts and disconnect abort requests without exposing response details',async()=>{
 const request=async(_,input)=>new Promise((resolve,reject)=>input.signal.addEventListener('abort',()=>reject(Error(token))));
 const provider=cloudflareEmbeddings({accountId,token,fetch:request,timeoutMs:5});await assert.rejects(()=>provider.embed(['test']),/timed out or was cancelled/);
 const pending=provider.embed(['test']);await provider.dispose();await assert.rejects(()=>pending,/cancelled/);
});
test('owner settings require consent, retain credentials privately, reuse vectors and disconnect without local fallback',async()=>{
 const engine=new ShardedEngine(':memory:'),ref=engine.create('new');engine.db.prepare('UPDATE shard_refs SET name=? WHERE name=?').run('relay-'+ref.room,'new');const store=new MemoryStore(engine,{referencesOnly:true});let calls=0;
 const remoteProvider=options=>cloudflareEmbeddings({...options,fetch:async(_,input)=>{calls++;return response(JSON.parse(input.body).text);}});
 let settings=new RetrievalSettings(store,{remoteProvider,provider:()=>({id:'local-test',embed:async texts=>texts.map(()=>[1,0])}),projects:()=>[{room:ref.room}]});
 try{
  await settings.serial;const initial=settings.read(),remote={...initial.settings,provider:'cloudflare',accountId,model};
  assert.throws(()=>settings.run({action:'configure',expectedRevision:0,settings:remote,token}),error=>error.code==='RETRIEVAL_CONSENT');assert.equal(calls,0);
  assert.throws(()=>settings.run({action:'configure',expectedRevision:0,settings:remote,externalProcessingApproved:true}),error=>error.code==='RETRIEVAL_CREDENTIALS');
  const test=await settings.run({action:'test',accountId,token,model});assert.equal(test.ok,true);assert.equal(settings.status().cloudflare.configured,false);
  settings.run({action:'configure',expectedRevision:0,settings:remote,token,externalProcessingApproved:true});await settings.serial;
  assert.equal(settings.status().status,'ready');assert.equal(settings.status().cloudflare.configured,true);assert.ok(!JSON.stringify(settings.status()).includes(token));assert.ok(!engine.db.prepare('SELECT data FROM retrieval_settings').get().data.includes(token));
  const note=store.run(ref.room,{command:'remember',requestId:'note',kind:'finding',title:'Shipping',text:'Delivery is charged once.'});
  store.index(ref.room);await store.semantic.prepare(ref.room);const afterIndex=calls;
  await store.semantic.prepare(ref.room);assert.equal(calls,afterIndex);
  const first=await store.semantic.search(ref.room,{query:'delivery calculation'},[]);assert.equal(first.results[0].id,note.id);const afterQuery=calls;
  await store.semantic.search(ref.room,{query:'delivery calculation'},[]);assert.equal(calls,afterQuery);
  assert.ok(!JSON.stringify(engine.export('relay-'+ref.room,[])).includes(token));
  assert.throws(()=>settings.run({action:'configure',expectedRevision:0,settings:remote,token:'replacement-'.repeat(4),externalProcessingApproved:true}),error=>error.code==='RETRIEVAL_CONFLICT');assert.equal(settings.credentials().token,token);
  await settings.close();settings=new RetrievalSettings(store,{remoteProvider,provider:()=>null});await settings.serial;assert.equal(settings.status().status,'ready');const afterRestart=calls;await store.semantic.prepare(ref.room);assert.equal(calls,afterRestart);
  settings.run({action:'configure',expectedRevision:1,settings:{...remote,enabled:false},clearToken:true});assert.equal(store.semantic,null);await settings.serial;assert.equal(settings.status().status,'disabled');assert.ok(!settings.credentials());
 }finally{await settings.close();engine.close();}
});

test('workspace HTTP and admin socket support async tests; only owners can read or change credentials',async t=>{
 const {mkdtempSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const {startTeamHost,hostRequest}=await import('../src/team/host.js'),{WorkspaceClient}=await import('../src/team/workspace-client.js');
 const base=mkdtempSync(join(tmpdir(),'spool-cf-owner-')),original=globalThis.fetch;let requests=0,host;
 globalThis.fetch=async(url,input)=>{if(String(url).startsWith('https://api.cloudflare.com/')){requests++;return response(JSON.parse(input.body).text);}return original(url,input);};
 t.after(async()=>{await host?.close();globalThis.fetch=original;rmSync(base,{recursive:true,force:true});});
 host=await startTeamHost(join(base,'host'),{port:0,embeddings:null});
 const owner=new WorkspaceClient(join(base,'owner')),member=new WorkspaceClient(join(base,'member'));
 await owner.run({command:'connect',link:host.command({command:'workspace-init',name:'Synthetic embeddings test'}).link,device:'Owner'});
 const invite=await owner.run({command:'invite-member',label:'Member'});await member.run({command:'connect',link:invite.link,device:'Member'});
 const initial=await owner.run({command:'retrieval',action:'status'}),remote={...initial.settings,enabled:true,provider:'cloudflare',model,accountId};
 for(const action of ['status','test','configure','retry'])await assert.rejects(()=>member.run({command:'retrieval',action,settings:remote,token,accountId,model}),error=>error.code==='WORKSPACE_ROLE');assert.equal(requests,0);
 const tested=await owner.run({command:'retrieval',action:'test',accountId,token,model});assert.equal(tested.ok,true);assert.equal(requests,1);
 assert.equal((await hostRequest(join(base,'host'),{command:'retrieval',action:'test',accountId,token,model})).ok,true);
 await owner.run({command:'retrieval',action:'configure',expectedRevision:0,settings:remote,token,externalProcessingApproved:true});
 // Retry waits for the same queued activation; no project content exists in this fixture.
 await new Promise(resolve=>setTimeout(resolve,20));const status=await owner.run({command:'retrieval',action:'status'});assert.equal(status.status,'ready');assert.ok(!JSON.stringify(status).includes(token));
 await owner.run({command:'retrieval',action:'configure',expectedRevision:1,settings:{...remote,enabled:false},clearToken:true});
 assert.equal((await owner.run({command:'retrieval',action:'status'})).cloudflare.configured,false);
});
