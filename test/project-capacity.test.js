import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {ProjectManager} from '../src/project-manager.js';
test('a client with sixteen existing projects can attach another checkout',async t=>{
 const base=mkdtempSync(join(tmpdir(),'spool-project-capacity-')),state=join(base,'state'),repo=join(base,'checkout');mkdirSync(state);mkdirSync(repo);execFileSync('git',['init','-q',repo]);writeFileSync(join(repo,'file.txt'),'fixture');
 const entries=Array.from({length:16},(_,i)=>({id:'old-'+i,name:'old-'+i,root:join(base,'old-'+i),dir:join(base,'state-'+i)}));writeFileSync(join(state,'projects.json'),JSON.stringify({projects:entries}));
 const primary={state:{room:'old-0',name:'old-0',root:entries[0].root}},manager=new ProjectManager(state,primary,{start:async dir=>({state:{room:'new'},app:{},close:async()=>{}})});t.after(async()=>{await manager.close();rmSync(base,{recursive:true,force:true});});
 const result=await manager.add({root:repo,captureFiles:false});assert.equal(result.existing,false);assert.equal(manager.list().length,17);assert.equal(manager.list().at(-1).root,repo);
});
