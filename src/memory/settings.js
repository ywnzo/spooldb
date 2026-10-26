import {fail} from '../relay/wire.js';
import {SemanticIndex} from './semantic.js';
import {embeddingModels,cloudflareModels,retrievalDefaults} from './models.js';
import {cloudflareEmbeddings} from './cloudflare-embeddings.js';
import {totalmem,freemem,availableParallelism} from 'node:os';
import {readFileSync} from 'node:fs';
function hardware(){let memory=totalmem();for(const path of ['/sys/fs/cgroup/memory.max','/sys/fs/cgroup/memory/memory.limit_in_bytes'])try{const limit=Number(readFileSync(path,'utf8').trim());if(Number.isFinite(limit)&&limit>0)memory=Math.min(memory,limit);}catch{}return {memoryBytes:memory,availableBytes:Math.min(freemem(),memory),cpus:availableParallelism()};}
export class RetrievalSettings{
 constructor(memory,{provider,remoteProvider=cloudflareEmbeddings,projects=()=>[]}={}){
  this.remoteProvider=remoteProvider;this.memory=memory;this.db=memory.engine.db;this.provider=provider;this.projects=projects;this.serial=Promise.resolve();this.state={status:'starting'};
  this.db.exec('CREATE TABLE IF NOT EXISTS retrieval_credentials(id INTEGER PRIMARY KEY,account TEXT NOT NULL,token TEXT NOT NULL);');
  this.db.exec('CREATE TABLE IF NOT EXISTS retrieval_settings(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL,data TEXT NOT NULL);');
  this.apply(this.read().settings);
 }
 read(){const row=this.db.prepare('SELECT * FROM retrieval_settings WHERE id=1').get();return {revision:row?.revision??0,settings:row?{provider:'local',accountId:'',...JSON.parse(row.data)}:{provider:'local',accountId:'',...retrievalDefaults,...(hardware().memoryBytes<1536*1048576?{model:'english-small',threads:1}:{})}};}
 async warm(provider){if(!provider.warm)return;if(!provider.id?.startsWith('workers-ai:'))return provider.warm();this.memory.usage.reserve('', ['SpoolDB connection test'],true);this.memory.usage.note('','embedding_probe_requests');const start=performance.now();try{return await provider.warm();}catch(error){this.memory.usage.note('','embedding_failures');throw error;}finally{this.memory.usage.note('','embedding_latency_ms',Math.round(performance.now()-start));}}
 credentials(){return this.db.prepare('SELECT account,token FROM retrieval_credentials WHERE id=1').get();}
 status(){const current=this.read();return {supported:true,...current,usage:{...this.memory.usage.status(),backlog:this.projects().map(p=>({room:p.room,name:p.name,records:this.memory.semantic?.remaining(p.room)??null})),lastFailure:this.memory.semantic?.lastFailure??null,queue:{queries:this.memory.semantic?.queue.queries.length??0,indexBatches:this.memory.semantic?.queue.background.length??0}},hardware:hardware(),cloudflare:{configured:!!this.credentials(),accountId:this.credentials()?.account??''},cloudflareModels,models:embeddingModels.map(({key,name,description})=>({key,name,description})),...this.state,cleanup:{mode:'archive',archived:this.db.prepare("SELECT count(*) AS n FROM memory_state WHERE status IN ('archived','resolved','superseded')").get().n,message:'Explicitly resolved or superseded records stay in history and are excluded from normal retrieval. Similarity alone never archives a record.'}};}
 run(input){
  if(input.action===undefined||input.action==='status')return this.status();
  if(input.action==='limits'){this.memory.usage.configure(input);if(this.memory.semantic){this.memory.semantic.retryAt=0;for(const project of this.projects())this.memory.semantic.schedule(project.room);}return this.status();}
  if(input.action==='retry'){this.apply(this.read().settings);return this.status();}
  if(input.action==='test'){
   fail(!this.testing,'RETRIEVAL_BUSY','A connection test is already running',429);
   const credentials=this.credentials(),accountId=input.accountId??credentials?.account,token=input.token||((accountId===credentials?.account)?credentials?.token:undefined);
   let provider;try{provider=this.remoteProvider({accountId,token,model:input.model});}catch{fail(false,'RETRIEVAL_CREDENTIALS','Enter a valid Account ID and Workers AI API token');}
   this.testing=true;return this.warm(provider).then(()=>({ok:true,message:'Cloudflare connection verified. No project memory was sent.'})).finally(async()=>{this.testing=false;await provider.dispose();});
  }
  fail(input.action==='configure','RETRIEVAL_ACTION','Choose status, configure, limits, test or retry');const raw=input.settings,value=raw&&{provider:'local',accountId:'',...raw};
  fail(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')==='accountId,contextChars,enabled,minScore,model,provider,threads'&&['local','cloudflare'].includes(value.provider)&&typeof value.accountId==='string'&&(value.accountId===''||/^[a-f0-9]{32}$/i.test(value.accountId))&&typeof value.enabled==='boolean'&&(value.provider==='cloudflare'?cloudflareModels:embeddingModels).some(m=>m.key===value.model)&&[1,2,4].includes(value.threads)&&Number.isFinite(value.minScore)&&value.minScore>=0.1&&value.minScore<=0.9&&Number.isInteger(value.contextChars)&&value.contextChars>=1000&&value.contextChars<=24000,'RETRIEVAL_SETTINGS','Choose a supported model, CPU limit, relevance threshold and context budget');
  fail(input.token===undefined||(typeof input.token==='string'&&/^[-A-Za-z0-9_]{20,256}$/.test(input.token)),'RETRIEVAL_CREDENTIALS','Enter a valid Workers AI API token');
  const credentials=this.credentials();
  if(value.provider==='cloudflare'&&value.enabled){fail(input.externalProcessingApproved===true,'RETRIEVAL_CONSENT','Confirm that indexed passages and search queries may be sent to Cloudflare');fail(value.accountId&&(input.token||credentials?.account===value.accountId),'RETRIEVAL_CREDENTIALS','Enter an Account ID and API token for this account');}
  fail(!input.clearToken||value.provider!=='cloudflare'||!value.enabled,'RETRIEVAL_CREDENTIALS','Disable Cloudflare retrieval before removing its token');
  this.memory.engine.transaction(()=>{const current=this.read();fail(input.expectedRevision===current.revision,'RETRIEVAL_CONFLICT','Retrieval settings changed; refresh before saving',409);if(input.clearToken)this.db.prepare('DELETE FROM retrieval_credentials').run();else if(input.token){fail(/^[a-f0-9]{32}$/i.test(value.accountId),'RETRIEVAL_CREDENTIALS','Enter a valid Account ID');this.db.prepare('INSERT INTO retrieval_credentials VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET account=excluded.account,token=excluded.token').run(value.accountId,input.token);}
   this.db.prepare('INSERT INTO retrieval_settings VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,data=excluded.data').run(current.revision+1,JSON.stringify(value));});
  this.apply(value);return this.status();
 }
 apply(settings){
  const generation=(this.generation??0)+1;this.generation=generation;this.state={...this.state,status:settings.enabled?'loading':'disabled',error:null,download:null};
  const active=this.memory.semantic,disconnect=active?.provider?.id?.startsWith('workers-ai:')||settings.provider==='cloudflare';
  const disabling=(!settings.enabled||disconnect)?active:null;if(disabling){this.memory.semantic=null;disabling.close();if(disabling.provider.id.startsWith('workers-ai:'))disabling.provider.dispose?.();}
  this.memory.retrievalSettings={contextChars:settings.contextChars,configuredModel:settings.model};
  this.serial=this.serial.catch(()=>{}).then(async()=>{
   if(generation!==this.generation){if(disabling){await disabling.close();await disabling.provider.dispose?.();}return;}
   if(disabling&&settings.enabled){await disabling.close();await disabling.provider.dispose?.();if(generation!==this.generation)return;}
   if(!settings.enabled){const old=disabling??this.memory.semantic;this.memory.semantic=null;await old?.close();await old?.provider.dispose?.();this.state={status:'disabled',activeModel:null};return;}
   let provider;
   try{
    provider=settings.provider==='cloudflare'?this.remoteProvider({...settings,token:this.credentials()?.account===settings.accountId?this.credentials()?.token:undefined}):await this.provider({...settings,onProgress:event=>{if(generation===this.generation&&['progress','download','done'].includes(event.status))this.state.download={file:event.file,progress:event.progress??null};}});
    fail(provider,'MODEL_RUNTIME','Local embedding runtime is unavailable');await this.warm(provider);
    if(generation!==this.generation){await provider.dispose?.();return;}
    const old=this.memory.semantic;await old?.close();if(generation!==this.generation){await provider.dispose?.();return;}this.memory.semantic=new SemanticIndex(this.memory,provider);if(old?.provider!==provider)await old?.provider.dispose?.();if(generation!==this.generation)return;
    this.state={status:'ready',activeModel:settings.model,error:null};
    for(const project of this.projects()){this.memory.index(project.room);this.memory.semantic.schedule(project.room);}
   }catch(error){await provider?.dispose?.().catch(()=>{});if(generation===this.generation)this.state={status:'error',activeModel:this.state.activeModel??null,error:settings.provider==='cloudflare'?'Cloudflare could not be connected. Test the credentials and check relay network access; keyword search remains available.':'Model could not be loaded. Check relay disk, memory and access to Hugging Face, then retry.'};}
  });
 }
 async close(){this.generation++;await this.serial;await this.memory.semantic?.close();await this.memory.semantic?.provider.dispose?.();}
}
