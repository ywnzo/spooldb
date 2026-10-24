#!/usr/bin/env bun
import {bundledRuntime} from '../runtime.js';
import {mkdirSync,existsSync,readFileSync,writeFileSync,renameSync,rmSync,cpSync,openSync,closeSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {homedir,hostname} from 'node:os';
import {execFileSync,spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline/promises';
import {stdin,stdout} from 'node:process';
import {desktopPaths,defaultState} from './paths.js';
import {isWorkspaceLink,parseWorkspaceLink} from '../team/workspace.js';
import {previewInvite} from './join.js';
import {parseInvite} from '../team/invites.js';
import {registerCLI,assertCLIWritable} from './cli-launcher.js';
import {launch} from './launcher.js';
const marker='# Managed by SpoolDB desktop installer';
const desktopQuote=value=>'"'+value.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('`','\\`').replaceAll('$','\\$').replaceAll('%','%%')+'"';
const unitQuote=value=>JSON.stringify(value.replaceAll('%','%%').replaceAll('$','$$'));
export function verifyBundle(bundle){const manifest=JSON.parse(readFileSync(join(bundle,'manifest.json')));for(const [name,expected]of Object.entries(manifest.files)){if(name.startsWith('/')||name.split('/').some(p=>p==='..'))throw new Error('Invalid package manifest');const actual=createHash('sha256').update(readFileSync(join(bundle,name))).digest('hex');if(actual!==expected)throw new Error('Package integrity check failed: '+name);}return manifest;}
export function registerDesktop({app,state,paths=desktopPaths(),activate=true,existing=false}){
 for(const value of [app,state,paths.data,paths.config])if(/[\x00-\x1f\x7f]/.test(value))throw new Error('Unsupported control character in installation path');
 const applications=join(paths.data,'applications');mkdirSync(applications,{recursive:true});const command=[bundledRuntime(app),join(app,'src/desktop/launcher.js'),'--state',state,...(existing?['--existing']:[])].map(desktopQuote).join(' ');
 const desktop=join(applications,'spool.desktop');writeFileSync(desktop,`[Desktop Entry]\nType=Application\nName=SpoolDB\nComment=Shared project memory for coding agents\nExec=${command} %u\nIcon=${join(app,'src/desktop/icon.svg')}\nTerminal=false\nCategories=Development;\nMimeType=x-scheme-handler/spool;\nStartupNotify=false\n`);
 if(activate){try{execFileSync('update-desktop-database',[applications],{stdio:'ignore'});}catch{}execFileSync('xdg-mime',['default','spool.desktop','x-scheme-handler/spool'],{stdio:'ignore'});}return desktop;
}
export async function installApp({bundle,paths=desktopPaths(),activate=true,strictService=false,onProgress=()=>{}}){
 if(process.platform!=='linux'||process.arch!=='x64')throw new Error('This package supports Linux x86-64.');
 assertCLIWritable(paths);const manifest=verifyBundle(bundle),base=join(paths.data,'spool'),app=join(base,'app'),state=join(paths.state,'spool'),unitDir=join(paths.config,'systemd/user'),unit=join(unitDir,'spool.service'),receipt=join(base,'installation.json');
 if(existsSync(unit)&&!readFileSync(unit,'utf8').includes(marker))throw new Error('An independently managed SpoolDB service already exists. Keep using it or migrate its state before installing this package.');
 if(existsSync(app)&&!existsSync(receipt))throw new Error('The installation folder contains an unmanaged app; choose a different XDG_DATA_HOME.');
 mkdirSync(base,{recursive:true,mode:0o700});mkdirSync(state,{recursive:true,mode:0o700});const lock=join(base,'install.lock');const fd=openSync(lock,'wx',0o600);let staged,backup;const previousUnit=existsSync(unit)?readFileSync(unit,'utf8'):null;
 try{
  onProgress('Copying bundled runtime and application…');staged=join(base,'app-new-'+randomUUID());cpSync(bundle,staged,{recursive:true,dereference:false});
  if(activate&&existsSync(unit))execFileSync('systemctl',['--user','stop','spool.service'],{stdio:'ignore',timeout:45000});
  if(existsSync(app)){backup=join(base,'app-previous-'+Date.now());renameSync(app,backup);}renameSync(staged,app);staged=null;mkdirSync(unitDir,{recursive:true});
  const runtime=bundledRuntime(app),service=join(app,'src/desktop/service.js');writeFileSync(unit,`${marker}\n[Unit]\nDescription=SpoolDB project memory and capture\nStartLimitIntervalSec=60\nStartLimitBurst=5\n\n[Service]\nType=simple\nExecStart=${[runtime,service,state].map(unitQuote).join(' ')}\nEnvironment=${unitQuote('PATH='+join(app,'runtime')+':'+(process.env.PATH??'/usr/bin:/bin'))}\nRestart=on-failure\nRestartSec=3\nTimeoutStopSec=45\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`);
  onProgress('Registering the app and invite links…');const desktop=registerDesktop({app,state,paths,activate});let background='systemd';
  if(activate)try{execFileSync('systemctl',['--user','daemon-reload'],{stdio:'ignore'});execFileSync('systemctl',['--user','enable','--now','spool.service'],{stdio:'ignore',timeout:15000});}catch(error){if(strictService)throw error;background='desktop-autostart';mkdirSync(join(paths.config,'autostart'),{recursive:true});writeFileSync(join(paths.config,'autostart/spool.desktop'),`[Desktop Entry]\nType=Application\nName=SpoolDB background capture\nExec=${[runtime,service,state].map(desktopQuote).join(' ')}\nTerminal=false\n`);}
  const cli=registerCLI({app,state,paths});const result={cli,version:manifest.version,app,state,unit,desktop,background,installedAt:new Date().toISOString()};writeFileSync(receipt,JSON.stringify(result,null,2)+'\n',{mode:0o600});return result;
 }catch(error){if(backup&&existsSync(backup)){rmSync(app,{recursive:true,force:true});renameSync(backup,app);if(previousUnit!==null)writeFileSync(unit,previousUnit);if(activate)try{execFileSync('systemctl',['--user','daemon-reload'],{stdio:'ignore'});execFileSync('systemctl',['--user','restart','spool.service'],{stdio:'ignore',timeout:15000});}catch{}}throw error;}finally{if(staged)rmSync(staged,{recursive:true,force:true});closeSync(fd);rmSync(lock,{force:true});}
}
async function localApi(origin,path,input){const prefix=path.startsWith('local/')?'local':'api';const session=await fetch(origin+'/'+prefix+'/session',{headers:{'sec-fetch-site':'same-origin'}}),cookie=session.headers.get('set-cookie')?.split(';')[0],auth=await session.json();const response=await fetch(origin+'/'+path,{method:'POST',headers:{'sec-fetch-site':'same-origin',origin,'content-type':'application/json',cookie,'x-spool-csrf':auth.csrf},body:JSON.stringify(input)});const result=await response.json();if(!response.ok)throw new Error(typeof result.error==='string'?result.error:result.error?.message??'Setup failed');return result;}
export function installerInvitation(args){const index=args.indexOf('--invite-file');if(index<0)return null;const path=args[index+1];if(!path||path.startsWith('--'))throw new Error('Supply an invitation file after --invite-file');const link=readFileSync(path,'utf8').trim();if(isWorkspaceLink(link))parseWorkspaceLink(link);else parseInvite(link);return link;}
async function interactive(){
 const suppliedInvite=installerInvitation(process.argv.slice(2));
 const bundle=fileURLToPath(new URL('../../',import.meta.url));if(process.argv.includes('--update')){if(process.argv.includes('--server'))throw Error('Use the server deployment workflow to upgrade a relay');const result=await installApp({bundle,strictService:true});console.log(JSON.stringify({...result,updated:true}));return;}if(process.argv.includes('--server')&&!process.argv.includes('--verify-only')){verifyBundle(bundle);const {interactiveServerSetup}=await import('../server-setup.js');return interactiveServerSetup({bundle});}if(process.argv.includes('--verify-only')){verifyBundle(bundle);const {ShardedEngine}=await import('../index.js');const engine=new ShardedEngine(':memory:');engine.create();engine.close();console.log('SpoolDB package and bundled runtime verified.');return;}
 try{execFileSync('git',['--version'],{stdio:'ignore'});}catch{throw new Error('Git is required. Install Git with your distribution’s software manager, then run this installer again.');}
 const rl=createInterface({input:stdin,output:stdout});const ask=async(question,value='')=>{const reply=(await rl.question(question+(value?' ['+value+']':'')+': ')).trim();return reply||value;};const yes=async question=>!/^(n|no)$/i.test(await ask(question+' (Y/n)','Y'));
 try{
  console.log('\nSpoolDB — shared project memory\nInstalls for your user, with a bundled runtime and background startup. No sudo needed.\n');const paths=desktopPaths();console.log('Application: '+join(paths.data,'spool/app')+'\nPrivate state: '+join(paths.state,'spool'));
  if(!await yes('Install SpoolDB'))return;const installed=await installApp({bundle,onProgress:message=>console.log('  '+message)});const ready=await launch({root:installed.state,noOpen:true});console.log('\nCLI command: '+installed.cli);console.log('\nInstalled. Invite links now open SpoolDB.');
  const link=suppliedInvite??await ask('Paste an invite link to join now, or press Enter to do it later');
  if(link){let done=false;while(!done)try{if(isWorkspaceLink(link)){const device=await ask('Name this computer',hostname()),mode=JSON.parse(readFileSync(join(installed.state,'service.json'))).mode;const result=await localApi(ready.origin,mode==='setup'?'api/workspace':'local/workspace',{command:'connect',link,device});console.log('Connected to '+result.workspace.name+'. Create or join a project in the UI.');done=true;break;}const preview=await previewInvite(link,{directory:join(installed.state,'p')});console.log('\nProject: '+preview.project+'\nRelay: '+preview.relay);const root=resolve((await ask('Local Git project folder',process.cwd())).replace(/^~(?=\/|$)/,homedir()));const device=await ask('Name this computer',hostname());const captureConversations=await yes('Share saved Codex conversations and project memory (code stays in Git)');if(!captureConversations){console.log('Not joined. Opening an invite later will let you choose what to share.');break;}const connectAgents=await yes('Connect Codex and Codex in Zed automatically');const mode=JSON.parse(readFileSync(join(installed.state,'service.json'))).mode;console.log('  Connecting project and recording background capture…');const result=await localApi(ready.origin,mode==='setup'?'api/join':'local/invites/join',{link,root,device,captureConversations,connectAgents});console.log('\nJoined '+(result.project?.name??preview.project)+'. Shared memory is ready.');if(result.agentError)console.log('Agent connection needs attention: '+result.agentError);if(result.captureError)console.log('Conversation capture needs attention: '+result.captureError);done=true;}catch(error){console.log('\n'+error.message);if(!await yes('Retry joining'))break;}}
  if(await yes('Detect repositories in new Codex sessions (ask before connecting each checkout)'))try{execFileSync(bundledRuntime(installed.app),[join(installed.app,'src/cli.js'),'discovery','enable','--state',installed.state],{stdio:'inherit',timeout:90000});console.log('Discovery is ready. Reopen Codex or Codex in Zed to load it.');}catch(error){console.log('Discovery needs attention: '+error.message+'; retry with spool discovery enable');}
  if(await yes('Open SpoolDB'))await launch({root:installed.state});console.log('\nYou can reopen SpoolDB from your application menu. Capture starts at sign-in.\n');
 }finally{rl.close();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){process.umask(0o077);interactive().catch(error=>{console.error('\nInstallation could not finish: '+error.message);process.exitCode=1;});}
