import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {ShardedEngine} from '../src/index.js';import {MemoryStore} from '../src/memory/store.js';import {TeamConnection} from '../src/team/client.js';import {defaultSharing} from '../src/team/sharing.js';
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'spool-idle-')),engine=new ShardedEngine(':memory:'),ref=engine.create('new'),branch='relay-'+ref.room;engine.db.prepare('UPDATE shard_refs SET name=? WHERE name=?').run(branch,'new');let clock=0;const connection=new TeamConnection(dir,engine,ref.room,dir,{now:()=>clock});connection.config={url:'https://relay.example',room:'shared-room',token:'test'};connection.sourcePrefix='@machines/test/';const calls=[];connection.request=async(action,input)=>{calls.push({action,input});return {sourcePrefix:connection.sourcePrefix,sharing:defaultSharing(),workspaceSharing:defaultSharing(),memoryLifecycle:1,results:[]};};t.after(()=>{engine.close();rmSync(dir,{recursive:true,force:true});});
 return {connection,engine,branch,room:ref.room,calls,setTime:value=>clock=value,write:text=>new MemoryStore(engine).run(ref.room,{command:'remember',kind:'finding',title:'Finding',text,requestId:crypto.randomUUID()})};
}
test('idle sync checks back off to five minutes and new memory bypasses the timer',async t=>{
 const {connection,calls,setTime,write}=fixture(t);
 for(let ms=0;ms<86400000;ms+=2000){setTime(ms);await connection.sync({background:true});}
 assert.ok(calls.length<=300,`Expected <=300 idle checks/day, got ${calls.length}`);assert.ok(calls.every(call=>call.action==='state'));assert.equal(connection.backgroundDelay,300000);
 const previous=calls.length;write('New evidence must be shared promptly');await connection.sync({background:true});assert.deepEqual(calls.slice(previous).map(call=>call.action),['state','source']);assert.equal(connection.backgroundDelay,10000);
 const sent=calls.length;await connection.sync({background:true});assert.equal(calls.length,sent);
 // User-driven refresh is immediate even during idle backoff and has no duplicate state call.
 await connection.sync();assert.equal(calls.length,sent+1);
});
test('file-only changes do not wake relay sync and reads skip the redundant policy request',async t=>{
 const {connection,engine,branch,calls}=fixture(t);await connection.sync({background:true});const initial=calls.length;
 engine.submit(branch,{actor:'test',requestId:'code',expectedHeads:engine.ref(branch).heads,operations:[{type:'file.create',fileId:'file',path:'code.js',kind:'text',text:'code only'}]});
 await connection.sync({background:true});assert.equal(calls.length,initial);
 await connection.memory({command:'search',query:'handoff'});assert.deepEqual(calls.slice(initial).map(call=>call.action),['memory']);
});
test('offline sync backs off, new evidence retries immediately and write policy stays fresh',async t=>{
 const {connection,calls,setTime,write}=fixture(t);let offline=true;const request=connection.request;connection.request=async(action,input)=>{if(offline){calls.push({action,input});throw Error('offline');}return request(action,input);};
 await assert.rejects(()=>connection.sync({background:true}),/retained/);for(let ms=2000;ms<10000;ms+=2000){setTime(ms);await connection.sync({background:true});}assert.equal(calls.length,1);
 setTime(10000);await assert.rejects(()=>connection.sync({background:true}),/retained/);assert.equal(calls.length,2);
 offline=false;write('Retry this new finding');await connection.sync({background:true});assert.equal(calls.at(-1).action,'source');
 const before=calls.length;await connection.memory({command:'remember',kind:'finding',title:'Fresh policy',text:'Approved scope',requestId:'write'});assert.equal(calls[before].action,'state');
});
