import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {mkdirSync,existsSync,readFileSync,writeFileSync,renameSync,rmSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes,createHash,randomUUID} from 'node:crypto';
import {hostname} from 'node:os';
import {parseWorkspaceLink} from './workspace.js';
import {PROTOCOL,RelayError} from '../relay/wire.js';
import {connectCodexMemory} from '../codex-connection.js';
const hash=value=>createHash('sha256').update(value).digest('hex');
const save=(path,value)=>{const tmp=path+'.'+randomUUID()+'.tmp';try{writeFileSync(tmp,JSON.stringify(value)+'\n',{mode:0o600});renameSync(tmp,path);}finally{rmSync(tmp,{force:true});}};
export function workspaceRequest(connection,action,input={}){return new Promise((resolve,reject)=>{const url=new URL(connection.url);if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||!['https:','http:'].includes(url.protocol)||url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))return reject(new Error('Use an HTTPS relay origin or loopback HTTP'));const body=JSON.stringify(input),req=(url.protocol==='https:'?httpsRequest:httpRequest)(new URL('/v1/workspace/'+action,url),{method:'POST',ca:connection.ca,rejectUnauthorized:true,timeout:10000,headers:{authorization:action==='action'?'Workspace '+connection.token:'Invite '+connection.code,'content-type':'application/json','content-length':Buffer.byteLength(body)}},res=>{let data='';res.setEncoding('utf8');res.on('error',reject);res.on('data',chunk=>{data+=chunk;if(Buffer.byteLength(data)>1000000)res.destroy(new Error('Workspace response too large'));});res.on('end',()=>{try{const value=JSON.parse(data);if(res.statusCode!==200)throw new RelayError(value.error?.code??'WORKSPACE',value.error?.message??'Workspace request failed',res.statusCode);if(value.protocol!==PROTOCOL)throw new Error('Unexpected workspace response');resolve(value);}catch(error){reject(error);}});});req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('Workspace request timed out')));req.end(body);});}
export class WorkspaceClient{
 constructor(directory,{manager,connector=connectCodexMemory,controlDirectory=directory}={}){Object.assign(this,{directory,manager,connector,controlDirectory});mkdirSync(directory,{recursive:true,mode:0o700});this.profilesPath=join(directory,'workspace-profiles');this.path=join(directory,'workspace.json');this.connection=existsSync(this.path)?JSON.parse(readFileSync(this.path)):null;}
 profiles(){return existsSync(this.profilesPath)?readdirSync(this.profilesPath).filter(name=>/^[a-f0-9]{64}\.json$/.test(name)).map(name=>JSON.parse(readFileSync(join(this.profilesPath,name)))):[];}
 remember(connection,data){const id=hash(connection.url+'#'+data.workspace.id);mkdirSync(this.profilesPath,{recursive:true,mode:0o700});save(join(this.profilesPath,id+'.json'),{id,workspace:data.workspace,member:data.member,connection});for(const p of this.profiles())if(p.id!==id&&p.connection.url===connection.url&&p.connection.token===connection.token)rmSync(join(this.profilesPath,p.id+'.json'),{force:true});}
 async rememberCurrent(){if(this.connection&&!this.profiles().some(p=>p.connection.url===this.connection.url&&p.connection.token===this.connection.token)){let data;try{data=await workspaceRequest(this.connection,'action',{command:'list'});}catch{data={workspace:{id:'unverified-'+hash(this.connection.token),name:'Saved workspace at '+new URL(this.connection.url).host},member:null};}this.remember(this.connection,data);}}
 publicProfiles(){return this.profiles().map(p=>({id:p.id,name:p.workspace.name,relay:p.connection.url,role:p.member?.role,active:p.connection.url===this.connection?.url&&p.connection.token===this.connection?.token}));}
 async run(input){
  this.connection=existsSync(this.path)?JSON.parse(readFileSync(this.path)):null;
  if(input.command==='profiles'){let connectionError;try{await this.rememberCurrent();}catch(error){connectionError=error.message;}return {connected:Boolean(this.connection),workspaces:this.publicProfiles(),...(connectionError?{connectionError}:{})};}
  if(input.command==='switch'){
   if(typeof input.workspace!=='string'||!input.workspace.trim())throw Error('Choose a saved workspace');
   const profiles=this.profiles(),exact=profiles.find(p=>p.id===input.workspace),matches=exact?[exact]:profiles.filter(p=>p.workspace.name.toLowerCase()===input.workspace.toLowerCase());if(matches.length!==1)throw Error('Choose a saved workspace by its unique name or ID');
   const selected=matches[0],data=await workspaceRequest(selected.connection,'action',{command:'list'});
   await this.rememberCurrent();this.remember(selected.connection,data);save(this.path,selected.connection);this.connection=selected.connection;return {...data,connected:true,relay:selected.connection.url,workspaces:this.publicProfiles()};
  }
  if(input.command==='preview')return workspaceRequest(parseWorkspaceLink(input.link),'preview');
  if(input.command==='connect'){
   const invite=parseWorkspaceLink(input.link),folder=join(this.directory,'workspace-enrollment');mkdirSync(folder,{recursive:true,mode:0o700});const path=join(folder,hash(invite.url+invite.code)+'.json'),attempt=existsSync(path)?JSON.parse(readFileSync(path)):{claim:randomBytes(32).toString('base64url')};save(path,attempt);
   if(!attempt.connection){const enrolled=await workspaceRequest(invite,'enroll',{claim:attempt.claim,device:input.device?.trim()||hostname()});attempt.connection=enrolled.connection;save(path,attempt);}
   const data=await workspaceRequest(attempt.connection,'action',{command:'list'});await this.rememberCurrent();this.remember(attempt.connection,data);save(this.path,attempt.connection);this.connection=attempt.connection;return this.run({command:'list'});
  }
  if(input.command==='disconnect'){this.connection=null;rmSync(this.path,{force:true});return {connected:false};}
  if(!this.connection){if(input.command==='list')return {connected:false};throw new Error('Connect to a workspace first');}
  if(input.command==='join-local'){
   const manager=await this.manager(input.root),added=await manager.add({root:input.root,connectCodex:false,captureFiles:false}),app=await manager.get(added.project.id);
   const grant=await workspaceRequest(this.connection,'action',{command:'join',room:input.room}),current=app.teamState(),existingConnection=current.configured&&current.url===this.connection.url&&current.room===input.room;if(!existingConnection)await app.teamConnect(grant.connection);let captureError=null,agentError=null;
   if(input.captureConversations!==false)try{await app.connect();}catch(error){captureError=error.message;}
   if(input.connectAgents!==false)try{await this.connector({directory:this.controlDirectory,room:added.project.id,root:added.project.root});}catch(error){agentError=error.message;}
   return {joined:true,project:added.project,existingConnection,captureError,agentError};
  }
  let result;try{result=await workspaceRequest(this.connection,'action',input);}catch(error){if(input.command==='delete-conversations'&&error.code==='WORKSPACE_ACTION')throw new RelayError('UPDATE_REQUIRED','This relay needs v0.4.12 or newer for conversation deletion. No data was deleted.',426);throw error;}return {...result,connected:true,relay:this.connection.url};
 }
}
