import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ShardedEngine} from '../src/index.js';
import {MemoryStore} from '../src/memory/store.js';
import {compactMemory} from '../src/memory/presentation.js';
import {queryTokens} from '../src/memory/query.js';
import {deleteSharedConversations} from '../src/team/conversation-deletion.js';

function fixture(t,provider){
 const engine=new ShardedEngine(':memory:');const ref=engine.create('new');engine.db.prepare('UPDATE shard_refs SET name=? WHERE name=?').run('relay-'+ref.room,'new');
 const store=new MemoryStore(engine,{referencesOnly:true,embeddings:provider});
 t.after(async()=>{await store.semantic?.close();engine.close();});
 const write=(fields,room=ref.room)=>store.run(room,{command:'remember',kind:'finding',requestId:crypto.randomUUID(),...fields});
 return {engine,room:ref.room,store,write};
}
const embedding=text=>/delivery|shipping/i.test(text)?[1,0,0]:/payments|billing/i.test(text)?[0,1,0]:[0,0,1];
const fake=()=>({id:'test-v1',calls:[],async embed(texts){this.calls.push(texts);return texts.map(embedding);}});

test('natural-language semantic matching is hybrid, cached, project-scoped, and kind/task filtered',async t=>{
 const provider=fake(),{engine,room,store,write}=fixture(t,provider);
 const target=write({kind:'decision',title:'Delivery policy',text:'Keep delivery costs separate from merchandise prices.'});
 write({title:'Billing',text:'Billing callbacks need deduplication.'});
 const foreign=engine.create('foreign');engine.db.prepare('UPDATE shard_refs SET name=? WHERE name=?').run('relay-'+foreign.room,'foreign');const secret=write({title:'Delivery secret',text:'Delivery belongs to another project.'},foreign.room);
 assert.equal(store.run(room,{command:'search',query:'shipping'}).results.length,0);
 const result=await store.retrieve(room,{command:'search',query:'shipping',kinds:['decision']});
 assert.equal(result.results[0].id,target.id);assert.deepEqual(result.results[0].retrievedBy,['semantic']);assert.equal(result.retrieval.mode,'hybrid');assert.equal(result.retrieval.semanticStatus,'ready');
 assert.ok(!result.results.some(item=>item.id===secret.id));assert.ok(provider.calls.flat().every(text=>!text.includes('another project')));
 const calls=provider.calls.length;await store.retrieve(room,{command:'search',query:'shipping',kinds:['decision']});assert.equal(provider.calls.length,calls);
 assert.equal((await store.retrieve(room,{command:'search',query:'shipping',kinds:['finding']})).results.length,0);
 assert.equal((await store.retrieve(room,{command:'context',query:'shipping'})).notes[0].id,target.id);
});

test('embedding failures fall back explicitly; invalid requests do not invoke the model',async t=>{
 let calls=0;const {room,store,write}=fixture(t,{id:'broken',async embed(){calls++;throw Error('secret provider error');}});write({title:'Unique identifier',text:'GUARD_927 is an exact error.'});
 const result=await store.retrieve(room,{command:'search',query:'GUARD_927'});assert.equal(result.results.length,1);assert.equal(result.retrieval.mode,'keyword');assert.equal(result.retrieval.semanticStatus,'unavailable');assert.ok(!JSON.stringify(result).includes('secret provider'));
 await store.retrieve(room,{command:'search',query:'GUARD_927'});assert.equal(calls,1);
 await assert.rejects(()=>store.retrieve(room,{command:'search',query:'x',limit:999}));assert.equal(calls,1);
});

test('model changes rebuild derived vectors; deletion removes conversation vectors and preserves findings',async t=>{
 const provider=fake(),{engine,room,store,write}=fixture(t,provider);const note=write({title:'Delivery note',text:'Delivery remains separate.'});
 engine.submit('relay-'+room,{actor:'capture',requestId:'chat',expectedHeads:engine.ref('relay-'+room).heads,operations:[{type:'message.add',messageId:'chat',role:'user',text:'Delivery chat text'}]});
 await store.retrieve(room,{command:'search',query:'shipping'});assert.ok(engine.db.prepare('SELECT count(*) AS n FROM memory_vectors WHERE id=?').get('chat').n>0);
 const next=new MemoryStore(engine,{referencesOnly:true,embeddings:{...fake(),id:'test-v2'}});await next.retrieve(room,{command:'search',query:'shipping'});
 assert.equal(engine.db.prepare('SELECT count(*) AS n FROM memory_vectors WHERE model=?').get('test-v1').n,0);
 const preview=deleteSharedConversations(engine,room,{});deleteSharedConversations(engine,room,{confirm:true,deletionToken:preview.deletionToken,requestId:'remove'});
 assert.equal(engine.db.prepare('SELECT count(*) AS n FROM memory_vectors WHERE room=?').get(room).n,0);
 const result=await next.retrieve(room,{command:'search',query:'shipping'});assert.equal(result.results[0].id,note.id);assert.ok(!result.results.some(item=>item.id==='chat'));
 await next.semantic.close();
});

test('deletion during embedding never resurrects or returns removed source vectors',async t=>{
 let unblock,started;const gate=new Promise(resolve=>unblock=resolve),ready=new Promise(resolve=>started=resolve);
 const {engine,room,store}=fixture(t,{id:'slow',async embed(texts){started();await gate;return texts.map(embedding);}});
 engine.submit('relay-'+room,{actor:'capture',requestId:'chat',expectedHeads:engine.ref('relay-'+room).heads,operations:[{type:'message.add',messageId:'chat',role:'user',text:'Delivery chat'}]});
 store.index(room);const pending=store.retrieve(room,{command:'search',query:'shipping'});await ready;
 const preview=deleteSharedConversations(engine,room,{});deleteSharedConversations(engine,room,{confirm:true,deletionToken:preview.deletionToken,requestId:'remove'});unblock();
 assert.equal((await pending).results.length,0);assert.equal(engine.db.prepare('SELECT count(*) AS n FROM memory_vectors').get().n,0);
});

test('cold inference is bounded and reports warmup instead of hanging a chat',async t=>{
 let unblock;const gate=new Promise(resolve=>unblock=resolve),{room,store,write}=fixture(t,{id:'cold',async embed(texts){await gate;return texts.map(embedding);}});write({title:'Delivery',text:'Delivery policy'});
 const start=performance.now(),result=await store.semantic.lookup(room,{query:'shipping'},store.index(room),{waitMs:20});assert.equal(result.status,'warming');assert.ok(performance.now()-start<500);unblock();await store.semantic.close();
});

test('compact context respects budget, deduplicates and preserves actionable evidence and privacy labels',()=>{
 const item={id:'note',kind:'finding',title:'Verified result',text:'x'.repeat(3000),git:{commit:'a'.repeat(40),submodules:Array(30).fill({path:'module',commit:'b'.repeat(40)})},files:[{path:'src/calc.js'}],reconciliation:{status:'different_revision',message:'Check current code',files:Array(50).fill({state:'different'})},sharing:{mode:'local',uploaded:false},refs:['evidence'],citation:'tw://room/note'};
 const raw={room:'room',tasks:[],notes:[item,{...item,id:'duplicate'},...Array.from({length:20},(_,i)=>({...item,id:'item'+i,text:'unique'+i+'x'.repeat(3000)}))]};
 const compact=compactMemory(raw,{maxChars:3000});assert.ok(JSON.stringify(compact).length<=3000);assert.equal(compact.notes[0].id,'note');assert.equal(compact.notes[0].reconciliation.status,'different_revision');assert.equal(compact.notes[0].sharing.uploaded,false);assert.deepEqual(compact.notes[0].paths,['src/calc.js']);assert.ok(compact.budget.omitted>0);assert.equal(compact.notes[0].truncated,true);
 assert.ok(!compactMemory(raw,{excludeIds:['note','duplicate']}).notes.some(item=>item.id==='note'));
});

test('lexical extraction keeps exact identifiers after natural-language boilerplate',()=>{
 assert.deepEqual(queryTokens('Please can you tell me why we should have the ERR_DUPLICATE_PAYMENT in BillingService?'),['tell','ERR_DUPLICATE_PAYMENT','BillingService']);
});

test('keyword fallback retains deep pagination instead of slicing the hybrid candidate window',async t=>{
 const {room,store,write}=fixture(t,null);for(let i=0;i<36;i++)write({title:'Pagination '+i,text:'pagination sentinel '+i});
 const expected=store.run(room,{command:'search',query:'sentinel',offset:30,limit:5}),actual=await store.retrieve(room,{command:'search',query:'sentinel',offset:30,limit:5});
 assert.deepEqual(actual.results,expected.results);assert.equal(actual.results.length,5);assert.equal(actual.retrieval.semanticStatus,'disabled');
});

test('compact search exposes the first omitted position for fetching the next budgeted page',()=>{
 const values=Array.from({length:10},(_,i)=>({id:'note-'+i,kind:'finding',title:'Result '+i,text:'evidence '+i+'x'.repeat(1000)}));
 const result=compactMemory({room:'room',results:values,nextOffset:null},{maxChars:2500,offset:20});assert.ok(result.results.length>0&&result.results.length<10);assert.equal(result.nextOffset,20+result.results.length);assert.ok(JSON.stringify(result).length<=2500);
});

test('a warming keyword fallback cannot leak a conversation deleted during inference',async t=>{
 let unblock,started;const gate=new Promise(resolve=>unblock=resolve),ready=new Promise(resolve=>started=resolve);
 const {engine,room,store}=fixture(t,{id:'cold-deletion',async embed(texts){started();await gate;return texts.map(embedding);}});
 engine.submit('relay-'+room,{actor:'capture',requestId:'chat',expectedHeads:engine.ref('relay-'+room).heads,operations:[{type:'message.add',messageId:'chat',role:'user',text:'Delivery conversation'}]});
 const lookup=store.semantic.lookup.bind(store.semantic);store.semantic.lookup=(room,input,version)=>lookup(room,input,version,{waitMs:30});
 const pending=store.retrieve(room,{command:'search',query:'Delivery'});await ready;const preview=deleteSharedConversations(engine,room,{});deleteSharedConversations(engine,room,{confirm:true,deletionToken:preview.deletionToken,requestId:'delete'});
 try{const result=await pending;assert.equal(result.retrieval.semanticStatus,'warming');assert.equal(result.results.length,0);}finally{unblock();}
});

test('background indexing completes a corpus larger than one batch and keeps latest task revisions',async t=>{
 const {room,store,write}=fixture(t,fake());store.semantic.maxChunks=2;
 for(let i=0;i<5;i++)write({title:'Delivery '+i,text:'Delivery costs are separate. '+i});
 const task=(expectedRevision,status)=>store.run(room,{command:'task_update',requestId:crypto.randomUUID(),taskId:'delivery',title:'Delivery task',text:'Delivery investigation',expectedRevision,status});
 const old=task(0,'in_progress'),latest=task(1,'done');await store.retrieve(room,{command:'search',query:'shipping'});
 const deadline=Date.now()+2000;while(store.semantic.remaining(room)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,30));assert.equal(store.semantic.remaining(room),0);
 const result=await store.retrieve(room,{command:'search',query:'shipping',limit:30});assert.ok(!result.results.some(item=>item.id===latest.id));assert.ok(!result.results.some(item=>item.id===old.id));assert.equal(store.run(room,{command:'get',id:latest.id}).status,'done');assert.equal(store.run(room,{command:'get',id:old.id}).revision,1);
});

test('exact cited paths are searchable and existing lexical indexes upgrade without changing source records',async t=>{
 const {engine,room,store,write}=fixture(t,null),saved=write({title:'Price finding',text:'Tax is rounded once.',files:['src/checkout/price-calculator.ts']});store.index(room);
 // Simulate a pre-semantic index whose FTS did not include code references.
 engine.db.prepare('UPDATE memory_index SET heads=? WHERE room=?').run(JSON.stringify(engine.version('relay-'+room).heads),room);engine.db.prepare('DELETE FROM memory_fts WHERE room=?').run(room);
 const result=await store.retrieve(room,{command:'search',query:'src/checkout/price-calculator.ts'});assert.equal(result.results[0].id,saved.id);assert.equal(store.run(room,{command:'get',id:saved.id}).text,'Tax is rounded once.');
});

test('distinct warming queries are bounded and model inference is serialized across projects',async t=>{
 let release;const gate=new Promise(resolve=>release=resolve);let active=0,peak=0;
 const provider={id:'slow-audit',async embed(texts){active++;peak=Math.max(peak,active);try{await gate;return texts.map(()=>[1,0]);}finally{active--;}}};
 const {engine,room,store,write}=fixture(t,provider);write({title:'First project',text:'Synthetic audit memory'});store.index(room);
 const foreign=engine.create('foreign');engine.db.prepare('UPDATE shard_refs SET name=? WHERE name=?').run('relay-'+foreign.room,'foreign');write({title:'Second project',text:'Another synthetic audit memory'},foreign.room);store.index(foreign.room);
 const jobs=Array.from({length:40},(_,i)=>store.semantic.lookup(i%2?room:foreign.room,{query:'distinct audit '+i},null,{waitMs:0}));
 const results=await Promise.all(jobs);assert.ok(store.semantic.lookups.size<=32);assert.ok(store.semantic.pending.size<=2);assert.ok(results.some(r=>r.status==='busy'));assert.equal(peak,1);
 release();await Promise.allSettled([...store.semantic.lookups.values()]);assert.equal(peak,1);assert.equal(store.semantic.lookups.size,0);
});
