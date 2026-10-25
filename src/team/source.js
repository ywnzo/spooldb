import {deletionSchema,deletedConversation,isConversation} from './conversation-deletion.js';
import {recordBlocked,defaultSharing} from './sharing.js';
import {createHash} from 'node:crypto';
import {fail} from '../relay/wire.js';
import {sharedFileReference} from './reference-contract.js';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const sourceId=(principal,id)=>`captured-${hash([principal,id])}`;
export const sourcePrefix=principal=>`@machines/${principal}/`;
export function ingestSource(engine,room,input,principal,sharing=defaultSharing()){
 deletionSchema(engine);
 fail(Array.isArray(input.records)&&input.records.length>0&&input.records.length<=50,'SOURCE_LIMIT','Expected 1–50 conversation records');
 // Validate the entire page before receipts or mutations, including old-client retries.
 for(const record of input.records){fail(record?.kind==='message','GIT_ONLY','Source files are not accepted. Update your client; code stays in Git.',426);fail(Object.keys(record).every(key=>['kind','id','role','text','provenance'].includes(key)),'SOURCE_MESSAGE','Only conversation fields are accepted');fail(typeof record.id==='string'&&record.id.length>0&&record.id.length<=200&&['user','assistant','system','tool'].includes(record.role)&&typeof record.text==='string'&&record.text.length<=500000,'SOURCE_MESSAGE','Invalid captured conversation');}
 for(const record of input.records)if(record.provenance!==undefined){const p=record.provenance;fail(p&&typeof p==='object'&&!Array.isArray(p)&&Object.keys(p).every(k=>['sessionId','turnId','itemId','harness','source'].includes(k))&&typeof p.sessionId==='string'&&Object.values(p).every(v=>typeof v==='string'&&v.length>0&&v.length<=200),'SOURCE_MESSAGE','Invalid conversation provenance');}
 for(const record of input.records){let event;try{event=JSON.parse(record.text);}catch{}if(event?.protocol==='spool-memory/1'){for(const file of event.files??[])sharedFileReference(file);if(event.git!==undefined)sharedFileReference(event.git);}}
 const branch=`relay-${room}`,prefix=sourcePrefix(principal.id),fingerprint=hash(input.records);
 engine.db.exec('CREATE TABLE IF NOT EXISTS conversation_origins(room TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(room,id))');
 engine.db.exec('CREATE TABLE IF NOT EXISTS team_source_private(room TEXT,principal TEXT,id TEXT,PRIMARY KEY(room,principal,id))');
 engine.db.exec('CREATE TABLE IF NOT EXISTS team_ingest(room TEXT,principal TEXT,request_id TEXT,hash TEXT,result TEXT,PRIMARY KEY(room,principal,request_id))');
 fail(typeof input.requestId==='string'&&input.requestId.length>0&&input.requestId.length<=200,'REQUEST_ID','Request ID required');
 return engine.transaction(()=>{
 const prior=engine.db.prepare('SELECT * FROM team_ingest WHERE room=? AND principal=? AND request_id=?').get(room,principal.id,input.requestId);if(prior){fail(prior.hash===fingerprint,'REQUEST_CONFLICT','Conversation retry changed',409);return JSON.parse(prior.result);}
 fail(engine.db.prepare('SELECT 1 FROM shard_refs WHERE name=?').get(branch),'ROOM_EMPTY','Create the shared project first',409);
 const operations=[];let skipped=0;
 for(const record of input.records){if(isConversation(record.text)&&deletedConversation(engine,room,sourceId(principal.id,record.id),record.provenance?.sessionId)){skipped++;continue;}if(recordBlocked(record,sharing)){if(!engine.manifest.get(engine.version(branch).root,'m:'+sourceId(principal.id,record.id)))engine.db.prepare('INSERT OR IGNORE INTO team_source_private VALUES(?,?,?)').run(room,principal.id,record.id);skipped++;continue;}if(engine.db.prepare('SELECT 1 FROM team_source_private WHERE room=? AND principal=? AND id=?').get(room,principal.id,record.id)){skipped++;continue;}const id=sourceId(principal.id,record.id);if(record.provenance)engine.db.prepare('INSERT INTO conversation_origins VALUES(?,?,?) ON CONFLICT(room,id) DO UPDATE SET data=excluded.data').run(room,id,JSON.stringify({...record.provenance,principal:principal.id}));if(engine.manifest.get(engine.version(branch).root,`m:${id}`))continue;let text=record.text,event;try{event=JSON.parse(text);}catch{}
 if(event?.protocol==='spool-memory/1'){
  event.actor=`${principal.id}/${String(event.actor).slice(0,100)}`;if(event.taskId)event.taskId=`${principal.id}.${event.taskId}`.slice(0,160);
  event.refs=(event.refs??[]).map(ref=>sourceId(principal.id,ref));event.files=(event.files??[]).map(sharedFileReference);if(event.resolveIds)event.resolveIds=event.resolveIds.map(ref=>sourceId(principal.id,ref));if(Array.isArray(event.lifecycleChanges))event.lifecycleChanges=event.lifecycleChanges.map(change=>({...change,targetId:sourceId(principal.id,change.targetId),...(change.replacementId?{replacementId:sourceId(principal.id,change.replacementId)}:{})}));event.importedFromLocal=true;text=JSON.stringify(event);
 }
 const operation={type:'message.add',messageId:id,role:record.role,text};operations.push(operation);const p=record.provenance;engine.submit(branch,{actor:principal.id,harness:p?.harness??'team-capture',evidence:'machine-captured-conversation',sessionId:p?.sessionId??principal.id,...(p?.turnId?{turnId:p.turnId}:{}),...(p?.itemId?{messageId:p.itemId}:{}),...(p?.source?{sourceEventId:p.source}:{}),requestId:`source-record-${hash([principal.id,input.requestId,record.id])}`,expectedHeads:engine.ref(branch).heads,operations:[operation]});
 }

 const result={room,sourcePrefix:prefix,accepted:input.records.length-skipped,skipped,operations:operations.length};engine.db.prepare('INSERT INTO team_ingest VALUES(?,?,?,?,?)').run(room,principal.id,input.requestId,fingerprint,JSON.stringify(result));return result;
 });
}
