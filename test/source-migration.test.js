import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ShardedEngine} from '../src/index.js';
import {MemoryStore} from '../src/memory/store.js';
import {ingestSource,sourceId} from '../src/team/source.js';

test('source migration preserves Git evidence, task revisions and links, while stripping legacy snapshots',()=>{
 const e=new ShardedEngine();try{
 const room=e.create('main').room;e.fork('main',`relay-${room}`);const principal={id:'migration-client'},commit='a'.repeat(40),files=[{path:'code.ts',commit,dirty:true,contentHash:'b'.repeat(64)},{path:'old.ts',fileId:'local-snapshot',heads:['private']}];
 const event=(kind,extra={})=>JSON.stringify({protocol:'spool-memory/1',kind,title:'Migration test',text:'Original evidence',createdAt:'2026-10-23T00:00:00Z',actor:'original-agent',taskId:'shared-task',files:[],refs:[],...extra});
 const records=[{kind:'message',id:'task-1',role:'system',text:event('task',{revision:1,status:'open'})},{kind:'message',id:'finding-1',role:'system',text:event('finding',{git:{commit},files,refs:['task-1']})},{kind:'message',id:'handoff-1',role:'system',text:event('handoff',{refs:['finding-1'],nextSteps:['Continue'],blockers:[]})}];
 const result=ingestSource(e,room,{requestId:'migration-page',records},principal);assert.equal(result.operations,3);assert.equal(ingestSource(e,room,{requestId:'migration-page',records},principal).operations,3);
 const memory=new MemoryStore(e,{referencesOnly:true}),finding=memory.run(room,{command:'get',id:sourceId(principal.id,'finding-1')});
 assert.equal(finding.git.commit,commit);assert.equal(finding.files[0].contentHash,'b'.repeat(64));assert.equal(finding.files[0].dirty,true);assert.deepEqual(finding.files[1],{path:'old.ts',legacySnapshotReference:true});assert.deepEqual(finding.refs,[sourceId(principal.id,'task-1')]);assert.equal(finding.createdAt,'2026-10-23T00:00:00Z');
 const context=memory.run(room,{command:'context'});assert.equal(context.tasks[0].revision,1);assert.equal(context.tasks[0].taskId,'migration-client.shared-task');
 const invalid=[{...records[0],id:'invalid',text:event('finding',{files:[{path:'code.ts',text:'repository contents'}]})}];assert.throws(()=>ingestSource(e,room,{requestId:'bad',records:invalid},principal),/Only Git reference metadata/);
 }finally{e.close();}
});

test('migration plan deduplicates prior local exports and maps handoff references to canonical source identities',async()=>{
 const {exportMemoryRecords,planMemoryMigration}=await import('../src/team/migration.js');
 const local=new ShardedEngine(),remote=new ShardedEngine();try{
 const a=local.create('main').room;local.fork('main',`relay-${a}`);const b=remote.create('main').room;remote.fork('main',`relay-${b}`);
 const lm=new MemoryStore(local),rm=new MemoryStore(remote,{referencesOnly:true});
 const task=lm.run(a,{command:'task_update',taskId:'real-task',title:'Original task',text:'Continue work',status:'open',expectedRevision:0,requestId:'task'});
 const finding=lm.run(a,{command:'remember',kind:'finding',title:'Original finding',text:'Observed behavior',taskId:'real-task',refs:[task.id],requestId:'finding'});
 const records=exportMemoryRecords(local,a).map(({descriptor,originPrincipal,...r})=>r);ingestSource(remote,b,{records,requestId:'old-export'},{id:'old-machine'});rm.index(b);
 const note=rm.run(b,{command:'handoff',title:'Direct shared handoff',text:'Read the original finding',refs:[sourceId('old-machine',finding.id)],nextSteps:['Continue'],requestId:'handoff'});
 const plan=planMemoryMigration({remote:exportMemoryRecords(remote,b),local:exportMemoryRecords(local,a)});
 assert.equal(plan.records.length,3);assert.equal(plan.localMarkers.length,2);assert.equal(plan.aliases[sourceId('old-machine',finding.id)],finding.id);
 assert.equal(JSON.parse(plan.records.find(r=>r.id===finding.id).text).taskId,'real-task');assert.deepEqual(JSON.parse(plan.records.find(r=>r.id===note.id).text).refs,[finding.id]);
 assert.deepEqual(plan,planMemoryMigration({remote:exportMemoryRecords(remote,b),local:exportMemoryRecords(local,a)}));
 }finally{local.close();remote.close();}
});
