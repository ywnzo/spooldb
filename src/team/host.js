import {relayAdminRequest} from './relay-admin.js';
import {deleteSharedConversations} from './conversation-deletion.js';
import {mkdirSync,readFileSync,writeFileSync,renameSync,existsSync,chmodSync,unlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createServer,createConnection} from 'node:net';
import {randomUUID} from 'node:crypto';
import {WorkspaceStore} from './workspace.js';
import {InviteStore} from './invites.js';
import {readJson,RelayError} from '../relay/wire.js';
import {localCertificate} from './tls.js';
import {RelayServer,createCredential} from '../relay/server.js';
export function hostRequest(dir,input){return new Promise((resolve,reject)=>{const socket=createConnection(join(dir,'admin.sock'));let text='';const timer=setTimeout(()=>{socket.destroy();reject(new Error('Shared host request timed out'));},15000);socket.on('connect',()=>socket.write(JSON.stringify(input)+'\n'));socket.on('data',chunk=>{text+=chunk;if(text.length>1000000){socket.destroy();return reject(new Error('Host response too large'));}if(text.includes('\n')){clearTimeout(timer);socket.end();try{const value=JSON.parse(text.split('\n')[0]);value.error?reject(new Error(value.error)):resolve(value);}catch(error){reject(error);}}});socket.on('error',error=>{clearTimeout(timer);reject(error);});});}
export async function startTeamHost(dir,{port=8878,host='127.0.0.1',publicOrigin,tls=false,relayAdmin=relayAdminRequest}={}){
 dir=resolve(dir);mkdirSync(dir,{recursive:true,mode:0o700});const configPath=join(dir,'host.json'),socketPath=join(dir,'admin.sock');
 if(existsSync(socketPath)){try{await hostRequest(dir,{command:'list'});throw new Error('Shared relay already running');}catch(error){if(error.code!=='ECONNREFUSED')throw error;unlinkSync(socketPath);}}
 const config=existsSync(configPath)?JSON.parse(readFileSync(configPath)):{projects:[],credentials:[]};const certificate=tls?localCertificate(dir,{dnsNames:publicOrigin?[new URL(publicOrigin).hostname]:[]}):undefined;const relay=new RelayServer(join(dir,'shared.sqlite'),{credentials:config.credentials,tls:certificate,referencesOnly:true,version:JSON.parse(readFileSync(new URL('../../package.json',import.meta.url))).version,maintenance:()=>existsSync(join(dir,'.spool-update-gate'))});
 if(relay.engine.db.prepare("SELECT 1 FROM shard_changes WHERE doc LIKE 'f:%' LIMIT 1").get()){await relay.close();throw new Error('Legacy source snapshots exist. Stop the relay and run src/team/migrate-memory-only.js with a backup directory outside relay storage.');}
 relay.engine.db.exec('CREATE TABLE IF NOT EXISTS team_projects(room TEXT PRIMARY KEY,name TEXT,creator TEXT,request_id TEXT,UNIQUE(creator,request_id))');
 for(const project of config.projects)relay.engine.db.prepare('INSERT OR IGNORE INTO team_projects VALUES(?,?,NULL,NULL)').run(project.room,project.name);
 const projectList=()=>relay.engine.db.prepare('SELECT room,name FROM team_projects ORDER BY rowid').all();config.projects=projectList();
 const save=()=>{relay.setCredentials(config.credentials);writeFileSync(configPath+'.tmp',JSON.stringify(config,null,2)+'\n',{mode:0o600});renameSync(configPath+'.tmp',configPath);relay.setCredentials(config.credentials);};
 const origin=await relay.listen({port,host}),url=publicOrigin??origin;
 let invites;const refresh=()=>{config.credentials=invites.credentials();save();};invites=new InviteStore(relay.engine,dir,{legacy:config.credentials,projects:()=>config.projects,origin:()=>url,ca:certificate?.ca,onChange:refresh});refresh();
 relay.inviteHandler=async(req,res,path)=>{if(!['/v1/invites/preview','/v1/invites/redeem'].includes(path))return false;if(req.method!=='POST')throw new RelayError('METHOD','Use POST',405);const match=/^Invite ([-A-Za-z0-9_]{43})$/.exec(req.headers.authorization??'');if(!match)throw new RelayError('INVITE_REQUIRED','Invite required',401);const body=await readJson(req,10000);const result=path.endsWith('/preview')?invites.preview(match[1]):invites.redeem(match[1],body);relay.send(res,200,result);return true;};
 let workspace;const command=input=>{
  if(input.command==='workspace-init')return workspace.init(input.name);
  if(input.command==='workspace-owner-invite')return workspace.invite({label:'Owner recovery',role:'owner',canCreate:true});
  if(input.command==='list')return {url,projects:config.projects.map(p=>({...p,members:config.credentials.filter(c=>c.rooms[p.room]).map(c=>({id:c.id,label:c.label,role:c.rooms[p.room]}))}))};
  if(input.command==='create'){
   if(typeof input.name!=='string'||!input.name.trim()||input.name.length>160)throw new RelayError('PROJECT_NAME','Enter a shared project name',400);
   let project;relay.engine.transaction(()=>{const prior=input.creator&&input.requestId?relay.engine.db.prepare('SELECT room,name FROM team_projects WHERE creator=? AND request_id=?').get(input.creator,input.requestId):null;if(prior){if(prior.name!==input.name.trim())throw new RelayError('REQUEST_CONFLICT','Project retry key reused with another name',409);project=prior;return;}const ref=relay.engine.create('new-'+randomUUID());relay.engine.db.prepare('UPDATE shard_refs SET name=? WHERE room=?').run(`relay-${ref.room}`,ref.room);project={name:input.name.trim(),room:ref.room};relay.engine.db.prepare('INSERT INTO team_projects VALUES(?,?,?,?)').run(project.room,project.name,input.creator??null,input.requestId??null);if(input.repositoryKey){if(!/^[a-f0-9]{64}$/.test(input.repositoryKey))throw new Error('Invalid repository identity');relay.engine.db.prepare('INSERT INTO workspace_repositories VALUES(?,?)').run(input.repositoryKey,project.room);}});config.projects=projectList();save();return {project};
  }
  const project=config.projects.find(p=>p.room===input.room);if(!project)throw new Error('Shared project not found');
  if(input.command==='create-invite'){if(typeof input.label!=='string'||input.label.length>120)throw new Error('Enter an invite label');return invites.create(project.room,input.label,{ttlMinutes:input.ttlMinutes??1440,role:input.role??'write'});}
  if(input.command==='invite'){
   if(typeof input.label!=='string'||!input.label.trim()||input.label.length>120||!['read','write'].includes(input.role??'write'))throw new Error('Enter a device/member label and role');
   const id='machine-'+randomUUID(),created=createCredential(id,{[project.room]:input.role??'write'});invites.add(created.credential,input.label.trim());return {connection:{version:1,url,room:project.room,token:created.token,project:project.name,device:input.label,...(certificate?{ca:certificate.ca}:{})},memberId:id};
  }
  if(input.command==='revoke'){invites.revoke(project.room,input.memberId);return {revoked:true};}
  throw new Error('Unknown shared host action');
 };
 workspace=new WorkspaceStore(relay.engine,dir,{projects:projectList,command,invites,origin:()=>url,ca:certificate?.ca,refresh,relayAdmin,conversationDeletion:(room,input)=>deleteSharedConversations(relay.engine,room,input)});
 relay.sharingPolicy=room=>workspace.projectSharing(room);
 const projectInvites=relay.inviteHandler;relay.inviteHandler=async(req,res,path)=>{
  if(!path.startsWith('/v1/workspace/'))return projectInvites(req,res,path);
  if(req.method!=='POST')throw new RelayError('METHOD','Use POST',405);
  if(!['/v1/workspace/preview','/v1/workspace/enroll','/v1/workspace/action'].includes(path))throw new RelayError('NOT_FOUND','Unknown workspace endpoint',404);
  if(!/^application\/json(?:;|$)/.test(req.headers['content-type']??''))throw new RelayError('CONTENT_TYPE','Use JSON',415);
  const body=await readJson(req,20000);let result;
  if(path.endsWith('/action')){const match=/^Workspace ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization??'');result=await workspace.run(workspace.authorize(match?.[1]),body);}
  else{const match=/^Invite ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization??'');if(!match)throw new RelayError('INVITE_REQUIRED','Workspace invitation required',401);result=path.endsWith('/preview')?workspace.preview(match[1]):workspace.enroll(match[1],body);}
  relay.send(res,200,result);return true;
 };
 relay.maintenanceHandler=async(req,res,path)=>{
  if(path!=='/v1/workspace/action'||req.method!=='POST')return false;
  const body=await readJson(req,20000);if(body.command!=='relay-admin')throw new RelayError('UPDATING','Relay update in progress; retry shortly',503);
  const match=/^Workspace ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization??'');relay.send(res,200,await workspace.run(workspace.authorize(match?.[1]),body));return true;
 };
 const admin=createServer(socket=>{let text='',handled=false;socket.setTimeout(15000,()=>socket.destroy());socket.on('error',()=>{});socket.on('data',chunk=>{if(handled)return;text+=chunk;if(text.length>10000){socket.destroy();return;}if(!text.includes('\n'))return;handled=true;try{socket.end(JSON.stringify(command(JSON.parse(text.split('\n')[0])))+'\n');}catch(error){socket.end(JSON.stringify({error:error.message})+'\n');}});});
 await new Promise((resolve,reject)=>{admin.once('error',reject);admin.listen(socketPath,resolve);});chmodSync(socketPath,0o600);save();
 return {relay,origin:url,command,close:async()=>{await new Promise(r=>admin.close(r));if(existsSync(socketPath))unlinkSync(socketPath);await relay.close();}};
}
