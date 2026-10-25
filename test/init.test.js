import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync,execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {Writable} from 'node:stream';
import {initializeCheckout} from '../src/init.js';
import {WorkspaceClient} from '../src/team/workspace-client.js';
import {startTeamHost} from '../src/team/host.js';
import {projectRequest} from '../src/project.js';
import {startDesktop} from '../src/desktop/service.js';
import {localCommand} from '../src/management-cli.js';
import {installDiscovery} from '../src/discovery-install.js';
import {discoveryRequest} from '../src/discovery.js';
const git=(root,...args)=>execFileSync('git',['-c','core.hooksPath=/dev/null','-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
async function fixture(t){const base=mkdtempSync(join(tmpdir(),'spool-init-')),host=await startTeamHost(join(base,'h'),{port:0}),owner=host.command({command:'workspace-init',name:'Team'}),clients=[];t.after(async()=>{for(const c of clients)await c.desktop.close();await host.close();rmSync(base,{recursive:true,force:true});});
 async function client(name,{remote='https://example.test/team/project.git',connected=true}={}){const root=join(base,name),state=join(base,name+'-s');mkdirSync(root);git(root,'init','-q');if(remote)git(root,'remote','add','origin',remote);writeFileSync(join(root,'app.ts'),'local code');let hooks=0;const desktop=await startDesktop(state,{port:0,connector:async()=>{throw Error('Init must use shared discovery hooks, not a second per-project hook set');}});const ws=new WorkspaceClient(state);if(connected){if(!clients.length)await ws.run({command:'connect',link:owner.link,device:name});else{const invite=await clients[0].ws.run({command:'invite-member',label:name,role:'admin'});await ws.run({command:'connect',link:invite.link,device:name});}}
  const local=(path,input,options={})=>localCommand(state,path,input,options),c={root,state,desktop,ws,local,connectCodex:async directory=>{hooks++;return {...installDiscovery(directory,{codexHome:join(state,'test-codex')}),trusted:true};},get hooks(){return hooks;}};clients.push(c);return c;
 }
 return {base,host,client};
}
async function init(c,answers,extra={}){const prompts=[];let text='';const result=await initializeCheckout({cwd:c.root,state:c.state,workspace:input=>c.ws.run(input),local:c.local,connectCodex:c.connectCodex,output:new Writable({write(c,e,done){text+=c;done();}}),ask:async(label,value='')=>{prompts.push(label);assert.ok(answers.length,'Unexpected prompt: '+label);return answers.shift()||value;},...extra});assert.equal(answers.length,0,'Unused answers');return {result,text,prompts};}
test('init creates and enrolls a repository, installs Codex integration and is idempotent on rerun',async t=>{
 const f=await fixture(t),a=await f.client('repo');mkdirSync(join(a.root,'nested'));const first=await init(a,['1','Project name','y'],{cwd:join(a.root,'nested')});assert.equal(first.result.project.root,a.root);assert.equal(first.result.connected,true);assert.equal(first.result.codexReady,true);assert.equal(a.hooks,1);assert.equal((await a.ws.run({command:'list'})).projects.length,1);assert.ok(readFileSync(join(a.state,'test-codex/config.toml'),'utf8').includes('--discover'));assert.equal(existsSync(join(a.root,'.codex')),false);
 const resolved=await discoveryRequest(a.state,{command:'resolve',cwd:a.root});assert.equal(resolved.status,'enrolled');assert.equal(resolved.projectId,first.result.project.id);assert.equal((await a.local('status')).root,a.root);
 const second=await init(a,['y','y']);assert.equal(second.result.project.id,first.result.project.id);assert.equal((await a.ws.run({command:'list'})).projects.length,1);assert.equal(a.hooks,2);
});
test('another checkout joins the matching shared project and retrieves its existing memory',async t=>{
 const f=await fixture(t),a=await f.client('a');await init(a,['1','Wield','y']);const finding=await projectRequest(join(a.state,'p'),{command:'memory',input:{command:'remember',kind:'finding',title:'Existing shared finding',text:'Continue from this evidence',requestId:'finding'}});
 const b=await f.client('b');const joined=await init(b,['1','y']);assert.equal(joined.result.connected,true);assert.match(joined.text,/Join Wield \(matches this repository\)/);assert.doesNotMatch(joined.text,/Create a shared project/);assert.equal((await b.local('memory',{command:'get',id:finding.id})).title,'Existing shared finding');assert.equal((await b.ws.run({command:'list'})).projects.length,1);assert.equal(b.hooks,1);
 const child=spawn(process.execPath,[join(process.cwd(),'src/memory-mcp.js'),b.state,'--discover'],{cwd:b.root,stdio:['pipe','pipe','pipe']});let output='';child.stdout.on('data',c=>output+=c);child.stdin.end([{jsonrpc:'2.0',id:1,method:'initialize',params:{}},{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'memory_get',arguments:{id:finding.id}}}].map(JSON.stringify).join('\n')+'\n');await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error('MCP failed')));});const response=output.trim().split('\n').map(line=>JSON.parse(line)).find(r=>r.id===2);assert.equal(response.result.isError,false);assert.equal(response.result.structuredContent.title,'Existing shared finding');
});
test('cancelling init does not create a shared project, capture a new checkout or install hooks',async t=>{
 const f=await fixture(t),a=await f.client('cancel');const result=await init(a,['1','Cancelled','n']);assert.equal(result.result.cancelled,true);assert.equal((await a.ws.run({command:'list'})).projects.length,0);assert.equal((await a.local('projects')).projects.length,0);assert.equal(existsSync(join(a.root,'.codex')),false);assert.equal(a.hooks,0);
});
test('init supports local Git repositories without remotes and joins existing projects by name selection',async t=>{
 const f=await fixture(t),a=await f.client('local-only',{remote:null});await init(a,['1','Local project','y']);assert.equal((await discoveryRequest(a.state,{command:'resolve',cwd:a.root})).status,'enrolled');
 const b=await f.client('other',{remote:null});await init(b,['2','1','y']);assert.equal((await b.ws.run({command:'list'})).projects.length,1);assert.equal((await b.local('status')).team.room,(await a.local('status')).team.room);
});
test('fresh init can use a browser project invite without workspace enrollment',async t=>{
 const f=await fixture(t),a=await f.client('owner');await init(a,['1','Wield','y']);const room=(await a.local('status')).team.room,invite=await a.ws.run({command:'invite-project',room,label:'New laptop'}),b=await f.client('new-laptop',{connected:false});
 const joined=await init(b,[invite.browserLink,'y']);assert.equal(joined.result.connected,true);assert.equal((await b.local('status')).team.room,room);assert.equal((await discoveryRequest(b.state,{command:'resolve',cwd:b.root})).status,'enrolled');assert.equal(b.hooks,1);
});
test('init asks before connecting a workspace invite and then creates a project in the same flow',async t=>{
 const f=await fixture(t),a=await f.client('owner'),invite=await a.ws.run({command:'invite-member',label:'new teammate',role:'member',canCreate:true}),b=await f.client('new-workspace',{connected:false});
 await init(b,[invite.browserLink,'y','1','New shared project','y']);assert.equal((await b.ws.run({command:'list'})).projects.length,1);assert.equal(b.hooks,1);
});
test('init rejects noninteractive execution and non-Git folders without creating a database',async t=>{
 const base=mkdtempSync(join(tmpdir(),'spool-init-cli-'));t.after(()=>rmSync(base,{recursive:true,force:true}));const state=join(base,'state');await assert.rejects(()=>promisify(execFile)(process.execPath,['src/cli.js','init','--state',state],{cwd:process.cwd()}),error=>{assert.match(error.stderr,/interactive terminal/);return true;});assert.equal(existsSync(state),false);assert.equal(existsSync(join(base,'init')),false);
 await assert.rejects(()=>initializeCheckout({cwd:base}),/Git/);
});

test('retrying a failed local connection does not duplicate a project without a Git remote',async t=>{
 const f=await fixture(t),a=await f.client('retry',{remote:null});let failed=false;
 await assert.rejects(()=>init(a,['1','Retry project','y'],{local:async(path,...args)=>{if(path==='workspace'&&!failed){failed=true;throw Error('Temporary companion failure');}return a.local(path,...args);}}),/Temporary companion failure/);
 assert.equal((await a.ws.run({command:'list'})).projects.length,1);await init(a,['1','Retry project','y']);assert.equal((await a.ws.run({command:'list'})).projects.length,1);
});
test('Codex setup failure is reported as partial completion and can be retried on the same project',async t=>{
 const f=await fixture(t),a=await f.client('partial');const first=await init(a,['1','Partial project','y'],{connectCodex:async()=>{throw Error('Codex is unavailable');}});assert.equal(first.result.connected,true);assert.equal(first.result.codexReady,false);assert.match(first.text,/Codex is unavailable/);assert.match(first.text,/Run spool init again/);
 const retried=await init(a,['y','y']);assert.equal(retried.result.codexReady,true);assert.equal((await a.ws.run({command:'list'})).projects.length,1);
});
