import {readFileSync,writeFileSync,mkdirSync,existsSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {hostname} from 'node:os';
import {parseInvite,inviteHttp} from '../team/invites.js';
import {connectCodexMemory} from '../codex-connection.js';
const hash=value=>createHash('sha256').update(value).digest('hex');
export async function previewInvite(link,{directory}={}){const invite=parseInvite(link);let preview;try{preview=await inviteHttp(invite,'preview');}catch(error){const path=directory&&join(directory,'join-attempts',hash(invite.url+invite.code)+'.json');if(error.code!=='INVITE_USED'||!path||!existsSync(path))throw error;const attempt=JSON.parse(readFileSync(path));if(!attempt.connection)throw error;preview={project:attempt.connection.project,room:attempt.connection.room,resuming:true};}return {...preview,relay:invite.url,device:hostname(),privateCertificate:Boolean(invite.ca)};}
export async function joinInvite({directory,manager,link,root,device,captureConversations=true,connectAgents=true,connector=connectCodexMemory}){
 const descriptor=parseInvite(link);if(typeof device!=='string'||!device.trim()||device.length>120)throw new Error('Name this computer');const folder=join(directory,'join-attempts');mkdirSync(folder,{recursive:true,mode:0o700});const path=join(folder,hash(descriptor.url+descriptor.code)+'.json');let attempt=existsSync(path)?JSON.parse(readFileSync(path)):{claim:randomBytes(32).toString('base64url')};const save=()=>{writeFileSync(path+'.tmp',JSON.stringify(attempt)+'\n',{mode:0o600});renameSync(path+'.tmp',path);};save();
 // Validate/register a local folder before consuming an invite or granting access.
 const added=await manager.add({root,connectCodex:false,captureFiles:false});const app=await manager.get(added.project.id);
 if(!attempt.connection){await inviteHttp(descriptor,'preview').catch(error=>{if(error.code!=='INVITE_USED')throw error;});const result=await inviteHttp(descriptor,'redeem',{claim:attempt.claim,device});attempt={...attempt,...result};save();}
 await app.teamConnect(attempt.connection);let captureError=null,agentError=null;
 if(captureConversations)try{await app.connect();}catch(error){captureError=error.message;}
 if(connectAgents)try{const agents=await connector({directory,room:added.project.id,root:added.project.root});if(agents?.ready===false)agentError=agents.message;}catch(error){agentError=error.message;}
 attempt.projectId=added.project.id;save();return {joined:true,project:added.project,captureError,agentError};
}
