import {existsSync,lstatSync,readFileSync,readdirSync,writeFileSync,renameSync,rmSync} from 'node:fs';
import {join,dirname,resolve,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {rootRun} from './server-caddy.js';
import {maintainRelayBackups} from './relay-backups.js';
const releasePattern=/^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const imagePattern=/^localhost\/spooldb-relay:(.+)$/;
const marker='.spool-relay-release.json',day=86400000;
const read=path=>JSON.parse(readFileSync(path,'utf8'));
const present=path=>{try{return lstatSync(path);}catch(error){if(error.code==='ENOENT')return null;throw error;}};
const regular=path=>present(path)?.isFile();
const imageId=value=>String(value??'').replace(/^sha256:/,'');
export const defaultArtifactRetention=Object.freeze({keep:3,maxAgeDays:30});
export function artifactRetention(configPath){
 const state=join(dirname(configPath),'relay-updates.json'),policy={...defaultArtifactRetention,...(existsSync(state)?read(state).artifactRetention:{})};
 if(!Number.isInteger(policy.keep)||policy.keep<1||policy.keep>100||!Number.isInteger(policy.maxAgeDays)||policy.maxAgeDays<1||policy.maxAgeDays>3650)throw Error('Artifact retention requires keep=1–100 and maxAgeDays=1–3650');
 return policy;
}
export function markRelayRelease(app,{image,version,createdAt=new Date().toISOString()}){
 writeFileSync(join(app,marker),JSON.stringify({managedBy:'SpoolDB',kind:'relay-release',id:basename(app),version,image,createdAt})+'\n',{mode:0o600});
}
function optional(path){const stat=present(path);if(!stat)return null;if(!stat.isFile())throw Error('Invalid retention reference file: '+path);return read(path);}
// The caller holds the shared operation lock. Inventory and validate all references
// before deleting anything. Never use engine-wide prune or forced image removal.
export function pruneRelayArtifacts(configPath,{run=rootRun,now=Date.now(),dryRun=false,backupPlan,cli='/usr/local/bin/spool'}={}){
 const root=dirname(resolve(configPath)),base=join(root,'releases'),config=read(configPath),policy=artifactRetention(configPath);
 const result={policy,dryRun,removedImages:[],removedReleases:[],retainedImages:[],retainedReleases:[],skipped:[],errors:[]};
 if(config.managedBy!=='SpoolDB'||!['/usr/bin/docker','/usr/bin/podman'].includes(config.engine))throw Error('Artifact cleanup requires a managed container installation');
 if(backupPlan?.errors?.length)throw Error('Backup cleanup has unresolved errors; artifact cleanup refused');
 const apps=new Set(),tags=new Set(),requiredTags=new Set(),ids=new Set(),refs=new Map();
 function protect(value){
  if(!value||typeof value.app!=='string'||dirname(resolve(value.app))!==base||!releasePattern.test(basename(value.app))||typeof value.image!=='string'||!releasePattern.test(imagePattern.exec(value.image)?.[1]??'')||value.engine!==config.engine)throw Error('Invalid release or image reference; cleanup refused');
  if(!present(resolve(value.app))?.isDirectory())throw Error('Protected application release is missing or symlinked; cleanup refused');
  apps.add(resolve(value.app));tags.add(value.image);requiredTags.add(value.image);
 }
 protect(config);
 for(const name of ['last-relay-update.json','relay-update-journal.json','last-relay-install.json','relay-control-runtime.json']){
  const ref=optional(join(root,name));if(!ref)continue;
  const previous=name==='relay-update-journal.json'?ref.old:ref.previous;
  protect(previous);if(ref.config)protect(ref.config);
  if(ref.backup){if(typeof ref.backup!=='string'||dirname(resolve(ref.backup))!==join(root,'relay-backups'))throw Error('Invalid backup reference');refs.set(resolve(ref.backup),previous);}
 }
 // Every retained memory backup must retain its original application and image.
 // Older versions only recorded the latest backup's association; missing links
 // block pruning until those backups expire rather than guessing from timestamps.
 const backupBase=join(root,'relay-backups'),removed=new Set(backupPlan?.removed??[]);
 if(present(backupBase)){
  if(!lstatSync(backupBase).isDirectory())throw Error('Backup storage must be a real directory');
  for(const name of readdirSync(backupBase)){
   if(removed.has(name))continue;
   const path=join(backupBase,name);if(!present(path)?.isDirectory())continue;
   const meta=optional(join(path,'backup.json'));
   if(meta?.managedBy==='SpoolDB'&&meta.kind==='relay-update-backup'||regular(join(path,'owners.json'))){
    const previous=meta?.previous??refs.get(path);if(!previous)throw Error('Retained backup has no recorded release association: '+name);protect(previous);
   }
  }
 }
 const containerIDs=run(config.engine,['container','ls','--all','--quiet']).trim().split(/\s+/).filter(Boolean);
 const containers=[];for(let i=0;i<containerIDs.length;i+=50)containers.push(...JSON.parse(run(config.engine,['container','inspect',...containerIDs.slice(i,i+50)],{maxBuffer:16*1024*1024})));
 if(!Array.isArray(containers)||containers.length!==containerIDs.length||containers.some(c=>typeof c.Image!=='string'||!c.Image))throw Error('Incomplete container inventory; cleanup refused');
 for(const container of containers){ids.add(imageId(container.Image));if(container.Config?.Image)tags.add(container.Config.Image);if(container.ImageName)tags.add(container.ImageName);}
 const inventoryIDs=[...new Set(run(config.engine,['image','ls','--quiet','--no-trunc']).trim().split(/\s+/).filter(Boolean))];
 const images=[];
 for(let i=0;i<inventoryIDs.length;i+=50)images.push(...JSON.parse(run(config.engine,['image','inspect',...inventoryIDs.slice(i,i+50)],{maxBuffer:16*1024*1024})));
 for(const image of images)if((image.RepoTags??[]).some(tag=>tags.has(tag)))ids.add(imageId(image.Id??image.ID));
 if(images.length!==inventoryIDs.length||images.some(image=>typeof (image.Id??image.ID)!=='string'||!(image.Id??image.ID)||image.RepoTags!=null&&(!Array.isArray(image.RepoTags)||image.RepoTags.some(tag=>typeof tag!=='string'))))throw Error('Incomplete image inventory; cleanup refused');
 for(const tag of requiredTags)if(!images.some(image=>(image.RepoTags??[]).includes(tag)))throw Error('A protected relay image is missing from the engine inventory; cleanup refused');
 const legacyContainer=containers.some(c=>{const image=images.find(i=>imageId(i.Id??i.ID)===imageId(c.Image));return (image?.RepoTags??[]).some(tag=>releasePattern.test(imagePattern.exec(tag)?.[1]??''))&&!image?.Config?.Labels?.['dev.spooldb.release'];});
 const mounts=containers.flatMap(c=>c.Mounts??[]).map(m=>m.Source).filter(source=>typeof source==='string').map(source=>resolve(source));
 for(const image of images){const release=image.Config?.Labels?.['dev.spooldb.release'];if(ids.has(imageId(image.Id??image.ID))&&releasePattern.test(release??''))apps.add(join(base,release));}
 const releases=[];
 if(present(base)){
  if(!lstatSync(base).isDirectory())throw Error('Release storage must be a real directory');
  for(const name of readdirSync(base)){
   const app=join(base,name),match=releasePattern.exec(name);
   if(!match||!present(app)?.isDirectory()){result.skipped.push(name);continue;}
   const meta=optional(join(app,marker));let createdAt;
   if(meta){
    if(meta.managedBy!=='SpoolDB'||meta.kind!=='relay-release'||meta.id!==name||meta.version!==match[1]||releasePattern.exec(imagePattern.exec(meta.image)?.[1]??'')?.[1]!==meta.version)throw Error('Invalid managed release metadata: '+name);
    createdAt=Date.parse(meta.createdAt);
    const image=images.find(value=>(value.RepoTags??[]).includes(meta.image));
    if(tags.has(meta.image)||image&&ids.has(imageId(image.Id??image.ID)))apps.add(app);
   }else{
    // Legacy installer releases: recognize the exact self-contained bundle layout.
    if(!regular(join(app,'manifest.json'))||!regular(join(app,'package.json'))||!regular(join(app,'Containerfile'))||!regular(join(app,'runtime/bun'))){result.skipped.push(name);continue;}
    if(read(join(app,'manifest.json')).version!==match[1]||read(join(app,'package.json')).version!==match[1]){result.skipped.push(name);continue;}
    createdAt=lstatSync(app).mtimeMs;
    if(legacyContainer)apps.add(app);
   }
   if(!Number.isFinite(createdAt)||createdAt>now)throw Error('Invalid managed release date: '+name);
   if(mounts.some(source=>app===source||app.startsWith(source+'/')||source.startsWith(app+'/')))apps.add(app);
   if([process.execPath,fileURLToPath(import.meta.url)].some(path=>path.startsWith(app+'/'))||regular(cli)&&readFileSync(cli,'utf8').includes(app))apps.add(app);
   releases.push({name,app,createdAt,image:meta?.image});
  }
 }
 const candidates=[];
 for(const image of images)for(const tag of image.RepoTags??[]){
  if(!releasePattern.test(imagePattern.exec(tag)?.[1]??''))continue;
  const labels=image.Config?.Labels??{};
  if(labels['dev.spooldb.managed']!==undefined&&labels['dev.spooldb.managed']!=='true'){result.skipped.push(tag);continue;}
  const createdAt=Date.parse(image.Created);if(!Number.isFinite(createdAt)||createdAt>now)throw Error('Invalid relay image date: '+tag);
  candidates.push({tag,id:imageId(image.Id??image.ID),createdAt,release:labels['dev.spooldb.release']});
 }
 const recent=(index,time)=>index<policy.keep&&now-time<=policy.maxAgeDays*day;
 releases.sort((a,b)=>b.createdAt-a.createdAt||a.name.localeCompare(b.name));
 for(const [index,release] of releases.entries())if(apps.has(release.app)||recent(index,release.createdAt)){apps.add(release.app);if(release.image)tags.add(release.image);}
 for(const image of images)if((image.RepoTags??[]).some(tag=>tags.has(tag)))ids.add(imageId(image.Id??image.ID));

 candidates.sort((a,b)=>b.createdAt-a.createdAt||a.tag.localeCompare(b.tag));
 for(const [index,image] of candidates.entries()){
  if(tags.has(image.tag)||ids.has(image.id)||recent(index,image.createdAt)){result.retainedImages.push(image.tag);if(releasePattern.test(image.release??''))apps.add(join(base,image.release));continue;}
  try{if(!dryRun)run(config.engine,['image','rm',image.tag]);result.removedImages.push(image.tag);}catch(error){for(const release of releases)if(release.image===image.tag||release.name===image.release)apps.add(release.app);result.errors.push({image:image.tag,error:error.message});}
 }
 releases.sort((a,b)=>b.createdAt-a.createdAt||a.name.localeCompare(b.name));
 for(const [index,release] of releases.entries()){
  if(apps.has(release.app)||recent(index,release.createdAt)){result.retainedReleases.push(release.name);continue;}
  try{if(!dryRun)rmSync(release.app,{recursive:true});result.removedReleases.push(release.name);}catch(error){result.errors.push({release:release.name,error:error.message});}
 }
 return result;
}
export function maintainRelayStorage(configPath,options={}){
 const backups=maintainRelayBackups(configPath,options);let artifacts;
 try{artifacts=pruneRelayArtifacts(configPath,{...options,backupPlan:backups});}catch(error){artifacts={errors:[{error:error.message}]};}
 if(!options.dryRun)try{
  const path=join(dirname(configPath),'relay-updates.json'),state={...(existsSync(path)?read(path):{}),artifactCleanup:{...artifacts,checkedAt:new Date().toISOString()}};
  writeFileSync(path+'.tmp',JSON.stringify(state,null,2)+'\n',{mode:0o600});renameSync(path+'.tmp',path);
 }catch(error){(artifacts.errors??=[]).push({error:'Could not record artifact cleanup: '+error.message});}
 return {...backups,artifacts};
}
