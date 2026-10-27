import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {mkdirSync,existsSync,readFileSync,writeFileSync,renameSync,rmSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes,createHash,randomUUID} from 'node:crypto';
import {hostname} from 'node:os';
import {parseWorkspaceLink} from './workspace.js';
import {PROTOCOL,RelayError} from '../relay/wire.js';
import {repositoryAt} from '../repository.js';
import {connectCodexMemory} from '../codex-connection.js';
const hash=value=>createHash('sha256').update(value).digest('hex');
const save=(path,value)=>{const tmp=path+'.'+randomUUID()+'.tmp';try{writeFileSync(tmp,JSON.stringify(value)+'\n',{mode:0o600});renameSync(tmp,path);}finally{rmSync(tmp,{force:true});}};
export function workspaceRequest(connection,action,input={}){return new Promise((resolve,reject)=>{const url=new URL(connection.url);if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||!['https:','http:'].includes(url.protocol)||url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))return reject(new Error('Use an HTTPS relay origin or loopback HTTP'));const body=JSON.stringify(input),req=(url.protocol==='https:'?httpsRequest:httpRequest)(new URL('/v1/workspace/'+action,url),{method:'POST',ca:connection.ca,rejectUnauthorized:true,timeout:10000,headers:{authorization:action==='action'?'Workspace '+connection.token:'Invite '+connection.code,'content-type':'application/json','content-length':Buffer.byteLength(body)}},res=>{let data='';res.setEncoding('utf8');res.on('error',reject);res.on('data',chunk=>{data+=chunk;if(Buffer.byteLength(data)>1000000)res.destroy(new Error('Workspace response too large'));});res.on('end',()=>{try{const value=JSON.parse(data);if(res.statusCode!==200)throw new RelayError(value.error?.code??'WORKSPACE',value.error?.message??'Workspace request failed',res.statusCode);if(value.protocol!==PROTOCOL)throw new Error('Unexpected workspace response');resolve(value);}catch(error){reject(error);}});});req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('Workspace request timed out')));req.end(body);});}
export class WorkspaceClient{
 constructor(directory,{manager,connector=connectCodexMemory,controlDirectory=directory}={}){Object.assign(this,{directory,manager,connector,controlDirectory});mkdirSync(directory,{recursive:true,mode:0o700});this.profilesPath=join(directory,'workspace-profiles');this.path=join(directory,'workspace.json');this.connection=null;}
 profiles(){return existsSync(this.profilesPath)?readdirSync(this.profilesPath).filter(name=>/^[a-f0-9]{64}\.json$/.test(name)).map(name=>JSON.parse(readFileSync(join(this.profilesPath,name)))):[];}
 remember(connection,data){const existing=this.profiles().find(p=>p.connection.url===connection.url&&(p.workspace.id===data.workspace.id||p.connection.token===connection.token)),id=existing?.id??hash(connection.url+'#'+data.workspace.id);mkdirSync(this.profilesPath,{recursive:true,mode:0o700});save(join(this.profilesPath,id+'.json'),{id,workspace:data.workspace,member:data.member,connection});return id;}
 async migrateLegacy(){
  if(!existsSync(this.path))return;
  const connection=JSON.parse(readFileSync(this.path));
  if(!this.profiles().some(p=>p.connection.url===connection.url&&p.connection.token===connection.token)){
   let data;try{data=await workspaceRequest(connection,'action',{command:'list'});}catch{data={workspace:{id:'unverified-'+hash(connection.token),name:'Saved connection at '+new URL(connection.url).host},member:null};}
   this.remember(connection,data);
  }
  // Preserve the legacy credential as a private migration backup, never as a default.
  try{renameSync(this.path,this.path+'.migrated-'+randomUUID());}catch(error){if(error.code!=='ENOENT')throw error;}
 }
 publicProfiles(){return this.profiles().map(p=>({id:p.id,name:p.workspace.name,relay:p.connection.url,role:p.member?.role}));}
 async scoped(selector){
  await this.migrateLegacy();const profiles=this.profiles(),exact=profiles.find(p=>p.id===selector),matches=exact?[exact]:profiles.filter(p=>p.workspace.name.toLowerCase()===String(selector).toLowerCase()||p.connection.url===selector);
  if(matches.length!==1)throw Error('Connection is unavailable or ambiguous. Choose a saved connection by its unique name or ID. No default relay was used.');
  const selected=matches[0],client=new WorkspaceClient(this.directory,{manager:this.manager,connector:this.connector,controlDirectory:this.controlDirectory});client.pinnedConnection=selected.connection;client.workspaceId=selected.id;client.workspaceName=selected.workspace.name;client.connection=selected.connection;return client;
 }
 async run(input){
  await this.migrateLegacy();
  if(input.command==='profiles')return {connected:Boolean(this.pinnedConnection),workspaces:this.publicProfiles(),selectionRequired:!this.pinnedConnection};
  if(input.command==='switch')throw Error('There is no global workspace. Select a connection for this repository using workspace, or connect it through Add project. Existing repository bindings are unchanged.');
  if(input.command==='preview')return workspaceRequest(parseWorkspaceLink(input.link),'preview');
  if(input.command==='connect'){
   const invite=parseWorkspaceLink(input.link),folder=join(this.directory,'workspace-enrollment');mkdirSync(folder,{recursive:true,mode:0o700});const path=join(folder,hash(invite.url+invite.code)+'.json'),attempt=existsSync(path)?JSON.parse(readFileSync(path)):{claim:randomBytes(32).toString('base64url')};save(path,attempt);
   if(!attempt.connection){const enrolled=await workspaceRequest(invite,'enroll',{claim:attempt.claim,device:input.device?.trim()||hostname()});attempt.connection=enrolled.connection;save(path,attempt);}
   const data=await workspaceRequest(attempt.connection,'action',{command:'list'}),id=this.remember(attempt.connection,data);this.connection=attempt.connection;
   return {...data,connected:true,relay:attempt.connection.url,workspaceProfile:id,workspaces:this.publicProfiles(),message:'Connection saved. Choose it when connecting a repository. Existing bindings are unchanged.'};
  }
  const selector=input.workspace??this.workspaceId;
  if(selector&&!this.pinnedConnection){const selected=await this.scoped(selector);const {workspace,...command}=input;return selected.run(command);}
  if(!this.pinnedConnection){const profiles=this.profiles();if(profiles.length===1)return (await this.scoped(profiles[0].id)).run(input);if(input.command==='list')return {connected:false,selectionRequired:true,workspaces:this.publicProfiles(),message:'Choose a saved connection for this repository, or add an invitation.'};throw Error('Choose a saved connection with workspace. There is no global active workspace.');}
  this.connection=this.pinnedConnection;
  if(input.command==='disconnect'){rmSync(join(this.profilesPath,this.workspaceId+'.json'),{force:true});return {connected:false,removedConnection:this.workspaceId,workspaces:this.publicProfiles(),message:'Saved management connection removed. Repository grants and memory are unchanged.'};}
  if(input.command==='join-local'){
   let repo;try{repo=repositoryAt(input.root);}catch{}if(repo?.repositoryKey)await workspaceRequest(this.connection,'action',{command:'repository-enroll',repositoryKey:repo.repositoryKey,mode:'join',room:input.room});
   const manager=await this.manager(input.root),added=await manager.add({root:input.root,connectCodex:false,captureFiles:false}),app=await manager.get(added.project.id);
   const grant=await workspaceRequest(this.connection,'action',{command:'join',room:input.room}),current=app.teamState(),existingConnection=current.configured&&current.url===this.connection.url&&current.room===input.room;if(!existingConnection)await app.teamConnect(grant.connection);let captureError=null,agentError=null;
   if(input.captureConversations!==false)try{await app.connect();}catch(error){captureError=error.message;}
   if(input.connectAgents!==false)try{const agents=await this.connector({directory:this.controlDirectory,discoveryDirectory:this.directory,room:added.project.id,root:added.project.root});if(agents?.ready===false)agentError=agents.message;}catch(error){agentError=error.message;}
   return {joined:true,project:added.project,existingConnection,captureError,agentError,relay:this.connection.url,...(this.workspaceId?{workspaceProfile:this.workspaceId}:{})};
  }
  let result;try{result=await workspaceRequest(this.connection,'action',input);}catch(error){if(input.command==='relay-admin'&&['WORKSPACE_ACTION','WORKSPACE_FORBIDDEN'].includes(error.code))return {supported:false,message:'Upgrade the relay to v0.4.18 or newer to enable host maintenance.'};if(input.command==='delete-conversations'&&error.code==='WORKSPACE_ACTION')throw new RelayError('UPDATE_REQUIRED','This relay needs v0.4.12 or newer for conversation deletion. No data was deleted.',426);throw error;}return {...result,connected:true,relay:this.connection.url,...(this.workspaceId?{workspaceProfile:this.workspaceId}:{})};
 }
}
