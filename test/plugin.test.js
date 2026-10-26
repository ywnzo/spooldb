import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync,spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {startTeamHost} from '../src/team/host.js';
import {startDesktop} from '../src/desktop/service.js';
import {WorkspaceClient} from '../src/team/workspace-client.js';
import {runDiscoveryHook} from '../src/discovery-hook.js';
import {projectRequest} from '../src/project.js';
import {migrateLegacy} from '../src/plugin/migration.js';
import {installDiscovery} from '../src/discovery-install.js';
import {installCodex} from '../src/codex-install.js';
function repository(base,name){const root=join(base,name);mkdirSync(root);execFileSync('git',['init','-q',root]);execFileSync('git',['-C',root,'remote','add','origin','https://example.test/team/game']);writeFileSync(join(root,'app.ts'),'source stays in Git');return root;}
function mcp(state,root){const child=spawn(process.execPath,[resolve('src/plugin/entry.js'),'mcp'],{cwd:root,env:{...process.env,SPOOL_STATE:state},stdio:['pipe','pipe','pipe']});let buffer='',id=0,stderr='';const pending=new Map();child.stderr.on('data',c=>stderr+=c);child.stdout.on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\n'))>=0){const msg=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);const entry=pending.get(msg.id);if(entry){pending.delete(msg.id);clearTimeout(entry.timer);entry.resolve(msg);}}});child.on('exit',()=>{for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(Error('MCP exited: '+stderr));}});
 const call=(method,params={})=>new Promise((resolve,reject)=>{const next=++id,timer=setTimeout(()=>reject(Error('MCP timeout: '+stderr)),30000);pending.set(next,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:next,method,params})+'\n');});
 return {call,tool:async(name,args={})=>(await call('tools/call',{name,arguments:args})).result,close:async()=>{child.stdin.end();await new Promise(done=>child.once('exit',done));}};
}
test('matching repository shows the shared name and requires explicit join approval without creating a duplicate',async t=>{
 const base=mkdtempSync(join(tmpdir(),'spool-plugin-join-first-')),state=join(base,'state'),backendRoot=repository(base,'backend'),platformRoot=repository(base,'GEREQ_PLATFORM'),host=await startTeamHost(join(base,'host'),{port:0}),desktop=await startDesktop(state,{port:0}),clients=[];
 t.after(async()=>{for(const c of clients)await c.close();await desktop.close();await host.close();rmSync(base,{recursive:true,force:true});});
 const ws=new WorkspaceClient(state);await ws.run({command:'connect',link:host.command({command:'workspace-init',name:'Team'}).link,device:'Owner'});
 const backend=mcp(state,backendRoot),platform=mcp(state,platformRoot);clients.push(backend,platform);await backend.call('initialize');await platform.call('initialize');
 const original=(await backend.tool('spool_setup',{action:'connect',create:true,name:'GEREQ_PLATFORM',confirm:true})).structuredContent;assert.ok(original.room);
 assert.equal((await backend.tool('remember',{kind:'finding',title:'Shared finding',text:'SHARED-JOIN-FIRST-938: preserve this finding'})).isError,false);
 const preview=(await platform.tool('spool_setup',{action:'preview'})).structuredContent;assert.equal(preview.match.name,'GEREQ_PLATFORM');
 const hook=await runDiscoveryHook({directory:state,event:'UserPromptSubmit',input:{cwd:platformRoot,session_id:'join-first',turn_id:'first',prompt:'Investigate shipping'},plugin:true}),guidance=hook.hookSpecificOutput.additionalContext;assert.match(guidance,/GEREQ_PLATFORM/);assert.match(guidance,/ask whether the user wants to join/i);assert.doesNotMatch(guidance,/Offer Create a shared project/);
 const offered=(await platform.tool('spool_setup',{action:'connect',create:true,name:'backend',confirm:true})).structuredContent;assert.equal(offered.status,'join_available');assert.equal(offered.requiresJoinApproval,true);assert.equal(offered.existingProject.room,original.room);assert.equal((await platform.tool('spool_setup',{action:'status'})).structuredContent.status,'pending');assert.equal(host.command({command:'list'}).projects.length,1);
 assert.equal((await platform.tool('spool_setup',{action:'connect',project:'GEREQ_PLATFORM'})).isError,true);
 const joined=await platform.tool('spool_setup',{action:'connect',project:'GEREQ_PLATFORM',confirm:true});assert.equal(joined.isError,false);assert.equal(joined.structuredContent.room,original.room);assert.equal((await platform.tool('memory_search',{query:'SHARED-JOIN-FIRST-938'})).structuredContent.results.length,1);
 const key=(await import('../src/repository.js')).repositoryAt(platformRoot).repositoryKey;await assert.rejects(ws.run({command:'repository-enroll',mode:'create',repositoryKey:key,name:'Duplicate',requestId:'stale-client-create'}),/already belongs to.*GEREQ_PLATFORM/);
 const pendingRoot=repository(base,'third-checkout'),{discoveryRequest}=await import('../src/discovery.js');await assert.rejects(discoveryRequest(state,{command:'approve',cwd:pendingRoot,confirm:true,create:true}),/Ask whether to join/);assert.equal(host.command({command:'list'}).projects.length,1);
});
test('plugin: consent before sharing, native capture, linked agent handoff, a separate client and pause',async t=>{
 const base=mkdtempSync(join(tmpdir(),'spool-plugin-')),state=join(base,'alice'),root=repository(base,'checkout'),host=await startTeamHost(join(base,'host'),{port:0}),desktops=[],clients=[];const oldHome=process.env.CODEX_HOME;process.env.CODEX_HOME=join(base,'codex');mkdirSync(process.env.CODEX_HOME);
 t.after(async()=>{if(oldHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=oldHome;for(const client of clients)await client.close();for(const service of desktops)await service.close();await host.close();rmSync(base,{recursive:true,force:true});});
 const history={close(){},async read(_root,onMessage){return {threads:1,messages:await onMessage({source:'codex-history',sessionId:'saved-session',turnId:'saved-turn',itemId:'saved-message',role:'assistant',text:'PLUGIN-CAPTURE-582: the shipping fee is doubled',harness:'codex'})};}};
 desktops.push(await startDesktop(state,{port:0,history}));const ws=new WorkspaceClient(state);await ws.run({command:'connect',link:host.command({command:'workspace-init',name:'Team'}).link,device:'Alice'});
 const client=mcp(state,root);clients.push(client);await client.call('initialize');const tools=await client.call('tools/list');assert.ok(tools.result.tools.some(t=>t.name==='spool_setup'));
 const input={cwd:root,session_id:'plugin-session-a',turn_id:'normal-turn',prompt:'Please investigate the shipping fee'};
 const pending=await runDiscoveryHook({directory:state,event:'UserPromptSubmit',input,plugin:true});assert.match(pending.hookSpecificOutput.additionalContext,/spool_setup/);assert.ok(!pending.hookSpecificOutput.additionalContext.includes('discovery approve'));
 assert.equal((await client.tool('spool_setup',{action:'status'})).structuredContent.status,'pending');
 assert.equal((await client.tool('spool_setup',{action:'connect',create:true,name:'Game'})).isError,true);assert.equal(host.command({command:'list'}).projects.length,0);assert.ok(!existsSync(join(state,'p/project.json')));
 const connected=await client.tool('spool_setup',{action:'connect',create:true,name:'Game',confirm:true});assert.equal(connected.isError,false);assert.equal(connected.structuredContent.status,'enrolled');assert.equal(connected.structuredContent.capture.enabled,true);assert.ok(!existsSync(join(root,'.codex/config.toml')));
 const capture=await client.tool('memory_search',{query:'PLUGIN-CAPTURE-582',kinds:['conversation']});assert.equal(capture.structuredContent.results[0].source.sessionId,'saved-session');assert.equal(capture.structuredContent.results.length,1);
 const prompted=await runDiscoveryHook({directory:state,event:'UserPromptSubmit',input,plugin:true}),taskId=/Task for this Codex session: ([\w-]+)/.exec(prompted.hookSpecificOutput.additionalContext)[1];
 assert.deepEqual(await runDiscoveryHook({directory:state,event:'Stop',input,plugin:true}),{});
 const finding=(await client.tool('remember',{taskId,kind:'finding',title:'Shipping finding',text:'Verified fee fixture doubles the charge',refs:[capture.structuredContent.results[0].id]})).structuredContent;
 const handoff=(await client.tool('handoff',{taskId,title:'Continue shipping fix',text:'Check the cited finding and add a regression',nextSteps:['Write regression'],refs:[finding.id]})).structuredContent;
 assert.ok(handoff?.id);assert.deepEqual(await runDiscoveryHook({directory:state,event:'Stop',input,plugin:true}),{});
 const fetched=(await client.tool('memory_get',{id:handoff.id})).structuredContent;assert.equal(fetched.sessionId,input.session_id);assert.equal(fetched.refs[0],finding.id);
 const invitation=await ws.run({command:'invite-project',room:connected.structuredContent.room,label:'Bob'}),stateB=join(base,'bob'),rootB=repository(base,'peer');desktops.push(await startDesktop(stateB,{port:0,history}));const peer=mcp(stateB,rootB);clients.push(peer);await peer.call('initialize');assert.equal((await peer.tool('spool_setup',{action:'connect',invitation:invitation.link,confirm:true})).isError,false);
 assert.equal((await peer.tool('memory_get',{id:handoff.id})).structuredContent.refs[0],finding.id);assert.match(JSON.stringify((await peer.tool('project_context')).structuredContent),/Continue shipping fix/);
 const paused=await client.tool('spool_setup',{action:'pause'});assert.equal(paused.structuredContent.capture.enabled,false);assert.deepEqual(await runDiscoveryHook({directory:state,event:'UserPromptSubmit',input:{...input,turn_id:'paused-turn'},plugin:true}),{});assert.equal((await client.tool('spool_setup',{action:'resume'})).isError,true);
 assert.equal(host.relay.engine.db.prepare("SELECT count(*) AS n FROM shard_changes WHERE doc LIKE 'f:%'").get().n,0);
});
test('plugin migration keeps old integration until hook review, backs up managed blocks and preserves unrelated config',async t=>{
 const base=mkdtempSync(join(tmpdir(),'spool-plugin-migrate-')),root=repository(base,'repo'),state=join(base,'state'),home=join(base,'codex');mkdirSync(state);mkdirSync(home);writeFileSync(join(home,'config.toml'),'model_verbosity = "low"\n');installDiscovery(state,{codexHome:home});installCodex({directory:state,root,room:'test-room'});const files=[join(home,'config.toml'),join(root,'.codex/config.toml')],before=files.map(p=>readFileSync(p,'utf8'));
 t.after(()=>rmSync(base,{recursive:true,force:true}));const options={state,root,pluginRoot:base,codexHome:home};await assert.rejects(()=>migrateLegacy({...options,trust:async()=>true}),/approval/);
 const blocked=await migrateLegacy({...options,confirm:true,trust:async()=>false});assert.equal(blocked.needsHookReview,true);assert.deepEqual(files.map(p=>readFileSync(p,'utf8')),before);
 const result=await migrateLegacy({...options,confirm:true,trust:async()=>true});assert.equal(result.changed.length,2);assert.equal(readFileSync(files[0],'utf8').trim(),'model_verbosity = "low"');for(let i=0;i<2;i++){assert.equal(readFileSync(result.changed[i].backup,'utf8'),before[i]);assert.ok(!readFileSync(files[i],'utf8').includes('BEGIN SPOOL'));}assert.equal((await migrateLegacy({...options,confirm:true,trust:async()=>false})).changed.length,0);
});
test('plugin starts its companion on a fresh machine without a separate install and releases its lease',async t=>{
 const base=mkdtempSync(join(tmpdir(),'spool-plugin-fresh-')),root=repository(base,'repo'),state=join(base,'state');let client,peer;
 t.after(async()=>{await client?.close();await peer?.close();const service=join(state,'service.json');if(existsSync(service)){const pid=JSON.parse(readFileSync(service)).pid;try{process.kill(pid,'SIGTERM');}catch{}}rmSync(base,{recursive:true,force:true});});
 client=mcp(state,root);peer=mcp(state,root);await Promise.all([client.call('initialize'),peer.call('initialize')]);const setup=await client.tool('spool_setup',{action:'status'});assert.equal(setup.structuredContent.status,'pending');assert.ok(existsSync(join(state,'discovery.sock')));assert.ok(!existsSync(join(state,'p/project.json')));
 await client.close();client=null;assert.equal((await import('node:fs')).readdirSync(join(state,'plugin-leases')).length,1);assert.equal((await peer.tool('spool_setup',{action:'status'})).structuredContent.status,'pending');await peer.close();peer=null;assert.equal((await import('node:fs')).readdirSync(join(state,'plugin-leases')).length,0);
});

test('Codex setup connects and switches saved workspaces without a Git folder or terminal setup',async t=>{
 const base=mkdtempSync(join(tmpdir(),'spool-workspace-chat-')),state=join(base,'client'),noRepo=join(base,'no-repo');mkdirSync(noRepo);
 const hostA=await startTeamHost(join(base,'host-a'),{port:0}),hostB=await startTeamHost(join(base,'host-b'),{port:0}),history={close(){},async read(){return {threads:0,messages:0};}},desktop=await startDesktop(state,{port:0,history});let client;
 t.after(async()=>{await client?.close();await desktop.close();await hostA.close();await hostB.close();rmSync(base,{recursive:true,force:true});});
 const admin=new WorkspaceClient(join(base,'admin'));await admin.run({command:'connect',link:hostA.command({command:'workspace-init',name:'Acme'}).link,device:'Admin'});const project=(await admin.run({command:'create',name:'Game',requestId:'game'})).project;
 const inviteA=await admin.run({command:'invite-member',label:'Codex',role:'writer',canCreate:false}),inviteB=hostB.command({command:'workspace-init',name:'Studio'}).link;
 client=mcp(state,noRepo);await client.call('initialize');const setup=args=>client.tool('spool_setup',args);
 assert.equal((await setup({action:'workspace_status'})).structuredContent.connected,false);
 assert.equal((await setup({action:'workspace_preview',invitation:inviteA.link})).structuredContent.workspace.name,'Acme');assert.ok(!existsSync(join(state,'workspace.json')));
 assert.equal((await setup({action:'workspace_connect',invitation:inviteA.link})).isError,true);
 const connected=await setup({action:'workspace_connect',invitation:inviteA.link,confirm:true});assert.equal(connected.structuredContent.workspace.name,'Acme');assert.equal(connected.structuredContent.requiresProjectApproval,true);assert.ok(!existsSync(join(state,'p/project.json')));assert.ok(!JSON.stringify(connected).includes(inviteA.link));
 const root=repository(base,'game');await admin.run({command:'repository-enroll',repositoryKey:(await import('../src/repository.js')).repositoryAt(root).repositoryKey,room:project.room});assert.equal((await setup({action:'connect',root,project:'Game',confirm:true})).structuredContent.status,'enrolled');const before=(await setup({action:'status',root})).structuredContent;assert.equal(before.relay,hostA.origin);
 assert.equal((await setup({action:'workspace_connect',invitation:inviteB,confirm:true})).structuredContent.workspace.name,'Studio');
 assert.equal((await setup({action:'workspace_sharing'})).structuredContent.sharing.conversations,true);assert.equal((await setup({action:'workspace_sharing',sharing:{conversations:false},expectedRevision:0})).isError,true);assert.equal((await setup({action:'workspace_sharing',sharing:{conversations:false},expectedRevision:0,confirm:true})).structuredContent.sharing.conversations,false);
 const studioClient=new WorkspaceClient(state);await studioClient.run({command:'create',name:'Studio project',requestId:'studio-project'});assert.equal((await setup({action:'project_sharing',project:'Studio project'})).structuredContent.overrides.findings,null);assert.equal((await setup({action:'project_sharing',project:'Studio project',sharing:{findings:false},expectedRevision:0})).isError,true);assert.equal((await setup({action:'project_sharing',project:'Studio project',sharing:{findings:false},expectedRevision:0,confirm:true})).structuredContent.sharing.findings,false);assert.equal((await setup({action:'project_sharing',project:'Studio project',sharing:{findings:null},expectedRevision:1,confirm:true})).structuredContent.sharing.findings,true);
 const saved=(await setup({action:'workspace_status'})).structuredContent;assert.equal(saved.workspaces.length,2);assert.equal(saved.workspaces.find(p=>p.active).name,'Studio');const token=JSON.parse(readFileSync(join(state,'workspace.json'))).token;assert.ok(!JSON.stringify(saved).includes(token));
 assert.equal((await setup({action:'workspace_switch',workspace:'Acme'})).isError,true);assert.equal((await setup({action:'workspace_status'})).structuredContent.workspace.name,'Studio');
 const switched=await setup({action:'workspace_switch',workspace:'Acme',confirm:true});assert.equal(switched.structuredContent.workspace.name,'Acme');assert.ok(switched.structuredContent.projects.some(p=>p.room===project.room));
 await client.close();client=mcp(state,noRepo);await client.call('initialize');const restarted=(await client.tool('spool_setup',{action:'workspace_status'})).structuredContent;assert.equal(restarted.workspace.name,'Acme');assert.equal(restarted.workspaces.length,2);
 assert.equal((await client.tool('spool_setup',{action:'workspace_switch',workspace:'Studio',confirm:true})).structuredContent.workspace.name,'Studio');const after=(await client.tool('spool_setup',{action:'status',root})).structuredContent;assert.equal(after.projectId,before.projectId);assert.equal(after.relay,hostA.origin);
 const member=(await admin.run({command:'list'})).members.find(m=>m.label===hostnameForTest());await admin.run({command:'revoke-member',memberId:member.id});assert.equal((await client.tool('spool_setup',{action:'workspace_switch',workspace:'Acme',confirm:true})).isError,true);assert.equal((await client.tool('spool_setup',{action:'workspace_status'})).structuredContent.workspace.name,'Studio');
 // Even an enrolled checkout must lose discovery authorization if its repository identity changes.
 execFileSync('git',['-C',root,'remote','set-url','origin','https://example.test/team/different']);
 const changed=(await client.tool('spool_setup',{action:'status',root})).structuredContent;assert.equal(changed.status,'pending');assert.equal(changed.projectId,undefined);assert.equal((await client.tool('project_context')).isError,true);
 function hostnameForTest(){return (JSON.parse(readFileSync(join(state,'workspace-profiles',saved.workspaces.find(p=>p.name==='Acme').id+'.json')))).member.label;}
});

test('historical analysis is an explicit persistent choice, reads private local pages and completes only with a project handoff',async t=>{
 const base=mkdtempSync(join(tmpdir(),'spool-plugin-retrospective-')),state=join(base,'state'),root=repository(base,'repo'),host=await startTeamHost(join(base,'host'),{port:0});let client;
 const history={close(){},async read(_root,onMessage){let messages=0;for(let i=0;i<3;i++)messages+=await onMessage({source:'codex-history',sessionId:'historical-session',turnId:'turn-'+i,itemId:'item-'+i,role:'assistant',text:'PRIVATE-RETRO-'+i+' historical evidence',harness:'codex'});return {threads:1,messages};}};
 const desktop=await startDesktop(state,{port:0,history});t.after(async()=>{await client?.close();await desktop.close();await host.close();rmSync(base,{recursive:true,force:true});});
 const ws=new WorkspaceClient(state);await ws.run({command:'connect',link:host.command({command:'workspace-init',name:'Team'}).link,device:'Owner'});await ws.run({command:'sharing',sharing:{conversations:false},expectedRevision:0});
 client=mcp(state,root);await client.call('initialize');const setup=args=>client.tool('spool_setup',args);
 const connected=(await setup({action:'connect',create:true,name:'Game',confirm:true})).structuredContent;assert.equal(connected.requiresRetrospectiveChoice,true);assert.equal(connected.retrospective.status,'offered');
 assert.equal((await setup({action:'history'})).isError,true);
 assert.equal((await client.tool('history_read',{})).isError,true);
 assert.equal((await client.tool('history_complete',{handoffId:'not-a-handoff'})).isError,true);
 const inventory=(await client.call('tools/list')).result.tools;assert.equal(inventory.find(t=>t.name==='history_read').annotations.readOnlyHint,true);assert.equal(inventory.find(t=>t.name==='history_complete').annotations.destructiveHint,false);
 assert.equal((await setup({action:'retrospective',analyzeExisting:true})).isError,true);
 assert.equal((await setup({action:'retrospective',analyzeExisting:false,confirm:true})).structuredContent.retrospective.status,'declined');
 assert.equal((await setup({action:'history'})).isError,true);
 const prompt={cwd:root,session_id:'retro-session',turn_id:'first',prompt:'Inspect the project'};
 assert.ok(!(await runDiscoveryHook({directory:state,event:'UserPromptSubmit',input:prompt,plugin:true})).hookSpecificOutput.additionalContext.includes('Ask one optional clarifying'));
 const choice=(await setup({action:'retrospective',analyzeExisting:true,confirm:true})).structuredContent;assert.equal((await setup({action:'retrospective',analyzeExisting:true,confirm:true})).structuredContent.retrospective.chosenAt,choice.retrospective.chosenAt);
 const guidance=await runDiscoveryHook({directory:state,event:'UserPromptSubmit',input:prompt,plugin:true});assert.match(guidance.hookSpecificOutput.additionalContext,/Historical analysis was explicitly approved/);
 const page=(await client.tool('history_read',{limit:2})).structuredContent;assert.equal(page.sourceScope,'local-only');assert.equal(page.results.length,2);assert.equal(page.nextOffset,2);assert.equal(page.total,3);
 const last=(await client.tool('history_read',{offset:page.nextOffset,limit:2})).structuredContent;assert.equal(last.results.length,1);assert.equal(last.nextOffset,null);assert.equal(new Set([...page.results,...last.results].map(r=>r.id)).size,3);
 assert.match((await setup({action:'history',recordId:page.results[0].id})).structuredContent.text,/PRIVATE-RETRO/);
 host.relay.memory.index(connected.room);assert.equal(host.relay.engine.db.prepare("SELECT count(*) AS n FROM memory_docs WHERE room=? AND kind='conversation'").get(connected.room).n,0);
 const finding=(await client.tool('remember',{kind:'finding',title:'Retrospective finding',text:'Historical behavior needs a new verification; raw text omitted.'})).structuredContent;
 assert.equal((await setup({action:'retrospective',handoffId:finding.id,confirm:true})).isError,true);
 await client.tool('task_update',{taskId:'historical-review',expectedRevision:0,status:'in_progress',title:'Historical review',text:'Review approved local snapshot'});
 const handoff=(await client.tool('handoff',{taskId:'historical-review',title:'Historical review finished',text:'Distilled existing evidence; application tests not rerun.',nextSteps:['Recheck historical behavior before new implementation'],refs:[finding.id]})).structuredContent;
 assert.equal((await client.tool('history_complete',{handoffId:handoff.id})).structuredContent.retrospective.status,'completed');
 assert.equal((await setup({action:'history'})).isError,true);
 await client.close();client=mcp(state,root);await client.call('initialize');assert.equal((await setup({action:'status'})).structuredContent.retrospective.status,'completed');
 host.relay.memory.index(connected.room);assert.equal(host.relay.engine.db.prepare("SELECT count(*) AS n FROM memory_docs WHERE room=? AND kind='conversation'").get(connected.room).n,0);assert.equal((await client.tool('memory_get',{id:handoff.id})).structuredContent.refs[0],finding.id);
});
