import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startTeamHost} from '../src/team/host.js';
import {WorkspaceClient,workspaceRequest} from '../src/team/workspace-client.js';

test('legacy repository association migrates without changing rooms, names or sharing; duplicates are rejected and original creation retries remain idempotent',async()=>{
 const base=mkdtempSync(join(tmpdir(),'spool-repository-migration-')),dir=join(base,'host');let host=await startTeamHost(dir,{port:0});
 try{
  const client=new WorkspaceClient(join(base,'client'));await client.run({command:'connect',link:host.command({command:'workspace-init',name:'Team'}).link,device:'Owner'});
  const key='a'.repeat(64),original=(await client.run({command:'repository-enroll',repositoryKey:key,name:'backend'})).project;
  await client.run({command:'project-sharing',room:original.room,sharing:{conversations:false},expectedRevision:0});
  host.relay.engine.db.prepare('INSERT INTO workspace_repositories VALUES(?,?)').run(key,original.room);host.relay.engine.db.exec('DROP TABLE workspace_repository_links');await host.close();host=await startTeamHost(dir,{port:0});
  const run=input=>workspaceRequest({...client.connection,url:host.origin},'action',input);
  assert.equal((await run({command:'repository-match',repositoryKey:key})).project.room,original.room);
  assert.equal((await run({command:'project-sharing',room:original.room})).sharing.conversations,false);
  await assert.rejects(run({command:'repository-enroll',repositoryKey:key,name:'GEREQ_PLATFORM'}),/Ask to join it explicitly/);
  const input={command:'repository-enroll',mode:'create',repositoryKey:key,name:'GEREQ_PLATFORM',requestId:'duplicate-platform'};await assert.rejects(run(input),/already belongs to/);
  const retry={...input,name:'backend',requestId:'repository-'+key};assert.equal((await run(retry)).project.room,original.room);await assert.rejects(run({...retry,repositoryKey:'b'.repeat(64)}),/changed name or repository identity/);
  const other=(await run({command:'create',name:'Unrelated',requestId:'unrelated'})).project;await assert.rejects(run({command:'repository-enroll',mode:'join',repositoryKey:key,room:other.room}),/Join that project instead/);
  await host.close();host=await startTeamHost(dir,{port:0});assert.equal((await run({command:'repository-match',repositoryKey:key})).project.room,original.room);assert.equal(host.relay.engine.db.prepare('SELECT count(*) AS n FROM workspace_repository_links').get().n,1);
  const racedKey='c'.repeat(64),requests=['first','second'].map(requestId=>run({command:'repository-enroll',mode:'create',repositoryKey:racedKey,name:requestId,requestId:'race-'+requestId})),results=await Promise.allSettled(requests);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(host.relay.engine.db.prepare('SELECT count(*) AS n FROM workspace_repository_links WHERE repository_key=?').get(racedKey).n,1);

 }finally{await host.close();rmSync(base,{recursive:true,force:true});}
});
