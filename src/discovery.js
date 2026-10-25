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
  if(input.command==='list')return {entries:this.entries,origin:this.origin(),companion:companionInfo()};
  const repo=repositoryAt(input.cwd??input.root);const within=relative(repo.root,this.directory);if(!within||(!within.startsWith('..')&&!within.startsWith('/')))throw new Error('Choose a source folder outside SpoolDB state');
  const id=digest(repo.root),scope=existsSync(join(this.workspace.directory,'workspace.json'))?JSON.parse(readFileSync(join(this.workspace.directory,'workspace.json'))).url:null;
  let entry=this.entries.find(e=>e.id===id);
  // A different repository always needs fresh sharing approval. Changing the active
  // enrollment workspace alone must not reassign an already approved checkout.
  const repositoryChanged=Boolean(entry && entry.repositoryKey!==repo.repositoryKey);
  const pendingWorkspaceChanged=Boolean(entry && entry.status!=='enrolled' && entry.workspace!==scope);
  if(repositoryChanged || pendingWorkspaceChanged){Object.assign(entry,repo,{status:'pending',workspace:scope});delete entry.projectId;delete entry.room;this.save();}
  // Previously connected folders retain their explicit authorization. No new capture or join occurs here.
  if(!entry){const manager=await this.manager(null),prior=manager?.list().find(p=>realpathSync(p.root)===repo.root);let shared;if(prior)shared=(await manager.get(prior.id)).teamState();entry={id,...repo,workspace:scope,status:shared?.configured?'enrolled':'pending',...(shared?.configured?{projectId:prior.id,room:shared.room}:{}),discoveredAt:new Date().toISOString()};this.entries.push(entry);this.save();}
  if(input.command==='approve-existing'){
   if(input.confirm!==true)throw new Error('Explicit user confirmation is required before connecting a repository');
   const manager=await this.manager(null),project=manager?.list().find(p=>realpathSync(p.root)===repo.root);if(!project)throw new Error('Connect this checkout to a shared project first');
   const shared=(await manager.get(project.id)).teamState();if(!shared.configured)throw new Error('Connect this checkout to a shared project first');
   Object.assign(entry,{status:'enrolled',room:shared.room,projectId:project.id,approvedAt:new Date().toISOString()});this.save();return {...entry,origin:this.origin(),controlDirectory:this.controlDirectory};
  }
  if(input.command==='ignore'){if(entry.status==='enrolled')throw new Error('This checkout is already connected. Pause its capture through project controls.');entry.status='ignored';this.save();return {...entry,origin:this.origin()};}
  if(input.command==='approve'){
   if(input.confirm!==true)throw new Error('Explicit user confirmation is required before connecting a repository');
   if(input.create===true&&input.room)throw Error('Choose either creating a new project or joining an existing project');
   let room=input.room;
   if(repo.repositoryKey){
    if(!room){const match=await this.workspace.run({command:'repository-match',repositoryKey:repo.repositoryKey});if(match.ambiguous)throw Error('Several existing shared projects use this repository. Choose which one to join.');if(match.project){if(entry.status==='enrolled'&&entry.room===match.project.room&&input.create!==true)return {...entry,origin:this.origin(),controlDirectory:this.controlDirectory};throw Error('This repository already belongs to '+JSON.stringify(match.project.name)+'. Ask whether to join it, then approve with that project selected. No connection was changed.');}}
    const result=await this.workspace.run({command:'repository-enroll',repositoryKey:repo.repositoryKey,name:input.name??repo.name,...(room?{mode:'join',room}:{mode:'create',requestId:'discovery-'+digest(JSON.stringify([repo.root,repo.repositoryKey,scope,input.name??repo.name]))})});if(!room&&result.enrollmentMode!=='create')throw Error('Upgrade the relay before creating a separate repository project. No local connection was changed.');room=result.project.room;
   }
   else if(!room)throw new Error('This repository has no supported origin remote. Choose an existing shared project explicitly.');
   // Global MCP/hooks handle the current checkout; do not install another project hook set.
   const result=await this.workspace.run({command:'join-local',room,root:repo.root,captureConversations:true,connectAgents:false});
   if(result.captureError)throw new Error(result.captureError);
   Object.assign(entry,{status:'enrolled',room,projectId:result.project.id,approvedAt:new Date().toISOString()});this.save();
  }
  if(input.command==='preview'){
   const workspace=await this.workspace.run({command:'list'});let match=null,matches=[],ambiguous=false;
   if(workspace.connected&&repo.repositoryKey){const result=await this.workspace.run({command:'repository-match',repositoryKey:repo.repositoryKey});match=result.project;matches=result.projects??(match?[match]:[]);ambiguous=Boolean(result.ambiguous);}
   return {...entry,origin:this.origin(),match,matches,ambiguous,projects:workspace.projects??[],canCreate:workspace.member?.canCreate??false,connected:workspace.connected};
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
