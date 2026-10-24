import {readFileSync,writeFileSync,renameSync,existsSync,mkdirSync,unlinkSync,openSync,closeSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {parseWorkspaceLink,isWorkspaceLink} from '../team/workspace.js';
import {parseInvite} from '../team/invites.js';
export const readInbox=path=>existsSync(path)?JSON.parse(readFileSync(path,'utf8')):[];
async function change(path,fn){mkdirSync(dirname(path),{recursive:true,mode:0o700});let fd;for(let i=0;i<100;i++){try{fd=openSync(path+'.lock','wx',0o600);break;}catch(error){if(error.code!=='EEXIST')throw error;await delay(30);}}if(fd===undefined)throw new Error('Invite inbox is busy');try{const result=fn(readInbox(path));const temporary=path+'.'+randomUUID();writeFileSync(temporary,JSON.stringify(result)+'\n',{mode:0o600});renameSync(temporary,path);}finally{closeSync(fd);unlinkSync(path+'.lock');}}
export async function enqueueInvite(path,link){if(isWorkspaceLink(link))parseWorkspaceLink(link);else parseInvite(link);await change(path,entries=>{if(entries.some(item=>item.link===link))return entries;if(entries.length>=16)throw new Error('Too many pending invites');return [...entries,{link,receivedAt:new Date().toISOString()}];});}
export const dismissInvite=(path,link)=>change(path,entries=>entries.filter(item=>item.link!==link));
