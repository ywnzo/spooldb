import {test} from 'node:test';import assert from 'node:assert/strict';
import {ShardedEngine} from '../src/index.js';import {MemoryStore} from '../src/memory/store.js';import {SemanticIndex} from '../src/memory/semantic.js';import {RetrievalSettings} from '../src/memory/settings.js';
function fixture(t,provider){const engine=new ShardedEngine(':memory:'),ref=engine.create('new');engine.db.prepare('UPDATE shard_refs SET name=? WHERE name=?').run('relay-'+ref.room,'new');const store=new MemoryStore(engine,{referencesOnly:true,embeddings:provider});t.after(async()=>{await store.semantic?.close();engine.close();});return {engine,room:ref.room,store,write:text=>store.run(ref.room,{command:'remember',requestId:crypto.randomUUID(),kind:'finding',title:'Delivery policy',text})};}
test('background embeddings recover from a transient API error without a new user request',async t=>{
 let calls=0;const {room,store,write}=fixture(t,null);store.semantic=new SemanticIndex(store,{id:'retry-test',async embed(texts){if(++calls===1)throw Error('temporary outage');return texts.map(()=>[1,0]);}},{retryDelayMs:20});write('Delivery policy');store.index(room);store.semantic.schedule(room,0);
 const deadline=Date.now()+500;while(store.semantic.remaining(room)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(store.semantic.remaining(room),0);assert.ok(calls>=2);
});
test('cached semantic queries still search indexed evidence while new embeddings are blocked',async t=>{
 let blocked=false,release,started;const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>started=resolve);const {room,store,write}=fixture(t,{id:'cache-outage',async embed(texts){if(blocked){started();await gate;}return texts.map(()=>[1,0]);}});
 const target=write('Delivery is charged once');await store.retrieve(room,{command:'search',query:'shipping calculation'});blocked=true;write('New evidence pending indexing');store.index(room);const building=store.semantic.prepare(room);await ready;
 const lookup=store.semantic.lookup.bind(store.semantic);store.semantic.lookup=(room,input,version)=>lookup(room,input,version,{waitMs:20});
 try{const result=await store.retrieve(room,{command:'search',query:'shipping calculation'});assert.equal(result.retrieval.mode,'hybrid');assert.ok(result.results.some(item=>item.id===target.id));}finally{release();await building;}
});
test('a superseded provider switch cannot publish an obsolete index after awaiting close',async t=>{
 const {store}=fixture(t,null);let release,started;const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>started=resolve);const settings=new RetrievalSettings(store,{provider:async options=>({id:options.model,async embed(texts){return texts.map(()=>[1,0]);},async dispose(){}})});await settings.serial;
 const initial=settings.read(),old=store.semantic,close=old.close.bind(old);old.close=async()=>{started();await gate;await close();};let value=old;const installed=[];Object.defineProperty(store,'semantic',{get:()=>value,set:next=>{value=next;if(next)installed.push(next.provider.id);},configurable:true});
 settings.run({action:'configure',expectedRevision:0,settings:{...initial.settings,model:'english-small'}});await ready;settings.run({action:'configure',expectedRevision:1,settings:initial.settings});release();await settings.serial;
 try{assert.deepEqual(installed,['multilingual']);assert.equal(settings.status().activeModel,'multilingual');}finally{await settings.close();}
});

test('one long conversation obeys the chunk budget and resumes without re-embedding completed batches',async t=>{
 let embedded=0;const provider={id:'chunk-budget',async embed(texts){embedded+=texts.length;return texts.map(()=>[1,0]);}}, {engine,room,store}=fixture(t,provider);store.semantic.maxChunks=4;store.semantic.batchSize=8;
 engine.submit('relay-'+room,{actor:'capture',requestId:'long-chat',expectedHeads:engine.ref('relay-'+room).heads,operations:[{type:'message.add',messageId:'long-chat',role:'user',text:'x'.repeat(6000)}]});store.index(room);
 await store.semantic.prepare(room);assert.equal(embedded,4);assert.equal(store.semantic.remaining(room),1);assert.equal(engine.db.prepare('SELECT next_chunk FROM memory_vector_progress').get().next_chunk,4);
 // Restart the index using the same model; the persisted cursor survives.
 await store.semantic.close();store.semantic=new SemanticIndex(store,provider,{maxChunks:4});await store.semantic.prepare(room);assert.equal(embedded,8);assert.equal(store.semantic.remaining(room),1);
 await store.semantic.prepare(room);assert.equal(embedded,10);assert.equal(store.semantic.remaining(room),0);assert.equal(engine.db.prepare('SELECT count(*) AS n FROM memory_vector_progress').get().n,0);assert.equal(engine.db.prepare('SELECT count(*) AS n FROM memory_vectors').get().n,10);
});

test('conversation deletion removes partial indexing cursors as well as vectors',async t=>{
 const {deleteSharedConversations}=await import('../src/team/conversation-deletion.js');const {engine,room,store}=fixture(t,{id:'partial-delete',async embed(texts){return texts.map(()=>[1,0]);}});store.semantic.maxChunks=2;
 engine.submit('relay-'+room,{actor:'capture',requestId:'partial-chat',expectedHeads:engine.ref('relay-'+room).heads,operations:[{type:'message.add',messageId:'partial-chat',role:'user',text:'Long conversation '.repeat(300)}]});store.index(room);await store.semantic.prepare(room);assert.equal(engine.db.prepare('SELECT count(*) AS n FROM memory_vector_progress').get().n,1);
 const preview=deleteSharedConversations(engine,room,{});deleteSharedConversations(engine,room,{confirm:true,deletionToken:preview.deletionToken,requestId:'remove-partial'});assert.equal(engine.db.prepare('SELECT count(*) AS n FROM memory_vector_progress').get().n,0);await store.semantic.prepare(room);assert.equal(engine.db.prepare('SELECT count(*) AS n FROM memory_vectors').get().n,0);
});
