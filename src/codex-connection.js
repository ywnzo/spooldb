import {lifecycleHealth,lifecycleMessage} from './lifecycle-health.js';
import {CodexRpc} from './codex-rpc.js';
import {readFileSync,realpathSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {homedir} from 'node:os';
import {installDiscovery} from './discovery-install.js';
import {legacyFiles} from './plugin/legacy.js';
const events=new Set(['sessionStart','userPromptSubmit','stop','interrupt']);
const shell=value=>"'"+value.replaceAll("'","'\\''")+"'";
function spoolPlugin(hook){
 if(hook.source!=='plugin'||!hook.sourcePath||!hook.sourcePath.endsWith('/hooks/hooks.json'))return false;
 try{return JSON.parse(readFileSync(join(dirname(dirname(hook.sourcePath)),'.codex-plugin/plugin.json'),'utf8')).name==='spooldb';}catch{return false;}
}
export async function codexMemoryState({root,directory,discoveryDirectory=directory,codexHome=process.env.CODEX_HOME??join(homedir(),'.codex')},{rpcFactory=options=>new CodexRpc(options)}={}){
 root=realpathSync(root);const rpc=rpcFactory({cwd:root});
 try{
  await rpc.start();const response=await rpc.request('hooks/list',{cwds:[root]}),data=response.data?.find(entry=>entry.cwd===root);
  if(data?.errors?.length)return {configured:false,ready:false,trusted:false,configurationError:true,message:'Codex reports hook configuration errors. Review its hook settings before connecting SpoolDB.'};
  const plugin=(data?.hooks??[]).filter(spoolPlugin),global=(data?.hooks??[]).filter(h=>h.sourcePath===join(codexHome,'config.toml')&&h.command?.includes('/discovery-hook.js')&&h.command.includes(shell(discoveryDirectory))),own=plugin.length?plugin:global,mode=plugin.length?'plugin':global.length?'shared':'none';
  const complete=own.length===4&&new Set(own.map(h=>h.eventName)).size===4&&own.every(h=>events.has(h.eventName)),trusted=complete&&own.every(h=>h.trustStatus==='trusted'),legacy=legacyFiles(root,{codexHome}).filter(path=>mode!=='shared'||path!==join(codexHome,'config.toml')),needsMigration=legacy.length>0,ready=trusted&&!needsMigration;
  let message=ready?'Connected through '+(mode==='plugin'?'the SpoolDB plugin':'the shared Codex integration')+'. New Codex sessions can retrieve context and leave handoffs.':mode==='none'?'No active SpoolDB plugin or shared Codex integration was found. Connect to set up agent memory.':!complete?'SpoolDB has an incomplete or duplicate hook configuration. Review the enabled plugin and hooks in Codex.':'Review the SpoolDB hooks in Codex, then check the connection again.';
  if(needsMigration)message=trusted?'The plugin hooks are ready, but an older managed SpoolDB configuration is also present. Ask Codex to migrate it with backups before starting a new session.':'An older managed SpoolDB configuration is present. Review the plugin hooks, then ask Codex to migrate the old integration with backups.';
  const lifecycle=lifecycleHealth(directory,root);if(ready)message+=' '+lifecycleMessage(lifecycle);
  return {lifecycle,mode,configured:complete,ready,trusted,needsHookReview:complete&&!trusted,needsMigration,legacyConfiguration:legacy,message,restartRequired:needsMigration};
 }finally{rpc.close();}
}
export async function connectCodexMemory(options,{inspect=codexMemoryState,installShared=installDiscovery}={}){
 const state=await inspect(options);if(state.mode!=='none'||state.needsMigration||state.configurationError)return state;
 const directory=realpathSync(options.discoveryDirectory??options.directory),installed=installShared(directory,{codexHome:options.codexHome});
 return {...state,mode:'shared',configured:true,ready:false,trusted:false,needsHookReview:true,config:installed.path,changed:installed.changed,restartRequired:true,message:'Shared Codex connection saved. Review the SpoolDB hooks in Codex, then open a new session. No per-project hooks were added.'};
}
