import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync,cpSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {packagePlugin} from '../src/plugin/package.js';
import {prepareStableHooks,installStableHooks,hookProfile} from '../src/plugin/stable-hooks.js';
import {CodexRpc} from '../src/codex-rpc.js';
let codex=true;try{execFileSync('codex',['--version'],{stdio:'ignore'});}catch{codex=false;}
test('native bundle changes require review; stable dispatchers and tamper detection remain enforced',{skip:!codex,timeout:60000},async t=>{
 const base=mkdtempSync(join(tmpdir(),'spool-stable-trust-')),home=join(base,'codex'),root=join(base,'repo'),state=join(base,'state'),marketplace=join(base,'market');mkdirSync(root);mkdirSync(home);execFileSync('git',['init','-q',root]);
 const {plugin}=packagePlugin({app:process.cwd(),destination:marketplace});const env={...process.env,CODEX_HOME:home,SPOOL_STATE:state,XDG_DATA_HOME:join(base,'data'),XDG_CONFIG_HOME:join(base,'config'),XDG_STATE_HOME:join(base,'xdg-state')};
 const run=args=>JSON.parse(execFileSync('codex',args,{env,stdio:'pipe',timeout:20000}));run(['plugin','marketplace','add',marketplace,'--json']);let installed=run(['plugin','add','spooldb@spooldb','--json']),rpc;
 t.after(()=>{rpc?.close();if(existsSync(join(state,'service.json')))try{process.kill(JSON.parse(readFileSync(join(state,'service.json'))).pid,'SIGTERM');}catch{}rmSync(base,{recursive:true,force:true});});
 const list=async()=>{rpc?.close();rpc=new CodexRpc({cwd:root,env});await rpc.start();return (await rpc.request('hooks/list',{cwds:[root]})).data[0].hooks.filter(h=>h.pluginId==='spooldb@spooldb');};
 const originalInstalledPath=installed.installedPath;const profile=installStableHooks(installed.installedPath,{data:env.XDG_DATA_HOME});const original=await list();assert.equal(original.length,4);assert.ok(original.every(h=>h.trustStatus==='untrusted'));
 // Emulate review ONLY in this disposable Codex home. Production code never writes trust hashes.
 assert.ok(home.startsWith(base+'/'));await rpc.request('config/batchWrite',{edits:original.map(h=>({keyPath:`hooks.state.${JSON.stringify(h.key)}.trusted_hash`,value:h.currentHash,mergeStrategy:'replace'})),reloadUserConfig:true});assert.ok((await list()).every(h=>h.trustStatus==='trusted'));
 const bump=version=>{const path=join(plugin,'.codex-plugin/plugin.json'),manifest=JSON.parse(readFileSync(path));manifest.version=version;writeFileSync(path,JSON.stringify(manifest));const mcpPath=join(plugin,'mcp.json'),mcp=JSON.parse(readFileSync(mcpPath));mcp.mcpServers.spooldb.args=mcp.mcpServers.spooldb.args.map(arg=>arg.replace(/\/spooldb\/\d+\.\d+\.\d+/g,'/spooldb/'+version));writeFileSync(mcpPath,JSON.stringify(mcp));};
 const icon=join(plugin,'assets/icon.svg');writeFileSync(icon,readFileSync(icon,'utf8').replace('#E6B99D','#e6b99d'));const css=join(plugin,'app/src/review/public/style.css');writeFileSync(css,readFileSync(css,'utf8')+'\n/* UI-only update */\n');bump('99.1.0');const unchanged=prepareStableHooks(plugin);assert.equal(unchanged.fingerprint,profile.fingerprint);installed=run(['plugin','add','spooldb@spooldb','--json']);
 let upgraded=await list();assert.deepEqual(upgraded.map(h=>[h.key,h.command]),original.map(h=>[h.key,h.command]));assert.ok(upgraded.every(h=>h.trustStatus==='modified'));assert.ok(upgraded.every((h,i)=>h.currentHash!==original[i].currentHash));
 // Current Codex fingerprints the full bundle, including UI assets. Review is
 // simulated only inside this disposable home; production never transfers trust.
 await rpc.request('config/batchWrite',{edits:upgraded.map(h=>({keyPath:`hooks.state.${JSON.stringify(h.key)}.trusted_hash`,value:h.currentHash,mergeStrategy:'replace'})),reloadUserConfig:true});upgraded=await list();assert.ok(upgraded.every(h=>h.trustStatus==='trusted'));assert.ok(upgraded.every(h=>h.sourcePath.includes('/99.1.0/')));
 assert.equal(installStableHooks(installed.installedPath,{data:env.XDG_DATA_HOME}).path,profile.path);
 const payload=JSON.stringify({cwd:root,session_id:'stable-hook-proof',hook_event_name:'SessionStart'}),dispatch=()=>execFileSync('sh',['-c',upgraded[0].command],{env:{...env,PLUGIN_ROOT:installed.installedPath},input:payload,encoding:'utf8',timeout:15000,stdio:['pipe','pipe','pipe']});
 const output=JSON.parse(dispatch());assert.match(output.hookSpecificOutput.additionalContext,/ask ONE clarifying question/);assert.ok(!existsSync(join(state,'p/project.json')));
 const tamper=join(installed.installedPath,'app/src/codex-hooks.js');writeFileSync(tamper,readFileSync(tamper,'utf8')+'\n/* Changed executable hook */\n');assert.throws(dispatch,error=>/hook code changed or is incomplete/.test(error.stderr?.toString()??''));
 const actualHook=join(plugin,'app/src/codex-hooks.js');writeFileSync(actualHook,readFileSync(actualHook,'utf8')+'\n/* Changed executable hook */\n');bump('99.2.0');const changed=prepareStableHooks(plugin);assert.notEqual(changed.fingerprint,profile.fingerprint);installed=run(['plugin','add','spooldb@spooldb','--json']);const changedHooks=await list();assert.ok(changedHooks.every(h=>h.trustStatus==='modified'));assert.ok(changedHooks.every((h,i)=>h.currentHash!==original[i].currentHash));
 // Reusing an identity must never overwrite a modified approved dispatcher.
 writeFileSync(join(profile.path,'run.sh'),'modified');assert.throws(()=>installStableHooks(originalInstalledPath,{data:env.XDG_DATA_HOME}));
});
