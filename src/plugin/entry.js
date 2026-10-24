import {installStableHooks} from './stable-hooks.js';
import {fileURLToPath} from 'node:url';
import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {pluginState} from './state.js';
import {ensureCompanion} from './companion.js';
process.umask(0o077);
const [mode,...args]=process.argv.slice(2),state=pluginState(),app=fileURLToPath(new URL('../',import.meta.url));
try{
 const pluginRoot=fileURLToPath(new URL('../../../',import.meta.url));if(mode==='mcp'&&existsSync(join(pluginRoot,'.codex-plugin/plugin.json')))installStableHooks(pluginRoot);
 const companion=await ensureCompanion(state,{timeout:mode==='hook'&&args[0]==='Interrupt'?1500:20000});
 const release=()=>companion.release();process.once('exit',release);
 if(mode==='mcp'){
  const child=spawn(process.execPath,[join(app,'memory-mcp.js'),state,'--discover','--plugin'],{stdio:'inherit',env:{...process.env,SPOOL_PLUGIN_ROOT:fileURLToPath(new URL('../../../',import.meta.url))}});
  for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));child.on('error',error=>{console.error(error.message);release();process.exitCode=1;});child.on('exit',code=>{release();process.exitCode=code??1;});
 }else if(mode==='hook'){
  const {runDiscoveryHook}=await import('../discovery-hook.js');let text='';for await(const chunk of process.stdin){text+=chunk;if(Buffer.byteLength(text)>1000000)throw Error('Hook input too large');}
  const result=await runDiscoveryHook({directory:state,event:args[0],input:JSON.parse(text),plugin:true});console.log(JSON.stringify(result));release();
 }else if(mode==='status'){
  const {pluginSetup}=await import('./setup.js');console.log(JSON.stringify(await pluginSetup(state,{action:'status'})));release();
 }else throw Error('Unknown plugin entry mode');
}catch(error){if(mode==='hook')console.log(JSON.stringify(/not a git repository|rev-parse/.test(error.message)?{}:{systemMessage:'SpoolDB plugin unavailable: '+error.message}));else{console.error('SpoolDB plugin unavailable: '+error.message);process.exitCode=1;}}
