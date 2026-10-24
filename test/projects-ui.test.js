import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {initializeProject,startProject} from '../src/project.js';
test('projects can be added and switched over the local UI API with isolated history, per-tab selection and restart persistence',async t=>{
 const base=mkdtempSync(join(tmpdir(),'tw-projects-')),first=join(base,'first'),second=join(base,'second'),state=join(base,'state');
 for(const [root,text]of [[first,'first project'],[second,'second project']]){mkdirSync(root);execFileSync('git',['init','-q',root]);writeFileSync(join(root,'code.txt'),text);}
 writeFileSync(join(second,'large-asset.bin'),Buffer.alloc(1100000));const primary=initializeProject(state,first);
 let service=await startProject(state,{port:0,intervalMs:60000});t.after(async()=>{await service.close();rmSync(base,{recursive:true,force:true});});
 let cookie,csrf;
 const session=async preferred=>{const r=await fetch(service.state.origin+'/local/session',{headers:{'sec-fetch-site':'same-origin',...(preferred?{cookie:preferred}:{})}});cookie=r.headers.get('set-cookie').split(';')[0];const data=await r.json();csrf=data.csrf;return data;};await session();
 const request=async(path,input,id)=>{const response=await fetch(service.state.origin+'/local/'+path,{method:input?'POST':'GET',headers:{'sec-fetch-site':'same-origin','x-spool-csrf':csrf,cookie,...(id?{'x-spool-project':id}:{}),...(input?{'content-type':'application/json'}:{})},...(input?{body:JSON.stringify(input)}:{})});return {status:response.status,cookie:response.headers.get('set-cookie'),data:await response.json()};};
 assert.equal((await request('projects')).data.projects.length,1);
 const added=await request('projects/add',{root:second});assert.equal(added.status,200);const id=added.data.project.id;assert.notEqual(id,primary.room);assert.equal(added.data.files,1);assert.ok(added.data.excluded.some(p=>p.path==='large-asset.bin'));
 const duplicate=await request('projects/add',{root:second+'/.'});assert.equal(duplicate.data.existing,true);assert.equal(duplicate.data.project.id,id);assert.equal((await request('projects')).data.projects.length,2);
 const selected=await request('projects/select',{id});assert.equal(selected.data.root,second);const preference=selected.cookie.split(';')[0];
 assert.equal((await request('status',undefined,primary.room)).data.root,first);assert.equal((await request('status',undefined,id)).data.root,second);
 const files=await request('review',{command:'files',branch:'working'},id);const file=await request('review',{command:'file',branch:'working',fileId:files.data.files[0].fileId},id);assert.equal(file.data.file.text,'second project');
 const foreign=await request('review',{command:'file',branch:'working',fileId:files.data.files[0].fileId},primary.room);assert.equal(foreign.status,404);
 assert.equal((await request('projects/select',{id:'missing'})).status,400);
 const before=readdirSync(join(state,'projects'));assert.equal((await request('projects/add',{root:join(base,'missing')})).status,400);assert.equal((await request('projects/add',{root:second,exclude:['../outside']})).data.existing,true);
 const invalid=join(base,'invalid');mkdirSync(invalid);execFileSync('git',['init','-q',invalid]);assert.equal((await request('projects/add',{root:invalid,exclude:['../outside']})).status,400);assert.deepEqual(readdirSync(join(state,'projects')),before);
 assert.equal(readFileSync(join(first,'code.txt'),'utf8'),'first project');assert.equal(readFileSync(join(second,'code.txt'),'utf8'),'second project');
 await service.close();service=await startProject(state,{port:0,intervalMs:60000});const restored=await session(preference);assert.equal(restored.project.id,id);assert.equal(restored.project.root,second);assert.equal((await request('projects')).data.projects.length,2);
});
