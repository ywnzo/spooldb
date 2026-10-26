import {InferenceQueue} from './inference-queue.js';
import {visibleMemory} from './lifecycle.js';
import {createHash} from 'node:crypto';
const needsVectors="(NOT EXISTS(SELECT 1 FROM memory_vectors v WHERE v.room=d.room AND v.id=d.id AND v.model=? AND v.fingerprint=d.fingerprint) OR EXISTS(SELECT 1 FROM memory_vector_progress p WHERE p.room=d.room AND p.id=d.id AND p.model=? AND p.fingerprint=d.fingerprint))";
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
 constructor(store,provider,{batchSize=8,maxChunks=64,minScore=0.25,retryDelayMs=30000}={}){
  this.retryDelayMs=retryDelayMs;this.store=store;this.provider=provider;this.batchSize=batchSize;this.maxChunks=maxChunks;this.minScore=provider?.minScore??minScore;this.pending=new Map();this.lookups=new Map();this.queue=new InferenceQueue();this.queries=new Map();this.retryAt=0;this.timers=new Map();this.closed=false;
  store.engine.db.exec('CREATE TABLE IF NOT EXISTS memory_vectors(room TEXT NOT NULL,id TEXT NOT NULL,model TEXT NOT NULL,fingerprint TEXT NOT NULL,chunk INTEGER NOT NULL,vector BLOB NOT NULL,PRIMARY KEY(room,id,model,chunk)); CREATE INDEX IF NOT EXISTS memory_vectors_room_model ON memory_vectors(room,model); CREATE INDEX IF NOT EXISTS memory_vectors_scan ON memory_vectors(room,model,id,chunk); CREATE TABLE IF NOT EXISTS memory_vector_progress(room TEXT NOT NULL,id TEXT NOT NULL,model TEXT NOT NULL,fingerprint TEXT NOT NULL,next_chunk INTEGER NOT NULL,PRIMARY KEY(room,id,model));');
 }
 async lookup(room,input,version,{waitMs=1200}={}){
  if(this.closed)return {results:[],status:'disabled'};
  const key=hash(JSON.stringify([room,input.query,input.taskId,input.kinds]));let job=this.lookups.get(key);
  if(!job&&this.lookups.size>=32)return {results:[],status:'busy'};
  if(!job){job=this.search(room,input,version).finally(()=>this.lookups.delete(key));this.lookups.set(key,job);}
  let timer;try{return await Promise.race([job,new Promise(resolve=>{timer=setTimeout(()=>resolve({results:[],status:'warming'}),waitMs);})]);}finally{clearTimeout(timer);}
 }
 async close(){this.closed=true;this.queue.close();for(const timer of this.timers.values())clearTimeout(timer);this.timers.clear();await Promise.allSettled([...this.lookups.values(),...this.pending.values()]);}
 remaining(room){return this.store.engine.db.prepare('SELECT count(*) AS n FROM memory_docs d WHERE d.room=? AND '+visibleMemory('d')+' AND '+needsVectors).get(room,this.provider.id,this.provider.id).n;}
 schedule(room,delayMs=100){
  if(this.closed||this.timers.has(room)||!this.remaining(room))return;
  const timer=setTimeout(()=>{this.timers.delete(room);if(this.closed)return;if(Date.now()<this.retryAt){this.schedule(room);return;}this.prepare(room).catch(()=>{});},Math.max(delayMs,this.retryAt-Date.now()));timer.unref?.();this.timers.set(room,timer);
 }
 async prepare(room){
  if(this.pending.has(room))return this.pending.get(room);
  if(this.pending.size>=2){this.schedule(room,1000);return Promise.resolve();}
  const job=this.build(room).catch(error=>{this.retryAt=Date.now()+this.retryDelayMs;this.lastFailure={code:error.code==='EMBEDDING_LIMIT'?'budget_exceeded':'provider_error',at:new Date().toISOString()};throw error;}).finally(()=>{this.pending.delete(room);this.schedule(room);});this.pending.set(room,job);return job;
 }
 async embed(texts,options){
  return this.queue.run(async()=>{
   if(this.closed)throw Error('Embedding index is closed');const room=options?.room,usage=this.store.usage;usage?.reserve(room,texts,this.provider.id.startsWith('workers-ai:'));const start=performance.now();
   try{return await this.provider.embed(texts,options);}catch(error){usage?.note(room,'embedding_failures');throw error;}finally{usage?.note(room,'embedding_latency_ms',Math.round(performance.now()-start));}
  },options?.type==='query');
 }
 async build(room){
  const db=this.store.engine.db,model=this.provider.id;
  // Delete derived data when its source was removed or changed. Also works after a rebuild/import.
  db.prepare('DELETE FROM memory_vectors WHERE room=? AND (model<>? OR NOT EXISTS(SELECT 1 FROM memory_docs d WHERE d.room=memory_vectors.room AND d.id=memory_vectors.id AND d.fingerprint=memory_vectors.fingerprint))').run(room,model);
  db.prepare('DELETE FROM memory_vector_progress WHERE room=? AND (model<>? OR NOT EXISTS(SELECT 1 FROM memory_docs d WHERE d.room=memory_vector_progress.room AND d.id=memory_vector_progress.id AND d.fingerprint=memory_vector_progress.fingerprint))').run(room,model);
  const rows=db.prepare('SELECT d.* FROM memory_docs d WHERE d.room=? AND '+visibleMemory('d')+' AND '+needsVectors+' ORDER BY CASE WHEN d.kind=\'conversation\' THEN 1 ELSE 0 END,d.seq DESC LIMIT ?').all(room,model,model,this.maxChunks);
  let processed=0;
  for(const row of rows){
   if(this.closed||processed>=this.maxChunks)break;
   const parts=chunks(row),progress=db.prepare('SELECT next_chunk FROM memory_vector_progress WHERE room=? AND id=? AND model=? AND fingerprint=?').get(room,row.id,model,row.fingerprint);
   for(let i=progress?.next_chunk??0;i<parts.length&&processed<this.maxChunks;){
    const end=Math.min(i+this.batchSize,i+this.maxChunks-processed,parts.length),batch=parts.slice(i,end),out=await this.embed(batch.map(part=>part.text),{room,type:'index'});if(out.length!==batch.length)throw Error('Embedding count mismatch');const vectors=out.map(normalized);
    // Persist a bounded batch and its cursor atomically. Source changes invalidate partial work.
    if(this.closed)return;this.store.index(room);let accepted=false;
    this.store.engine.transaction(()=>{
     const current=db.prepare('SELECT d.fingerprint FROM memory_docs d WHERE d.room=? AND d.id=? AND '+visibleMemory('d')).get(room,row.id);if(current?.fingerprint!==row.fingerprint)return;
     for(let j=0;j<batch.length;j++)db.prepare('INSERT OR REPLACE INTO memory_vectors VALUES(?,?,?,?,?,?)').run(room,row.id,model,row.fingerprint,batch[j].offset,new Uint8Array(vectors[j].buffer));
     if(end===parts.length)db.prepare('DELETE FROM memory_vector_progress WHERE room=? AND id=? AND model=?').run(room,row.id,model);
     else db.prepare('INSERT INTO memory_vector_progress VALUES(?,?,?,?,?) ON CONFLICT(room,id,model) DO UPDATE SET fingerprint=excluded.fingerprint,next_chunk=excluded.next_chunk').run(room,row.id,model,row.fingerprint,end);
     accepted=true;
    });processed+=batch.length;i=end;if(!accepted)break;
   }
  }
 }
 async search(room,input,version){
  if(!this.provider)return {results:[],status:'disabled'};
  const cacheKey=hash(this.provider.id+'\0'+input.query);let query=this.queries.get(cacheKey);this.store.usage?.note(room,query?'query_cache_hits':'query_cache_misses');
  const indexed=query&&this.store.engine.db.prepare('SELECT 1 FROM memory_vectors v JOIN memory_docs d ON d.room=v.room AND d.id=v.id WHERE d.room=? AND v.model=? AND v.fingerprint=d.fingerprint AND '+visibleMemory('d')+' LIMIT 1').get(room,this.provider.id);
  if(!indexed&&Date.now()<this.retryAt)return {results:[],status:this.lastFailure?.code==='budget_exceeded'?'budget_exceeded':'unavailable'};
  try{
   // A fresh query joins the priority queue before bulk indexing; existing
   // vectors remain searchable while the backlog progresses in the background.
   if(!query){query=normalized((await this.embed([input.query],{type:'query',room}))[0]);if(this.queries.size>=64)this.queries.delete(this.queries.keys().next().value);this.queries.set(cacheKey,query);}
   const available=indexed||this.store.engine.db.prepare('SELECT 1 FROM memory_vectors v JOIN memory_docs d ON d.room=v.room AND d.id=v.id WHERE d.room=? AND v.model=? AND v.fingerprint=d.fingerprint AND '+visibleMemory('d')+' LIMIT 1').get(room,this.provider.id);
   if(available)this.schedule(room);else await this.prepare(room);if(this.closed)return {results:[],status:'disabled'};
   // Filters apply before vector scoring: one project's vectors never participate in another's search.
   const where=['d.room=?',visibleMemory('d'),'v.model=?','v.fingerprint=d.fingerprint'],params=[room,this.provider.id];
   if(input.taskId){where.push('d.task_id=?');params.push(input.taskId);}
   if(input.kinds?.length){where.push(`d.kind IN (${input.kinds.map(()=>'?').join(',')})`);params.push(...input.kinds);}
   const background=this.store.backgroundTasks(room);if(background.length){where.push(`(d.task_id IS NULL OR d.task_id NOT IN (${background.map(()=>'?').join(',')}))`);params.push(...background);}
   const scores=new Map(),scanStart=performance.now();let lastId='',lastChunk=-1,pages=0,scanned=0;
   while(true){
    const rows=this.store.engine.db.prepare(`SELECT d.id,d.seq,d.fingerprint,v.chunk,v.vector FROM memory_vectors v JOIN memory_docs d ON d.room=v.room AND d.id=v.id WHERE ${where.join(' AND ')} AND (v.id,v.chunk)>(?,?) ORDER BY v.id,v.chunk LIMIT 512`).all(...params,lastId,lastChunk);
    if(!rows.length)break;
    for(const row of rows){const bytes=new Uint8Array(row.vector),vector=new Float32Array(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));if(vector.length!==query.length)throw Error('Embedding dimensions changed');let score=0;for(let i=0;i<vector.length;i++)score+=vector[i]*query[i];if(score<this.minScore)continue;if(!scores.has(row.id)||scores.get(row.id).score<score)scores.set(row.id,{row:{id:row.id,seq:row.seq,chunk:row.chunk,fingerprint:row.fingerprint},score});}
    scanned+=rows.length;const last=rows.at(-1);lastId=last.id;lastChunk=last.chunk;
    if(++pages%16===0){await new Promise(resolve=>setTimeout(resolve,0));if(this.closed)return {results:[],status:'disabled'};}
   }
   this.store.usage?.note(room,'vector_scan_vectors',scanned);this.store.usage?.note(room,'vector_scan_ms',Math.round(performance.now()-scanStart));
   const results=[...scores.values()].sort((a,b)=>b.score-a.score||b.row.seq-a.row.seq).slice(0,100).map(({row,score})=>{const source=this.store.engine.db.prepare('SELECT d.* FROM memory_docs d WHERE d.room=? AND d.id=? AND d.fingerprint=? AND '+visibleMemory('d')).get(room,row.id,row.fingerprint);if(!source)return null;return {...this.store.decorate(source,version,input.query),text:source.text.slice(row.chunk,row.chunk+750),truncated:row.chunk>0||source.text.length>750,match:{semantic:Math.round(score*1000)/1000,offset:row.chunk}};}).filter(Boolean);
   const remaining=this.remaining(room);
   return {results,status:remaining?'indexing':'ready',remaining,model:this.provider.id};
  }catch(error){this.retryAt=Date.now()+this.retryDelayMs;this.lastFailure={code:error.code==='EMBEDDING_LIMIT'?'budget_exceeded':'provider_error',at:new Date().toISOString()};return {results:[],status:this.lastFailure.code==='budget_exceeded'?'budget_exceeded':'unavailable'};}
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
