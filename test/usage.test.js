import {test} from 'node:test';import assert from 'node:assert/strict';
import {ShardedEngine} from '../src/index.js';import {RetrievalUsage} from '../src/memory/usage.js';import {InferenceQueue} from '../src/memory/inference-queue.js';
test('external usage caps persist, isolate project allowance, count attempts and reset at midnight UTC',t=>{
 const engine=new ShardedEngine(':memory:');t.after(()=>engine.close());let time=Date.parse('2026-10-26T23:59:00Z');let usage=new RetrievalUsage(engine,{now:()=>time});usage.configure({expectedRevision:0,limits:{dailyCharacters:10,dailyRequests:3,projectDailyCharacters:6}});
 usage.reserve('a',['12345'],true);assert.throws(()=>usage.reserve('a',['12'],true),error=>error.code==='EMBEDDING_LIMIT');usage.reserve('b',['12345'],true);assert.throws(()=>usage.reserve('c',['1'],true),error=>error.code==='EMBEDDING_LIMIT');
 assert.equal(usage.status().totals.external_requests,2);assert.equal(usage.status().totals.external_characters,10);assert.equal(usage.status().totals.budget_denied,2);assert.equal(usage.status().projects.a.external_characters,5);
 usage=new RetrievalUsage(engine,{now:()=>time});assert.equal(usage.limits().dailyCharacters,10);assert.throws(()=>usage.configure({expectedRevision:0,limits:{dailyCharacters:0,dailyRequests:0,projectDailyCharacters:0}}),error=>error.code==='USAGE_CONFLICT');
 usage.reserve('a',['local inference stays available'],false);time+=60000;usage.reserve('a',['12345'],true);assert.equal(usage.status().totals.external_requests,1);assert.equal(usage.status().day,'2026-10-27');
 time+=91*86400000;usage.record('a','http_requests');assert.equal(engine.db.prepare('SELECT count(*) AS n FROM retrieval_usage WHERE day<?').get('2026-10-28').n,0);
});
test('daily request cap blocks external work before invocation while unlimited defaults stay compatible',t=>{
 const engine=new ShardedEngine(':memory:');t.after(()=>engine.close());const usage=new RetrievalUsage(engine);usage.configure({expectedRevision:0,limits:{dailyCharacters:0,dailyRequests:1,projectDailyCharacters:0}});usage.reserve('a',['test'],true);assert.throws(()=>usage.reserve('b',['test'],true),error=>error.code==='EMBEDDING_LIMIT');assert.equal(usage.status().totals.external_requests,1);
});
test('queries pass queued indexing batches with serial inference and bounded fairness',async()=>{
 const queue=new InferenceQueue(),order=[];let release;const gate=new Promise(resolve=>release=resolve);let active=0,peak=0;const work=(label,wait)=>async()=>{active++;peak=Math.max(active,peak);try{if(wait)await gate;order.push(label);}finally{active--;}};
 const jobs=[queue.run(work('active-index',true)),queue.run(work('waiting-index')),...Array.from({length:6},(_,i)=>queue.run(work('query-'+i),true))];release();await Promise.all(jobs);assert.deepEqual(order.slice(0,6),['active-index','query-0','query-1','query-2','query-3','waiting-index']);assert.equal(peak,1);queue.close();await assert.rejects(()=>queue.run(work('closed')),/closed/);
});

test('a capped semantic lookup makes no provider call and falls back to available keyword evidence',async t=>{
 const {MemoryStore}=await import('../src/memory/store.js');const engine=new ShardedEngine(':memory:'),ref=engine.create('new');engine.db.prepare('UPDATE shard_refs SET name=? WHERE name=?').run('relay-'+ref.room,'new');let calls=0;const store=new MemoryStore(engine,{referencesOnly:true,embeddings:{id:'workers-ai:synthetic-cap',async embed(texts){calls++;return texts.map(()=>[1,0]);}}});t.after(async()=>{await store.semantic.close();engine.close();});
 store.run(ref.room,{command:'remember',kind:'finding',title:'Delivery policy',text:'Delivery is charged once.',requestId:'seed'});store.index(ref.room);await store.semantic.prepare(ref.room);assert.equal(calls,1);store.usage.configure({expectedRevision:0,limits:{dailyCharacters:0,dailyRequests:1,projectDailyCharacters:0}});
 const result=await store.retrieve(ref.room,{command:'search',query:'Delivery policy'});assert.equal(result.retrieval.mode,'keyword');assert.equal(result.retrieval.semanticStatus,'budget_exceeded');assert.equal(result.results.length,1);assert.equal(calls,1);assert.equal(store.usage.status().totals.budget_denied,1);
});

test('prototype-shaped project IDs cannot bypass project budgets and telemetry failure stays non-fatal',t=>{
 const engine=new ShardedEngine(':memory:');t.after(()=>engine.close());const usage=new RetrievalUsage(engine);usage.configure({expectedRevision:0,limits:{dailyCharacters:0,dailyRequests:0,projectDailyCharacters:3}});usage.reserve('constructor',['abc'],true);assert.equal(usage.status().projects.constructor.external_characters,3);assert.throws(()=>usage.reserve('constructor',['x'],true),error=>error.code==='EMBEDDING_LIMIT');
 usage.record=()=>{throw Error('synthetic disk failure');};assert.equal(usage.note('project','http_requests'),false);assert.equal(usage.status().recordingError,'Usage telemetry could not be persisted.');
});
