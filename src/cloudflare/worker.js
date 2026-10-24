import {sharedMemoryInput} from '../team/sharing.js';
import {authenticatedRelay} from './oauth.js';
import {publicDownloads} from './downloads.js';
import {DurableObject} from 'cloudflare:workers';
import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {DurableSqlite} from './sqlite.js';
import {ShardedEngine} from '../sharded-engine.js';
import {MemoryStore} from '../memory/store.js';
import {ReviewStore} from '../review/store.js';
import {WorkspaceStore} from '../team/workspace.js';
import {InviteStore} from '../team/invites.js';
import {ingestSource} from '../team/source.js';
import {PROTOCOL,RelayError,fail,heads,MAX_BODY} from '../relay/wire.js';
const hash=value=>createHash('sha256').update(value).digest('hex');
const json=(data,status=200)=>Response.json({...data,protocol:PROTOCOL},{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'}});
const fault=error=>error instanceof RelayError?json({error:{code:error.code,message:error.message}},error.status):(console.error(error),json({error:{code:'INTERNAL',message:'Relay request failed'}},500));
async function body(req,max=MAX_BODY){
 fail(/^application\/json(?:;|$)/i.test(req.headers.get('content-type')??'')&&!req.headers.has('content-encoding'),'CONTENT_TYPE','Use uncompressed JSON',415);
 const reader=req.body?.getReader();fail(reader,'INVALID_JSON','Expected JSON');let bytes=0;const chunks=[];try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;fail(bytes<=max,'BODY_TOO_LARGE','Request exceeds byte limit',413);chunks.push(value);}}finally{reader.releaseLock();}
 let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{throw new RelayError('INVALID_JSON','Invalid JSON');}fail(value&&typeof value==='object'&&!Array.isArray(value),'INVALID_REQUEST','Expected object');return value;
}
const secret=(provided,expected)=>typeof expected==='string'&&/^[a-f0-9]{64}$/.test(expected)&&timingSafeEqual(Buffer.from(hash(provided??'')),Buffer.from(expected));
export default authenticatedRelay({async fetch(req,env){try{
 const path=new URL(req.url).pathname;
 const publicResponse=await publicDownloads(req,env);if(publicResponse)return publicResponse;
 if(path==='/healthz')return req.method==='GET'?json({ok:true,backend:'cloudflare',sourceSharing:'git-references-only'}):json({error:{code:'METHOD',message:'Use GET'}},405);
 // Only the workspace authenticates external requests. Project objects are never routed directly.
 return await env.WORKSPACE.get(env.WORKSPACE.idFromName('workspace')).fetch(req);
 }catch(error){return fault(error);}}});
export class SpoolWorkspace extends DurableObject {
 constructor(ctx,env){super(ctx,env);this.db=new DurableSqlite(ctx.storage);this.engine={db:this.db,transaction:fn=>this.db.transaction(fn)};
 this.db.exec('CREATE TABLE IF NOT EXISTS deployment_meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE IF NOT EXISTS team_projects(room TEXT PRIMARY KEY,name TEXT,creator TEXT,request_id TEXT,UNIQUE(creator,request_id))');
 const key=name=>{let row=this.db.prepare('SELECT value FROM deployment_meta WHERE key=?').get(name);if(!row){const value=randomBytes(32).toString('base64');this.db.prepare('INSERT INTO deployment_meta VALUES(?,?)').run(name,value);row={value};}return Buffer.from(row.value,'base64');};
 const projects=()=>this.db.prepare('SELECT room,name FROM team_projects ORDER BY rowid').all();
 this.invites=new InviteStore(this.engine,'/unused',{key:key('invite-key'),projects,origin:()=>this.origin});
 const command=input=>{fail(input.command==='create','WORKSPACE_ACTION','Unknown project operation');fail(typeof input.name==='string'&&input.name.trim()&&input.name.length<=160,'PROJECT_NAME','Enter a project name');return this.engine.transaction(()=>{const prior=this.db.prepare('SELECT room,name FROM team_projects WHERE creator=? AND request_id=?').get(input.creator,input.requestId);if(prior){fail(prior.name===input.name.trim(),'REQUEST_CONFLICT','Retry key changed',409);return {project:prior};}const project={room:randomUUID(),name:input.name.trim()};this.db.prepare('INSERT INTO team_projects VALUES(?,?,?,?)').run(project.room,project.name,input.creator,input.requestId);if(input.repositoryKey)this.db.prepare('INSERT INTO workspace_repositories VALUES(?,?)').run(input.repositoryKey,project.room);return {project};});};
 this.workspace=new WorkspaceStore(this.engine,'/unused',{key:key('workspace-key'),projects,command,invites:this.invites,origin:()=>this.origin,refresh:()=>{}});
 }
 async fetch(req){try{
 const path=new URL(req.url).pathname;this.origin=this.env.PUBLIC_ORIGIN||new URL(req.url).origin;
 if(path==='/v1/setup'){
  fail(req.method==='POST','METHOD','Use POST',405);fail(secret(req.headers.get('authorization')?.replace(/^Bootstrap /,''),this.env.BOOTSTRAP_TOKEN_HASH),'UNAUTHORIZED','Setup authentication required',401);
  const input=await body(req,20000);const result=this.workspace.init(input.name);return json(result);
 }
 if(path.startsWith('/v1/workspace/')){
  fail(req.method==='POST','METHOD','Use POST',405);const input=await body(req,20000),action=path.slice('/v1/workspace/'.length);let result;
  if(action==='action'){const token=/^Workspace ([A-Za-z0-9_-]{43})$/.exec(req.headers.get('authorization')??'')?.[1];result=this.workspace.run(this.workspace.authorize(token),input);}
  else{const code=/^Invite ([A-Za-z0-9_-]{43})$/.exec(req.headers.get('authorization')??'')?.[1];fail(code,'INVITE_REQUIRED','Invite required',401);fail(['preview','enroll'].includes(action),'NOT_FOUND','Unknown workspace action',404);result=action==='preview'?this.workspace.preview(code):this.workspace.enroll(code,input);}
  return json(result);
 }
 if(['/v1/invites/preview','/v1/invites/redeem'].includes(path)){
  fail(req.method==='POST','METHOD','Use POST',405);const code=/^Invite ([A-Za-z0-9_-]{43})$/.exec(req.headers.get('authorization')??'')?.[1];fail(code,'INVITE_REQUIRED','Invite required',401);const input=await body(req,20000);return json(path.endsWith('/preview')?this.invites.preview(code):this.invites.redeem(code,input));
 }
 const match=/^\/v1\/rooms\/([A-Za-z0-9][A-Za-z0-9._-]{0,179})\/(state|memory|source|pull|push|review)$/.exec(path);fail(match,'NOT_FOUND','Unknown endpoint',404);
 const [,room,action]=match;fail(req.method===(action==='state'?'GET':'POST'),'METHOD','Unsupported method',405);
 // Read the body before rechecking current credentials, so revocation is honored.
 let input=action==='state'?{}:await body(req);const token=/^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(req.headers.get('authorization')??'')?.[1];
 const member=token&&this.db.prepare('SELECT id,label,role FROM team_members WHERE room=? AND token_hash=? AND revoked=0').get(room,hash(token));fail(member,'UNAUTHORIZED','Project authentication required',401);
 if(member.id.startsWith('workspace-')){const workspaceMember=this.db.prepare('SELECT * FROM workspace_members WHERE id=? AND revoked=0').get(member.id.slice(10));fail(workspaceMember,'UNAUTHORIZED','Workspace access revoked',401);const currentRole=this.workspace.projectRole(workspaceMember,room);fail(currentRole,'FORBIDDEN','Project access revoked',403);member.role=currentRole==='read'?'read':'write';}
 const write=action==='source'||action==='push'||action==='memory'&&['remember','handoff','task_update'].includes(input.command);fail(!write||member.role==='write','FORBIDDEN','Write access required',403);
 fail(action!=='push','GIT_ONLY','Repository sync bundles are not accepted',403);
 const policy=this.workspace.projectSharing(room);if(action==='memory')input=sharedMemoryInput(input,policy.sharing);
 const stub=this.env.PROJECTS.get(this.env.PROJECTS.idFromName(room));const response=await stub.fetch(new Request('https://project.internal/'+action,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({room,principal:{id:member.id,label:member.label},input,policy})}));
 if(action!=='memory'||!response.ok)return response;
 const result=await response.json(),labels=new Map(this.db.prepare('SELECT id,label FROM team_members WHERE room=?').all(room).map(m=>[m.id,m.label]));const decorate=value=>({...value,actorLabel:labels.get(value.actor?.split('/')[0])??value.actor});for(const key of ['tasks','notes','results','relatedConversations'])if(Array.isArray(result[key]))result[key]=result[key].map(decorate);return json({...decorate(result),workspaceSharing:policy.sharing});
 }catch(error){return fault(error);}}
}
export class SpoolProject extends DurableObject {
 constructor(ctx,env){super(ctx,env);this.engine=new ShardedEngine(':memory:',{database:new DurableSqlite(ctx.storage)});this.memory=new MemoryStore(this.engine,{referencesOnly:true});this.review=new ReviewStore(this.engine);}
 async fetch(req){try{
 const {room,principal,input,policy}=await body(req),action=new URL(req.url).pathname.slice(1),branch=`relay-${room}`;
 const existing=this.engine.refs();fail(existing.length===0||existing[0].room===room,'ROOM_MISMATCH','Project mismatch',403);
 if(!existing.length)this.engine.create(branch,{room});
 const actualBranch=branch;
 let result;
 if(action==='state')result={heads:this.engine.ref(actualBranch).heads,maxPageBytes:1500000,...policy};
 else if(action==='memory')result=this.memory.run(room,input,principal);
 else if(action==='source')result=ingestSource(this.engine,room,input,principal,policy?.sharing);
 else if(action==='review'){fail(input.command!=='publish','GIT_ONLY','Code stays in Git',403);result=this.review.run(room,input,principal);}
 else if(action==='pull'){heads(input.since);result=this.engine.exportPage(branch,input.since,{heads:input.heads,maxBytes:1500000});}
 else throw new RelayError('NOT_FOUND','Unknown action',404);
 return json({room,sourcePrefix:`@machines/${principal.id}/`,...result});
 }catch(error){return fault(error);}}
}
