import {fail} from '../relay/wire.js';
export function visibleMemory(alias='d',{includeArchived=false}={}){
 const control=`COALESCE(json_extract(${alias}.data,'$.lifecycleControl'),0)<>1`;
 if(includeArchived)return control;
 return `${control} AND NOT EXISTS(SELECT 1 FROM memory_state s WHERE s.room=${alias}.room AND s.id=${alias}.id AND s.status IN ('archived','resolved','superseded')) AND (${alias}.kind<>'task' OR (COALESCE(json_extract(${alias}.data,'$.status'),'')<>'done' AND NOT EXISTS(SELECT 1 FROM memory_docs newer WHERE newer.room=${alias}.room AND newer.kind='task' AND newer.task_id=${alias}.task_id AND CAST(json_extract(newer.data,'$.revision') AS INTEGER)>CAST(json_extract(${alias}.data,'$.revision') AS INTEGER))))`;
}
export function lifecycleState(db,room,id){const row=db.prepare('SELECT data FROM memory_state WHERE room=? AND id=?').get(room,id);return row?JSON.parse(row.data):{status:'active',revision:0};}
export function rebuildLifecycle(db,room){
 const groups=new Map(),rows=db.prepare("SELECT id,data FROM memory_docs WHERE room=? AND json_type(data,'$.lifecycleChanges')='array' ORDER BY seq,rowid").all(room);
 for(const row of rows){const event=JSON.parse(row.data);for(const change of (event.lifecycleChanges??[]).slice(0,60)){if(!change||typeof change.targetId!=='string'||!['active','archived','resolved','superseded'].includes(change.status)||!Number.isSafeInteger(change.revision)||change.revision<1||change.targetId===row.id)continue;
  if(!db.prepare('SELECT 1 FROM memory_docs WHERE room=? AND id=?').get(room,change.targetId))continue;
  const current=groups.get(change.targetId);if(current&&current.revision>change.revision)continue;
  const state={...change,sourceId:row.id,actor:event.actor,changedAt:event.createdAt};
  if(current?.revision===change.revision){const conflicts=[...new Set([...(current.conflicts??[current.sourceId]),row.id])];groups.set(change.targetId,{status:'conflict',revision:change.revision,conflicts});}else groups.set(change.targetId,state);
 }}
 db.prepare('DELETE FROM memory_state WHERE room=?').run(room);for(const [id,state]of groups)db.prepare('INSERT INTO memory_state VALUES(?,?,?,?,?)').run(room,id,state.status,state.revision,JSON.stringify(state));
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_vectors'").get())db.prepare(`DELETE FROM memory_vectors WHERE room=? AND id IN (SELECT d.id FROM memory_docs d WHERE d.room=? AND NOT (${visibleMemory('d')}))`).run(room,room);
}
export function lifecycleChanges(store,room,input,newId){
 const changes=[],seen=new Set(),db=store.engine.db;
 const add=(id,status,replacementId,reason,expectedRevision,resolveIds)=>{
  fail(typeof id==='string'&&id.length>0&&id.length<=200&&!seen.has(id),'MEMORY_LIFECYCLE','Choose distinct records from this project');seen.add(id);
  const target=db.prepare('SELECT kind,data FROM memory_docs WHERE room=? AND id=?').get(room,id);fail(target&&!JSON.parse(target.data).lifecycleControl,'MEMORY_NOT_FOUND','Target memory is not in this project',404);
  const current=lifecycleState(db,room,id);if(expectedRevision!==undefined)fail(expectedRevision===current.revision,'MEMORY_CONFLICT','Record state changed; retrieve it before updating',409);
  if(current.conflicts?.length)fail(JSON.stringify([...(resolveIds??[])].sort())===JSON.stringify([...current.conflicts].sort()),'MEMORY_CONFLICT','Resolve every conflicting state update explicitly',409);
  if(replacementId&&replacementId!==newId)fail(replacementId!==id&&db.prepare('SELECT 1 FROM memory_docs WHERE room=? AND id=?').get(room,replacementId),'MEMORY_NOT_FOUND','Replacement must be another record in this project',404);
  if(replacementId&&replacementId!==newId)fail(lifecycleState(db,room,replacementId).status==='active','MEMORY_LIFECYCLE','The replacement must be active; restore or resolve it first');
  changes.push({targetId:id,status,revision:current.revision+1,...(replacementId?{replacementId}:{}),reason:String(reason).slice(0,1000)});
 };
 if(input.lifecycle){const value=input.lifecycle;fail(value&&['archive','restore','resolve','supersede'].includes(value.action)&&Number.isSafeInteger(value.expectedRevision)&&value.expectedRevision>=0,'MEMORY_LIFECYCLE','Choose an action and the current state revision');if(value.action==='supersede')fail(typeof value.replacementId==='string','MEMORY_LIFECYCLE','Superseding a record needs its replacement');add(value.id,{archive:'archived',restore:'active',resolve:'resolved',supersede:'superseded'}[value.action],value.replacementId,input.text,value.expectedRevision,value.resolveIds);}
 for(const [field,status]of [['supersedes','superseded'],['resolves','resolved']])if(input[field]!==undefined){fail(Array.isArray(input[field])&&input[field].length<=30,'MEMORY_LIFECYCLE','Too many supersession links');for(const id of input[field])add(id,status,newId,input.title);}
 return changes;
}
export function updateMemoryInput(input){return {command:'remember',kind:'decision',title:`Memory ${input.action}`,text:input.reason,requestId:input.requestId,lifecycle:{id:input.id,action:input.action,replacementId:input.replacementId,expectedRevision:input.expectedRevision,resolveIds:input.resolveIds}};}
