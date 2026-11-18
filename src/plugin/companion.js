import {compatibleCompanion,upgradeCompanion} from './companion-upgrade.js';
import {existsSync,mkdirSync,readFileSync,writeFileSync,openSync,closeSync,rmSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {discoveryRequest} from '../discovery-request.js';
export const isAlive=pid=>{if(!Number.isInteger(pid)||pid<2)return false;try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}};
export async function ensureCompanion(state,{timeout=20000,request=discoveryRequest,upgrade=upgradeCompanion}={}){
 mkdirSync(state,{recursive:true,mode:0o700});const leaseDirectory=join(state,'plugin-leases');mkdirSync(leaseDirectory,{recursive:true,mode:0o700});
 const lease=join(leaseDirectory,randomUUID()+'.json');writeFileSync(lease,JSON.stringify({pid:process.pid}),{mode:0o600});
 const release=()=>rmSync(lease,{force:true});
 let observed,transition;
 const ready=async()=>{try{observed=await request(state,{command:'list'});return compatibleCompanion(observed.companion);}catch(error){observed=undefined;if(!['ENOENT','ECONNREFUSED'].includes(error.code))throw error;return false;}};
 const lock=join(state,'plugin-start.lock');let own=false;
 try{
  if(await ready())return {release};
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){
   try{const fd=openSync(lock,'wx',0o600);writeFileSync(fd,JSON.stringify({pid:process.pid}));closeSync(fd);own=true;}catch(error){if(error.code!=='EEXIST')throw error;try{if(!isAlive(JSON.parse(readFileSync(lock)).pid)){rmSync(lock,{force:true});continue;}}catch(e){if(e.code==='ENOENT')continue;if(e instanceof SyntaxError){if(Date.now()-statSync(lock).mtimeMs>timeout)rmSync(lock,{force:true});await delay(100);continue;}throw e;}}
   if(own){
    if(!await ready()&&observed){transition=await upgrade(state);observed=undefined;}
    if(!await ready()&&!transition?.upgraded){
     const fd=openSync(join(state,'plugin-companion.log'),'w',0o600);
     try{const child=spawn(process.execPath,[fileURLToPath(new URL('./service.js',import.meta.url)),state],{detached:true,stdio:['ignore',fd,fd],env:{...process.env,SPOOL_PORT:'0',SPOOL_COMPANION_KIND:'plugin'}});child.on('error',()=>{});child.unref();}finally{closeSync(fd);}
    }
    while(Date.now()<deadline){if(await ready())return {release};await delay(100);}
   }else{if(await ready())return {release};await delay(100);}
  }
  throw Error('SpoolDB companion did not start; check its private plugin-companion.log');
 }catch(error){if(transition?.rollback)try{transition.rollback();}catch{}release();throw error;}finally{if(own)rmSync(lock,{force:true});}
}

export async function ensureNativeCompanion(state,binary,{timeout=20000}={}){
 mkdirSync(state,{recursive:true,mode:0o700});
 const receipt=join(state,'service.json');
 const ready=async()=>{
  try{
   const {origin,pid}=JSON.parse(readFileSync(receipt));
   if(!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(origin)||!isAlive(pid))return false;
   const response=await fetch(origin+'/healthz',{signal:AbortSignal.timeout(700),redirect:'error'});
   const status=await response.json();
   return response.ok&&status.ok===true&&status.protocol==='spool-relay/1';
  }catch{return false;}
 };
 if(await ready())return;
 const log=openSync(join(state,'plugin-companion.log'),'a',0o600);
 try{
  const child=spawn(binary,['companion','start'],{
   detached:true,stdio:['ignore',log,log],env:{...process.env,SPOOL_STATE:state},
  });
  child.on('error',()=>{});child.unref();
 }finally{closeSync(log);}
 const deadline=Date.now()+timeout;
 while(Date.now()<deadline){
  if(await ready())return;
  await delay(100);
 }
 throw Error('SpoolDB companion did not start. See plugin-companion.log in its state directory.');
}
