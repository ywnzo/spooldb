import {join} from 'node:path';
import {homedir} from 'node:os';
import {createRequire} from 'node:module';
import {embeddingModels} from './models.js';

// Pin weights as well as the runtime: cached vectors must never silently mix models.
export const MODEL='Xenova/paraphrase-multilingual-MiniLM-L12-v2';
export const REVISION='2c4055b12046f11709e9df2c122e59ffbdc2f900';
const pipelines=new Map();
export function localEmbeddings({cacheDir=process.env.SPOOL_MODEL_CACHE??join(process.env.XDG_CACHE_HOME??join(homedir(),'.cache'),'spool/models'),model='multilingual',threads=2,minScore=0.25,onProgress}={}){
 // The lightweight Codex plugin asks its relay to infer; only standalone installs
 // and source checkouts include the native inference runtime.
 try{createRequire(import.meta.url).resolve('@huggingface/transformers');}catch{return null;}
 const selected=embeddingModels.find(item=>item.key===model);if(!selected)throw Error('Choose a supported embedding model');
 const key=JSON.stringify([cacheDir,selected.model,selected.revision,threads]);
 let attached,disposed=false;
 const load=()=>{
  if(disposed)throw Error('Embedding model was released');
  if(!pipelines.has(key)){const entry={references:0};entry.promise=(async()=>{
   const {pipeline}=await import('@huggingface/transformers');
   return pipeline('feature-extraction',selected.model,{revision:selected.revision,dtype:'q8',cache_dir:cacheDir,progress_callback:onProgress,session_options:{intraOpNumThreads:threads,interOpNumThreads:1}});
  })().catch(error=>{if(pipelines.get(key)===entry)pipelines.delete(key);throw error;});pipelines.set(key,entry);}
  const entry=pipelines.get(key);if(attached!==entry){entry.references++;attached=entry;}return entry.promise;
 };
 return {id:`${selected.model}@${selected.revision}:q8:mean:256:plain`,minScore,warm:load,async dispose(){if(disposed)return;disposed=true;if(attached&&--attached.references===0){if(pipelines.get(key)===attached)pipelines.delete(key);const model=await attached.promise.catch(()=>null);await model?.dispose();}},async embed(texts){
  const extractor=await load();
  const result=await extractor(texts,{pooling:'mean',normalize:true,truncation:true,max_length:256});
  return result.tolist();
 }};
}
