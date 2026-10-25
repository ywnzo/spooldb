import {visibleMemory} from './lifecycle.js';
import {createHash} from 'node:crypto';
const hash=text=>createHash('sha256').update(text).digest('hex');
export function chunks(row){
 const meta=JSON.parse(row.data),prefix=`${row.kind}: ${row.title.slice(0,120)}\n${(Array.isArray(meta.files)?meta.files:[]).map(file=>file?.path).filter(path=>typeof path==='string').join(' ').slice(0,100)}\n`,parts=[];
 // Small overlapping passages avoid burying a relevant conclusion at the end of a long chat.
 for(let offset=0;offset<row.text.length||offset===0;offset+=600)parts.push({offset,text:prefix+row.text.slice(offset,offset+750)});
 return parts;
}
function normalized(vector){
 if(!Array.isArray(vector)||!vector.length||vector.length>4096||!vector.every(Number.isFinite))throw Error('Invalid embedding');
 const norm=Math.hypot(...vector);if(!norm)throw Error('Zero embedding');return Float32Array.from(vector,v=>v/norm);
}
export class SemanticIndex {
 constructor(store,provider,{batchSize=8,maxChunks=64,minScore=0.25}={}){
  this.store=store;this.provider=provider;this.batchSize=batchSize;this.maxChunks=maxChunks;this.minScore=provider?.minScore??minScore;this.pending=new Map();this.lookups=new Map();this.inference=Promise.resolve();this.queries=new Map();this.retryAt=0;this.timers=new Map();this.closed=false;
  store.engine.db.exec('CREATE TABLE IF NOT EXISTS memory_vectors(room TEXT NOT NULL,id TEXT NOT NULL,model TEXT NOT NULL,fingerprint TEXT NOT NULL,chunk INTEGER NOT NULL,vector BLOB NOT NULL,PRIMARY KEY(room,id,model,chunk)); CREATE INDEX IF NOT EXISTS memory_vectors_room_model ON memory_vectors(room,model);');
 }
 async lookup(room,input,version,{waitMs=1200}={}){
  if(this.closed)return {results:[],status:'disabled'};
  const key=hash(JSON.stringify([room,input.query,input.taskId,input.kinds]));let job=this.lookups.get(key);
  if(!job&&this.lookups.size>=32)return {results:[],status:'busy'};
  if(!job){job=this.search(room,input,version).finally(()=>this.lookups.delete(key));this.lookups.set(key,job);}
  let timer;try{return await Promise.race([job,new Promise(resolve=>{timer=setTimeout(()=>resolve({results:[],status:'warming'}),waitMs);})]);}finally{clearTimeout(timer);}
 }
 async close(){this.closed=true;for(const timer of this.timers.values())clearTimeout(timer);this.timers.clear();await Promise.allSettled([...this.lookups.values(),...this.pending.values()]);}
 remaining(room){return this.store.engine.db.prepare('SELECT count(*) AS n FROM memory_docs d WHERE d.room=? AND '+visibleMemory('d')+' AND NOT EXISTS(SELECT 1 FROM memory_vectors v WHERE v.room=d.room AND v.id=d.id AND v.model=? AND v.fingerprint=d.fingerprint)').get(room,this.provider.id).n;}
 schedule(room,delayMs=100){
  if(this.closed||this.timers.has(room)||!this.remaining(room))return;
  const timer=setTimeout(()=>{this.timers.delete(room);if(!this.closed&&Date.now()>=this.retryAt)this.prepare(room).catch(()=>{this.retryAt=Date.now()+30000;});},delayMs);timer.unref?.();this.timers.set(room,timer);
 }
 async prepare(room){
  if(this.pending.has(room))return this.pending.get(room);
  if(this.pending.size>=2){this.schedule(room,1000);return Promise.resolve();}
  const job=this.build(room).finally(()=>{this.pending.delete(room);this.schedule(room);});this.pending.set(room,job);return job;
 }
 async embed(texts,options){
  const job=this.inference.then(()=>{if(this.closed)throw Error('Embedding index is closed');return this.provider.embed(texts,options);});this.inference=job.catch(()=>{});return job;
 }
 async build(room){
  const db=this.store.engine.db,model=this.provider.id;
  // Delete derived data when its source was removed or changed. Also works after a rebuild/import.
  db.prepare('DELETE FROM memory_vectors WHERE room=? AND (model<>? OR NOT EXISTS(SELECT 1 FROM memory_docs d WHERE d.room=memory_vectors.room AND d.id=memory_vectors.id AND d.fingerprint=memory_vectors.fingerprint))').run(room,model);
  const rows=db.prepare('SELECT d.* FROM memory_docs d WHERE d.room=? AND '+visibleMemory('d')+' AND NOT EXISTS(SELECT 1 FROM memory_vectors v WHERE v.room=d.room AND v.id=d.id AND v.model=? AND v.fingerprint=d.fingerprint) ORDER BY CASE WHEN d.kind=\'conversation\' THEN 1 ELSE 0 END,d.seq DESC LIMIT ?').all(room,model,this.maxChunks);
  let processed=0;
  for(const row of rows){
   if(this.closed||processed>=this.maxChunks)break;
   const parts=chunks(row),vectors=[];
   for(let i=0;i<parts.length;i+=this.batchSize){const batch=parts.slice(i,i+this.batchSize),out=await this.embed(batch.map(part=>part.text));if(out.length!==batch.length)throw Error('Embedding count mismatch');vectors.push(...out.map(normalized));}
   // No await inside the transaction; discard results if deletion or another write occurred meanwhile.
   if(this.closed)return;this.store.index(room);
   this.store.engine.transaction(()=>{
    const current=db.prepare('SELECT d.fingerprint FROM memory_docs d WHERE d.room=? AND d.id=? AND '+visibleMemory('d')+'').get(room,row.id);if(current?.fingerprint!==row.fingerprint)return;
    db.prepare('DELETE FROM memory_vectors WHERE room=? AND id=? AND model=?').run(room,row.id,model);
    for(let i=0;i<parts.length;i++)db.prepare('INSERT INTO memory_vectors VALUES(?,?,?,?,?,?)').run(room,row.id,model,row.fingerprint,parts[i].offset,new Uint8Array(vectors[i].buffer));
   });processed+=parts.length;
  }
 }
 async search(room,input,version){
  if(!this.provider)return {results:[],status:'disabled'};
  if(Date.now()<this.retryAt)return {results:[],status:'unavailable'};
  try{
   await this.prepare(room);if(this.closed)return {results:[],status:'disabled'};
   const cacheKey=hash(this.provider.id+'\0'+input.query);let query=this.queries.get(cacheKey);
   if(!query){query=normalized((await this.embed([input.query],{type:'query'}))[0]);if(this.queries.size>=64)this.queries.delete(this.queries.keys().next().value);this.queries.set(cacheKey,query);}
   // Filters apply before vector scoring: one project's vectors never participate in another's search.
   const where=['d.room=?',visibleMemory('d'),'v.model=?','v.fingerprint=d.fingerprint'],params=[room,this.provider.id];
   if(input.taskId){where.push('d.task_id=?');params.push(input.taskId);}
   if(input.kinds?.length){where.push(`d.kind IN (${input.kinds.map(()=>'?').join(',')})`);params.push(...input.kinds);}
   const background=this.store.backgroundTasks(room);if(background.length){where.push(`(d.task_id IS NULL OR d.task_id NOT IN (${background.map(()=>'?').join(',')}))`);params.push(...background);}
   const rows=this.store.engine.db.prepare(`SELECT d.id,d.seq,v.chunk,v.vector FROM memory_vectors v JOIN memory_docs d ON d.room=v.room AND d.id=v.id WHERE ${where.join(' AND ')}`).all(...params),scores=new Map();
   for(const row of rows){const bytes=new Uint8Array(row.vector),vector=new Float32Array(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));if(vector.length!==query.length)throw Error('Embedding dimensions changed');let score=0;for(let i=0;i<vector.length;i++)score+=vector[i]*query[i];if(score<this.minScore)continue;if(!scores.has(row.id)||scores.get(row.id).score<score)scores.set(row.id,{row,score});}
   const results=[...scores.values()].sort((a,b)=>b.score-a.score||b.row.seq-a.row.seq).slice(0,100).map(({row,score})=>{const source=this.store.engine.db.prepare('SELECT * FROM memory_docs WHERE room=? AND id=?').get(room,row.id);return {...this.store.decorate(source,version,input.query),text:source.text.slice(row.chunk,row.chunk+750),truncated:row.chunk>0||source.text.length>750,match:{semantic:Math.round(score*1000)/1000,offset:row.chunk}};});
   const remaining=this.remaining(room);
   return {results,status:remaining?'indexing':'ready',remaining,model:this.provider.id};
  }catch{this.retryAt=Date.now()+30000;return {results:[],status:'unavailable'};}
 }
}

export function fuse(lexical,semantic,query=''){
 const ranked=new Map();
 const identifiers=query.match(/\b[A-Z][A-Z0-9_]{3,}\b|\b\w+[a-z][A-Z]\w*\b|(?:[\w.-]+\/)+[\w.-]+/g)??[];
 for(const [channel,list]of [['keyword',lexical],['semantic',semantic]])for(let i=0;i<list.length;i++){
  const item=list[i],prior=ranked.get(item.id)??{item,score:0,channels:[]};
  prior.score+=(channel==='semantic'?1.5:1)/(60+i+1)+(channel==='semantic'?(item.match?.semantic??0)*0.2:0);
  if(channel==='keyword'&&identifiers.some(id=>`${item.title}\n${item.text}\n${(Array.isArray(item.files)?item.files:[]).map(file=>file?.path).join('\n')}`.includes(id)))prior.score+=1;
  prior.channels.push(channel);if(channel==='semantic')prior.item={...item,...(prior.channels.includes('keyword')?{match:{...item.match,keyword:true}}:{})};ranked.set(item.id,prior);
 }
 return [...ranked.values()].sort((a,b)=>b.score-a.score||b.item.sequence-a.item.sequence).map(({item,channels})=>({...item,retrievedBy:channels}));
}
