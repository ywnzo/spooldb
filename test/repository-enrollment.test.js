import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startTeamHost} from '../src/team/host.js';
import {WorkspaceClient,workspaceRequest} from '../src/team/workspace-client.js';

test('legacy repository association migrates without changing rooms, names or sharing; separate creation is idempotent',async()=>{
 const base=mkdtempSync(join(tmpdir(),'spool-repository-migration-')),dir=join(base,'host');let host=await startTeamHost(dir,{port:0});
 try{
  const client=new WorkspaceClient(join(base,'client'));await client.run({command:'connect',link:host.command({command:'workspace-init',name:'Team'}).link,device:'Owner'});
  const key='a'.repeat(64),original=(await client.run({command:'repository-enroll',repositoryKey:key,name:'backend'})).project;
  await client.run({command:'project-sharing',room:original.room,sharing:{conversations:false},expectedRevision:0});
  host.relay.engine.db.prepare('INSERT INTO workspace_repositories VALUES(?,?)').run(key,original.room);host.relay.engine.db.exec('DROP TABLE workspace_repository_links');await host.close();host=await startTeamHost(dir,{port:0});
  const run=input=>workspaceRequest({...client.connection,url:host.origin},'action',input);
  assert.equal((await run({command:'repository-match',repositoryKey:key})).project.room,original.room);
  assert.equal((await run({command:'project-sharing',room:original.room})).sharing.conversations,false);
  await assert.rejects(run({command:'repository-enroll',repositoryKey:key,name:'GEREQ_PLATFORM'}),/Explicitly choose create or join/);
  const input={command:'repository-enroll',mode:'create',repositoryKey:key,name:'GEREQ_PLATFORM',requestId:'separate-platform'},separate=await run(input);
  assert.notEqual(separate.project.room,original.room);assert.equal(separate.enrollmentMode,'create');await assert.rejects(run({...input,repositoryKey:'b'.repeat(64)}),/changed repository identity/);assert.equal((await run(input)).project.room,separate.project.room);
  assert.equal((await run({command:'repository-match',repositoryKey:key})).ambiguous,true);
  await host.close();host=await startTeamHost(dir,{port:0});
  const projects=(await run({command:'list'})).projects;assert.deepEqual(projects.map(p=>p.name),['backend','GEREQ_PLATFORM']);assert.equal(host.relay.engine.db.prepare('SELECT count(*) AS n FROM workspace_repository_links').get().n,2);
 }finally{await host.close();rmSync(base,{recursive:true,force:true});}
});
