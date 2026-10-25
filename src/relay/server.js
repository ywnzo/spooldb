import {sharedMemoryInput,defaultSharing} from '../team/sharing.js';
import { createServer } from 'node:http';
import {createServer as createTlsServer} from 'node:https';
import { createHash, randomBytes } from 'node:crypto';
import { openSync,closeSync,unlinkSync,fsyncSync,readFileSync } from 'node:fs';
import { resolve,dirname } from 'node:path';
import { ShardedEngine } from '../sharded-engine.js';
import { RelayError,fail,heads,readJson,MAX_BODY,PROTOCOL } from './wire.js';
import { MemoryStore } from '../memory/store.js';
import {ingestSource} from '../team/source.js';
import { ReviewStore } from '../review/store.js';

export const hashToken = token => createHash('sha256').update(token).digest('hex');
export function createCredential(id,rooms) {
  const token=randomBytes(32).toString('base64url');return { token,credential:{ id,tokenHash:hashToken(token),rooms } };
}
const roomName = room => `relay-${room}`;

export class RelayServer {
  constructor(filename,{credentials=[],maxPageBytes=4*1024*1024,maxConnections=64,maxActiveRequests=16,tls,referencesOnly=false,maintenance=()=>false,version,embeddings=null}={}) {
    fail(Number.isSafeInteger(maxPageBytes)&&maxPageBytes>=1024&&maxPageBytes<=8*1024*1024,'INVALID_CONFIG','Invalid page size');
    fail([maxConnections,maxActiveRequests].every(n=>Number.isSafeInteger(n)&&n>0&&n<=1024),'INVALID_CONFIG','Invalid connection limits');
    this.maintenance=maintenance;this.version=version;this.setCredentials(credentials);this.maxPageBytes=maxPageBytes;this.active=0;this.maxActiveRequests=maxActiveRequests;
    this.engine=new ShardedEngine(filename);
    this.referencesOnly=referencesOnly;this.review=new ReviewStore(this.engine);this.memory=new MemoryStore(this.engine,{referencesOnly,embeddings});
    this.engine.db.exec(`CREATE TABLE IF NOT EXISTS relay_audit(seq INTEGER PRIMARY KEY,room TEXT NOT NULL,principal TEXT NOT NULL,heads TEXT NOT NULL,accepted_at TEXT NOT NULL,UNIQUE(room,principal,heads))`);
    this.tls=Boolean(tls);this.server=(tls?createTlsServer:createServer)({...tls,headersTimeout:10000,requestTimeout:30000,maxHeaderSize:8192},(req,res)=>this.handle(req,res));
    this.server.maxConnections=maxConnections;this.server.maxRequestsPerSocket=100;this.server.keepAliveTimeout=1000;
    this.server.on('clientError',(_error,socket)=>{if(socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');});
  }
  setCredentials(credentials) {
    fail(Array.isArray(credentials),'INVALID_CONFIG','Credentials must be an array');const next=new Map();
    for(const c of credentials) {
      fail(c && typeof c.id==='string' && /^[A-Za-z0-9._-]{1,128}$/.test(c.id) && /^[a-f0-9]{64}$/.test(c.tokenHash) && c.rooms && typeof c.rooms==='object' && !Array.isArray(c.rooms),'INVALID_CONFIG','Invalid credential');
      fail(!next.has(c.tokenHash),'INVALID_CONFIG','Duplicate token hash');const rooms=new Map(Object.entries(c.rooms));
      fail([...rooms].every(([room,role])=>/^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/.test(room)&&['read','write'].includes(role)),'INVALID_CONFIG','Invalid room grant');
      next.set(c.tokenHash,{id:c.id,label:typeof c.label==='string'?c.label:c.id,rooms});
    }
    this.credentials=next;
  }
  authorize(req,room,write) {
    const match=/^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(req.headers.authorization??'');
    const principal=match&&this.credentials.get(hashToken(match[1]));fail(principal,'UNAUTHORIZED','Authentication required',401);
    const role=principal.rooms.get(room);fail(role && (!write||role==='write'),'FORBIDDEN','Room access denied',403);return principal;
  }
  state(room) {
    const row=this.engine.db.prepare('SELECT heads FROM shard_refs WHERE name=?').get(roomName(room));
    return { memoryLifecycle:1,room,heads:row?JSON.parse(row.heads):[],maxPageBytes:this.maxPageBytes,...(this.sharingPolicy?.(room)??{}) };
  }
  send(res,status,value) {
    const body=JSON.stringify({...value,protocol:PROTOCOL});
    fail(Buffer.byteLength(body)<=MAX_BODY,'RESPONSE_TOO_LARGE','Response exceeds byte limit',413);
    res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-length':Buffer.byteLength(body)});res.end(body);
  }
  async handle(req,res) {
    if(this.active>=this.maxActiveRequests) {req.resume();this.send(res,503,{error:{code:'BUSY',message:'Retry later'}});return;}
    this.active++;
    try {
      if(req.url==='/healthz'&&req.method==='GET') {this.send(res,200,{ok:true,...(this.version?{version:this.version,updating:this.maintenance()}: {})});return;}
      const reviewUrl=new URL(req.url,'http://localhost');
      if(this.maintenance()){if(this.maintenanceHandler&&await this.maintenanceHandler(req,res,reviewUrl.pathname))return;res.setHeader('retry-after','30');this.send(res,503,{error:{code:'UPDATING',message:'Relay update in progress; retry shortly'}});return;}
      if(this.inviteHandler&&await this.inviteHandler(req,res,reviewUrl.pathname))return;
      if(this.localHandler&&await this.localHandler(req,res,reviewUrl.pathname))return;
      if(reviewUrl.pathname==='/review'&&req.method==='GET') {res.writeHead(308,{location:`/review/${reviewUrl.search}`,'cache-control':'no-store'});res.end();return;}
      const asset={'/review/':'index.html','/review/discovery.js':'discovery.js','/review/workspace.js':'workspace.js','/review/app.js':'app.js','/review/settings.js':'settings.js','/review/relay-settings.js':'relay-settings.js','/review/retrieval-settings.js':'retrieval-settings.js','/review/kiln.css':'kiln.css','/review/style.css':'style.css'}[reviewUrl.pathname];
      if(asset&&req.method==='GET') {
        const body=readFileSync(new URL(`../review/public/${asset}`,import.meta.url));const type=asset.endsWith('.html')?'text/html':asset.endsWith('.js')?'text/javascript':'text/css';
        res.writeHead(200,{'content-type':`${type}; charset=utf-8`,'cache-control':'no-store','content-security-policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",'x-content-type-options':'nosniff','referrer-policy':'no-referrer','content-length':body.length});res.end(body);return;
      }
      const match=/^\/v1\/rooms\/([A-Za-z0-9][A-Za-z0-9._-]{0,179})\/(state|pull|push|review|memory|source)$/.exec(req.url??'');
      fail(match,'NOT_FOUND','Unknown endpoint',404);const [,room,action]=match;
      fail(req.method===(action==='state'?'GET':'POST'),'METHOD_NOT_ALLOWED','Unsupported method',405);
      let principal=this.authorize(req,room,['push','source'].includes(action));
      fail(!this.referencesOnly||!['push'].includes(action),'GIT_ONLY','Shared project memory does not accept repository sync bundles',403);
      if(action==='state') {this.send(res,200,this.state(room));return;}
      fail(/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']??'')&&!req.headers['content-encoding'],'CONTENT_TYPE','Use uncompressed application/json',415);
      fail(!req.headers['content-length']||Number(req.headers['content-length'])<=MAX_BODY,'BODY_TOO_LARGE','Request exceeds byte limit',413);
      const input=await readJson(req);principal=this.authorize(req,room,['push','source'].includes(action)); // Revocation can occur while reading a body.
      fail(input&&typeof input==='object'&&!Array.isArray(input),'INVALID_REQUEST','Expected request object');
      if(action==='source'){const result=ingestSource(this.engine,room,input,principal,this.sharingPolicy?.(room).sharing??defaultSharing());this.memory.index(room);this.memory.semantic?.schedule(room);this.send(res,200,result);return;}
      if(action==='memory') {
        principal=this.authorize(req,room,['remember','task_update','handoff'].includes(input.command));fail(this.state(room).heads.length,'ROOM_EMPTY','Sync this project before using memory',409);
        const mapped=sharedMemoryInput(input,this.sharingPolicy?.(room).sharing??defaultSharing());const result=await this.memory.retrieve(room,mapped,principal);principal=this.authorize(req,room,false);if(['remember','handoff','task_update'].includes(input.command)){this.memory.index(room);this.memory.semantic?.schedule(room);}const labels=new Map([...this.credentials.values()].filter(c=>c.rooms.has(room)).map(c=>[c.id,c.label]));const decorate=item=>({...item,actorLabel:labels.get(item.actor?.split('/')[0])??item.actor});for(const key of ['tasks','notes','results','relatedConversations'])if(Array.isArray(result[key]))result[key]=result[key].map(decorate);this.send(res,200,{room,sourcePrefix:`@machines/${principal.id}/`,...decorate(result),...(['search','context'].includes(input.command)?{retrieval:{...this.memory.retrievalSettings,...result.retrieval}}:{}),workspaceSharing:this.sharingPolicy?.(room).sharing??defaultSharing()});return;
      }
      if(action==='review') {
        fail(!this.referencesOnly||input.command!=='publish','GIT_ONLY','Code branches stay in Git',403);
        principal=this.authorize(req,room,input.command==='publish');fail(this.state(room).heads.length,'ROOM_EMPTY','Sync this room before opening review',409);
        this.send(res,200,{room,...this.review.run(room,input,principal)});return;
      }
      if(action==='pull') {
        const since=heads(input.since);const state=this.state(room);
        if(!state.heads.length) {fail(!since.length,'MISSING_DEPENDENCIES','Relay history is missing; reset sync cursors',409);this.send(res,200,{room,bundle:null,heads:[],more:false,bytes:0});return;}
        if(input.heads!==undefined) {heads(input.heads);fail(input.heads.length,'INVALID_FRONTIER','Target heads cannot be empty');}
        const page=this.engine.exportPage(roomName(room),since,{heads:input.heads,maxBytes:this.maxPageBytes});
        this.send(res,200,{room,...page});
      } else {
        fail(input.bundle?.room===room,'ROOM_MISMATCH','Bundle room does not match authorized room',403);
        heads(input.bundle.heads);fail(input.bundle.heads.length,'INVALID_FRONTIER','Push heads cannot be empty');
        fail(Buffer.byteLength(JSON.stringify(input.bundle))<=this.maxPageBytes,'PAGE_TOO_LARGE','Bundle exceeds relay page size',413);
        const result=this.engine.transaction(()=>{
          const ref=this.engine.import(roomName(room),input.bundle);
          heads(ref.heads); // Do not commit a frontier this transport cannot represent.
          this.engine.db.prepare('INSERT OR IGNORE INTO relay_audit(room,principal,heads,accepted_at) VALUES(?,?,?,?)').run(room,principal.id,JSON.stringify([...input.bundle.heads].sort()),new Date().toISOString());return ref;
        });
        this.send(res,200,{room,acceptedHeads:input.bundle.heads,heads:result.heads,durable:true});
      }
    } catch(error) {
      let fault=error;
      if(!(error instanceof RelayError)) {
        const message=error.message??'';
        const missing=/[Mm]issing|Incomplete|not an ancestor|Unknown or missing global heads/.test(message);
        fault=new RelayError(missing?'MISSING_DEPENDENCIES':/atomic batch exceeds/.test(message)?'BATCH_TOO_LARGE':'INVALID_BUNDLE',missing?'Causal base missing; reset sync cursors':/atomic batch exceeds/.test(message)?'One atomic batch exceeds the page limit':'Invalid causal data',missing?409:422);
      }
      if(!res.headersSent&&!res.destroyed) this.send(res,fault.status,{error:{code:fault.code,message:fault.message}});
      req.resume();
    } finally {this.active--;}
  }
  async listen({host='127.0.0.1',port=0}={}) {
    await new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(port,host,()=>{this.server.removeListener('error',reject);resolve();});});
    const address=this.server.address();return `${this.tls?'https':'http'}://${address.family==='IPv6'?`[${address.address}]`:address.address}:${address.port}`;
  }
  backup(filename) {
    fail(!this.engine.transactionDepth,'TRANSACTION','Backup requires its own snapshot');const target=resolve(filename);
    const fd=openSync(target,'wx',0o600);closeSync(fd);
    try {
      this.engine.db.prepare('VACUUM INTO ?').run(target);
      const directory=openSync(dirname(target),'r');try {fsyncSync(directory);} finally {closeSync(directory);}
      return {path:target,heads:this.engine.refs()};
    } catch(error) {unlinkSync(target);throw error;}
  }
  async close() {
    if(this.server.listening) await new Promise((resolve,reject)=>{this.server.close(error=>error?reject(error):resolve());this.server.closeAllConnections();});
    while(this.active)await new Promise(resolve=>setTimeout(resolve,10));
    await this.memory.semantic?.close();this.engine.close();
  }
}
