import {CodexRpc} from './codex-rpc.js';
import {realpathSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {installCodex} from './codex-install.js';
export async function trustMemoryHooks({root,directory,room}){
root=realpathSync(root);directory=realpathSync(directory);
const shell=value=>"'"+value.replaceAll("'","'\\''")+"'";
const prefix=[process.execPath,fileURLToPath(new URL('./codex-hooks.js',import.meta.url)),directory,room,root].map(shell).join(' ');
const rpc=new CodexRpc({cwd:root});
try{
 await rpc.start();const list=async()=>{const result=await rpc.request('hooks/list',{cwds:[root]});return result.data.find(e=>e.cwd===root);};
 const before=await list();if(before.errors?.length)throw new Error('Hook configuration has errors');
 const own=before.hooks.filter(h=>h.sourcePath===join(root,'.codex/config.toml')&&['sessionStart','userPromptSubmit','stop','interrupt'].includes(h.eventName)&&h.command===prefix+' '+shell({sessionStart:'SessionStart',userPromptSubmit:'UserPromptSubmit',stop:'Stop',interrupt:'Interrupt'}[h.eventName]));
 if(own.length!==4)throw new Error(`Expected exactly four matching SpoolDB hooks, found ${own.length}`);
 const edits=own.filter(h=>h.trustStatus!=='trusted').map(h=>({keyPath:`hooks.state.${JSON.stringify(h.key)}.trusted_hash`,value:h.currentHash,mergeStrategy:'replace'}));
 if(edits.length)await rpc.request('config/batchWrite',{edits,reloadUserConfig:true});
 const after=await list();const verified=own.every(h=>after.hooks.some(a=>a.key===h.key&&a.currentHash===h.currentHash&&a.trustStatus==='trusted'));if(!verified)throw new Error('Hook trust verification failed');
 return {trusted:verified,hooks:own.map(h=>({event:h.eventName,key:h.key,hash:h.currentHash})),project:root};
}finally{rpc.close();}
}
export async function connectCodexMemory(options){const installed=installCodex(options);const trust=await trustMemoryHooks(options);return {...installed,trusted:trust.trusted};}
