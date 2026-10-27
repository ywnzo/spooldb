import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {execFile,execFileSync,spawn} from 'node:child_process';
import {startTeamHost} from '../src/team/host.js';
import {WorkspaceClient} from '../src/team/workspace-client.js';
import {startDesktop} from '../src/desktop/service.js';
import {discoveryRequest} from '../src/discovery.js';
import {canonicalRemote,repositoryAt} from '../src/repository.js';
import {installDiscovery} from '../src/discovery-install.js';
const execute=promisify(execFile);
const git=(root,args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
function repo(base,name,remote='git@example.com:team/project.git'){const root=join(base,name);mkdirSync(root);git(root,['init','-q']);if(remote)git(root,['remote','add','origin',remote]);writeFileSync(join(root,'app.ts'),'local source must never reach relay');return root;}
async function cliHook(directory,cwd,event='SessionStart'){
 const child=spawn(process.execPath,['src/discovery-hook.js',directory,event],{cwd:process.cwd(),stdio:['pipe','pipe','pipe']});let output='';child.stdout.on('data',chunk=>output+=chunk);child.stdin.end(JSON.stringify({cwd,session_id:'discovery-test',turn_id:'first',prompt:'Test context'}));await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error('Hook failed')));});return JSON.parse(output);
}
async function mcp(directory,cwd,calls){
 const script=join(process.cwd(),'src/memory-mcp.js'),child=spawn(process.execPath,[script,directory,'--discover'],{cwd,stdio:['pipe','pipe','pipe']});let text='';child.stdout.on('data',chunk=>text+=chunk);child.stdin.end([{id:1,method:'initialize',params:{}},...calls.map((call,index)=>({id:index+2,method:'tools/call',params:{name:call.name,arguments:call.name==='spool_setup'?call.args??{}:{root:cwd,...(call.args??{})}}}))].map(m=>JSON.stringify({jsonrpc:'2.0',...m})).join('\n')+'\n');await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error('MCP failed')));});return text.trim().split('\n').map(line=>JSON.parse(line));
}
test('repository identity unifies SSH and HTTPS, drops credentials, preserves path and nonstandard port distinctions',()=>{
 assert.equal(canonicalRemote('git@EXAMPLE.com:team/project.git'),canonicalRemote('https://user:secret@example.com/team/project.git'));
 assert.equal(canonicalRemote('ssh://git@example.com:22/team/project.git'),'example.com/team/project');
 assert.notEqual(canonicalRemote('https://example.com/Team/project'),canonicalRemote('https://example.com/team/project'));
 assert.notEqual(canonicalRemote('ssh://git@example.com:2222/team/project'),canonicalRemote('ssh://git@example.com/team/project'));
 assert.notEqual(canonicalRemote('https://example.com:22/team/project'),canonicalRemote('https://example.com/team/project'));
 assert.equal(canonicalRemote('/local/repository'),null);assert.equal(canonicalRemote('file:///local/repository'),null);
});
test('first-session discovery asks before capture; two independently approved clients enroll exactly one shared repository',async t=>{
 const base=mkdtempSync(join(tmpdir(),'spool-discovery-')),host=await startTeamHost(join(base,'host'),{port:0}),desktops=[];t.after(async()=>{for(const d of desktops)await d.close();await host.close();rmSync(base,{recursive:true,force:true});});
 const owner=new WorkspaceClient(join(base,'owner'));await owner.run({command:'connect',link:host.command({command:'workspace-init',name:'Team'}).link,device:'Owner'});
 async function client(name){const state=join(base,name),desktop=await startDesktop(state,{port:0});desktops.push(desktop);const ws=new WorkspaceClient(state),invite=await owner.run({command:'invite-member',label:name});await ws.run({command:'connect',link:invite.link,device:name});return {state,desktop,ws};}
 const a=await client('alice'),b=await client('bob'),aroot=repo(base,'alice-repo'),broot=repo(base,'bob-repo','https://example.com/team/project.git');
 const proposal=await discoveryRequest(a.state,{command:'propose',cwd:aroot});assert.equal(proposal.status,'pending');const denied=await mcp(a.state,aroot,[{name:'project_context'}]);assert.equal(denied[1].result.isError,false);assert.equal(denied[1].result.structuredContent.code,'PROJECT_CONNECTION_REQUIRED');assert.equal(denied[1].result.structuredContent.onboarding.phase,'choose_project');assert.equal(host.command({command:'list'}).projects.length,0);assert.ok(!existsSync(join(a.state,'p/project.json')));assert.ok(!existsSync(join(aroot,'.codex/config.toml')));
 const hook=await cliHook(a.state,aroot);assert.match(hook.hookSpecificOutput.additionalContext,/ask ONE clarifying question/);assert.equal(hook.systemMessage,undefined);const firstPrompt=await cliHook(a.state,aroot,'UserPromptSubmit');assert.match(firstPrompt.hookSpecificOutput.additionalContext,/wait for the user's next reply/);assert.match(firstPrompt.hookSpecificOutput.additionalContext,/Never approve or enroll before the user chooses/);assert.equal(host.command({command:'list'}).projects.length,0);
 await assert.rejects(()=>discoveryRequest(a.state,{command:'approve',cwd:aroot}),/confirmation/);
 await assert.rejects(()=>execute(process.execPath,['src/cli.js','discovery','approve',aroot,'--state',a.state,'--json']),/Explicit approval required/);assert.equal(host.command({command:'list'}).projects.length,0);assert.ok(!existsSync(join(a.state,'p/project.json')));
 const enrollment=await execute(process.execPath,['src/cli.js','discovery','approve',aroot,'--state',a.state,'--yes','--json']);const approved=JSON.parse(enrollment.stdout.trim().split('\n').at(-1));assert.equal(approved.status,'enrolled');assert.equal(host.command({command:'list'}).projects.length,1);
 const bproposal=await discoveryRequest(b.state,{command:'propose',cwd:broot});assert.equal(bproposal.status,'pending');assert.ok(!existsSync(join(b.state,'p/project.json')));
 // Membership is not implied by matching a Git remote. Grant Bob access using the existing invitation flow.
 await assert.rejects(()=>discoveryRequest(b.state,{command:'preview',cwd:broot}),/access required/);
 await assert.rejects(()=>b.ws.run({command:'repository-enroll',mode:'create',repositoryKey:bproposal.repositoryKey,name:'Duplicate',requestId:'no-access-duplicate'}),/invitation/);assert.equal(host.command({command:'list'}).projects.length,1);
 await b.ws.run({command:'accept-project',link:(await a.ws.run({command:'invite-project',room:approved.room,label:'Bob'})).link});
 const preview=await discoveryRequest(b.state,{command:'preview',cwd:broot});assert.equal(preview.match.room,approved.room);
 const joined=await discoveryRequest(b.state,{command:'approve',cwd:broot,confirm:true,room:approved.room});assert.equal(joined.room,approved.room);assert.equal(host.command({command:'list'}).projects.length,1);
 const written=await mcp(a.state,aroot,[{name:'task_update',args:{taskId:'discovery-shared',title:'Continue',text:'Alice started',status:'in_progress',expectedRevision:0}},{name:'handoff',args:{taskId:'discovery-shared',title:'Alice handoff',text:'DISCOVERY-MCP-621 verified fixture marker',nextSteps:['Verify from Bob']}}]);assert.ok(written.slice(1).every(m=>m.result.isError===false));
 const retrieved=await mcp(b.state,broot,[{name:'project_context'}]);assert.equal(retrieved[1].result.isError,false);assert.match(JSON.stringify(retrieved[1]),/DISCOVERY-MCP-621/);
 assert.equal((await discoveryRequest(a.state,{command:'approve',cwd:aroot,confirm:true})).room,approved.room);
 assert.ok(!existsSync(join(aroot,'.codex/config.toml')));assert.ok(!existsSync(join(broot,'.codex/config.toml')));
 const context=await cliHook(b.state,broot);assert.match(context.hookSpecificOutput.additionalContext,/SpoolDB is connected/);
 const ignored=repo(base,'ignored','https://example.com/team/ignored');await discoveryRequest(a.state,{command:'ignore',cwd:ignored});assert.deepEqual(await cliHook(a.state,ignored),{});assert.equal(host.command({command:'list'}).projects.length,1);
 git(aroot,['remote','set-url','origin','https://example.com/team/different']);assert.equal((await discoveryRequest(a.state,{command:'resolve',cwd:aroot})).status,'pending');
 assert.equal(host.relay.engine.db.prepare("SELECT count(*) AS n FROM shard_changes WHERE doc LIKE 'f:%'").get().n,0);
});
test('explicitly link an existing project; a repository without origin requires a manual choice; discovery config is repeatable',async t=>{
 const base=mkdtempSync(join(tmpdir(),'spool-discovery-link-')),host=await startTeamHost(join(base,'host'),{port:0}),state=join(base,'client'),desktop=await startDesktop(state,{port:0});t.after(async()=>{await desktop.close();await host.close();rmSync(base,{recursive:true,force:true});});
 const ws=new WorkspaceClient(state);await ws.run({command:'connect',link:host.command({command:'workspace-init',name:'Team'}).link,device:'Owner'});
 const existing=(await ws.run({command:'create',name:'Existing',requestId:'existing'})).project,root=repo(base,'repo');
 assert.equal((await discoveryRequest(state,{command:'approve',cwd:root,confirm:true,room:existing.room})).room,existing.room);assert.equal(host.command({command:'list'}).projects.length,1);
 const offline=repo(base,'offline',null);await assert.rejects(()=>discoveryRequest(state,{command:'approve',cwd:offline,confirm:true}),/no supported origin/);
 assert.equal((await discoveryRequest(state,{command:'approve',cwd:offline,confirm:true,room:existing.room})).room,existing.room);
 const home=join(base,'codex');mkdirSync(home);writeFileSync(join(home,'config.toml'),'model_verbosity = "medium"\n');const first=installDiscovery(state,{codexHome:home});assert.equal(first.changed,true);assert.equal(installDiscovery(state,{codexHome:home}).changed,false);assert.ok(readFileSync(first.path,'utf8').includes('--discover'));assert.ok(readFileSync(first.path,'utf8').startsWith('model_verbosity'));
 const parsed=JSON.parse(execFileSync('python3',['-c','import tomllib,json,sys;print(json.dumps(tomllib.load(open(sys.argv[1],"rb"))))',first.path],{encoding:'utf8'}));assert.equal(parsed.hooks.SessionStart.length,1);assert.equal(parsed.mcp_servers.spool.args.at(-1),'--discover');
 // Worktrees resolve their actual root and share the repository identity.
 git(root,['add','.']);git(root,['-c','user.name=Test','-c','user.email=test@example.com','commit','-qm','Initial']);const worktree=join(base,'worktree');git(root,['worktree','add','-qb','test-peer',worktree]);assert.equal(repositoryAt(worktree).repositoryKey,repositoryAt(root).repositoryKey);
});
