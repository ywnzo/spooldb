import {existsSync,readFileSync,writeFileSync,mkdirSync,cpSync,renameSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
export const companionVersion=JSON.parse(readFileSync(new URL('../../package.json',import.meta.url))).version;
export const companionInfo=()=>({protocol:'spool-companion/1',version:companionVersion,pid:process.pid,kind:process.env.SPOOL_COMPANION_KIND??'native',capabilities:['git-submodules']});
export function compatibleCompanion(info){if(info?.protocol!=='spool-companion/1'||!info.capabilities?.includes('git-submodules'))return false;const parse=value=>/^\d+\.\d+\.\d+$/.test(value??'')?value.split('.').map(Number):null,a=parse(info.version),b=parse(companionVersion);if(!a)return false;for(let i=0;i<3;i++)if(a[i]!==b[i])return a[i]>b[i];return true;}
const runDefault=(command,args)=>execFileSync(command,args,{encoding:'utf8',timeout:45000,stdio:['ignore','pipe','pipe']});
export function recognizedPluginProcess(command,state){const words=command.trim().split('\0').filter(Boolean);if(words.length>1)return words.length===3&&words[1].endsWith('/src/plugin/service.js')&&resolve(words[2])===resolve(state);return /\/src\/plugin\/service\.js /.test(command)&&command.trim().endsWith('/src/plugin/service.js '+resolve(state));}
export async function upgradeCompanion(state,{run=runDefault,kill=(pid,signal)=>process.kill(pid,signal),platform=process.platform,unit=join(process.env.XDG_CONFIG_HOME??join(homedir(),'.config'),'systemd/user/spool.service'),app=fileURLToPath(new URL('../../',import.meta.url)),stageApp}={}){
 // A legacy plugin-owned service records its PID. Verify its actual command;
 // never terminate an arbitrary PID from a stale readiness file.
 const ready=join(state,'service.json');if(existsSync(ready)){
  const pid=JSON.parse(readFileSync(ready)).pid;if(Number.isInteger(pid)&&pid>1){let command;try{command=platform==='linux'?readFileSync('/proc/'+pid+'/cmdline','utf8'):run('ps',['-p',String(pid),'-o','command=']);}catch{}if(command&&recognizedPluginProcess(command,state)){kill(pid,'SIGTERM');for(let i=0;i<80;i++){try{kill(pid,0);}catch{return {stopped:true};}await delay(100);}throw Error('The older plugin companion is still shutting down; retry setup. It was not force-killed.');}}
 }
 if(platform!=='linux'||!existsSync(unit))throw Error('SpoolDB found an outdated companion without a recognized managed service. Update that companion before retrying; no process or project data was changed.');
 const before=readFileSync(unit,'utf8'),line=before.split('\n').find(value=>value.startsWith('ExecStart='));
 const suffix=' start '+state;const match=line?.match(/^(ExecStart=).*\/src\/project-cli\.js"?( start .*)$/);
 const desktop=line?.match(/^ExecStart=.*\/src\/desktop\/service\.js"? (.+)$/);
 const desktopState=desktop?.[1];const isDesktop=desktopState===state||desktopState===JSON.stringify(state);
 const managedArgs=match&&(match[2]===suffix||new RegExp('^'+suffix.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+' --port=\\d+$').test(match[2]));
 if(!/Description=SpoolDB/.test(before)||!managedArgs&&!isDesktop)throw Error('The outdated companion service is independently configured. No service or project data was changed.');
 const base=join(state,'companion-runtime'),target=join(base,companionVersion+'-'+randomUUID());mkdirSync(base,{recursive:true,mode:0o700});
 if(stageApp)stageApp(target);else{mkdirSync(target,{mode:0o700});for(const name of ['src','schemas','package.json','node_modules'])cpSync(join(app,name),join(target,name),{recursive:true});mkdirSync(join(target,'runtime'));cpSync(process.execPath,join(target,'runtime/bun'));}
 const quote=value=>JSON.stringify(value.replaceAll('%','%%').replaceAll('$','$$'));
 const after=before.replace(/^ExecStart=.*$/m,'ExecStart='+quote(join(target,'runtime/bun'))+' '+quote(join(target,isDesktop?'src/desktop/service.js':'src/project-cli.js'))+(isDesktop?' '+desktopState:match[2]));
 const backup=join(base,'service-before-'+randomUUID()+'.unit');writeFileSync(backup,before,{mode:0o600});
 try{writeFileSync(unit+'.spool-next',after,{mode:0o600});renameSync(unit+'.spool-next',unit);run('systemctl',['--user','daemon-reload']);run('systemctl',['--user','restart','spool.service']);return {upgraded:true,backup,rollback(){writeFileSync(unit,before,{mode:0o600});run('systemctl',['--user','daemon-reload']);run('systemctl',['--user','restart','spool.service']);}};}catch(error){writeFileSync(unit,before,{mode:0o600});try{run('systemctl',['--user','daemon-reload']);run('systemctl',['--user','restart','spool.service']);}catch{}rmSync(target,{recursive:true,force:true});throw Error('Companion upgrade failed; the previous service configuration was restored. '+error.message);}
}
