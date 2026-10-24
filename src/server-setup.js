#!/usr/bin/env bun
import {bundledRuntime} from './runtime.js';
import {existsSync,mkdirSync,readFileSync,writeFileSync,cpSync,renameSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline/promises';
import {stdin,stdout} from 'node:process';
import {userInfo,networkInterfaces} from 'node:os';
import {registerCLI,assertCLIWritable} from './desktop/cli-launcher.js';
import {desktopPaths} from './desktop/paths.js';
import {startTeamHost,hostRequest} from './team/host.js';
import {setTimeout as delay} from 'node:timers/promises';
const marker='# Managed by SpoolDB server setup';
const quote=value=>JSON.stringify(value.replaceAll('%','%%').replaceAll('$','$$'));
export async function configureServer({state,app,workspaceName,publicOrigin,port=8878,host='127.0.0.1',tls=false,paths=desktopPaths(),activate=true}){
 assertCLIWritable(paths);state=resolve(state);app=resolve(app);const url=new URL(publicOrigin);if(url.username||url.password||url.pathname!=='/'||url.search||url.hash||!['https:','http:'].includes(url.protocol)||url.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new Error('Use an HTTPS public origin, or loopback HTTP');if(!Number.isInteger(port)||port<1||port>65535||!['127.0.0.1','0.0.0.0','::1'].includes(host))throw new Error('Invalid listener');
 const unit=join(paths.config,'systemd/user/spool-shared.service');if(existsSync(unit)&&!readFileSync(unit,'utf8').includes(marker))throw new Error('An independently managed shared relay service exists; configure its workspace with the host CLI instead of replacing it');if(existsSync(join(state,'admin.sock')))throw new Error('Stop the existing relay before setup');
 mkdirSync(state,{recursive:true,mode:0o700});const config={port,host,publicOrigin:url.origin,tls};writeFileSync(join(state,'server.json'),JSON.stringify(config,null,2)+'\n',{mode:0o600});
 const server=await startTeamHost(state,{port:0,host:'127.0.0.1',publicOrigin:url.origin,tls});let enrollment;try{enrollment=server.command({command:'workspace-init',name:workspaceName});}finally{await server.close();}
 mkdirSync(join(paths.config,'systemd/user'),{recursive:true});const runtime=bundledRuntime(app);
 writeFileSync(unit,`${marker}\n[Unit]\nDescription=SpoolDB shared workspace memory\nAfter=network.target\n\n[Service]\nExecStart=${[runtime,join(app,'src/server-service.js'),state].map(quote).join(' ')}\nRestart=on-failure\nRestartSec=3\nUMask=0077\nTimeoutStopSec=45\n\n[Install]\nWantedBy=default.target\n`);
 if(activate){execFileSync('systemctl',['--user','daemon-reload'],{stdio:'ignore'});execFileSync('systemctl',['--user','enable','--now','spool-shared.service'],{stdio:'ignore',timeout:15000});let ready=false;const deadline=Date.now()+10000;while(Date.now()<deadline){try{await hostRequest(state,{command:'list'});ready=true;break;}catch{await delay(100);}}if(!ready)throw new Error('Server did not become ready. Check journalctl --user -u spool-shared.service');}
 const cli=registerCLI({app,serverState:state,paths,runtime});return {cli,state,unit,origin:url.origin,workspace:enrollment.workspace,ownerLink:enrollment.link??null,alreadyConfigured:Boolean(enrollment.alreadyConfigured)};
}
export async function interactiveServerSetup({bundle}={}){
 const rl=createInterface({input:stdin,output:stdout}),ask=async(label,value='')=>(await rl.question(label+(value?' ['+value+']':'')+': ')).trim()||value;
 try{const paths=desktopPaths();let address='localhost';try{address=Object.values(networkInterfaces()).flat().find(value=>value.family==='IPv4'&&!value.internal)?.address??address;}catch{}console.log('\nSpoolDB server setup\nOne server hosts multiple projects. Shared memory contains conversations and Git references; repository code stays in Git.\n');
 const workspaceName=await ask('Workspace name','Company workspace'),state=resolve(await ask('Persistent server storage',join(paths.state,'spool-server'))),mode=await ask('HTTPS mode: 1 = private LAN certificate, 2 = your HTTPS reverse proxy','1'),port=Number(await ask('Relay port','8878')),publicOrigin=await ask('Reachable server URL (include https://)',mode==='1'?'https://'+address+':'+port:'https://memory.example.com'),host=mode==='1'?'0.0.0.0':'127.0.0.1';
 const checkUrl=new URL(publicOrigin);if(checkUrl.username||checkUrl.password||checkUrl.pathname!=='/'||checkUrl.search||checkUrl.hash||!['https:','http:'].includes(checkUrl.protocol)||checkUrl.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(checkUrl.hostname))throw new Error('Enter a valid HTTPS server origin');if(!['1','2'].includes(mode)||!Number.isInteger(port)||port<1||port>65535)throw new Error('Choose mode 1 or 2 and a valid port');
 if(mode==='1')try{execFileSync('openssl',['version'],{stdio:'ignore'});}catch{throw new Error('Install OpenSSL with your distribution’s software manager to use private LAN TLS.');}
 console.log('\nWorkspace: '+workspaceName+'\nURL: '+publicOrigin+'\nStorage: '+state+'\nBackground service: spool-shared.service (current user)');if(!/^y(es)?$/i.test(await ask('Install and start server? (y/N)','N')))return;
 let app=fileURLToPath(new URL('../',import.meta.url));
 if(bundle){app=join(paths.data,'spool-server/app');const unit=join(paths.config,'systemd/user/spool-shared.service');if(existsSync(unit)&&!readFileSync(unit,'utf8').includes(marker))throw new Error('An independently managed shared relay already exists; it has not been changed');mkdirSync(join(paths.data,'spool-server'),{recursive:true});const staged=app+'-new';if(existsSync(staged))throw new Error('A staged server install exists; inspect it before retrying');cpSync(bundle,staged,{recursive:true});if(existsSync(app)){try{execFileSync('systemctl',['--user','stop','spool-shared.service'],{stdio:'ignore'});}catch{}renameSync(app,app+'-previous-'+Date.now());}renameSync(staged,app);}
 const result=await configureServer({state,app,workspaceName,publicOrigin,port,host,tls:mode==='1'});console.log('\nCLI command: '+result.cli);console.log('\nServer ready: '+result.origin+'\nOpen your client UI → Company workspace and paste this private owner setup link:\n');console.log(result.ownerLink??'Workspace already configured. Existing owners can reconnect; local administrator recovery is available with workspace-owner-invite.');console.log('\nKeep the owner link private. It expires in 24 hours and can be used once.\n');if(mode==='1')console.log('Allow the chosen relay port through your LAN firewall. Other machines must be able to reach the URL above.');else console.log('Configure your HTTPS reverse proxy to forward the public URL to 127.0.0.1:'+port+'.');if(/^y(es)?$/i.test(await ask('Keep server running after logout and start it at boot? (Y/n)','Y'))){try{execFileSync('loginctl',['enable-linger',userInfo().username],{stdio:'inherit',timeout:60000});console.log('Background startup at boot enabled.');}catch{console.log('An administrator must run: sudo loginctl enable-linger '+userInfo().username);}}else console.log('Server starts at sign-in.');
 }finally{rl.close();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){process.umask(0o077);interactiveServerSetup().catch(error=>{console.error('Server setup could not finish: '+error.message);process.exitCode=1;});}
