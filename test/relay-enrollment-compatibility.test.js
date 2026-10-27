import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {RepositoryDiscovery} from '../src/discovery.js';
test('legacy relay capability check prevents remote creation before any mutation',async()=>{
 const base=mkdtempSync(join(tmpdir(),'spool-legacy-enroll-')),root=join(base,'repo');mkdirSync(root);execFileSync('git',['init','-q',root]);execFileSync('git',['-C',root,'remote','add','origin','https://example.test/team/repo']);const commands=[];
 const legacy={run:async input=>{commands.push(input.command);if(input.command==='list')return {connected:true};throw Error('Mutation must not run');}};
 const workspace={scoped:async()=>legacy,run:async()=>({workspaces:[{id:'legacy'}]})};const discovery=new RepositoryDiscovery(join(base,'state'),{workspace,manager:async()=>({list:()=>[]})});
 try{await assert.rejects(discovery.run({command:'approve',cwd:root,confirm:true,create:true,workspace:'legacy'}),e=>e.code==='RELAY_UPDATE_REQUIRED');assert.deepEqual(commands,['list']);assert.equal((await discovery.run({command:'resolve',cwd:root})).status,'pending');}finally{rmSync(base,{recursive:true,force:true});}
});
