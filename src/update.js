import {existsSync,readFileSync,writeFileSync,mkdirSync,cpSync,renameSync,rmSync,mkdtempSync,statSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
const origin='https://github.com/ywnzo/spooldb',marker='# Managed by SpoolDB updater';
const read=path=>existsSync(path)?JSON.parse(readFileSync(path,'utf8')):null;
const version=value=>{const match=/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value??'');if(!match)throw Error('Expected a stable release version');return match.slice(1).map(Number);};
export const newerVersion=(candidate,current)=>{const a=version(candidate),b=version(current);for(let i=0;i<3;i++){if(a[i]!==b[i])return a[i]>b[i];}return false;};
const runDefault=(command,args,options={})=>execFileSync(command,args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:180000,...options});
const defaultPaths=()=>({data:process.env.XDG_DATA_HOME??join(homedir(),'.local/share'),config:process.env.XDG_CONFIG_HOME??join(homedir(),'.config'),state:process.env.XDG_STATE_HOME??join(homedir(),'.local/state'),bin:process.env.SPOOL_BIN_HOME??join(homedir(),'.local/bin')});
function save(path,value){mkdirSync(dirname(path),{recursive:true,mode:0o700});const stage=path+'.new-'+randomUUID();writeFileSync(stage,JSON.stringify(value,null,2)+'\n',{mode:0o600});renameSync(stage,path);}
export const updateStatus=(state,target='plugin')=>read(join(state,'updates-'+target+'.json'))??{mode:'off',target:'plugin',lastCheck:null};
const nativeRuntime=app=>{const mac=join(app,'runtime/bun-darwin-arm64');if(process.platform==='darwin'&&process.arch==='arm64'&&existsSync(mac))return mac;return existsSync(join(app,'runtime/bun'))?join(app,'runtime/bun'):process.execPath;};
export function findCodex(run=runDefault){
 try{const path=run('which',['codex']).trim();if(path.startsWith('/'))return path;}catch{}
 for(const name of ['Codex','ChatGPT']){const path='/Applications/'+name+'.app/Contents/Resources/codex';if(existsSync(path))return path;}
 throw Error('Codex command-line tools are required for plugin updates. Install the Codex CLI command from your desktop app first.');
}
export async function releaseInfo({fetcher=fetch}={}){
 const response=await fetcher('https://api.github.com/repos/ywnzo/spooldb/releases/latest',{headers:{accept:'application/vnd.github+json'},signal:AbortSignal.timeout(30000)});if(!response.ok)throw Error('Could not check releases: HTTP '+response.status);
 const bytes=await boundedBody(response,2000000),release=JSON.parse(bytes.toString());version(release.tag_name);if(release.draft||release.prerelease)throw Error('Expected a published stable release');
 return {version:release.tag_name.slice(1),url:origin+'/releases/tag/'+release.tag_name,assets:release.assets??[]};
}
async function boundedBody(response,maximum){const parts=[];let size=0;for await(const part of response.body){size+=part.length;if(size>maximum)throw Error('Update download exceeds size limit');parts.push(part);}return Buffer.concat(parts);}
function atomicCopy(source,target){const temporary=target+'.new-'+randomUUID();try{cpSync(source,temporary,{dereference:true});renameSync(temporary,target);}finally{rmSync(temporary,{force:true});}}
export function refreshUpdater(state,app){
 for(const target of ['plugin','client']){const config=updateStatus(state,target);if(!config.mode||config.mode==='off'||!config.paths)continue;const base=join(config.paths.data,'spool/updater');mkdirSync(base,{recursive:true,mode:0o700});atomicCopy(join(app,'src/update.js'),join(base,'update.js'));atomicCopy(nativeRuntime(app),join(base,'bun'));}
}
export function installedVersion(config,{run=runDefault}={}){
 if(config.target==='plugin'){
  const list=JSON.parse(run(config.codex??findCodex(run),['plugin','list','--json'],{env:{...process.env,...(config.codexHome?{CODEX_HOME:config.codexHome}:{})}}));
  const plugin=list.installed?.find(value=>value.pluginId==='spooldb@spooldb');if(!plugin)throw Error('SpoolDB is not installed from its Codex marketplace');if(plugin.marketplaceSource?.sourceType==='local')throw Error('This is a local plugin marketplace. Install SpoolDB from ywnzo/spooldb in Codex before enabling plugin updates.');return plugin.version;
 }
 const receipt=read(join(config.paths.data,'spool/installation.json'));if(!receipt)throw Error('Client updates require an installer-managed SpoolDB installation');return receipt.version;
}
export async function checkUpdate(config,options={}){const release=await releaseInfo(options),current=installedVersion(config,options);return {current,latest:release.version,available:newerVersion(release.version,current),release};}
export async function applyUpdate(config,{fetcher=fetch,run=runDefault}={}){
 const checked=await checkUpdate(config,{fetcher,run});if(!checked.available)return {...checked,updated:false};
 if(config.target==='plugin'){
  const command=config.codex??findCodex(run),options={env:{...process.env,...(config.codexHome?{CODEX_HOME:config.codexHome}:{})}};
  run(command,['plugin','marketplace','upgrade','spooldb'],options);
  const installed=JSON.parse(run(command,['plugin','add','spooldb@spooldb','--json'],options));
  if(installed.version!==checked.latest)throw Error('The marketplace is not ready for this release. Retry later.');
  if(installed.installedPath&&existsSync(join(installed.installedPath,'scripts/bootstrap.sh'))){run('sh',[join(installed.installedPath,'scripts/bootstrap.sh'),installed.installedPath],{timeout:180000});refreshUpdater(config.state,join(installed.installedPath,'app'));}
  return {...checked,updated:true,restartRequired:true,hookReviewRequired:true,message:'Plugin updated through Codex. Start a new chat and review any changed hooks in Codex.'};
 }
 if(process.platform!=='linux'||process.arch!=='x64')throw Error('The standalone client updater currently supports Linux x86-64; use the Codex plugin on Apple Silicon.');
 const name='spool-linux-x64.run',base=origin+'/releases/download/v'+checked.latest+'/';
 const download=async(name,max)=>{const asset=checked.release.assets.find(value=>value.name===name);if(!asset||asset.browser_download_url!==base+name)throw Error('Official update asset missing: '+name);const response=await fetcher(asset.browser_download_url,{signal:AbortSignal.timeout(120000)});if(!response.ok)throw Error('Update download failed: HTTP '+response.status);return boundedBody(response,max);};
 const sums=(await download('SHA256SUMS',100000)).toString(),matches=sums.split('\n').map(line=>line.trim().split(/\s+/)).filter(parts=>parts[1]===name);
 if(matches.length!==1||!/^[a-f0-9]{64}$/.test(matches[0][0]))throw Error('Official installer checksum missing');
 const data=await download(name,200000000);if(createHash('sha256').update(data).digest('hex')!==matches[0][0])throw Error('Update checksum mismatch; nothing was installed');
 const temporary=mkdtempSync(join(tmpdir(),'spool-update-'));
 try{const installer=join(temporary,name);writeFileSync(installer,data,{mode:0o700});run('sh',[installer,'--update'],{timeout:180000,env:{...process.env,XDG_DATA_HOME:config.paths.data,XDG_CONFIG_HOME:config.paths.config,XDG_STATE_HOME:config.paths.state,SPOOL_BIN_HOME:config.paths.bin}});}finally{rmSync(temporary,{recursive:true,force:true});}
 if(existsSync(join(config.paths.data,'spool/app/src/update.js')))refreshUpdater(config.state,join(config.paths.data,'spool/app'));
 return {...checked,updated:true,message:'Client updated; project memory and connections were preserved.'};
}
export function configureUpdates({state,mode,target='plugin',app,paths=defaultPaths(),run=runDefault,platform=process.platform,activate=true,codex}={}){
 if(!['off','check','automatic'].includes(mode)||!['plugin','client'].includes(target))throw Error('Choose update mode off, check or automatic and target plugin or client');
 if(!['linux','darwin'].includes(platform))throw Error('Automatic updates support Linux and macOS');
 state=resolve(state);app=resolve(app);const configPath=join(state,'updates-'+target+'.json'),prior=updateStatus(state,target),home=process.env.CODEX_HOME??join(homedir(),'.codex');
 const base=join(paths.data,'spool/updater'),script=join(base,'update.js'),runtime=join(base,'bun'),unit=join(paths.config,'systemd/user/spool-update-'+target+'.service'),timer=join(paths.config,'systemd/user/spool-update-'+target+'.timer'),agent=join(paths.home??homedir(),'Library/LaunchAgents/dev.spooldb.update.'+target+'.plist');
 const settings={...prior,mode,target,app,paths,state,codexHome:home,...(target==='plugin'&&mode!=='off'?{codex:codex??findCodex(run)}:{}),configuredAt:new Date().toISOString()};
 for(const path of [unit,timer,agent])if(existsSync(path)&&!readFileSync(path,'utf8').includes(marker))throw Error('An unmanaged update scheduler exists: '+path);
 if(mode==='off'){
  if(activate)try{if(platform==='linux')run('systemctl',['--user','disable','--now','spool-update-'+target+'.timer']);else run('launchctl',['bootout','gui/'+process.getuid(),agent]);}catch{}
  for(const path of platform==='linux'?[unit,timer]:[agent])rmSync(path,{force:true});save(configPath,settings);return settings;
 }
 if(target==='client')installedVersion(settings,{run});
 mkdirSync(base,{recursive:true,mode:0o700});const source=fileURLToPath(import.meta.url);if(resolve(source)!==resolve(script))atomicCopy(source,script);const executable=nativeRuntime(app);if(resolve(executable)!==resolve(runtime))atomicCopy(executable,runtime);
 const license=[join(app,'runtime/LICENSE'),join(app,'third-party/BUN-LICENSE.txt')].find(existsSync);if(license)cpSync(license,join(base,'LICENSE'));
 save(configPath,settings);
 if(platform==='linux'){
  mkdirSync(dirname(unit),{recursive:true});const quote=value=>JSON.stringify(value.replaceAll('%','%%').replaceAll('$','$$'));
  writeFileSync(unit,marker+'\n[Unit]\nDescription=SpoolDB update check\n[Service]\nType=oneshot\nTimeoutStartSec=10min\nUMask=0077\nExecStart='+[runtime,script,'--scheduled',configPath].map(quote).join(' ')+'\n');
  writeFileSync(timer,marker+'\n[Unit]\nDescription=SpoolDB automatic updates\n[Timer]\nOnBootSec=5m\nOnCalendar=hourly\nRandomizedDelaySec=5m\nPersistent=true\n[Install]\nWantedBy=timers.target\n');
  if(activate){run('systemctl',['--user','daemon-reload']);run('systemctl',['--user','enable','--now','spool-update-'+target+'.timer']);}
 }else{
  const xml=value=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');mkdirSync(dirname(agent),{recursive:true});
  writeFileSync(agent,'<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><!-- '+marker+' --><key>Label</key><string>dev.spooldb.update.'+target+'</string><key>ProgramArguments</key><array>'+[runtime,script,'--scheduled',configPath].map(value=>'<string>'+xml(value)+'</string>').join('')+'</array><key>StartInterval</key><integer>3600</integer><key>RunAtLoad</key><true/></dict></plist>');
  if(activate){try{run('launchctl',['bootout','gui/'+process.getuid(),agent]);}catch{}run('launchctl',['bootstrap','gui/'+process.getuid(),agent]);}
 }
 return {...settings,message:'Updates are checked daily. Automatic plugin updates use Codex and never approve changed hooks. The scheduler retries hourly if an agent session is active.'};
}
export async function scheduledUpdate(configPath,{now=Date.now(),...options}={}){
 const config=read(configPath);if(!config||config.mode==='off')return {skipped:'disabled'};
 const lock=configPath+'.lock';try{mkdirSync(lock);}catch(error){if(error.code!=='EEXIST')throw error;
  if(now-statSync(lock).mtimeMs<21600000)return {skipped:'another update is running'};
  let owner;try{owner=read(join(lock,'owner.json'));}catch{}if(Number.isInteger(owner?.pid)&&owner.pid>1){try{process.kill(owner.pid,0);return {skipped:'another update is running'};}catch(error){if(error.code==='EPERM')return {skipped:'another update is running'};}}
  rmSync(lock,{recursive:true,force:true});try{mkdirSync(lock);}catch{return {skipped:'another update is running'};}
 }
 try{
  save(join(lock,'owner.json'),{pid:process.pid});
  if(config.lastCheck&&now-Date.parse(config.lastCheck)<86400000)return {skipped:'checked recently'};
  // A live plugin session must keep its loaded version until it is finished.
  if(config.target==='plugin'){
   const {readdirSync}=await import('node:fs');const leases=join(config.state,'plugin-leases');
   if(existsSync(leases))for(const name of readdirSync(leases)){let lease;try{lease=read(join(leases,name));}catch{continue;}if(Number.isInteger(lease?.pid)&&lease.pid>1){try{process.kill(lease.pid,0);return {skipped:'an agent session is active'};}catch(error){if(error.code==='EPERM')return {skipped:'an agent session is active'};}}}
  }
  if(config.target==='plugin'&&config.mode==='automatic'){const list=JSON.parse((options.run??runDefault)(config.codex??findCodex(options.run),['plugin','list','--json'],{env:{...process.env,...(config.codexHome?{CODEX_HOME:config.codexHome}:{})}}));if(list.installed?.find(value=>value.pluginId==='spooldb@spooldb')?.enabled===false)return {skipped:'the plugin is disabled in Codex'};}
  const result=config.mode==='automatic'?await applyUpdate(config,options):await checkUpdate(config,options);save(configPath,{...config,lastCheck:new Date(now).toISOString(),lastResult:result,error:null});return result;
 }catch(error){save(configPath,{...config,lastAttempt:new Date(now).toISOString(),error:error.message});throw error;}finally{rmSync(lock,{recursive:true,force:true});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)&&process.argv[2]==='--scheduled')scheduledUpdate(process.argv[3]).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.message);process.exitCode=1;});
