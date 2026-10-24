import {createHash} from 'node:crypto';
import {unpack} from '../storage/codec.js';
import {sourceId} from './source.js';
import {sharedFileReference} from './reference-contract.js';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function exportMemoryRecords(engine,room){
 const version=engine.version(`relay-${room}`),meta=new Map(engine.db.prepare('SELECT body FROM shard_batches WHERE room=?').all(room).map(row=>{const m=unpack(row.body).metadata;return [m?.eventId,m];}));
 const sequence=new Map(engine.db.prepare('SELECT id,seq FROM memory_docs WHERE room=?').all(room).map(row=>[row.id,row.seq]));
 const origins=new Map(engine.db.prepare('SELECT id,data FROM conversation_origins WHERE room=?').all(room).map(row=>[row.id,JSON.parse(row.data)]));
 return engine.documents.scope(()=>[...engine.manifest.entries(version.root)].filter(([key])=>key.startsWith('m:')).sort(([a],[b])=>(sequence.get(a.slice(2))??0)-(sequence.get(b.slice(2))??0)).map(([key,descriptor])=>{
  const id=key.slice(2),value=engine.doc(version,key).messages[id],source=origins.get(id)??meta.get(value.eventId)??{};
  const provenance=source.sessionId?{sessionId:source.sessionId,...(source.turnId?{turnId:source.turnId}:{}),...(source.itemId??source.messageId?{itemId:source.itemId??source.messageId}:{}),harness:source.harness??'generic',source:source.source??'relay-migration'}:undefined;
  return {kind:'message',id,role:value.role,text:value.text,...(provenance?{provenance}:{}),descriptor,originPrincipal:source.principal};
 }));
}
export function planMemoryMigration({remote,local}){
 const localById=new Map(local.map(r=>[r.id,r])),aliases=new Map(),matches=new Map();
 for(const record of remote){if(!record.originPrincipal)continue;for(const candidate of local){if(record.id===sourceId(record.originPrincipal,candidate.id)){aliases.set(record.id,candidate.id);matches.set(record.id,candidate);break;}}}
 const taskAliases=new Map();for(const record of remote){const match=matches.get(record.id);if(match){try{const a=JSON.parse(record.text),b=JSON.parse(match.text);if(a.taskId&&b.taskId)taskAliases.set(a.taskId,b.taskId);}catch{}}}
 const records=remote.map(record=>{
  let text=record.text,event;try{event=JSON.parse(text);}catch{}
  if(event?.protocol==='spool-memory/1'){
   event.files=(event.files??[]).map(sharedFileReference);event.refs=(event.refs??[]).map(id=>aliases.get(id)??id);if(event.resolveIds)event.resolveIds=event.resolveIds.map(id=>aliases.get(id)??id);if(event.taskId)event.taskId=taskAliases.get(event.taskId)??event.taskId;text=JSON.stringify(event);
  }
  return {kind:'message',id:aliases.get(record.id)??record.id,role:record.role,text,...(record.provenance?{provenance:record.provenance}:{})};
 });
 if(new Set(records.map(r=>r.id)).size!==records.length)throw Error('Migration identity collision; source has not been changed');
 return {records,aliases:Object.fromEntries(aliases),localMarkers:[...matches.values()].map(r=>({id:'m:'+r.id,fingerprint:hash(localById.get(r.id).descriptor)})),sourceMap:Object.fromEntries(remote.map(r=>[r.id,aliases.get(r.id)??r.id]))};
}
export function markMigratedLocalRecords(engine,connection,markers){
 const key=hash(['memory-provenance-v2',connection.url,connection.room,connection.token]);
 engine.transaction(()=>{for(const marker of markers)engine.db.prepare('INSERT INTO team_export VALUES(?,?,?) ON CONFLICT(remote,id) DO UPDATE SET fingerprint=excluded.fingerprint').run(key,marker.id,marker.fingerprint);});
}
