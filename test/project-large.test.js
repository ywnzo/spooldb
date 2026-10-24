import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {startDesktop} from '../src/desktop/service.js';
import {startTeamHost} from '../src/team/host.js';
import {WorkspaceClient} from '../src/team/workspace-client.js';
import {discoveryRequest} from '../src/discovery-request.js';
import {ShardedEngine} from '../src/index.js';
test('shared enrollment of a large checkout with submodules stores memory without code snapshots',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'spool-large-project-')),root=join(dir,'repo'),state=join(dir,'state');mkdirSync(root);execFileSync('git',['init','-q',root]);execFileSync('git',['-C',root,'remote','add','origin','https://example.test/team/large']);execFileSync('git',['-C',root,'update-index','--add','--cacheinfo','160000,'+'a'.repeat(40)+',modules/Cms']);
 for(let i=0;i<90;i++)writeFileSync(join(root,'file-'+i+'.txt'),randomBytes(45000).toString('hex'));
 const host=await startTeamHost(join(dir,'host'),{port:0}),history={close(){},async read(){return {threads:0,messages:0};}};let service;
 try{service=await startDesktop(state,{port:0,history});const ws=new WorkspaceClient(state);await ws.run({command:'connect',link:host.command({command:'workspace-init',name:'Team'}).link,device:'Client'});await discoveryRequest(state,{command:'approve',cwd:root,confirm:true,name:'Large project'});const enrolled=await discoveryRequest(state,{command:'resolve',cwd:root});assert.equal(enrolled.status,'enrolled');const config=JSON.parse(readFileSync(join(state,'p/project.json')));assert.equal(config.captureFiles,false);const engine=new ShardedEngine(join(state,'p/capture.sqlite'));try{assert.equal(engine.read('working').files.length,0);}finally{engine.close();}assert.equal((await ws.run({command:'list'})).projects.length,1);await service.close();service=null;service=await startDesktop(state,{port:0,history});assert.equal((await discoveryRequest(state,{command:'resolve',cwd:root})).status,'enrolled');}finally{await service?.close();await host.close();rmSync(dir,{recursive:true,force:true});}
});
