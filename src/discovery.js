import {companionInfo} from './plugin/companion-upgrade.js';
import {discoveryRequest} from './discovery-request.js';
import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync,chmodSync,unlinkSync,realpathSync} from 'node:fs';
import {join,relative} from 'node:path';
import {createServer,createConnection} from 'node:net';
import {createHash} from 'node:crypto';
import {repositoryAt} from './repository.js';
const digest=s=>createHash('sha256').update(s).digest('hex');
export {discoveryRequest} from './discovery-request.js';
export class RepositoryDiscovery{
 constructor(directory,{workspace,manager,controlDirectory=directory,origin=()=>null}){Object.assign(this,{directory,workspace,manager,controlDirectory,origin});this.path=join(directory,'discovery.json');this.entries=existsSync(this.path)?JSON.parse(readFileSync(this.path)).entries:[];this.tail=Promise.resolve();}
 save(){mkdirSync(this.directory,{recursive:true,mode:0o700});writeFileSync(this.path+'.tmp',JSON.stringify({entries:this.entries},null,2)+'\n',{mode:0o600});renameSync(this.path+'.tmp',this.path);}
 run(input){const result=this.tail.then(()=>this.execute(input));this.tail=result.catch(()=>{});return result;}
 async execute(input){
  if(input.command==='list'){const entries=[];for(const entry of this.entries){if(entry.status==='pending'&&entry.superproject)try{entries.push(await this.execute({command:'resolve',cwd:entry.root}));continue;}catch{}entries.push(entry);}return {entries,origin:this.origin(),companion:companionInfo()};}
  const repo=repositoryAt(input.cwd??input.root);const within=relative(repo.root,this.directory);if(!within||(!within.startsWith('..')&&!within.startsWith('/')))throw new Error('Choose a source folder outside SpoolDB state');
  const id=digest(repo.root),scope=null;
  let entry=this.entries.find(e=>e.id===id);
  // A different repository always needs fresh sharing approval. Saved management connections do not
  // reassign an already approved checkout.
  const repositoryChanged=Boolean(entry && entry.repositoryKey!==repo.repositoryKey);
  if(repositoryChanged){Object.assign(entry,repo,{status:'pending',workspace:scope});delete entry.projectId;delete entry.room;delete entry.retrospective;delete entry.workspaceProfile;this.save();}
  // Previously connected folders retain their explicit authorization. No new capture or join occurs here.
  if(!entry){const manager=await this.manager(null),prior=manager?.list().find(p=>realpathSync(p.root)===repo.root);let shared;if(prior)shared=(await manager.get(prior.id)).teamState();entry={id,...repo,workspace:shared?.configured?shared.url:scope,status:shared?.configured?'enrolled':'pending',...(shared?.configured?{projectId:prior.id,room:shared.room}:{}),discoveredAt:new Date().toISOString()};this.entries.push(entry);this.save();}
  // Registered Git submodules inherit the approved parent grant unless explicitly bound or skipped.
  // This is a virtual binding: never persist a copied grant or enroll another relay project.
  if(entry.status==='pending'&&repo.superproject&&['propose','resolve','preview'].includes(input.command)){
   const parent=await this.execute({command:'resolve',cwd:repo.superproject.root});
   if(parent.status==='enrolled')return {...entry,status:'enrolled',inherited:true,bindingRoot:parent.bindingRoot??parent.root,pathPrefix:relative(parent.bindingRoot??parent.root,repo.root),inheritedFrom:repo.superproject.root,projectId:parent.projectId,room:parent.room,workspace:parent.workspace,workspaceProfile:parent.workspaceProfile??null,retrospective:parent.retrospective,origin:this.origin(),controlDirectory:this.controlDirectory,connected:true,relay:parent.workspace,canCreate:false};
  }
  if(entry.status==='enrolled'){
   const manager=await this.manager(null),local=manager.list().find(p=>p.id===entry.projectId&&realpathSync(p.root)===repo.root);
   if(!local)throw Error('Repository binding is missing or points to another checkout. Reconnect this repository explicitly.');
   const shared=(await manager.get(local.id)).teamState();
   if(!shared.configured||shared.room!==entry.room)throw Error('Repository binding differs from its saved project connection. Reconnect it explicitly; no fallback was used.');
   if(entry.workspace!==shared.url){entry.workspace=shared.url;delete entry.workspaceProfile;this.save();}
  }
  // Only enrollment/management needs workspace credentials. Existing memory routing
  // uses the checkout's stored project grant, independent of saved management connections.
  let selectedWorkspace;
  const enrollmentWorkspace=async()=>{
   if(selectedWorkspace)return selectedWorkspace;
   const selector=input.workspace??(entry.status==='enrolled'?(entry.workspaceProfile??entry.workspace):null);
   if(selector)selectedWorkspace=await this.workspace.scoped(selector);else{const saved=await this.workspace.run({command:'profiles'});if(saved.workspaces.length!==1)throw Error('Choose a saved connection for this repository. There is no global workspace.');selectedWorkspace=await this.workspace.scoped(saved.workspaces[0].id);}
   return selectedWorkspace;
  };
  if(input.command==='retrospective'){
   if(entry.status!=='enrolled')throw Error('Connect this project before choosing historical analysis');
   if(input.confirm!==true)throw Error('Explicit user approval is required for the historical analysis choice');
   if(typeof input.analyzeExisting==='boolean'){
    if(input.analyzeExisting&&['pending','completed'].includes(entry.retrospective?.status)||!input.analyzeExisting&&entry.retrospective?.status==='declined')return {...entry,controlDirectory:this.controlDirectory};
    entry.retrospective={status:input.analyzeExisting?'pending':'declined',chosenAt:new Date().toISOString()};
   }else if(input.handoffId){
    if(entry.retrospective?.status==='completed'&&entry.retrospective.handoffId===input.handoffId)return {...entry,controlDirectory:this.controlDirectory};
    if(entry.retrospective?.status!=='pending')throw Error('Approve historical analysis before completing it');
    const manager=await this.manager(null),app=await manager.get(entry.projectId),record=await app.memory({command:'get',id:input.handoffId});
    if(record.kind!=='handoff')throw Error('A saved handoff in this project is required to complete historical analysis');
    entry.retrospective={...entry.retrospective,status:'completed',handoffId:record.id,completedAt:new Date().toISOString()};
   }else throw Error('Choose whether to analyze existing chats, or supply the saved completion handoff');
   this.save();return {...entry,controlDirectory:this.controlDirectory};
  }
  if(input.command==='approve-existing'){
   if(input.confirm!==true)throw new Error('Explicit user confirmation is required before connecting a repository');
   const manager=await this.manager(null),project=manager?.list().find(p=>realpathSync(p.root)===repo.root);if(!project)throw new Error('Connect this checkout to a shared project first');
   const shared=(await manager.get(project.id)).teamState();if(!shared.configured)throw new Error('Connect this checkout to a shared project first');
   if(entry.room&&entry.room!==shared.room)delete entry.retrospective;
   Object.assign(entry,{status:'enrolled',workspace:shared.url,room:shared.room,projectId:project.id,approvedAt:new Date().toISOString()});if(typeof input.analyzeExisting==='boolean')entry.retrospective={status:input.analyzeExisting?'pending':'declined',chosenAt:new Date().toISOString()};this.save();return {...entry,origin:this.origin(),controlDirectory:this.controlDirectory};
  }
  if(input.command==='ignore'){if(entry.status==='enrolled')throw new Error('This checkout is already connected. Pause its capture through project controls.');entry.status='ignored';this.save();return {...entry,origin:this.origin()};}
  if(input.command==='approve'){
   if(input.confirm!==true)throw new Error('Explicit user confirmation is required before connecting a repository');
   if(input.create===true&&input.room)throw Error('Choose either creating a new project or joining an existing project');
   let room=input.room;
   const selected=await enrollmentWorkspace(),relay=await selected.run({command:'list'});
   if(!room&&!relay.capabilities?.includes('repository-enrollment-v2')){const error=Error('This relay needs an update before creating repository projects. Existing projects can still be joined. Ask whether to update the selected relay or continue without SpoolDB. No project was created.');error.code='RELAY_UPDATE_REQUIRED';throw error;}
   if(repo.repositoryKey){
    if(!room){const match=await (await enrollmentWorkspace()).run({command:'repository-match',repositoryKey:repo.repositoryKey});if(match.ambiguous)throw Error('Several existing shared projects use this repository. Choose which one to join.');if(match.project){if(entry.status==='enrolled'&&entry.room===match.project.room&&input.create!==true)return {...entry,origin:this.origin(),controlDirectory:this.controlDirectory};throw Error('This repository already belongs to '+JSON.stringify(match.project.name)+'. Ask whether to join it, then approve with that project selected. No connection was changed.');}}
    const result=await (await enrollmentWorkspace()).run({command:'repository-enroll',repositoryKey:repo.repositoryKey,name:input.name??repo.name,...(room?{mode:'join',room}:{mode:'create',requestId:'discovery-'+digest(JSON.stringify([repo.root,repo.repositoryKey,scope,input.name??repo.name]))})});if(!room&&result.enrollmentMode!=='create'){const match=await selected.run({command:'repository-match',repositoryKey:repo.repositoryKey});if(match.ambiguous||!match.project||match.project.room!==result.project?.room){const error=Error('Relay enrollment could not be verified. A remote project may have been created; preview this repository before retrying. No local binding was changed.');error.code='ENROLLMENT_UNVERIFIED';throw error;}}room=result.project.room;
   }
   else if(!room)throw new Error('This repository has no supported origin remote. Choose an existing shared project explicitly.');
   // Global MCP/hooks handle the current checkout; do not install another project hook set.
   const result=await (await enrollmentWorkspace()).run({command:'join-local',room,root:repo.root,captureConversations:true,connectAgents:false});
   if(result.captureError)throw new Error(result.captureError);
   if(entry.room&&entry.room!==room)delete entry.retrospective;
   Object.assign(entry,{status:'enrolled',workspace:result.relay??(await enrollmentWorkspace()).connection?.url??scope,workspaceProfile:result.workspaceProfile??null,room,projectId:result.project.id,approvedAt:new Date().toISOString()});this.save();
  }
  if(['approve','approve-existing'].includes(input.command)&&typeof input.analyzeExisting==='boolean'){entry.retrospective={status:input.analyzeExisting?'pending':'declined',chosenAt:new Date().toISOString()};this.save();}
  if(input.command==='preview'){
   if(!input.workspace&&entry.status!=='enrolled'){const saved=await this.workspace.run({command:'profiles'});if(saved.workspaces.length!==1)return {...entry,origin:this.origin(),connected:false,selectionRequired:true,workspaces:saved.workspaces,projects:[],matches:[],canCreate:false};}
   const selectedWorkspace=await enrollmentWorkspace(),workspace=await selectedWorkspace.run({command:'list'});const saved=await this.workspace.run({command:'profiles'});let match=null,matches=[],ambiguous=false;
   if(workspace.connected&&repo.repositoryKey){const result=await (await enrollmentWorkspace()).run({command:'repository-match',repositoryKey:repo.repositoryKey});match=result.project;matches=result.projects??(match?[match]:[]);ambiguous=Boolean(result.ambiguous);}
   return {...entry,origin:this.origin(),relayUpdate:workspace.capabilities?.includes('repository-enrollment-v2')?null:{required:true,reason:'This relay predates safe repository creation. Join existing projects now, or offer to update this relay before creating one.',next:{tool:'spool_setup',arguments:{action:'relay_update',workspace:workspace.workspaceProfile}}},match,matches,ambiguous,projects:workspace.projects??[],canCreate:workspace.member?.canCreate??false,connected:workspace.connected,relay:workspace.relay,workspaceName:workspace.workspace?.name,workspaceProfile:workspace.workspaceProfile??null,workspaces:saved.workspaces??[]};
  }
  if(!['propose','resolve','preview','approve'].includes(input.command))throw new Error('Unknown discovery command');
  return {...entry,origin:this.origin(),controlDirectory:this.controlDirectory};
 }
}
export async function serveDiscovery(discovery){
 const path=join(discovery.directory,'discovery.sock');
 if(existsSync(path)){try{await discoveryRequest(discovery.directory,{command:'list'});throw new Error('Discovery service already running');}catch(error){if(error.code!=='ECONNREFUSED')throw error;unlinkSync(path);}}
 const server=createServer(socket=>{let buffer='',handled=false;socket.setTimeout(65000,()=>socket.destroy());socket.on('error',()=>{});socket.on('data',chunk=>{if(handled)return;buffer+=chunk;if(buffer.length>20000)return socket.destroy();if(!buffer.includes('\n'))return;handled=true;Promise.resolve().then(()=>discovery.run(JSON.parse(buffer.split('\n')[0]))).then(result=>socket.end(JSON.stringify({result})+'\n'),error=>socket.end(JSON.stringify({error:error.message})+'\n'));});});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(path,resolve);});chmodSync(path,0o600);
 return async()=>{await discovery.tail;await new Promise(resolve=>server.close(resolve));if(existsSync(path))unlinkSync(path);};
}
