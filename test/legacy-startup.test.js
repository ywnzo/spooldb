import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {initializeProject,startProject,projectRequest} from '../src/project.js';
import {startDesktop} from '../src/desktop/service.js';
import {primaryDirectory} from '../src/desktop/paths.js';
import {discoveryRequest} from '../src/discovery-request.js';
import {startTeamHost} from '../src/team/host.js';
import {WorkspaceClient} from '../src/team/workspace-client.js';
const history={close(){},async read(){return {threads:0,messages:0};}};
function fixture(){const base=mkdtempSync(join(tmpdir(),'spool-legacy-startup-')),root=join(base,'repo'),state=join(base,'state');mkdirSync(root);execFileSync('git',['init','-q',root]);execFileSync('git',['-C',root,'remote','add','origin','https://example.test/team/legacy']);writeFileSync(join(root,'app.txt'),'original');return {base,root,state};}
test('primary directory retains legacy state in place and keeps fresh desktop layout',()=>{
 const {base,state}=fixture();try{assert.equal(primaryDirectory(state),join(state,'p'));mkdirSync(join(state,'p'),{recursive:true});writeFileSync(join(state,'p/project.json'),'{}');assert.equal(primaryDirectory(state),join(state,'p'));writeFileSync(join(state,'project.json'),'{}');assert.equal(primaryDirectory(state),state);}finally{rmSync(base,{recursive:true,force:true});}
});
test('desktop restart preserves enrolled legacy grants, connections and shared memory despite oversized source',async()=>{
 const {base,root,state}=fixture(),host=await startTeamHost(join(base,'host'),{port:0});let service,desktop;
 try{
  const initial=initializeProject(state,root);service=await startProject(state,{port:0,history});
  const workspace=new WorkspaceClient(state);await workspace.run({command:'connect',link:host.command({command:'workspace-init',name:'Original connection'}).link,device:'Legacy'});
  await discoveryRequest(state,{command:'approve',cwd:root,confirm:true,name:'Existing project',captureConversations:false,connectAgents:false});
  const before=await discoveryRequest(state,{command:'resolve',cwd:root});assert.equal(before.status,'enrolled');assert.equal(before.projectId,initial.room);
  const original=await service.app.memory({command:'remember',kind:'finding',title:'Before update',text:'Saved before the desktop upgrade',requestId:'before-update'});
  service.manager.save();
  const names=['project.json','team.json','tokens.json','projects.json','discovery.json'],saved=new Map(names.map(name=>[name,readFileSync(join(state,name))]));
  const profiles=workspace.profiles().map(p=>[p.id,readFileSync(join(state,'workspace-profiles',p.id+'.json'))]);
  await service.close();service=null;writeFileSync(join(root,'grown.txt'),'x'.repeat(1_000_001));
  desktop=await startDesktop(state,{port:0,history});
  const after=await discoveryRequest(state,{command:'resolve',cwd:root});assert.equal(after.status,'enrolled');assert.equal(after.projectId,before.projectId);assert.equal(after.room,before.room);assert.equal(existsSync(join(state,'p')),false);
  for(const [name,bytes] of saved)assert.deepEqual(readFileSync(join(state,name)),bytes,name+' must remain intact');
  for(const [id,bytes] of profiles)assert.deepEqual(readFileSync(join(state,'workspace-profiles',id+'.json')),bytes);
  assert.match((await projectRequest(state,{command:'status'})).lastError,/exceeds 1 MB/);
  const memory=input=>projectRequest(state,{command:'memory',input});
  assert.equal((await memory({command:'get',id:original.id})).text,'Saved before the desktop upgrade');
  const next=await memory({command:'remember',kind:'finding',title:'After update',text:'New shared memory after restart',requestId:'after-update'});
  assert.equal(next.sharing.mode,'shared');assert.equal((await memory({command:'get',id:next.id})).text,'New shared memory after restart');
  // A failed source scan must be visible and retryable, without weakening its size limit.
  writeFileSync(join(root,'grown.txt'),'small again');await projectRequest(state,{command:'capture'});assert.equal((await projectRequest(state,{command:'status'})).lastError,null);
  await desktop.close();desktop=null;desktop=await startDesktop(state,{port:0,history});assert.equal((await memory({command:'get',id:next.id})).text,'New shared memory after restart');
 }finally{await desktop?.close();await service?.close();await host.close();rmSync(base,{recursive:true,force:true});}
});
