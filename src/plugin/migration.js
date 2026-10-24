import {existsSync,readFileSync,mkdirSync,writeFileSync,renameSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {CodexRpc} from '../codex-rpc.js';
import {markers,legacyFiles} from './legacy.js';
export {legacyFiles} from './legacy.js';
export async function trustedPluginHooks(root,pluginRoot){
 const rpc=new CodexRpc({cwd:root});try{await rpc.start();const listed=await rpc.request('hooks/list',{cwds:[root]}),data=listed.data.find(d=>d.cwd===root),source=join(pluginRoot,'hooks/hooks.json');
 const own=data?.hooks.filter(h=>h.sourcePath===source&&(h.command.includes('spool.sh')||h.command.includes('/spool/codex-hooks/')))??[];
 return own.length===4&&own.every(h=>h.trustStatus==='trusted')&&!data.errors?.length;
 }finally{rpc.close();}
}
export async function migrateLegacy({state,root,pluginRoot,confirm,trust=trustedPluginHooks,codexHome}){
 if(confirm!==true)throw Error('Explicit approval is required to migrate the existing SpoolDB integration');
 const paths=legacyFiles(root,{codexHome});if(!paths.length)return {migrated:true,changed:[],restartRequired:false};
 if(!await trust(root,pluginRoot))return {migrated:false,needsHookReview:true,message:'Review and trust the SpoolDB plugin hooks in Codex, then retry migration. Existing hooks remain in place.'};
 const changes=paths.map(path=>{let after=readFileSync(path,'utf8');const before=after;
 for(const [begin,end]of markers){const starts=after.split(begin).length-1,stops=after.split(end).length-1;if(starts!==stops||starts>1)throw Error('Incomplete or duplicate SpoolDB managed block in '+path);if(!starts)continue;const start=after.indexOf(begin),stop=after.indexOf(end);if(stop<start||start>0&&after[start-1]!=='\n')throw Error('Malformed managed block in '+path);after=after.slice(0,start)+after.slice(stop+end.length).replace(/^\n/,'');}
 return {path,before,after};});
 const backups=join(state,'integration-backups');mkdirSync(backups,{recursive:true,mode:0o700});const changed=[];
 for(const {path,before,after}of changes){const backup=join(backups,'plugin-migration-'+randomUUID()+'.toml');writeFileSync(backup,before,{mode:0o600});writeFileSync(path+'.spool-tmp',after,{mode:0o600});renameSync(path+'.spool-tmp',path);changed.push({path,backup});}
 return {migrated:true,changed,restartRequired:!!changed.length};
}
