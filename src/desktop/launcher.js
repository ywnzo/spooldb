#!/usr/bin/env node
import {readFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {defaultState,inboxPath} from './paths.js';
import {enqueueInvite} from './inbox.js';
export async function launch({root=defaultState(),link,noOpen=false,existing=false}={}){
 root=resolve(root);if(link)await enqueueInvite(existing?join(root,'pending-invite.json'):inboxPath(root),link);
 let origin=existing?'http://127.0.0.1:8787':null;
 const alive=async()=>{try{if(!existing&&existsSync(join(root,'service.json')))origin=JSON.parse(readFileSync(join(root,'service.json'))).origin;if(!origin)return false;const data=await (await fetch(origin+'/healthz',{signal:AbortSignal.timeout(1000)})).json();return data.ok&&data.protocol==='spool-relay/1';}catch{return false;}};
 if(!await alive()){
  try{execFileSync('systemctl',['--user','start','spool.service'],{stdio:'ignore',timeout:10000});}catch{if(existing)throw new Error('SpoolDB background service is unavailable');const child=spawn(process.execPath,[fileURLToPath(new URL('./service.js',import.meta.url)),root],{detached:true,stdio:'ignore'});child.unref();}
  for(let i=0;i<100&&!await alive();i++)await delay(200);if(!await alive())throw new Error('SpoolDB did not start');
 }
 if(!noOpen){const child=spawn('xdg-open',[origin+'/'],{stdio:'ignore'});child.on('error',()=>{});child.unref();}return {origin};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){process.umask(0o077);const args=process.argv.slice(2),index=args.indexOf('--state'),root=index>=0?args[index+1]:defaultState(),link=args.find(a=>a.startsWith('spool:')||a.startsWith('threadweave:')||a.startsWith('https:')||a.startsWith('http:'));await launch({root,link,noOpen:process.env.SPOOL_NO_OPEN==='1',existing:args.includes('--existing')});}
