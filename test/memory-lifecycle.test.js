import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ShardedEngine} from '../src/index.js';
import {MemoryStore} from '../src/memory/store.js';
import {updateMemoryInput} from '../src/memory/lifecycle.js';
import {RetrievalSettings} from '../src/memory/settings.js';
import {deleteSharedConversations} from '../src/team/conversation-deletion.js';
function fixture(t){const engine=new ShardedEngine(':memory:'),ref=engine.create('new');engine.db.prepare('UPDATE shard_refs SET name=? WHERE name=?').run('relay-'+ref.room,'new');const store=new MemoryStore(engine,{referencesOnly:true});t.after(async()=>{await store.semantic?.close();engine.close();});const run=input=>store.run(ref.room,{requestId:crypto.randomUUID(),...input});const note=(text,extra={})=>run({command:'remember',kind:'finding',title:'Delivery finding',text,...extra});const update=(id,action,expectedRevision,extra={})=>run(updateMemoryInput({id,action,expectedRevision,reason:'Verified newer evidence',requestId:crypto.randomUUID(),...extra}));return {engine,room:ref.room,store,run,note,update};}
test('new verified evidence archives resolved records, preserving their content and reversible audit history',t=>{
 const {run,note,update}=fixture(t),old=note('Delivery was charged twice.'),next=note('Delivery is now charged once; the regression passed.',{resolves:[old.id]});
 assert.deepEqual(run({command:'search',query:'Delivery'}).results.map(item=>item.id),[next.id]);const archived=run({command:'get',id:old.id});assert.equal(archived.lifecycle.status,'resolved');assert.equal(archived.lifecycle.replacementId,next.id);assert.equal(archived.text,'Delivery was charged twice.');
 assert.equal(run({command:'search',query:'Delivery',includeArchived:true}).results.length,2);update(old.id,'restore',1);assert.equal(run({command:'get',id:old.id}).lifecycle.status,'active');assert.equal(run({command:'search',query:'Delivery'}).results.length,2);assert.throws(()=>update(old.id,'archive',0),error=>error.code==='MEMORY_CONFLICT');
});
test('lifecycle is reconstructed on replicas and rejects foreign records atomically',t=>{
 const {engine,room,run,note}=fixture(t),old=note('Old delivery policy'),replacement=note('New delivery policy',{supersedes:[old.id]});
 const replica=new ShardedEngine(':memory:');t.after(()=>replica.close());replica.import('relay-'+room,engine.export('relay-'+room,[]));const other=new MemoryStore(replica,{referencesOnly:true});assert.equal(other.run(room,{command:'get',id:old.id}).lifecycle.replacementId,replacement.id);
 const heads=engine.ref('relay-'+room).heads;assert.throws(()=>note('Must not persist',{resolves:['foreign']}),error=>error.code==='MEMORY_NOT_FOUND');assert.deepEqual(engine.ref('relay-'+room).heads,heads);assert.equal(run({command:'search',query:'persist'}).results.length,0);
});
test('conflicting offline state updates remain visible until explicitly reconciled',t=>{
 const {engine,room,run,note,update}=fixture(t),old=note('Delivery evidence');const ids=['control-a','control-b'];
 for(const [i,id]of ids.entries())engine.submit('relay-'+room,{actor:'offline',requestId:id,expectedHeads:engine.ref('relay-'+room).heads,operations:[{type:'message.add',messageId:id,role:'system',text:JSON.stringify({protocol:'spool-memory/1',kind:'decision',title:'Memory update',text:'Audited source',lifecycleControl:true,lifecycleChanges:[{targetId:old.id,status:i?'active':'archived',revision:1,reason:'Offline observation'}]})}]});
 assert.equal(run({command:'get',id:old.id}).lifecycle.status,'conflict');assert.equal(run({command:'search',query:'Delivery'}).results.length,1);assert.throws(()=>update(old.id,'archive',1),error=>error.code==='MEMORY_CONFLICT');update(old.id,'archive',1,{resolveIds:ids});assert.equal(run({command:'search',query:'Delivery'}).results.length,0);
});
test('completed tasks leave normal retrieval but remain available for explicit continuation and audit',t=>{
 const {run}=fixture(t);const task=revision=>run({command:'task_update',taskId:'delivery',title:'Delivery task',text:'Delivery work',status:revision?'done':'in_progress',expectedRevision:revision});task(0);task(1);
 assert.equal(run({command:'context'}).tasks.length,0);assert.equal(run({command:'context',taskId:'delivery'}).tasks[0].revision,2);assert.equal(run({command:'search',query:'Delivery'}).results.length,0);assert.equal(run({command:'search',query:'Delivery',includeArchived:true}).results.length,2);
});
test('deleting an archived conversation removes its state and cannot restore its raw content',t=>{
 const {engine,room,run,update}=fixture(t);engine.submit('relay-'+room,{actor:'capture',requestId:'chat',expectedHeads:engine.ref('relay-'+room).heads,operations:[{type:'message.add',messageId:'chat',role:'user',text:'Delivery chat'}]});update('chat','archive',0);const preview=deleteSharedConversations(engine,room,{});deleteSharedConversations(engine,room,{confirm:true,deletionToken:preview.deletionToken,requestId:'delete'});assert.throws(()=>run({command:'get',id:'chat'}),error=>error.code==='MEMORY_NOT_FOUND');assert.equal(engine.db.prepare('SELECT count(*) AS n FROM memory_state WHERE room=?').get(room).n,0);
});
test('model configuration persists, rejects stale/unsafe settings and keeps the old model on download failure',async t=>{
 const {engine,store,room}=fixture(t);let disposed=0;const provider=async settings=>({id:settings.model,async warm(){if(settings.model==='english-small')throw Error('offline');},async embed(texts){return texts.map(()=>[1,0]);},async dispose(){disposed++;}});
 const settings=new RetrievalSettings(store,{provider,projects:()=>[{room}]});await settings.serial;assert.equal(settings.status().status,'ready');const initial=settings.read();settings.run({action:'configure',expectedRevision:0,settings:{...initial.settings,model:'english-small'}});await settings.serial;assert.equal(settings.status().status,'error');assert.equal(store.semantic.provider.id,'multilingual');assert.equal(settings.status().settings.model,'english-small');assert.ok(disposed>=1);
 assert.throws(()=>settings.run({action:'configure',expectedRevision:0,settings:initial.settings}),error=>error.code==='RETRIEVAL_CONFLICT');assert.throws(()=>settings.run({action:'configure',expectedRevision:1,settings:{...initial.settings,model:'https://unsafe.test/model'}}),error=>error.code==='RETRIEVAL_SETTINGS');
 settings.run({action:'configure',expectedRevision:1,settings:{...initial.settings,enabled:false,contextChars:3000}});await settings.serial;assert.equal(settings.status().status,'disabled');assert.equal(store.retrievalSettings.contextChars,3000);assert.equal(JSON.parse(engine.db.prepare('SELECT data FROM retrieval_settings').get().data).enabled,false);await settings.close();
});
