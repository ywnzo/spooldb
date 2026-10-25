export async function defaultEmbeddings(options){
 if(typeof process!=='undefined'&&process.env.SPOOL_EMBEDDINGS==='off')return null;
 const {localEmbeddings}=await import('#spool-local-embeddings');return localEmbeddings(options);
}

// Optional explicit binding. The self-hosted default never uses an external embedding API.
export function workersEmbeddings(ai,model='@cf/baai/bge-small-en-v1.5'){
 return ai?{id:`workers-ai:${model}:mean`,async embed(texts){return (await ai.run(model,{text:texts})).data;}}:null;
}
