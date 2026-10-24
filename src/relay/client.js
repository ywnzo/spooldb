import { setTimeout as delay } from 'node:timers/promises';
import { RelayError,fail,heads,MAX_BODY,PROTOCOL } from './wire.js';
const running=new WeakMap();

export class SyncClient {
  constructor(engine,{url,token,room,branch='main',timeoutMs=30000,retries=2,maxPages=1000,allowInsecureHttp=false}={}) {
    fail(engine?.layout==='sharded','LAYOUT','Relay sync requires sharded storage');
    const remote=new URL(url);
    fail(!remote.username&&!remote.password&&!remote.search&&!remote.hash&&['http:','https:'].includes(remote.protocol),'URL','Invalid relay URL');
    fail(remote.pathname==='/'||remote.pathname==='','URL','Relay URL must be an origin');
    fail(remote.protocol==='https:'||['127.0.0.1','localhost','[::1]'].includes(remote.hostname)||allowInsecureHttp,'TLS_REQUIRED','Remote relays require HTTPS');
    fail(typeof token==='string'&&/^[A-Za-z0-9_-]{32,128}$/.test(token),'TOKEN','Invalid bearer token');
    fail(typeof room==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/.test(room),'ROOM','Invalid room');
    fail(typeof branch==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(branch),'BRANCH','Invalid branch');
    fail(Number.isSafeInteger(timeoutMs)&&timeoutMs>=100&&timeoutMs<=120000&&Number.isSafeInteger(retries)&&retries>=0&&retries<=5&&Number.isSafeInteger(maxPages)&&maxPages>0&&maxPages<=100000,'OPTIONS','Invalid sync limits');
    Object.assign(this,{engine,url:remote.origin,token,room,branch,timeoutMs,retries,maxPages});
    engine.db.exec(`CREATE TABLE IF NOT EXISTS relay_cursors(remote TEXT NOT NULL,room TEXT NOT NULL,branch TEXT NOT NULL,push_heads TEXT NOT NULL,pull_heads TEXT NOT NULL,PRIMARY KEY(remote,room,branch))`);
  }
  cursor() {
    const row=this.engine.db.prepare('SELECT * FROM relay_cursors WHERE remote=? AND room=? AND branch=?').get(this.url,this.room,this.branch);
    return {push:row?JSON.parse(row.push_heads):[],pull:row?JSON.parse(row.pull_heads):[]};
  }
  save(cursor) {
    this.engine.db.prepare(`INSERT INTO relay_cursors VALUES(?,?,?,?,?) ON CONFLICT(remote,room,branch) DO UPDATE SET push_heads=excluded.push_heads,pull_heads=excluded.pull_heads`)
      .run(this.url,this.room,this.branch,JSON.stringify(cursor.push),JSON.stringify(cursor.pull));
  }
  reset() { this.save({push:[],pull:[]}); }
  async publishBranch(name,{expectedRevision=0,requestId=crypto.randomUUID(),signal}={}) {
    fail(typeof name==='string'&&/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(name),'INVALID_BRANCH','Invalid review branch name');
    fail(Number.isSafeInteger(expectedRevision)&&expectedRevision>=0,'INVALID_REVISION','Expected revision is required');
    const snapshot=this.engine.ref(this.branch);fail(snapshot.room===this.room,'ROOM_MISMATCH','Local branch belongs to a different room');
    const sync=await this.sync({mode:'push',signal});const metrics={requests:0,retries:0,uploadedBytes:0,downloadedBytes:0};
    const result=await this.request('review',{command:'publish',name,heads:snapshot.heads,expectedRevision,requestId},signal,metrics);
    return {branch:result,sync};
  }
  async request(action,input,signal,metrics) {
    const body=input===undefined?undefined:JSON.stringify(input);fail(!body||Buffer.byteLength(body)<=MAX_BODY,'BODY_TOO_LARGE','Sync request exceeds byte limit');
    for(let attempt=0;;attempt++) {
      try {
        signal?.throwIfAborted();
        metrics.requests++;metrics.uploadedBytes+=body?Buffer.byteLength(body):0;
        const response=await fetch(`${this.url}/v1/rooms/${this.room}/${action}`,{method:body===undefined?'GET':'POST',redirect:'error',
          headers:{authorization:`Bearer ${this.token}`,...(body?{'content-type':'application/json'}:{})},body,
          signal:signal?AbortSignal.any([signal,AbortSignal.timeout(this.timeoutMs)]):AbortSignal.timeout(this.timeoutMs)});
        const chunks=[];let bytes=0;
        if(Number(response.headers.get('content-length')??0)>MAX_BODY) {await response.body?.cancel();throw new RelayError('BODY_TOO_LARGE','Relay response exceeds byte limit');}
        const reader=response.body?.getReader();
        try {if(reader) while(true) {const {done,value}=await reader.read();if(done) break;bytes+=value.byteLength;if(bytes>MAX_BODY) {await reader.cancel();throw new RelayError('BODY_TOO_LARGE','Relay response exceeds byte limit');}chunks.push(value);}}
        finally {reader?.releaseLock();}
        let data;try {data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));} catch {throw new RelayError('INVALID_RESPONSE','Relay returned invalid JSON');}
        fail(data.protocol===PROTOCOL,'PROTOCOL','Unsupported relay protocol');
        metrics.downloadedBytes+=bytes;
        if(!response.ok) throw new RelayError(data.error?.code??'HTTP_ERROR',data.error?.message??'Relay request failed',response.status);
        fail(data.room===this.room,'ROOM_MISMATCH','Relay response room mismatch');return data;
      } catch(error) {
        if(signal?.aborted) throw signal.reason;
        const retry=!(error instanceof RelayError)||[429,502,503,504].includes(error.status);
        if(!retry||attempt>=this.retries) throw error;
        metrics.retries++;await delay(Math.min(1000,100*2**attempt),undefined,{signal});
      }
    }
  }
  async sync({mode='both',signal}={}) {
    fail(['both','pull','push'].includes(mode),'MODE','Invalid sync mode');
    let locks=running.get(this.engine);if(!locks) {locks=new Set();running.set(this.engine,locks);}
    const key=`${this.url}/${this.room}/${this.branch}`;fail(!locks.has(key),'BUSY','Sync is already running for this branch');locks.add(key);
    const metrics={requests:0,retries:0,uploadedBytes:0,downloadedBytes:0,pushPages:0,pullPages:0,resets:0};
    try {
      let pages=0;let completed=false;
      while(!completed) {
        const state=await this.request('state',undefined,signal,metrics);heads(state.heads);
        fail(Number.isSafeInteger(state.maxPageBytes)&&state.maxPageBytes>=1024&&state.maxPageBytes<=8*1024*1024,'INVALID_RESPONSE','Invalid relay page size');
        let cursor=this.cursor();
        try {
          const local=this.engine.db.prepare('SELECT room,heads FROM shard_refs WHERE name=?').get(this.branch);
          fail(!local||local.room===this.room,'ROOM_MISMATCH','Local branch belongs to a different room');
          if(mode!=='pull'&&local) {
            const target=JSON.parse(local.heads);let more=true;
            while(more) {
              signal?.throwIfAborted();fail(++pages<=this.maxPages,'PAGE_BUDGET','Sync page budget reached; resume sync to continue');
              const page=this.engine.exportPage(this.branch,cursor.push,{heads:target,maxBytes:state.maxPageBytes});
              if(!page.bundle) break;
              const ack=await this.request('push',{bundle:page.bundle},signal,metrics);
              heads(ack.acceptedHeads);fail(ack.durable===true&&JSON.stringify([...ack.acceptedHeads].sort())===JSON.stringify([...page.bundle.heads].sort()),'INVALID_ACK','Relay did not acknowledge the uploaded frontier');
              cursor={...cursor,push:page.bundle.heads};this.save(cursor);metrics.pushPages++;more=page.more;
            }
          }
          if(mode==='push') {completed=true;continue;}
          let more=true;let target;
          while(more) {
            signal?.throwIfAborted();fail(++pages<=this.maxPages,'PAGE_BUDGET','Sync page budget reached; resume sync to continue');
            const page=await this.request('pull',{since:cursor.pull,...(target?{heads:target}:{})},signal,metrics);heads(page.heads);target=page.heads;
            fail(typeof page.more==='boolean'&&(!page.more||page.bundle),'INVALID_RESPONSE','Invalid relay page');
            if(page.bundle) {
              fail(page.bundle.room===this.room,'ROOM_MISMATCH','Relay bundle room mismatch');heads(page.bundle.heads);
              this.engine.transaction(()=>{
                this.engine.import(this.branch,page.bundle);
                // Only advance upload knowledge using heads proved durable at
                // the relay, never edits made locally while fetch was pending.
                const push=this.engine.frontier(this.room,[...cursor.push,...page.bundle.heads]).heads;
                cursor={push,pull:page.bundle.heads};this.save(cursor);
              });metrics.pullPages++;
            } else fail(!page.more,'INVALID_RESPONSE','Empty continuing page');
            more=page.more;
          }
          completed=true;
        } catch(error) {
          if(error.code!=='MISSING_DEPENDENCIES'||metrics.resets>=1) throw error;
          this.reset();metrics.resets++;
        }
      }
      const row=this.engine.db.prepare('SELECT heads FROM shard_refs WHERE name=?').get(this.branch);
      return {...metrics,room:this.room,heads:row?JSON.parse(row.heads):[],durability:'relay-sqlite',mode};
    } finally {locks.delete(key);}
  }
  async watch({intervalMs=1000,mode='both',signal,onSync=()=>{},onError=()=>{}}={}) {
    fail(Number.isSafeInteger(intervalMs)&&intervalMs>=100&&intervalMs<=60000,'INTERVAL','Invalid polling interval');
    while(!signal?.aborted) {
      try {onSync(await this.sync({mode,signal}));}
      catch(error) {if(signal?.aborted) break;onError(error);if(error instanceof RelayError&&error.code!=='PAGE_BUDGET'&&![429,502,503,504].includes(error.status)) throw error;}
      try {await delay(intervalMs,undefined,{signal});} catch(error) {if(!signal?.aborted) throw error;}
    }
  }
}
