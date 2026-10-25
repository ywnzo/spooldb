import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startTeamHost} from '../src/team/host.js';
import {recordCategory,recordBlocked} from '../src/team/sharing.js';

test('unrecognized structured kinds cannot bypass disabled conversation sharing through inherited object properties',()=>{
 for(const kind of ['__proto__','constructor','toString']){
  const record={role:'system',text:JSON.stringify({protocol:'spool-memory/1',kind,text:'private conversation'})};
  assert.equal(recordCategory(record),'conversations');assert.equal(recordBlocked(record,{conversations:false}),true);
 }
});
test('malformed imported memory is rejected atomically before it can poison shared retrieval',async t=>{
 const base=mkdtempSync(join(tmpdir(),'spool-security-')),host=await startTeamHost(base,{port:0,embeddings:null});t.after(async()=>{await host.close();rmSync(base,{recursive:true,force:true});});
 const project=host.command({command:'create',name:'Audit fixture'}).project,connection=host.command({command:'invite',room:project.room,label:'Writer'}).connection;
 const request=async(action,input)=>{const r=await fetch(host.origin+`/v1/rooms/${project.room}/${action}`,{method:'POST',headers:{authorization:'Bearer '+connection.token,'content-type':'application/json'},body:JSON.stringify(input)});return {status:r.status,body:await r.json()};};
 const heads=host.relay.engine.ref('relay-'+project.room).heads;
 for(const fields of [{kind:'__proto__'},{kind:'constructor'},{nextSteps:'not a list'},{blockers:{length:1}},{kind:'task',taskId:'audit',status:{bad:true},revision:1},{files:Array.from({length:31},()=>({path:'app.js'}))}]){
  const event={protocol:'spool-memory/1',kind:'handoff',title:'Audit',text:'Synthetic memory',...fields};
  const result=await request('source',{requestId:crypto.randomUUID(),records:[{kind:'message',id:crypto.randomUUID(),role:'assistant',text:'Valid record before the malformed record'},{kind:'message',id:crypto.randomUUID(),role:'system',text:JSON.stringify(event)}]});
  assert.equal(result.status,400,JSON.stringify(result.body));assert.deepEqual(host.relay.engine.ref('relay-'+project.room).heads,heads);
 }
 assert.equal((await request('memory',{command:'context'})).status,200);
});

test('anonymous workspace requests are rejected before waiting for an unfinished body',async t=>{
 const {request}=await import('node:http');const base=mkdtempSync(join(tmpdir(),'spool-auth-')),host=await startTeamHost(base,{port:0,embeddings:null});t.after(async()=>{await host.close();rmSync(base,{recursive:true,force:true});});
 for(const path of ['/v1/workspace/action','/v1/workspace/enroll','/v1/invites/redeem']){
  const status=await new Promise((resolve,reject)=>{const req=request(host.origin+path,{method:'POST',headers:{'content-type':'application/json','content-length':10000}},res=>{res.resume();resolve(res.statusCode);req.destroy();});req.setTimeout(1000,()=>{req.destroy();reject(Error('Server waited for an unauthenticated body'));});req.on('error',error=>{if(error.code!=='ECONNRESET')reject(error);});req.flushHeaders();req.write('{');});
  assert.equal(status,401);
 }
});

test('legacy malformed JSON is retained as source text without entering the structured memory index',async t=>{
 const base=mkdtempSync(join(tmpdir(),'spool-legacy-audit-')),host=await startTeamHost(base,{port:0,embeddings:null});t.after(async()=>{await host.close();rmSync(base,{recursive:true,force:true});});
 const project=host.command({command:'create',name:'Legacy fixture'}).project,branch='relay-'+project.room;
 const text=JSON.stringify({protocol:'spool-memory/1',kind:'handoff',title:'Malformed legacy note',text:'Keep the original evidence',nextSteps:'not a list'});
 host.relay.engine.submit(branch,{actor:'legacy-fixture',requestId:'legacy-poison',expectedHeads:host.relay.engine.ref(branch).heads,operations:[{type:'message.add',messageId:'legacy-poison',role:'assistant',text}]});
 const context=host.relay.memory.run(project.room,{command:'context'});assert.equal(context.notes.length,0);
 const stored=host.relay.memory.run(project.room,{command:'get',id:'legacy-poison'});assert.equal(stored.kind,'conversation');assert.equal(stored.text,text);
});

test('JSON quoted in ordinary chats remains a conversation and cannot bypass capture sharing controls',async t=>{
 const {ShardedEngine}=await import('../src/index.js'),{MemoryStore}=await import('../src/memory/store.js'),{ingestSource,sourceId}=await import('../src/team/source.js');
 const engine=new ShardedEngine(':memory:');t.after(()=>engine.close());const room=engine.create('main').room;engine.fork('main','relay-'+room);
 const text=JSON.stringify({protocol:'spool-memory/1',kind:'finding',title:'A JSON example in a chat',text:'Private chat content'}),records=['user','assistant'].map(role=>({kind:'message',id:role,role,text}));
 for(const record of records){assert.equal(recordCategory(record),'conversations');assert.equal(recordBlocked(record,{conversations:false,findings:true}),true);}
 const result=ingestSource(engine,room,{requestId:'private-quoted-json',records},{id:'private'},{conversations:false,findings:true});assert.equal(result.operations,0);
 ingestSource(engine,room,{requestId:'shared-quoted-json',records},{id:'shared'},{conversations:true,findings:true});const memory=new MemoryStore(engine,{referencesOnly:true});
 for(const record of records){const item=memory.run(room,{command:'get',id:sourceId('shared',record.id)});assert.equal(item.kind,'conversation');assert.equal(item.text,text);}
});
