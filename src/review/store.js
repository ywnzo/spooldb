import { fail,heads } from '../relay/wire.js';
import { lineDiff } from './diff.js';
import { unpack } from '../storage/codec.js';
import * as A from '@automerge/automerge';
import { digest } from '../adapters/contract.js';
const branchName=room=>`relay-${room}`;
const causal=`WITH RECURSIVE reachable(id) AS (SELECT value FROM json_each(?) UNION SELECT p.value FROM reachable r CROSS JOIN shard_batches b CROSS JOIN json_each(b.parents) p WHERE b.room=? AND b.id=r.id)`;
const plain=value=>JSON.parse(JSON.stringify(value));
const name=value=>fail(typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(value),'INVALID_BRANCH','Invalid review branch name');

export class ReviewStore {
  constructor(engine) {
    this.engine=engine;engine.db.exec(`CREATE TABLE IF NOT EXISTS relay_review_branches(room TEXT NOT NULL,name TEXT NOT NULL,heads TEXT NOT NULL,revision INTEGER NOT NULL,updated_by TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(room,name))`);
    engine.db.exec(`CREATE TABLE IF NOT EXISTS relay_review_publications(room TEXT NOT NULL,principal TEXT NOT NULL,request_id TEXT NOT NULL,input TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(room,principal,request_id))`);
  }
  branches(room) {
    const live=this.engine.ref(branchName(room));
    return [{name:'@live',label:'Synced room',heads:live.heads,revision:0,live:true},...this.engine.db.prepare('SELECT name,heads,revision,updated_by AS updatedBy,updated_at AS updatedAt FROM relay_review_branches WHERE room=? ORDER BY name').all(room).map(row=>({...row,heads:JSON.parse(row.heads),live:false}))];
  }
  version(room,branch='@live',requested) {
    let frontier;
    if(branch==='@live')frontier=this.engine.ref(branchName(room)).heads;
    else {name(branch);const row=this.engine.db.prepare('SELECT heads FROM relay_review_branches WHERE room=? AND name=?').get(room,branch);fail(row,'BRANCH_NOT_FOUND','Review branch not found',404);frontier=JSON.parse(row.heads);}
    if(requested!==undefined) {
      heads(requested);fail(requested.length,'INVALID_FRONTIER','Revision must include a causal head');
      const found=this.engine.db.prepare(`${causal} SELECT count(*) AS n FROM reachable WHERE id IN (SELECT value FROM json_each(?))`).get(JSON.stringify(frontier),room,JSON.stringify([...new Set(requested)]));
      fail(found.n===new Set(requested).size,'REVISION_NOT_FOUND','Revision is outside this branch',404);frontier=requested;
    }
    return this.engine.version(branchName(room),frontier);
  }
  publish(room,input,principal) {
    name(input.name);heads(input.heads);fail(input.heads.length,'INVALID_FRONTIER','Branch must include a head');
    fail(Number.isSafeInteger(input.expectedRevision)&&input.expectedRevision>=0,'INVALID_REVISION','Expected revision is required');
    fail(typeof input.requestId==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(input.requestId),'INVALID_REQUEST_ID','A publication request identity is required');
    this.version(room,'@live',input.heads);
    return this.engine.transaction(()=>{
      const encoded=digest({name:input.name,heads:[...input.heads].sort(),expectedRevision:input.expectedRevision});
      const receipt=this.engine.db.prepare('SELECT input,result FROM relay_review_publications WHERE room=? AND principal=? AND request_id=?').get(room,principal.id,input.requestId);
      if(receipt) {fail(receipt.input===encoded,'REQUEST_CONFLICT','Publication request identity was reused with different input',409);return JSON.parse(receipt.result);}
      const current=this.engine.db.prepare('SELECT revision FROM relay_review_branches WHERE room=? AND name=?').get(room,input.name);
      fail((current?.revision??0)===input.expectedRevision,'BRANCH_CONFLICT','Branch changed; read its revision before publishing again',409);
      const revision=input.expectedRevision+1;const at=new Date().toISOString();
      this.engine.db.prepare(`INSERT INTO relay_review_branches VALUES(?,?,?,?,?,?) ON CONFLICT(room,name) DO UPDATE SET heads=excluded.heads,revision=excluded.revision,updated_by=excluded.updated_by,updated_at=excluded.updated_at`).run(room,input.name,JSON.stringify(input.heads),revision,principal.id,at);
      const result={name:input.name,heads:input.heads,revision,updatedBy:principal.id,updatedAt:at};
      this.engine.db.prepare('INSERT INTO relay_review_publications VALUES(?,?,?,?,?)').run(room,principal.id,input.requestId,encoded,JSON.stringify(result));return result;
    });
  }
  descriptors(version) {return new Map([...this.engine.manifest.entries(version.root)].filter(([key])=>key.startsWith('f:')).map(([key,value])=>[key.slice(2),value]));}
  base(room,input) {
    if(input.baseHeads!==undefined) {heads(input.baseHeads);return this.engine.frontier(room,input.baseHeads);}
    return input.compare?this.version(room,input.compare):null;
  }
  files(room,input,version) {
    const limit=input.limit??100;fail(Number.isSafeInteger(limit)&&limit>0&&limit<=200,'INVALID_LIMIT','Invalid page limit');
    fail(input.after===undefined||typeof input.after==='string','INVALID_CURSOR','Invalid file cursor');
    fail(typeof input.query==='string'||input.query===undefined,'INVALID_QUERY','Invalid file search');const query=(input.query??'').toLowerCase();fail(query.length<=200,'INVALID_QUERY','Search is too long');
    const current=this.descriptors(version),base=this.base(room,input);const previous=base?this.descriptors(base):new Map();const rows=[];
    for(const id of [...new Set([...current.keys(),...previous.keys()])].sort()) {
      const a=previous.get(id),b=current.get(id);const path=b?.path??a.path;
      const wasPresent=Boolean(a&&!a.deleted),isPresent=Boolean(b&&!b.deleted);
      const status=!base?'present':!wasPresent&&isPresent?'added':wasPresent&&!isPresent?'deleted':!wasPresent&&!isPresent?'unchanged':a.path!==b.path?'renamed':JSON.stringify(a.heads)!==JSON.stringify(b.heads)?'modified':'unchanged';
      if((!base&&b.deleted)||id<=(input.after??'')||!path.toLowerCase().includes(query)||(input.changedOnly&&status==='unchanged'))continue;
      rows.push({fileId:id,path,previousPath:a?.path,status,deleted:b?.deleted??true});
    }
    return {heads:version.heads,files:rows.slice(0,limit),total:rows.length,nextCursor:rows.length>limit?rows[limit-1].fileId:null};
  }
  file(version,fileId) {
    fail(typeof fileId==='string'&&fileId.length<=200,'INVALID_FILE','Invalid file identity');
    if(!this.engine.manifest.get(version.root,`f:${fileId}`))return null;
    const data=this.engine.readFile(branchName(version.room),fileId,version.heads);const f=data.file;
    return {...f,...(f.kind==='binary'?{data:undefined,bytes:Buffer.from(f.data,'base64').length}:{}),conflicts:data.conflicts};
  }
  timeline(room,input,version) {
    const before=input.before??Number.MAX_SAFE_INTEGER,limit=input.limit??25;
    fail(Number.isSafeInteger(before)&&before>0&&Number.isSafeInteger(limit)&&limit>0&&limit<=50,'INVALID_CURSOR','Invalid history page');
    const rows=this.engine.db.prepare(`${causal} SELECT b.seq FROM shard_batches b JOIN reachable r ON r.id=b.id WHERE b.room=? AND b.seq<? ORDER BY b.seq DESC LIMIT ?`).all(JSON.stringify(version.heads),room,room,before,limit+1);
    const entries=rows.slice(0,limit).map(({seq})=>{
      const row=this.engine.db.prepare('SELECT id,parents,body FROM shard_batches WHERE seq=?').get(seq);
      return {cursor:seq,changeId:row.id,parents:JSON.parse(row.parents),body:row.body};
    });
    return {entries,nextCursor:rows.length>limit?entries.at(-1).cursor:null};
  }
  record(version,key) {
    if(!this.engine.manifest.get(version.root,key))return null;
    return this.engine.documents.scope(()=>{const doc=this.engine.doc(version,key);try {const field={m:'messages',c:'comments',a:'adapterEvents'}[key[0]];return plain(doc[field][key.slice(2)]);}finally{this.engine.documents.release(doc);}});
  }
  comments(version,fileId) {
    const matches=[...this.engine.manifest.entries(version.root)].filter(([key])=>key.startsWith('c:'));const result=[];let fileDoc;
    // Metadata discovery is a manifest scan; content work is explicitly capped.
    try {for(const [key] of matches.slice(0,200)) {const c=this.record(version,key);if(c.fileId!==fileId)continue;let resolved;
      try {
        fileDoc??=this.engine.doc(version,`f:${fileId}`);const path=['files',fileId,'text'];const start=A.getCursorPosition(fileDoc,path,c.start),end=A.getCursorPosition(fileDoc,path,c.end);const file=fileDoc.files[fileId];
        resolved={fileId,path:file.path,deleted:file.deleted,start,end,text:file.text.slice(start,Math.min(end,start+300))};
      }catch{resolved=null;}result.push({id:key.slice(2),...c,text:c.text.slice(0,12000),truncated:c.text.length>12000,resolved});
    }} finally {if(fileDoc)this.engine.documents.release(fileDoc);}
    return {comments:result,partial:matches.length>200};
  }
  run(room,input,principal) {
    return this.engine.documents.scope(()=>{
      if(input.command==='branches')return {branches:this.branches(room)};
      if(input.command==='publish')return this.publish(room,input,principal);
      const version=this.version(room,input.branch,input.heads);
      if(input.command==='files')return this.files(room,input,version);
      if(input.command==='message') {
        fail(typeof input.messageId==='string'&&input.messageId.length<=200,'INVALID_MESSAGE','Invalid message identity');const message=this.record(version,`m:${input.messageId}`);fail(message,'MESSAGE_NOT_FOUND','Message not found',404);return {message};
      }
      if(input.command==='timeline') {
        const page=this.timeline(room,input,version);const seen=new Set();let count=0;
        const entries=page.entries.map(({body,...entry})=>{
          const raw=unpack(body).metadata;const strings=value=>Array.isArray(value)?value.filter(v=>typeof v==='string'&&v.length<=200):[];
          const metadata=raw?{actor:typeof raw.actor==='string'?raw.actor.slice(0,200):'unknown',harness:typeof raw.harness==='string'?raw.harness.slice(0,200):'unknown',observedAt:typeof raw.observedAt==='string'?raw.observedAt.slice(0,200):'',fileIds:strings(raw.fileIds).slice(0,100),operationTypes:[...new Set(strings(raw.operationTypes))].slice(0,50)}:null;
          if(metadata){for(const key of ['sessionId','evidence','sourceEventId'])if(typeof raw[key]==='string')metadata[key]=raw[key].slice(0,200);}
          if(metadata)metadata.paths=Object.fromEntries(metadata.fileIds.map(id=>[id,this.engine.manifest.get(version.root,`f:${id}`)?.path?.slice(0,200)??id]));
          const ids=[...new Set([...strings(raw?.messageIds),...(typeof raw?.messageId==='string'?[raw.messageId]:[])])];const messages=[];
          for(const id of ids.slice(0,16)) {
            if(seen.has(id)||count>=50)continue;seen.add(id);const message=this.record(version,`m:${id}`);if(!message)continue;count++;
            messages.push({id,...message,text:message.text.slice(0,12000),truncated:message.text.length>12000});
          }
          return {...entry,metadata,messages,partial:ids.length>16||count>=50};
        });
        return {...page,entries,heads:version.heads};
      }
      if(input.command==='diff'||input.command==='file') {
        const current=this.file(version,input.fileId);const base=this.base(room,input);const before=base?this.file(base,input.fileId):null;
        fail(current||before,'FILE_NOT_FOUND','File not found in either version',404);
        const meta=f=>f?{fileId:f.fileId,path:f.path,kind:f.kind,mode:f.mode,deleted:f.deleted,bytes:f.bytes,target:f.target,conflicts:f.conflicts}:null;
        if(input.command==='file') {
          const f=current??before;const text=f.kind==='text'?f.text.slice(0,200000).split('\n').slice(0,2000).join('\n'):'';
          return {file:{...meta(f),text},previewFrom:current?'target':'base',truncated:text!==f.text&&f.kind==='text',heads:version.heads,...this.comments(version,input.fileId)};
        }
        const nonText=[current,before].filter(f=>f&&!f.deleted).some(f=>f.kind!=='text');
        const diff=nonText?{rows:[],added:null,removed:null,nonText:true,truncated:false}:lineDiff(before&&!before.deleted?before.text:'',current&&!current.deleted?current.text:'');
        return {before:meta(before),after:meta(current),...diff,heads:version.heads,...this.comments(version,input.fileId)};
      }
      fail(false,'UNKNOWN_REVIEW_COMMAND','Unknown review command',400);
    });
  }
}
