import {createServer} from 'node:net';
import {existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,writeFileSync,renameSync,rmSync,chmodSync,chownSync,statfsSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {relayUpdateStatus,configureRelayUpdates,checkRelayUpdate,updateRelay,recoverRelayUpdate,cleanupRelayBackups,cleanupPlanHash} from './relay-update.js';
import {prepareRelayControl} from './relay-control-install.js';
import {rootRun} from './server-caddy.js';
const read=p=>existsSync(p)?JSON.parse(readFileSync(p,'utf8')):{};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const actions=new Set(['check','update','configure','preview','cleanup','recover']);
function save(p,v){writeFileSync(p+'.tmp',JSON.stringify(v)+'\n',{mode:0o600});renameSync(p+'.tmp',p);}
const revision=s=>createHash('sha256').update(JSON.stringify([Boolean(s.enabled),s.backupRetention,s.artifactRetention])).digest('hex');
export function validateControlInput(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['action','requestId','settings','previewId'].includes(k)))throw Error('Invalid maintenance request');
 if(input.action==='status'){if(input.settings||input.requestId||input.previewId)throw Error('Invalid status request');return input;}
 if(!actions.has(input.action)||!uuid.test(input.requestId??''))throw Error('Choose a supported maintenance action and a UUID request ID');
 if(input.action==='configure'){
  const s=input.settings;if(!s||Object.keys(s).sort().join(',')!=='artifactRetention,automatic,backupRetention,expectedRevision'||typeof s.automatic!=='boolean'||!/^[a-f0-9]{64}$/.test(s.expectedRevision??''))throw Error('Invalid maintenance settings');
  for(const key of ['backupRetention','artifactRetention']){const p=s[key];if(!p||Object.keys(p).sort().join(',')!=='keep,maxAgeDays'||!Number.isInteger(p.keep)||p.keep<1||p.keep>100||!Number.isInteger(p.maxAgeDays)||p.maxAgeDays<1||p.maxAgeDays>3650)throw Error('Retention requires 1–100 copies and 1–3650 days');}
 }else if(input.settings!==undefined)throw Error('This maintenance action does not accept settings');
 if(input.action==='cleanup'){if(!uuid.test(input.previewId??''))throw Error('Preview cleanup before applying it');}else if(input.previewId!==undefined)throw Error('Unexpected cleanup preview');
 return input;
}
function jobs(root){const dir=join(root,'control-jobs');mkdirSync(dir,{recursive:true,mode:0o700});return readdirSync(dir).filter(n=>uuid.test(n.replace(/\.json$/,''))&&n.endsWith('.json')).map(n=>({path:join(dir,n),job:read(join(dir,n))})).sort((a,b)=>b.job.createdAt.localeCompare(a.job.createdAt));}
function alive(pid){try{if(!Number.isInteger(pid)||pid<2)return false;process.kill(pid,0);return true;}catch{return false;}}
function inventoryJobs(root){const all=jobs(root);for(const entry of all){const j=entry.job;if(j.status==='running'&&!alive(j.pid)||j.status==='queued'&&Date.now()-Date.parse(j.createdAt)>60000){j.status='failed';j.error='Maintenance was interrupted. Refresh relay status before retrying.';j.completedAt=new Date().toISOString();save(entry.path,j);}}for(const entry of all.slice(20))if(!['running','queued'].includes(entry.job.status))rmSync(entry.path,{force:true});return all.slice(0,20).map(e=>e.job);}
function operation(root){const lock=root+'.operation.lock',pid=Number(existsSync(join(lock,'pid'))?readFileSync(join(lock,'pid'),'utf8'):NaN);return {present:existsSync(lock),known:Number.isInteger(pid)&&pid>1,alive:alive(pid)};}
function publicJob(j){return {id:j.id,action:j.action,status:j.status,createdAt:j.createdAt,completedAt:j.completedAt,result:j.result,error:j.error};}
export function controlStatus(configPath,{run=rootRun}={}){
 const root=dirname(configPath),s=relayUpdateStatus(configPath),config=read(configPath),recent=inventoryJobs(root);let timerNext=null,relayRunning=null;
 try{timerNext=run('systemctl',['show','spool-relay-update.timer','--property=NextElapseUSecRealtime','--value'],{timeout:2000}).trim()||null;}catch{}
 try{const data=JSON.parse(run(config.engine,['container','inspect','spool-relay'],{timeout:2000}));relayRunning=data[0].State.Running;}catch{}
 const lock=operation(root),journal=existsSync(join(root,'relay-update-journal.json'));const disk=statfsSync(root);return {supported:true,version:s.current,automatic:Boolean(s.enabled),backupRetention:s.backupRetention,artifactRetention:s.artifactRetention,revision:revision(s),needsRecovery:journal||lock.present&&lock.known&&!lock.alive,canRecover:!lock.alive&&(journal||lock.present&&lock.known),busy:existsSync(root+'.operation.lock')||recent.some(j=>['queued','running'].includes(j.status)),relayRunning,timerNext,disk:{availableBytes:Number(disk.bavail)*Number(disk.bsize),totalBytes:Number(disk.blocks)*Number(disk.bsize)},backupCleanup:s.backupCleanup,artifactCleanup:s.artifactCleanup,jobs:recent.slice(0,5).map(publicJob)};
}
export function acceptControlJob(configPath,input,{launch,run=rootRun}={}){
 validateControlInput(input);if(input.action==='status')return controlStatus(configPath,{run});
 const root=dirname(configPath),dir=join(root,'control-jobs');mkdirSync(dir,{recursive:true,mode:0o700});const path=join(dir,input.requestId+'.json'),fingerprint=createHash('sha256').update(JSON.stringify([input.action,input.settings,input.previewId])).digest('hex');
 if(existsSync(path)){const prior=read(path);if(prior.fingerprint!==fingerprint)throw Error('Request ID already used for another action');return {accepted:true,job:publicJob(prior)};}
 const all=inventoryJobs(root);if(all.some(j=>['queued','running'].includes(j.status)))throw Error('Another maintenance action is already running');
 if(existsSync(root+'.operation.lock')&&(input.action!=='recover'||operation(root).alive))throw Error('Relay update is busy or needs recovery');
 const job={id:input.requestId,action:input.action,settings:input.settings,previewId:input.previewId,fingerprint,status:'queued',createdAt:new Date().toISOString()};save(path,job);
 try{if(launch)launch(job.id);else{const config=read(configPath),child=spawn(join(config.app,'runtime/bun'),[join(config.app,'src/relay-control.js'),'--worker',job.id,configPath],{detached:true,stdio:'ignore'});child.on('error',error=>{save(path,{...job,status:'failed',error:error.message,completedAt:new Date().toISOString()});});child.unref();}}catch(error){save(path,{...job,status:'failed',error:error.message,completedAt:new Date().toISOString()});throw error;}
 return {accepted:true,job:publicJob(job)};
}
export async function executeControlJob(configPath,id,{run=rootRun,handlers={},units='/etc/systemd/system',requireRoot=true}={}){
 if(!uuid.test(id))throw Error('Invalid maintenance job');const root=dirname(configPath),path=join(root,'control-jobs',id+'.json'),job=read(path);if(job.status!=='queued')return;
 validateControlInput({action:job.action,requestId:id,...(job.settings?{settings:job.settings}:{}),...(job.previewId?{previewId:job.previewId}:{})});save(path,{...job,status:'running',pid:process.pid});
 try{
  let result;
  if(handlers[job.action])result=await handlers[job.action](job);
  else if(job.action==='check'){const c=await checkRelayUpdate(configPath);result={current:c.current,latest:c.latest,available:c.available};}
  else if(job.action==='update'){const c=await updateRelay(configPath,{run});result={current:c.current,latest:c.latest,updated:Boolean(c.updated)};}
  else if(job.action==='recover'){const lock=operation(root);if(!existsSync(join(root,'relay-update-journal.json'))&&lock.present&&lock.known&&!lock.alive){rmSync(root+'.operation.lock',{recursive:true,force:true});result={recovered:true,abandonedOperationCleared:true};}else result=await recoverRelayUpdate(configPath,{run});}
  else if(job.action==='preview'){result=cleanupRelayBackups(configPath,{run,dryRun:true,requireRoot});result.planHash=cleanupPlanHash(result);}
  else if(job.action==='cleanup'){const preview=read(join(root,'control-jobs',job.previewId+'.json'));if(preview.action!=='preview'||preview.status!=='succeeded'||Date.now()-Date.parse(preview.completedAt)>300000||preview.result.errors?.length||preview.result.artifacts?.errors?.length)throw Error('A successful recent cleanup preview is required');result=cleanupRelayBackups(configPath,{run,requireRoot,expectedPlan:preview.result.planHash});}
  else if(job.action==='configure'){
   const lock=root+'.operation.lock';mkdirSync(lock,{mode:0o700});writeFileSync(join(lock,'pid'),String(process.pid));
   try{if(revision(relayUpdateStatus(configPath))!==job.settings.expectedRevision)throw Error('Settings changed. Refresh and try again.');const statePath=join(root,'relay-updates.json'),previous=read(statePath);try{configureRelayUpdates(configPath,job.settings.automatic,{run,units,requireRoot});save(statePath,{...read(statePath),backupRetention:job.settings.backupRetention,artifactRetention:job.settings.artifactRetention});result={saved:true};}catch(error){try{configureRelayUpdates(configPath,Boolean(previous.enabled),{run,units,requireRoot});save(statePath,previous);}catch{}throw error;}}finally{rmSync(lock,{recursive:true,force:true});}
  }
  save(path,{...job,status:'succeeded',completedAt:new Date().toISOString(),result});
 }catch(error){save(path,{...job,status:'failed',completedAt:new Date().toISOString(),error:error.message.slice(0,1600)});}
}
export async function startRelayControl(configPath,{run=rootRun,requireRoot=true,launch}={}){
 const root=dirname(resolve(configPath)),dir=prepareRelayControl(configPath,{requireRoot}),socketPath=join(dir,'agent.sock');
 if(existsSync(socketPath)){if(!lstatSync(socketPath).isSocket())throw Error('Unmanaged control socket path');const {relayAdminRequest}=await import('./team/relay-admin.js');const previous=await relayAdminRequest({action:'status'},{socketPath});if(previous.supported)throw Error('Relay control is already running');rmSync(socketPath);}
 const server=createServer(socket=>{let body='',done=false;socket.setTimeout(6000,()=>socket.destroy());socket.on('error',()=>{});socket.on('data',chunk=>{if(done)return;body+=chunk;if(body.length>20000){socket.destroy();return;}if(!body.includes('\n'))return;done=true;try{socket.end(JSON.stringify(acceptControlJob(configPath,JSON.parse(body.split('\n')[0]),{run,launch}))+'\n');}catch(error){socket.end(JSON.stringify({error:error.message})+'\n');}});});server.maxConnections=8;
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});chmodSync(socketPath,0o660);if(requireRoot)chownSync(socketPath,0,1000);
 return {close:async()=>{await new Promise(resolve=>server.close(resolve));rmSync(socketPath,{force:true});},socketPath};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)&&process.argv[2]==='--worker'){
 if(process.getuid?.()!==0)throw Error('Relay control workers require root');executeControlJob(resolve(process.argv[4]),process.argv[3]).catch(()=>{process.exitCode=1;});
}
