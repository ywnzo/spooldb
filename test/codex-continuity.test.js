import {lifecycleHealth} from '../src/lifecycle-health.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {runHook} from '../src/codex-hooks.js';
import {installCodex} from '../src/codex-install.js';
test('project installer preserves existing config and hooks, is repeatable and backs up before edits',t=>{
 const base=mkdtempSync(join(tmpdir(),'tw-install-')),root=join(base,'repo'),directory=join(base,'state');mkdirSync(root);mkdirSync(directory);mkdirSync(join(root,'.codex'));t.after(()=>rmSync(base,{recursive:true,force:true}));
 const path=join(root,'.codex/config.toml'),before='model_verbosity = "medium"\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "echo existing"\n';writeFileSync(path,before);
 const first=installCodex({root,directory,room:'room-test'});assert.equal(first.changed,true);const config=readFileSync(path,'utf8');assert.ok(config.startsWith(before));assert.ok(config.includes('mcp_servers.spool'));assert.ok(config.includes('echo existing'));assert.equal(installCodex({root,directory,room:'room-test'}).changed,false);
 // Validate actual TOML, including arrays of hook groups, instead of string snapshots alone.
 const parsed=JSON.parse(execFileSync('python3',['-c','import tomllib,json,sys; print(json.dumps(tomllib.load(open(sys.argv[1],"rb"))))',path],{encoding:'utf8'}));assert.equal(parsed.hooks.Stop.length,2);assert.equal(parsed.hooks.SessionStart.length,1);assert.equal(parsed.model_verbosity,'medium');
});
test('hooks provide optional guidance without consulting memory or gating the turn', async t => {
 const base=mkdtempSync(join(tmpdir(),'spool-advisory-'));t.after(()=>rmSync(base,{recursive:true,force:true}));
 let requests=0;
 const request=()=>{requests++;throw Error('The companion is offline');};
 const options={directory:base,root:base,request,parentRequest:request};
 const input={cwd:base,session_id:'session',turn_id:'turn',prompt:'private prompt',last_assistant_message:'private reply'};
 for(const event of ['SessionStart','UserPromptSubmit']){
  const output=await runHook({...options,event,input});
  assert.deepEqual(Object.keys(output),['hookSpecificOutput']);
  assert.match(output.hookSpecificOutput.additionalContext,/SpoolDB is optional/);
  assert.match(output.hookSpecificOutput.additionalContext,/explicit user approval/);
  assert.doesNotMatch(output.hookSpecificOutput.additionalContext,/private prompt|private reply|project_memory_data/);
 }
 for(const event of ['Stop','Interrupt'])assert.deepEqual(await runHook({...options,event,input}),{});
 assert.equal(requests,0);
 assert.equal(lifecycleHealth(base,base).status,'observed');
});

test('app-generated composer prompts receive no memory guidance', async t => {
 const base=mkdtempSync(join(tmpdir(),'spool-composer-'));t.after(()=>rmSync(base,{recursive:true,force:true}));
 const input={cwd:base,session_id:'composer',prompt:'This is an app-generated request for a suggested next user message. The user did not write this message.'};
 assert.deepEqual(await runHook({directory:base,root:base,event:'UserPromptSubmit',input}),{});
 assert.equal(lifecycleHealth(base,base).status,'not_observed');
});
