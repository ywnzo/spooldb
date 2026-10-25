// Captured JSON is untrusted input, including fields consumed by the index and UI.
const kinds=new Set(['task','finding','decision','blocker','handoff']);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const text=(value,max)=>typeof value==='string'&&value.length<=max;
const list=(value,max=30,length=1000)=>Array.isArray(value)&&value.length<=max&&value.every(item=>text(item,length));
export function validMemoryEvent(value){
 if(!object(value)||value.protocol!=='spool-memory/1'||!kinds.has(value.kind)||!text(value.title,500)||!text(value.text,16000))return false;
 for(const key of ['actor','sessionId','createdAt','taskId'])if(value[key]!==undefined&&value[key]!==null&&!text(value[key],key==='taskId'?160:300))return false;
 for(const key of ['refs','nextSteps','blockers','resolveIds','commits'])if(value[key]!==undefined&&!list(value[key]))return false;
 if(value.files!==undefined&&(!Array.isArray(value.files)||value.files.length>30||!value.files.every(object)))return false;
 if(value.git!==undefined&&!object(value.git))return false;
 if(value.status!==undefined&&!['open','in_progress','blocked','done'].includes(value.status))return false;
 if(value.revision!==undefined&&(!Number.isSafeInteger(value.revision)||value.revision<1))return false;
 if(value.kind==='task'&&(!text(value.taskId,160)||!value.taskId||!Number.isSafeInteger(value.revision)||value.revision<1||!['open','in_progress','blocked','done'].includes(value.status)))return false;
 for(const key of ['lifecycleControl','importedFromLocal'])if(value[key]!==undefined&&typeof value[key]!=='boolean')return false;
 if(value.lifecycleChanges!==undefined&&(!Array.isArray(value.lifecycleChanges)||value.lifecycleChanges.length>60||!value.lifecycleChanges.every(change=>object(change)&&text(change.targetId,200)&&change.targetId.length>0&&['active','archived','resolved','superseded'].includes(change.status)&&Number.isSafeInteger(change.revision)&&change.revision>0&&(change.replacementId===undefined||text(change.replacementId,200)&&change.replacementId.length>0)&&text(change.reason,1000))))return false;
 return true;
}
