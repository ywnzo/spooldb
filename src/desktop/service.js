#!/usr/bin/env bun
import {existsSync,mkdirSync,writeFileSync,readFileSync,lstatSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {hostname} from 'node:os';
import {startProject,initializeProject} from '../project.js';
import {ProjectManager} from '../project-manager.js';
import {previewInvite,joinInvite} from './join.js';
import {readInbox,dismissInvite} from './inbox.js';
import {defaultState,primaryDirectory,inboxPath} from './paths.js';
import {RepositoryDiscovery,serveDiscovery} from '../discovery.js';
import {WorkspaceClient} from '../team/workspace-client.js';
import {localWeb,pickFolder} from './web.js';
export async function startDesktop(root=defaultState(),{port=8787,setupPort=0,connector,history}={}){
 root=resolve(root);mkdirSync(root,{recursive:true,mode:0o700});const directory=primaryDirectory(root),inbox=inboxPath(root),ready=join(root,'service.json');let service,setup,discovery,closeDiscovery,busy=false;
 const publish=(origin,mode)=>writeFileSync(ready,JSON.stringify({origin,mode,pid:process.pid})+'\n',{mode:0o600});
 const workspace=new WorkspaceClient(root,{controlDirectory:directory,...(connector?{connector}:{}),manager:async path=>{if(path)await ensureProject(path,{captureFiles:false});return service?.manager;}});
 async function ensureProject(path,{captureFiles=true}={}){path=realpathSync(resolve(path));if(path===root||root.startsWith(path+'/'))throw new Error('Choose a source folder outside SpoolDB state');const top=execFileSync('git',['-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-C',path,'rev-parse','--show-toplevel'],{encoding:'utf8',timeout:10000,env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}}).trim();if(realpathSync(top)!==path)throw new Error('Choose the top-level Git project folder');if(!existsSync(join(directory,'project.json')))initializeProject(directory,path,{exclude:['.codex','.claude','.hermes','node_modules','dist','build','.next','.cache','.preview'],captureFiles});if(!service)service=await startProject(directory,{port,...(history?{history}:{}),inviteInbox:inbox,workspaceDirectory:root,discoverRepositories:false,discoveryHandler:input=>discovery.run(input)});publish(service.state.origin,'ready');}
 if(existsSync(join(directory,'project.json'))){service=await startProject(directory,{port,...(history?{history}:{}),inviteInbox:inbox,workspaceDirectory:root,discoverRepositories:false,discoveryHandler:input=>discovery.run(input)});publish(service.state.origin,'ready');}
 else{
  setup=await localWeb({page:'setup',port:setupPort,api:async(command,input)=>{
   if(command==='discovery')return discovery.run(input);
   if(command==='workspace'){const result=await workspace.run(input);if(input.command==='connect')await dismissInvite(inbox,input.link);return result.joined?{...result,origin:service.state.origin}:result;}
   if(command==='browse')return pickFolder();
   if(command==='status'){const pending=readInbox(inbox)[0];return {pending:pending?.link??null,device:hostname()};}
   if(command==='preview')return previewInvite(input.link,{directory});
   if(command!=='join')throw new Error('Unknown setup action');if(busy)throw new Error('Joining is already in progress');busy=true;
   try{
    if(typeof input.root!=='string'||!input.root.trim())throw new Error('Choose your local Git project folder');const path=resolve(input.root);if(path===root||root.startsWith(path+'/'))throw new Error('Choose a folder outside SpoolDB state');
    const git=args=>execFileSync('git',['-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-C',path,...args],{encoding:'utf8',timeout:10000,maxBuffer:16000000,env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}});
    if(git(['rev-parse','--show-toplevel']).trim()!==path)throw new Error('Choose the top-level Git project folder');
    if(!existsSync(join(directory,'project.json'))){const exclude=['.codex','.claude','.hermes','node_modules','dist','build','.next','.cache','.preview'];for(const name of git(['ls-files','--cached','--others','--exclude-standard','-z']).split('\0').filter(Boolean))try{if(lstatSync(join(path,name)).size>1000000)exclude.push(name);}catch{}initializeProject(directory,path,{exclude,captureFiles:!input.link});}
    if(!service)service=await startProject(directory,{port,...(history?{history}:{}),inviteInbox:inbox,workspaceDirectory:root,discoverRepositories:false,discoveryHandler:input=>discovery.run(input)});
    const result=input.link?await joinInvite({directory,manager:service.manager,link:input.link,root:path,device:input.device,captureConversations:input.captureConversations!==false,connectAgents:input.connectAgents!==false,...(connector?{connector}:{})}):{joined:false,project:{id:service.state.id}};
    if(input.link)await dismissInvite(inbox,input.link);publish(service.state.origin,'ready');return {...result,origin:service.state.origin};
   }finally{busy=false;}
  }});publish(setup.origin,'setup');
 }
 discovery=new RepositoryDiscovery(root,{workspace,manager:async()=>service?.manager,controlDirectory:directory,origin:()=>service?.state.origin??setup?.origin});closeDiscovery=await serveDiscovery(discovery);
 return {get origin(){return service?.state.origin??setup.origin;},close:async()=>{await closeDiscovery?.();await setup?.close();await service?.close();}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){process.umask(0o077);const root=process.argv[2]??defaultState();const service=await startDesktop(root,{port:Number(process.env.SPOOL_PORT??8787)});let closing=false;for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{if(closing)return;closing=true;await service.close();});}
