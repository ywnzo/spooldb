import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {initializeProject,startProject,projectRequest} from '../src/project.js';
import {Bridge} from '../src/bridge.js';
import {ShardedEngine} from '../src/index.js';
test('project service captures real disk changes, publishes review, serializes harnesses and retains exclusions on reopen',async t=>{
  const base=mkdtempSync(join(tmpdir(),'spool-project-')),root=join(base,'repo'),dir=join(base,'state');mkdirSync(root);execFileSync('git',['init','-q',root]);
  writeFileSync(join(root,'app.js'),'before\n');mkdirSync(join(root,'private'));writeFileSync(join(root,'private','large.bin'),Buffer.alloc(1100000));
  const initial=initializeProject(dir,root,{exclude:['private']});assert.equal(initial.files,1);assert.equal(initial.excluded[0].reason,'configured-exclusion');assert.equal(statSync(join(dir,'tokens.json')).mode&0o777,0o600);
  let release;const gate=new Promise(resolve=>release=resolve);let block=false;
  const runner=async(engine,options)=>{if(block)await gate;engine.submit('working',{actor:'test-agent',harness:options.harness,requestId:crypto.randomUUID(),expectedHeads:engine.ref('working').heads,operations:[{type:'message.add',messageId:crypto.randomUUID(),role:'assistant',text:options.prompt}]});writeFileSync(join(root,'app.js'),`${options.harness}\n`);return {status:'completed'};};
  let service=await startProject(dir,{port:0,intervalMs:25,runner});t.after(async()=>{await service.close();rmSync(base,{recursive:true,force:true});});
  const tokens=JSON.parse(readFileSync(join(dir,'tokens.json')));
  const api=async input=>{const response=await fetch(`${service.state.origin}/v1/rooms/${initial.room}/review`,{method:'POST',headers:{authorization:`Bearer ${tokens.reader}`,'content-type':'application/json'},body:JSON.stringify(input)});assert.equal(response.status,200);return response.json();};
  writeFileSync(join(root,'app.js'),'manual save\n');
  // Observe durable published state: the next idle scan resets lastCapture.operations to zero.
  let files;const deadline=Date.now()+3000;while(!(files=await api({command:'files',branch:'working',compare:'main'})).files.some(file=>file.path==='app.js'&&file.status==='modified')){assert.ok(Date.now()<deadline,'watcher must publish the edit without a manual capture request');await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(files.files[0].status,'modified');
  for(const harness of ['codex','claude'])assert.equal((await projectRequest(dir,{command:'run',harness,prompt:`Hello from ${harness}`})).status,'completed');
  const timeline=await api({command:'timeline',branch:'working'});const text=timeline.entries.flatMap(e=>e.messages).map(m=>m.text).join('\n');assert.match(text,/Hello from codex/);assert.match(text,/Hello from claude/);
  block=true;const running=projectRequest(dir,{command:'run',harness:'codex',prompt:'blocked'});
  while(!(await projectRequest(dir,{command:'status'})).runningHarness)await new Promise(resolve=>setTimeout(resolve,5));
  await assert.rejects(projectRequest(dir,{command:'run',harness:'claude',prompt:'overlap'}),/already running/);release();await running;
  await service.close();service=await startProject(dir,{port:0,intervalMs:60000,runner});assert.equal((await projectRequest(dir,{command:'status'})).room,initial.room);
  assert.equal((await api({command:'branches'})).branches.find(b=>b.name==='main').revision,1);
  await service.close();const engine=new ShardedEngine(join(dir,'capture.sqlite'));try{assert.ok(!new Bridge(engine).scan(root).entries['private/large.bin']);assert.throws(()=>new Bridge(engine).setExclusions(root,[]),/before attaching/);}finally{engine.close();}
});
