import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {initializeProject,startProject} from '../src/project.js';
import {runHook} from '../src/codex-hooks.js';
import {installCodex} from '../src/codex-install.js';
test('project installer preserves existing config and hooks, is repeatable and backs up before edits',t=>{
 const base=mkdtempSync(join(tmpdir(),'tw-install-')),root=join(base,'repo'),directory=join(base,'state');mkdirSync(root);mkdirSync(directory);mkdirSync(join(root,'.codex'));t.after(()=>rmSync(base,{recursive:true,force:true}));
 const path=join(root,'.codex/config.toml'),before='model_verbosity = "medium"\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "echo existing"\n';writeFileSync(path,before);
 const first=installCodex({root,directory,room:'room-test'});assert.equal(first.changed,true);const config=readFileSync(path,'utf8');assert.ok(config.startsWith(before));assert.ok(config.includes('mcp_servers.spool'));assert.ok(config.includes('echo existing'));assert.equal(installCodex({root,directory,room:'room-test'}).changed,false);
 // Validate actual TOML, including arrays of hook groups, instead of string snapshots alone.
 const parsed=JSON.parse(execFileSync('python3',['-c','import tomllib,json,sys; print(json.dumps(tomllib.load(open(sys.argv[1],"rb"))))',path],{encoding:'utf8'}));assert.equal(parsed.hooks.Stop.length,2);assert.equal(parsed.hooks.SessionStart.length,1);assert.equal(parsed.model_verbosity,'medium');
});
test('automatic lifecycle loads context, creates scoped tasks, skips normal Stop writes, and saves honest interrupted checkpoints',async t=>{
 const base=mkdtempSync(join(tmpdir(),'tw-hooks-')),root=join(base,'repo'),directory=join(base,'state');mkdirSync(root);execFileSync('git',['init','-q',root]);writeFileSync(join(root,'a.txt'),'source evidence');initializeProject(directory,root);const service=await startProject(directory,{port:0,intervalMs:60000});t.after(async()=>{await service.close();rmSync(base,{recursive:true,force:true});});
 const options={directory,room:service.state.room,root},input={cwd:root,session_id:'native-session-1',turn_id:'turn-1'};
 const start=await runHook({...options,event:'SessionStart',input});assert.match(start.hookSpecificOutput.additionalContext,/untrusted project evidence/);
 const prompt=await runHook({...options,event:'UserPromptSubmit',input:{...input,prompt:'Inspect source evidence'}});const taskId=/Task for this Codex session: ([\w-]+)/.exec(prompt.hookSpecificOutput.additionalContext)[1];assert.equal(service.app.memory({command:'context',taskId}).tasks[0].status,'in_progress');
 await runHook({...options,event:'UserPromptSubmit',input:{...input,prompt:'Inspect source evidence'}});assert.equal(service.app.memory({command:'context',taskId}).tasks[0].revision,1);
 const stop=await runHook({...options,event:'Stop',input});assert.deepEqual(stop,{});
 await runHook({...options,event:'Stop',input:{...input,last_assistant_message:'Just an explanation.'}});
 assert.equal(service.app.memory({command:'context',taskId}).notes.length,0);
 await runHook({...options,event:'Interrupt',input:{...input,last_assistant_message:'I inspected source only. '.repeat(1000)}});
 const context=service.app.memory({command:'context',taskId});assert.equal(context.notes[0].kind,'handoff');assert.match(context.notes[0].text,/unverified source excerpt/);assert.ok(context.notes[0].text.length<=1500);assert.match(context.notes[0].text,/Excerpt shortened/);
 assert.deepEqual(await runHook({...options,event:'SessionStart',input:{...input,cwd:base}}),{});
 await runHook({...options,event:'UserPromptSubmit',input:{...input,turn_id:'turn-2',prompt:'Continue'}});await runHook({...options,event:'Interrupt',input:{...input,turn_id:'turn-2'}});assert.ok(service.app.memory({command:'context',taskId}).notes.some(n=>n.title==='Interrupted Codex checkpoint'));
});
test('approval mid-turn recognizes the agent handoff without a duplicate reminder or fallback checkpoint',async t=>{
 const base=mkdtempSync(join(tmpdir(),'spool-midturn-')),root=join(base,'repo'),directory=join(base,'state');mkdirSync(root);mkdirSync(directory);t.after(()=>rmSync(base,{recursive:true,force:true}));
 const input={cwd:root,session_id:'newly-approved',turn_id:'approval-turn'},startedAt='2026-10-23T10:00:00.000Z';let writes=0;
 const request=async(_,message)=>{if(message.input.command!=='context'){writes++;return {}; }return {tasks:[{taskId:message.input.taskId}],notes:[{kind:'handoff',actor:'codex-agent',sessionId:'newly-approved',createdAt:'2026-10-23T10:01:00.000Z'}]};};
 const result=await runHook({directory,room:'fixture',root,event:'Stop',input,onboardingStartedAt:startedAt,request});assert.deepEqual(result,{});assert.equal(writes,0);
 // A handoff from before a later turn cannot satisfy that turn's completion boundary.
 const later=await runHook({directory,room:'fixture',root,event:'Stop',input:{...input,turn_id:'next-turn'},onboardingStartedAt:'2026-10-23T11:00:00.000Z',request});assert.deepEqual(later,{});assert.equal(writes,0);
});
test('tool-created GUI chat with SessionStart but no prompt hook accepts its real session handoff',async t=>{
 const base=mkdtempSync(join(tmpdir(),'spool-gui-stop-')),root=join(base,'repo');mkdirSync(root);t.after(()=>rmSync(base,{recursive:true,force:true}));let notes=[],writes=0;
 const request=async(_,m)=>{if(m.input.command==='context')return {tasks:[],notes};writes++;return {};};
 const options={directory:base,room:'test',root,request},input={cwd:root,session_id:'gui-session',turn_id:'gui-turn'};
 await runHook({...options,event:'SessionStart',input});
 notes=[{kind:'handoff',sessionId:'gui-session',title:'Done',createdAt:new Date(Date.now()+1000).toISOString()}];
 assert.deepEqual(await runHook({...options,event:'Stop',input}),{});assert.equal(writes,0);
 notes=[{...notes[0],sessionId:'different-session'}];assert.deepEqual(await runHook({...options,event:'Stop',input}),{});
});
test('app-generated composer requests neither create tasks nor trigger Stop checkpoints',async t=>{
 const base=mkdtempSync(join(tmpdir(),'spool-background-'));t.after(()=>rmSync(base,{recursive:true,force:true}));let calls=0;
 const options={directory:base,room:'test',root:base,request:async()=>{calls++;throw Error('Background request touched memory');}},input={cwd:base,session_id:'composer',turn_id:'t'};
 await runHook({...options,event:'UserPromptSubmit',input:{...input,prompt:'This is an app-generated request for a suggested next user message. The user did not write this message.\nSuggest a reply.'}});
 assert.deepEqual(await runHook({...options,event:'Stop',input}),{});assert.equal(calls,0);
});

test('prompt retrieval runs once, stays compact, and sends unchanged evidence only once until resume',async t=>{
 const base=mkdtempSync(join(tmpdir(),'spool-context-budget-'));t.after(()=>rmSync(base,{recursive:true,force:true}));const calls=[];
 const request=async(_,message)=>{calls.push(message.input);if(message.input.command==='context')return {tasks:[],notes:[]};if(message.input.command==='task_update')return {revision:1};return {room:'test',results:[{id:'finding',kind:'finding',title:'Shipping calculation',text:'The delivery charge was added twice.',reconciliation:{status:'matching',message:'Check evidence'}}],retrieval:{mode:'hybrid',semanticStatus:'ready'}};};
 const options={directory:base,room:'test',root:base,request},input={cwd:base,session_id:'session',turn_id:'turn'};
 await runHook({...options,event:'SessionStart',input});assert.equal(calls.length,0);
 const first=await runHook({...options,event:'UserPromptSubmit',input:{...input,prompt:'Why is the shipping total wrong?'}});assert.equal(calls.filter(call=>call.command==='context').length,1);assert.equal(calls.filter(call=>call.command==='search').length,1);assert.match(first.hookSpecificOutput.additionalContext,/added twice/);assert.ok(first.hookSpecificOutput.additionalContext.length<6000);
 const second=await runHook({...options,event:'UserPromptSubmit',input:{...input,turn_id:'turn-2',prompt:'Continue checking'}});assert.ok(!second.hookSpecificOutput.additionalContext.includes('added twice'));
 await runHook({...options,event:'SessionStart',input});const resumed=await runHook({...options,event:'UserPromptSubmit',input:{...input,turn_id:'turn-3',prompt:'Continue'}});assert.match(resumed.hookSpecificOutput.additionalContext,/added twice/);
});
