import {spawn,execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,existsSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {createInterface} from 'node:readline';
import assert from 'node:assert/strict';
const plugin=resolve(process.argv[2]??'work/plugin-marketplace/plugins/spooldb');
const temporary=mkdtempSync(join(tmpdir(),'spool-native-smoke-')),state=join(temporary,'state'),root=join(temporary,'repo');mkdirSync(root);execFileSync('git',['init','-q',root]);
const env={...process.env,PLUGIN_ROOT:plugin,SPOOL_STATE:state,XDG_DATA_HOME:join(temporary,'data'),XDG_CONFIG_HOME:join(temporary,'config'),XDG_STATE_HOME:join(temporary,'xdg-state')};
const child=spawn('sh',[join(plugin,'scripts/spool.sh'),'mcp'],{cwd:root,env,stdio:['pipe','pipe','inherit']});
let sequence=0;const pending=new Map();
createInterface({input:child.stdout}).on('line',line=>{const result=JSON.parse(line);const waiter=pending.get(result.id);if(waiter){pending.delete(result.id);result.error?waiter.reject(Error(JSON.stringify(result.error))):waiter.resolve(result.result);}});
child.on('exit',code=>{for(const waiter of pending.values())waiter.reject(Error('MCP exited: '+code));});
const request=(method,params)=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
const timeout=setTimeout(()=>{child.kill();for(const waiter of pending.values())waiter.reject(Error('MCP smoke test timed out'));},30000);
try{
 await request('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'native-smoke',version:'1'}});
 child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
 const tools=await request('tools/list',{});assert.ok(tools.tools.some(tool=>tool.name==='spool_setup'));
 const status=await request('tools/call',{name:'spool_setup',arguments:{action:'status'}});assert.ok(!status.isError);assert.equal(status.structuredContent.status,'pending');
 assert.equal(existsSync(join(state,'p/project.json')),false);
 const hooks=JSON.parse(readFileSync(join(plugin,'hooks/runtime-profile.json')));
 const dispatcher=join(env.XDG_DATA_HOME,'spool/codex-hooks',hooks.fingerprint,'run.sh');
 const hook=JSON.parse(execFileSync('sh',[dispatcher,'SessionStart'],{cwd:root,env,input:JSON.stringify({cwd:root,session_id:'native-smoke'}),encoding:'utf8',timeout:30000}));
 assert.ok(!/unavailable/i.test(hook.systemMessage??''));
 console.log(JSON.stringify({platform:process.platform+'-'+process.arch,mcp:'ready',hook:'ready',setup:'pending',tools:tools.tools.length}));
}finally{
 clearTimeout(timeout);child.stdin.end();child.kill();
 const service=join(state,'service.json');if(existsSync(service))try{process.kill(JSON.parse(readFileSync(service)).pid,'SIGTERM');}catch{}
 rmSync(temporary,{recursive:true,force:true});
}
