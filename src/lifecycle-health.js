import {readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
// Configuration/trust is not proof that an existing chat loaded the hooks.
export function lifecycleHealth(directory,root){
 let files;try{files=readdirSync(join(directory,'lifecycle'));}catch(error){if(error.code==='ENOENT')return {status:'not_observed',sessions:0,lastPromptAt:null};throw error;}
 let sessions=0,lastPromptAt=null;
 for(const file of files){if(!/^[a-f0-9]{64}(?:-[a-f0-9]{16})?\.json$/.test(file))continue;let state;try{state=JSON.parse(readFileSync(join(directory,'lifecycle',file),'utf8'));}catch{continue;}
  if(state.root!==root||state.ignored||!state.guidanceSent)continue;sessions++;
  // Older state has startedAt but no explicit successful-delivery timestamp.
  if(state.lastPromptAt&&Number.isFinite(Date.parse(state.lastPromptAt))&&(!lastPromptAt||Date.parse(state.lastPromptAt)>Date.parse(lastPromptAt)))lastPromptAt=state.lastPromptAt;
 }
 return {status:lastPromptAt?'observed':sessions?'session_only':'not_observed',sessions,lastPromptAt};
}
export function lifecycleMessage(health){return health.status==='observed'?'Prompt-hook delivery was last observed at '+health.lastPromptAt+'. This does not guarantee that every chat saved structured memory.':'No successful prompt-hook delivery has been observed for this checkout. Capture can still work independently. Open a new Codex chat with SpoolDB enabled and its hooks reviewed; existing chats may not have loaded the integration.';}
