import {existsSync,lstatSync,readFileSync,readdirSync,rmSync,writeFileSync,renameSync} from 'node:fs';
import {dirname,join,resolve,basename} from 'node:path';
const day=86400000;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const defaultBackupRetention=Object.freeze({keep:3,maxAgeDays:30});
const read=path=>existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{};
const regular=path=>{try{return lstatSync(path).isFile();}catch{return false;}};
const directory=path=>{try{return lstatSync(path).isDirectory();}catch{return false;}};
export function backupRetention(configPath){
 const configured=read(join(dirname(configPath),'relay-updates.json')).backupRetention;
 const policy={...defaultBackupRetention,...configured};
 if(!Number.isInteger(policy.keep)||policy.keep<1||policy.keep>100||!Number.isInteger(policy.maxAgeDays)||policy.maxAgeDays<1||policy.maxAgeDays>3650)throw Error('Backup retention requires keep=1–100 and maxAgeDays=1–3650');
 return policy;
}
export function markRelayBackup(path,{createdAt=new Date().toISOString(),previous}={}){
 writeFileSync(join(path,'backup.json'),JSON.stringify({managedBy:'SpoolDB',kind:'relay-update-backup',id:basename(path),createdAt,...(previous?{previous}:{})})+'\n',{mode:0o600});
}
// Called only while holding the relay operation lock. Never follow directory symlinks.
export function pruneRelayBackups(configPath,{now=Date.now(),dryRun=false}={}){
 const root=dirname(resolve(configPath)),base=join(root,'relay-backups'),policy=backupRetention(configPath);
 const result={policy,dryRun,removed:[],retained:[],skipped:[],errors:[]};
 // Parse references before deleting anything. Corrupt recovery metadata fails closed.
 const protectedPaths=new Set();
 for(const file of ['last-relay-update.json','relay-update-journal.json']){
  const refPath=join(root,file);
  if(!existsSync(refPath))continue;
  if(!regular(refPath))throw Error('Invalid backup reference file: '+file);
  const ref=read(refPath).backup;
  if(typeof ref!=='string'||dirname(resolve(ref))!==base)throw Error('Invalid backup reference in '+file);
  protectedPaths.add(resolve(ref));
 }
 if(!existsSync(base))return result;
 if(!directory(base))throw Error('Backup storage must be a real directory');
 const backups=[];
 for(const name of readdirSync(base)){
  const path=join(base,name),metaPath=join(path,'backup.json');
  if(!uuid.test(name)||!directory(path)){result.skipped.push(name);continue;}
  let createdAt;
  try{
   if(regular(metaPath)){
    const meta=read(metaPath);
    if(meta.managedBy!=='SpoolDB'||meta.kind!=='relay-update-backup'||meta.id!==name)throw Error('Unrecognized backup metadata');
    createdAt=Date.parse(meta.createdAt);
   }else{
    // v0.4.13–0.4.14 snapshots had no marker. Recognize their exact layout,
    // including the original ownership manifest, without adopting arbitrary folders.
    const owners=join(path,'owners.json');
    if(existsSync(metaPath)||!regular(owners)||!directory(join(path,'data')))throw Error('Unrecognized backup directory');
    const entries=JSON.parse(readFileSync(owners,'utf8'));
    if(!Array.isArray(entries)||!entries.length||entries[0][0]!==''||!entries.every(v=>Array.isArray(v)&&v.length===3&&typeof v[0]==='string'&&v[0].split('/').every(p=>p!=='..')&&v.slice(1).every(n=>Number.isInteger(n)&&n>=0)))throw Error('Unrecognized ownership manifest');
    createdAt=lstatSync(owners).mtimeMs;
   }
   if(!Number.isFinite(createdAt)||createdAt>now)throw Error('Invalid backup date');
   backups.push({name,path,createdAt});
  }catch(error){result.skipped.push(name);result.errors.push({name,error:error.message});}
 }
 backups.sort((a,b)=>b.createdAt-a.createdAt||a.name.localeCompare(b.name));
 for(const [index,backup] of backups.entries()){
  const protect=protectedPaths.has(backup.path);
  if(protect||index<policy.keep&&now-backup.createdAt<=policy.maxAgeDays*day){result.retained.push({name:backup.name,protected:protect});continue;}
  try{if(!dryRun)rmSync(backup.path,{recursive:true});result.removed.push(backup.name);}catch(error){result.errors.push({name:backup.name,error:error.message});}
 }
 return result;
}
// Cleanup failure must never roll back an already healthy update or quarantine a release.
export function maintainRelayBackups(configPath,options){
 const root=dirname(configPath),path=join(root,'relay-updates.json');let result;
 try{result=pruneRelayBackups(configPath,options);}catch(error){result={errors:[{error:error.message}]};}
 if(!options?.dryRun)try{const state={...read(path),backupCleanup:{...result,checkedAt:new Date().toISOString()}};writeFileSync(path+'.tmp',JSON.stringify(state,null,2)+'\n',{mode:0o600});renameSync(path+'.tmp',path);}catch(error){(result.errors??=[]).push({error:'Could not record cleanup: '+error.message});}
 return result;
}
