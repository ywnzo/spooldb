import {prepareRelayControl,installRelayControl} from './relay-control-install.js';
import {artifactRetention,markRelayRelease,maintainRelayStorage} from './relay-artifacts.js';
import {backupRetention,markRelayBackup} from './relay-backups.js';
import {existsSync,readFileSync,writeFileSync,mkdirSync,renameSync,rmSync,mkdtempSync,cpSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {releaseInfo,newerVersion} from './update.js';
import {rootRun,waitForHTTPS} from './server-caddy.js';
import {containerCommands,containerRequest} from './server-vps.js';
import {verifyBundle} from './desktop/install.js';
const marker='# Managed by SpoolDB relay updater';
const read=path=>existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{};
function save(path,value){writeFileSync(path+'.tmp',JSON.stringify(value,null,2)+'\n',{mode:0o600});renameSync(path+'.tmp',path);}
export function relayUpdateStatus(configPath){const config=read(configPath);return {...read(join(dirname(configPath),'relay-updates.json')),current:read(join(config.app??'','package.json')).version,config:configPath,backupRetention:backupRetention(configPath),artifactRetention:artifactRetention(configPath)};}
export function configureRelayUpdates(configPath,enabled,{run=rootRun,units='/etc/systemd/system',requireRoot=true}={}){
 if(requireRoot&&process.getuid?.()!==0)throw Error('Use sudo to manage relay updates');
 const path=join(dirname(configPath),'relay-updates.json');
 for(const name of ['spool-relay-update.service','spool-relay-update.timer']){const file=join(units,name);if(existsSync(file)&&!readFileSync(file,'utf8').includes(marker))throw Error('Unmanaged updater unit: '+file);}
 save(path,{...read(path),enabled});
 writeFileSync(join(units,'spool-relay-update.service'),`${marker}\n[Unit]\nDescription=Check and safely update SpoolDB relay\nAfter=network-online.target spool-shared.service\nWants=network-online.target\n[Service]\nType=oneshot\nExecStart=/usr/local/bin/spool update --target relay --yes\nUMask=0077\nTimeoutStartSec=1800\n`);
 writeFileSync(join(units,'spool-relay-update.timer'),`${marker}\n[Unit]\nDescription=Daily SpoolDB relay update check\n[Timer]\nOnCalendar=*-*-* 04:00:00\nRandomizedDelaySec=1h\nPersistent=true\n[Install]\nWantedBy=timers.target\n`);
 run('systemctl',['daemon-reload']);run('systemctl',[enabled?'enable':'disable','--now','spool-relay-update.timer']);return relayUpdateStatus(configPath);
}
export async function checkRelayUpdate(configPath,options={}){const current=relayUpdateStatus(configPath).current,release=await releaseInfo(options);return {current,latest:release.version,available:newerVersion(release.version,current),release};}
async function download(response,max){if(!response.ok)throw Error('Release download failed: HTTP '+response.status);const chunks=[];let bytes=0;for await(const part of response.body){bytes+=part.length;if(bytes>max)throw Error('Release download too large');chunks.push(part);}return Buffer.concat(chunks);}
export async function updateRelay(configPath,{fetcher=fetch,run=rootRun,requireRoot=true}={}){
 if(requireRoot&&process.getuid?.()!==0)throw Error('Use sudo spool update on the relay');if(process.platform!=='linux'||process.arch!=='x64')throw Error('Automatic relay updates currently require Linux x86-64');
 const root=dirname(configPath),lock=root+'.operation.lock';if(existsSync(join(root,'relay-update-journal.json')))throw Error('Interrupted update: run sudo spool update recover');try{mkdirSync(lock,{mode:0o700});writeFileSync(join(lock,'pid'),String(process.pid));}catch{throw Error('Another relay update is running, or an interrupted update needs administrator inspection: '+lock);}
 const statePath=join(root,'relay-updates.json');let temporary,checked;
 try{const backupCleanup=maintainRelayStorage(configPath,{run});checked=await checkRelayUpdate(configPath,{fetcher});if(!checked.available)return {...checked,backupCleanup};if(read(statePath).failedVersion===checked.latest)throw Error('This release previously failed validation; wait for a newer release or inspect relay-updates.json before retrying.');
 const base='https://github.com/ywnzo/spooldb/releases/download/v'+checked.latest+'/';
 const get=async(name,max)=>{const asset=checked.release.assets.find(a=>a.name===name);if(asset?.browser_download_url!==base+name)throw Error('Official release asset missing');return download(await fetcher(base+name,{signal:AbortSignal.timeout(120000)}),max);};
 const sums=(await get('SHA256SUMS',100000)).toString(),data=await get('spool-linux-x64.run',200000000),lines=sums.split('\n').filter(line=>/\s+spool-linux-x64.run$/.test(line));if(lines.length!==1||lines[0].split(/\s+/)[0]!==createHash('sha256').update(data).digest('hex'))throw Error('Installer checksum mismatch');
 temporary=mkdtempSync(join(tmpdir(),'spool-relay-update-'));const installer=join(temporary,'update.run');writeFileSync(installer,data,{mode:0o700});run('/bin/sh',[installer,'--relay-update',configPath],{stdio:'inherit',timeout:1500000});
 save(statePath,{...read(statePath),lastCheck:new Date().toISOString(),updatedTo:checked.latest,failedVersion:null,error:null});return {...checked,updated:true};
 }catch(error){save(statePath,{...read(statePath),lastCheck:new Date().toISOString(),failedVersion:checked?.latest??null,error:error.message});throw error;}finally{if(temporary)rmSync(temporary,{recursive:true,force:true});rmSync(lock,{recursive:true,force:true});}
}
// All helper containers are short lived. Neither application container receives the engine socket.
export function volumeAction(config,backup,action,{run=rootRun}={}){
 const script=`const fs=require('node:fs');const action=${JSON.stringify(action)};if(action==='snapshot'){const owners=[];function walk(p){const s=fs.lstatSync(p);if(s.isSocket())return;owners.push([p.slice(5),s.uid,s.gid]);if(s.isDirectory())for(const n of fs.readdirSync(p))walk(p+'/'+n);}walk('/data');fs.writeFileSync('/backup/owners.json',JSON.stringify(owners));fs.cpSync('/data','/backup/data',{recursive:true,filter:p=>!fs.lstatSync(p).isSocket()});fs.writeFileSync('/data/.spool-update-gate','1');}else if(action==='restore'){for(const p of fs.readdirSync('/data'))fs.rmSync('/data/'+p,{recursive:true,force:true});fs.cpSync('/backup/data','/data',{recursive:true});for(const [p,u,g] of JSON.parse(fs.readFileSync('/backup/owners.json')))fs.lchownSync('/data'+p,u,g);}else fs.rmSync('/data/.spool-update-gate',{force:true});`;
 run(config.engine,['run','--rm','--user','0','-v','spool-relay-data:/data','-v',backup+':/backup:Z',config.image,'bun','-e',script],{timeout:300000});
}
export async function applyRelayBundle(configPath,bundle,{run=rootRun,health=waitForHTTPS,cli='/usr/local/bin/spool',requireRoot=true,hostControl=requireRoot,controlUnits='/etc/systemd/system'}={}){
 if(requireRoot&&process.getuid?.()!==0)throw Error('Relay updates require root');const old=read(configPath),manifest=verifyBundle(bundle),current=read(join(old.app,'package.json')).version;if(old.managedBy!=='SpoolDB'||!newerVersion(manifest.version,current))throw Error('Expected a newer release for a managed relay');
 const root=dirname(configPath),id=randomUUID(),app=join(root,'releases',manifest.version+'-'+id),backup=join(root,'relay-backups',id),previous='spool-relay-previous-'+id;
 cpSync(bundle,app,{recursive:true});mkdirSync(backup,{recursive:true,mode:0o700});markRelayBackup(backup,{previous:old});
 const config={...old,app,...(hostControl?{hostControl:true}:{}),image:'localhost/spooldb-relay:'+manifest.version+'-'+id};
 markRelayRelease(app,{image:config.image,version:manifest.version});
 writeFileSync(join(app,'Containerfile'),`FROM docker.io/oven/bun:1.4.3\nWORKDIR /app\nCOPY src ./src\nCOPY schemas ./schemas\nCOPY package.json ./\nCOPY node_modules ./node_modules\nRUN chmod -R a+rX /app\nUSER bun\n`);
 run(old.engine,['build','--label','dev.spooldb.managed=true','--label','dev.spooldb.release='+app.split('/').at(-1),'-f',join(app,'Containerfile'),'-t',config.image,app],{stdio:'inherit',timeout:600000});
 if(hostControl)prepareRelayControl(configPath,{requireRoot});
 // Validate the old endpoint before beginning downtime.
 await health(old.domain,old.probe);const savedCLI=readFileSync(cli);save(join(root,'relay-update-journal.json'),{old,backup,previous,cli,savedCLI:savedCLI.toString(),phase:'prepared'});let stopped=false,snapshot=false,renamed=false,created=false;
 try{run(old.engine,['stop','-t','30','spool-relay']);stopped=true;volumeAction(old,backup,'snapshot',{run});snapshot=true;save(join(root,'relay-update-journal.json'),{old,backup,previous,cli,savedCLI:savedCLI.toString(),phase:'snapshot'});
 run(old.engine,['rename','spool-relay',previous]);renamed=true;run(old.engine,containerCommands(config)[0]);created=true;run(old.engine,['start','spool-relay']);
 await health(config.domain,config.probe);const response=JSON.parse(run(old.engine,['exec','spool-relay','bun','-e',"const r=await fetch('http://127.0.0.1:8878/healthz');console.log(await r.text())"]));if(response.version!==manifest.version||response.updating!==true)throw Error('Candidate version or maintenance gate mismatch');
 containerRequest(configPath,{command:'list'},{run});
 save(configPath,config);writeFileSync(cli,savedCLI.toString().replaceAll(old.app,app),{mode:0o755});save(join(root,'relay-update-journal.json'),{old,config,backup,previous,cli,savedCLI:savedCLI.toString(),phase:'committed'});volumeAction(config,backup,'commit',{run});
 if(hostControl)installRelayControl(configPath,{run,units:controlUnits,requireRoot});
 save(join(root,'last-relay-update.json'),{version:manifest.version,previous:old,backup,completedAt:new Date().toISOString()});rmSync(join(root,'relay-update-journal.json'),{force:true});try{run(old.engine,['rm',previous]);}catch{}const backupCleanup=maintainRelayStorage(configPath,{run});return {updated:true,version:manifest.version,backup,backupCleanup};
 }catch(error){if(read(join(root,'relay-update-journal.json')).phase==='committed')throw Error('Update committed; finish recovery with sudo spool update recover: '+error.message);try{if(created)run(old.engine,['rm','-f','spool-relay']);if(snapshot)volumeAction(old,backup,'restore',{run});if(renamed)run(old.engine,['rename',previous,'spool-relay']);save(configPath,old);writeFileSync(cli,savedCLI,{mode:0o755});if(stopped)run(old.engine,['start','spool-relay']);await health(old.domain,old.probe);rmSync(join(root,'relay-update-journal.json'),{force:true});maintainRelayStorage(configPath,{run});error.message+=' Previous relay and memory restored.';}catch(rollback){error.message+=' ROLLBACK FAILED: '+rollback.message+'; backup: '+backup;}throw error;}
}

export async function recoverRelayUpdate(configPath,{run=rootRun,health=waitForHTTPS,requireRoot=true}={}){
 if(requireRoot&&process.getuid?.()!==0)throw Error('Use sudo to recover the relay');const root=dirname(configPath),pidPath=join(root+'.operation.lock','pid');if(existsSync(pidPath)){const pid=Number(readFileSync(pidPath,'utf8'));if(Number.isSafeInteger(pid)&&pid>0){let alive=false;try{process.kill(pid,0);alive=true;}catch{}if(alive)throw Error('An updater is still running; recovery refused');}}const path=join(root,'relay-update-journal.json'),j=read(path);if(!j.old)throw Error('No interrupted relay transaction found; inspect the lock before removing it');
 const {old,backup,previous,cli,savedCLI}=j;if(j.phase==='committed'){volumeAction(j.config,backup,'commit',{run});await health(j.config.domain,j.config.probe);if(j.config.hostControl)installRelayControl(configPath,{run});save(join(root,'last-relay-update.json'),{version:read(join(j.config.app,'package.json')).version,previous:old,backup,completedAt:new Date().toISOString()});rmSync(path);const backupCleanup=maintainRelayStorage(configPath,{run});rmSync(root+'.operation.lock',{recursive:true,force:true});return {recovered:true,version:read(join(j.config.app,'package.json')).version,backupCleanup};}let renamed=false;try{run(old.engine,['container','inspect',previous]);renamed=true;}catch{}
 if(renamed){let candidate=false;try{run(old.engine,['container','inspect','spool-relay']);candidate=true;}catch{}if(candidate)run(old.engine,['rm','-f','spool-relay']);}else run(old.engine,['stop','-t','30','spool-relay']);
 if(j.phase==='snapshot'||existsSync(join(backup,'data'))&&existsSync(join(backup,'owners.json')))volumeAction(old,backup,'restore',{run});if(renamed)run(old.engine,['rename',previous,'spool-relay']);save(configPath,old);writeFileSync(cli,savedCLI,{mode:0o755});run(old.engine,['start','spool-relay']);await health(old.domain,old.probe);rmSync(path);const backupCleanup=maintainRelayStorage(configPath,{run});rmSync(root+'.operation.lock',{recursive:true,force:true});return {recovered:true,backupCleanup};
}

export function cleanupRelayBackups(configPath,{dryRun=false,requireRoot=true,run=rootRun,expectedPlan}={}){
 if(requireRoot&&process.getuid?.()!==0)throw Error('Use sudo spool update cleanup');
 const lock=dirname(configPath)+'.operation.lock';try{mkdirSync(lock,{mode:0o700});writeFileSync(join(lock,'pid'),String(process.pid));}catch{throw Error('Another relay operation is running or needs recovery');}
 try{if(expectedPlan){const preview=maintainRelayStorage(configPath,{dryRun:true,run});if(preview.errors?.length||preview.artifacts?.errors?.length||cleanupPlanHash(preview)!==expectedPlan)throw Error('Cleanup plan changed. Preview cleanup again.');}return maintainRelayStorage(configPath,{dryRun,run});}finally{rmSync(lock,{recursive:true,force:true});}
}

export function cleanupPlanHash(plan){return createHash('sha256').update(JSON.stringify([[...(plan.removed??[])].sort(),[...(plan.artifacts?.removedImages??[])].sort(),[...(plan.artifacts?.removedReleases??[])].sort()])).digest('hex');}
