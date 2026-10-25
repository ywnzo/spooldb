import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {packagePlugin} from '../src/plugin/package.js';
import {CodexRpc} from '../src/codex-rpc.js';
let available=true;try{execFileSync('codex',['--version'],{stdio:'ignore'});}catch{available=false;}
test('installed Codex loads packaged skills, four untrusted hooks and a working self-contained MCP server', {skip:!available,timeout:60000},async t=>{
 const base=mkdtempSync(join(tmpdir(),'spool-native-plugin-')),root=join(base,"repo with spaces'"),home=join(base,'codex'),state=join(base,'state'),marketplace=join(base,'marketplace');mkdirSync(root);mkdirSync(home);execFileSync('git',['init','-q',root]);writeFileSync(join(root,'README.md'),'Native plugin fixture');
 packagePlugin({app:process.cwd(),destination:marketplace});const env={...process.env,CODEX_HOME:home,SPOOL_STATE:state,XDG_DATA_HOME:join(base,'data'),XDG_CONFIG_HOME:join(base,'config'),XDG_STATE_HOME:join(base,'xdg-state')},run=args=>execFileSync('codex',args,{env,stdio:'pipe',timeout:20000});run(['plugin','marketplace','add',marketplace,'--json']);const installed=JSON.parse(run(['plugin','add','spooldb@spooldb','--json']));const rpc=new CodexRpc({cwd:root,env});
 t.after(async()=>{rpc.close();if(existsSync(join(state,'service.json')))try{process.kill(JSON.parse(readFileSync(join(state,'service.json'))).pid,'SIGTERM');}catch{}rmSync(base,{recursive:true,force:true});});
 await rpc.start();const detail=(await rpc.request('plugin/read',{pluginName:'spooldb',marketplacePath:join(marketplace,'.agents/plugins/marketplace.json')})).plugin;assert.equal(detail.skills.length,2);assert.equal(detail.onboardingSkill.name,'spooldb:setup');assert.deepEqual(detail.mcpServers,['spooldb']);
 const hooks=(await rpc.request('hooks/list',{cwds:[root]})).data[0];assert.equal(hooks.errors.length,0);assert.equal(hooks.hooks.length,4);assert.deepEqual(hooks.hooks.map(h=>h.statusMessage),['SpoolDB: Load project context','SpoolDB: Retrieve relevant memory','SpoolDB: Save handoff','SpoolDB: Save interrupted checkpoint']);assert.ok(hooks.hooks.every(h=>h.source==='plugin'&&h.trustStatus==='untrusted'&&h.command.includes('/spool/codex-hooks/')&&!h.command.includes(installed.installedPath)));
 const started=await rpc.request('thread/start',{cwd:root,ephemeral:true}),threadId=started.thread.id;let inventory,server;
 for(let attempt=0;attempt<30;attempt++){inventory=await rpc.request('mcpServerStatus/list',{threadId,detail:'toolsAndAuthOnly'});server=inventory.data.find(s=>s.name==='spooldb'&&s.tools?.spool_setup);if(server)break;await new Promise(done=>setTimeout(done,200));}
 assert.ok(server,'Codex must actually launch the cached plugin and initialize its MCP server');assert.equal(Object.keys(server.tools).length,11);
 const result=await rpc.request('mcpServer/tool/call',{threadId,server:'spooldb',tool:'spool_setup',arguments:{action:'status'}});assert.equal(result.isError,false);assert.equal(result.structuredContent.root,root);assert.equal(result.structuredContent.status,'pending');assert.equal(result.structuredContent.hookReviewRequired,true);assert.ok(!existsSync(join(state,'p/project.json')));
});
