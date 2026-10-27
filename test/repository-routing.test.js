import {localCommand} from '../src/management-cli.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {WorkspaceClient} from '../src/team/workspace-client.js';
import {startTeamHost} from '../src/team/host.js';
import {startDesktop} from '../src/desktop/service.js';
import {discoveryRequest} from '../src/discovery-request.js';
import {repositoryAt} from '../src/repository.js';
const git=(root,args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
function repo(base,name){const root=join(base,name);mkdirSync(root);git(root,['init','-q']);git(root,['config','user.email','test@example.test']);git(root,['config','user.name','Test']);writeFileSync(join(root,'app.js'),'export const fixture=true;');git(root,['add','.']);git(root,['commit','-qm','fixture']);git(root,['remote','add','origin','https://example.test/team/'+name+'.git']);return root;}
function mcp(state,cwd){const child=spawn(process.execPath,[resolve('src/memory-mcp.js'),state,'--discover'],{cwd,stdio:['pipe','pipe','pipe']});let buffer='',id=0,stderr='';const pending=new Map();child.stderr.on('data',c=>stderr+=c);child.stdout.on('data',c=>{buffer+=c;let at;while((at=buffer.indexOf('\n'))>=0){const msg=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);const entry=pending.get(msg.id);if(entry){clearTimeout(entry.timer);pending.delete(msg.id);entry.resolve(msg.result);}}});child.on('exit',()=>{for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(Error('MCP exited: '+stderr));}});return {call:(method,params={})=>new Promise((resolve,reject)=>{const next=++id,timer=setTimeout(()=>reject(Error('MCP timeout')),30000);pending.set(next,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:next,method,params})+'\n');}),close:async()=>{child.stdin.end();await new Promise(done=>child.once('exit',done));}};}
test('one agent routes parent and submodule memory across independent relays without a global workspace or fallback',{timeout:90000},async t=>{
 const base=mkdtempSync(join(tmpdir(),'spool-repo-routing-')),state=join(base,'state'),platform=repo(base,'platform'),library=repo(base,'library'),unbound=repo(base,'unbound');
 git(platform,['-c','protocol.file.allow=always','submodule','add','-q',library,'modules/cms-lib']);const nested=join(platform,'modules/cms-lib');git(nested,['remote','set-url','origin','https://example.test/team/cms-lib.git']);assert.equal(repositoryAt(nested).superproject.root,platform);
 const a=await startTeamHost(join(base,'relay-a'),{port:0}),b=await startTeamHost(join(base,'relay-b'),{port:0}),desktop=await startDesktop(state,{port:0,history:{read:async()=>({threads:0,messages:0}),close(){}}}),ws=new WorkspaceClient(state);let session;
 t.after(async()=>{await session?.close();await desktop.close();await a.close();await b.close();rmSync(base,{recursive:true,force:true});});
 const ac=await ws.run({command:'connect',link:a.command({command:'workspace-init',name:'Company'}).link}),bc=await ws.run({command:'connect',link:b.command({command:'workspace-init',name:'Library team'}).link});
 assert.equal(existsSync(join(state,'workspace.json')),false);assert.equal((await ws.run({command:'list'})).selectionRequired,true);assert.ok((await ws.run({command:'profiles'})).workspaces.every(p=>!('active'in p)));
 await assert.rejects(()=>ws.run({command:'switch',workspace:ac.workspaceProfile}),/no global workspace/i);
 const approve=(cwd,workspace,name)=>discoveryRequest(state,{command:'approve',cwd,workspace,create:true,name,confirm:true});
 const parent=await approve(platform,ac.workspaceProfile,'Platform'),child=await approve(nested,bc.workspaceProfile,'cms-lib');assert.equal(parent.workspace,a.origin);assert.equal(child.workspace,b.origin);
 const parentSettings=await localCommand(state,'workspace',{command:'list'},{project:parent.projectId}),childSettings=await localCommand(state,'workspace',{command:'list'},{project:child.projectId});assert.equal(parentSettings.relay,a.origin);assert.equal(childSettings.relay,b.origin);assert.equal(parentSettings.repositoryBinding.room,parent.room);await assert.rejects(()=>localCommand(state,'workspace',{command:'project-sharing',room:child.room},{project:parent.projectId}),/selected repository/);
 assert.equal((await discoveryRequest(state,{command:'preview',cwd:platform})).relay,a.origin);assert.equal((await discoveryRequest(state,{command:'preview',cwd:nested})).relay,b.origin);
 session=mcp(state,platform);await session.call('initialize');const tool=(name,args)=>session.call('tools/call',{name,arguments:args});
 const missing=await tool('project_context',{});assert.equal(missing.isError,true);
 const pa=await tool('remember',{root:platform,kind:'finding',title:'Platform only',text:'PLATFORM-ONLY-8462'});assert.equal(pa.isError,false);assert.equal(pa.structuredContent.repository.relay,a.origin);
 assert.equal((await tool('remember',{root:platform,kind:'finding',title:'Wrong owner',text:'Child code must go to child memory',files:['modules/cms-lib/app.js']})).isError,true);
 const cb=await tool('remember',{root:nested,kind:'finding',title:'Library only',text:'LIBRARY-ONLY-9351'});assert.equal(cb.isError,false);assert.equal(cb.structuredContent.repository.root,nested);assert.equal(cb.structuredContent.repository.relay,b.origin);
 const parentContext=await tool('project_context',{root:platform});assert.match(JSON.stringify(parentContext),/PLATFORM-ONLY-8462/);assert.doesNotMatch(JSON.stringify(parentContext),/LIBRARY-ONLY-9351/);
 const childContext=await tool('project_context',{root:nested});assert.match(JSON.stringify(childContext),/LIBRARY-ONLY-9351/);assert.doesNotMatch(JSON.stringify(childContext),/PLATFORM-ONLY-8462/);
 assert.equal((await tool('memory_get',{root:nested,id:pa.structuredContent.id})).isError,true);
 assert.equal((await tool('handoff',{root:nested,taskId:'work',title:'Wrong project ref',text:'Must not cross project',nextSteps:['Check'],refs:[pa.structuredContent.id]})).isError,true);
 const pending=await tool('project_context',{root:unbound});assert.equal(pending.isError,false);assert.equal(pending.structuredContent.code,'PROJECT_CONNECTION_REQUIRED');assert.equal(pending.structuredContent.onboarding.phase,'choose_connection');
 assert.equal(pending.structuredContent.saved,false);assert.equal(pending.structuredContent.onboarding.enrollmentAuthorized,false);assert.equal(pending.structuredContent.onboarding.connections.length,2);
 const rejectedWrite=await tool('remember',{root:unbound,kind:'finding',title:'Must not save',text:'UNAPPROVED-WRITE-2816'});assert.equal(rejectedWrite.isError,true);assert.equal(rejectedWrite.structuredContent.saved,false);
 const preview=await tool('spool_setup',{action:'preview',root:unbound,workspace:ac.workspaceProfile});assert.equal(preview.structuredContent.onboarding.phase,'choose_project');assert.ok(preview.structuredContent.onboarding.choices.some(c=>c.id==='create'));
 const deniedConnect=await tool('spool_setup',{action:'connect',root:unbound,workspace:ac.workspaceProfile,create:true,name:'New repo'});assert.equal(deniedConnect.isError,true);assert.equal((await discoveryRequest(state,{command:'resolve',cwd:unbound})).status,'pending');
 const approvedConnect=await tool('spool_setup',{action:'connect',root:unbound,workspace:ac.workspaceProfile,create:true,name:'New repo',confirm:true});assert.equal(approvedConnect.isError,false);assert.equal(approvedConnect.structuredContent.status,'enrolled');
 const newlyAvailable=await tool('project_context',{root:unbound});assert.equal(newlyAvailable.structuredContent.repository.relay,a.origin);assert.doesNotMatch(JSON.stringify(newlyAvailable),/UNAPPROVED-WRITE-2816/);
 const skipped=repo(base,'skipped');await tool('spool_setup',{action:'ignore',root:skipped});const ignored=await tool('project_context',{root:skipped});assert.equal(ignored.isError,false);assert.equal(ignored.structuredContent.code,'PROJECT_SKIPPED');assert.equal(ignored.structuredContent.onboarding.question,null);assert.equal((await tool('task_update',{root:skipped,taskId:'declined',title:'No task',text:'Not approved',status:'open',expectedRevision:0})).isError,true);
 const matching=repo(base,'matching');git(matching,['remote','set-url','origin','https://example.test/team/platform.git']);const matchingPreview=await tool('spool_setup',{action:'preview',root:matching,workspace:ac.workspaceProfile});assert.equal(matchingPreview.structuredContent.onboarding.phase,'join_existing');assert.equal(matchingPreview.structuredContent.onboarding.projects[0].room,parent.room);assert.ok(!matchingPreview.structuredContent.onboarding.choices.some(c=>c.id==='create'));assert.equal((await discoveryRequest(state,{command:'resolve',cwd:matching})).status,'pending');

 assert.equal((await tool('project_context',{root:base})).isError,true);
 const before=readFileSync(join(state,'workspace-profiles',ac.workspaceProfile+'.json'),'utf8');await ws.run({command:'list',workspace:bc.workspaceProfile});assert.equal(readFileSync(join(state,'workspace-profiles',ac.workspaceProfile+'.json'),'utf8'),before);
 assert.equal((await tool('project_context',{root:platform})).structuredContent.repository.relay,a.origin);
 assert.equal(existsSync(join(state,'workspace.json')),false);
});

test('legacy workspace credentials become saved connections without altering project data',{timeout:30000},async t=>{
 const base=mkdtempSync(join(tmpdir(),'spool-connections-migration-')),host=await startTeamHost(join(base,'host'),{port:0});t.after(async()=>{await host.close();rmSync(base,{recursive:true,force:true});});
 const first=new WorkspaceClient(join(base,'original')),saved=await first.run({command:'connect',link:host.command({command:'workspace-init',name:'Legacy'}).link});const profile=JSON.parse(readFileSync(join(base,'original/workspace-profiles',saved.workspaceProfile+'.json')));
 const directory=join(base,'old');mkdirSync(directory);writeFileSync(join(directory,'workspace.json'),JSON.stringify(profile.connection),{mode:0o600});writeFileSync(join(directory,'projects.json'),'KEEP PROJECT BINDINGS');
 const migrated=new WorkspaceClient(directory),listing=await migrated.run({command:'profiles'});assert.equal(listing.workspaces.length,1);assert.equal(existsSync(join(directory,'workspace.json')),false);assert.equal(readFileSync(join(directory,'projects.json'),'utf8'),'KEEP PROJECT BINDINGS');assert.equal((await migrated.run({command:'list',workspace:listing.workspaces[0].id})).workspace.name,'Legacy');assert.ok(!JSON.stringify(listing).includes(profile.connection.token));
});
