import {existsSync,readFileSync,writeFileSync,mkdirSync,renameSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {CodexRpc} from './codex-rpc.js';
const begin='# BEGIN SPOOL DISCOVERY',end='# END SPOOL DISCOVERY';
const shell=s=>"'"+s.replaceAll("'","'\\''")+"'";
export function installDiscovery(directory,{codexHome=process.env.CODEX_HOME??join(homedir(),'.codex')}={}){
 mkdirSync(codexHome,{recursive:true,mode:0o700});const path=join(codexHome,'config.toml'),before=existsSync(path)?readFileSync(path,'utf8'):'';
 const start=before.indexOf(begin),stop=before.indexOf(end);if((start<0)!==(stop<0))throw new Error('Incomplete SpoolDB discovery configuration');
 const prior=start<0?before:before.slice(0,start)+before.slice(stop+end.length).replace(/^\n/,'');
 if(/^\s*\[mcp_servers\.spool\]/m.test(prior))throw new Error('A user-managed spool MCP server already exists; it was left unchanged');
 const commands={};let block=`${begin}\n[mcp_servers.spool]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([fileURLToPath(new URL('./memory-mcp.js',import.meta.url)),directory,'--discover'])}\nstartup_timeout_sec = 30\ntool_timeout_sec = 60\n`;
 for(const event of ['SessionStart','UserPromptSubmit','Stop','Interrupt']){commands[event]=[process.execPath,fileURLToPath(new URL('./discovery-hook.js',import.meta.url)),directory,event].map(shell).join(' ');block+=`\n[[hooks.${event}]]\n[[hooks.${event}.hooks]]\ntype = "command"\ncommand = ${JSON.stringify(commands[event])}\ntimeout = ${event==='Interrupt'?3:60}\n${['SessionStart','UserPromptSubmit'].includes(event)?'additionalContextLimit = 7000\n':''}`;}
 const after=prior.trimEnd()+'\n\n'+block+end+'\n';if(after!==before){mkdirSync(join(directory,'integration-backups'),{recursive:true,mode:0o700});writeFileSync(join(directory,'integration-backups','global-codex-'+Date.now()+'.toml'),before,{mode:0o600});writeFileSync(path+'.spool-tmp',after,{mode:0o600});renameSync(path+'.spool-tmp',path);}
 return {path,commands,changed:after!==before};
}
export async function enableDiscovery(directory,options={}){
 const installed=installDiscovery(directory,options),rpc=new CodexRpc({cwd:homedir()});
 try{await rpc.start();const list=async()=>{const result=await rpc.request('hooks/list',{cwds:[homedir()]});return result.data.find(e=>e.cwd===homedir());};const before=await list();if(before.errors?.length)throw new Error('Hook configuration has errors');
 const own=before.hooks.filter(h=>h.sourcePath===installed.path&&Object.values(installed.commands).includes(h.command));if(own.length!==4)throw new Error('Expected four global discovery hooks');
 const edits=own.filter(h=>h.trustStatus!=='trusted').map(h=>({keyPath:`hooks.state.${JSON.stringify(h.key)}.trusted_hash`,value:h.currentHash,mergeStrategy:'replace'}));if(edits.length)await rpc.request('config/batchWrite',{edits,reloadUserConfig:true});
 const after=await list();if(!own.every(h=>after.hooks.some(a=>a.key===h.key&&a.currentHash===h.currentHash&&a.trustStatus==='trusted')))throw new Error('Discovery hook trust verification failed');return {configured:true,trusted:true,config:installed.path,restartRequired:true};
 }finally{rpc.close();}
}
