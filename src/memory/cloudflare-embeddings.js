import {cloudflareModels} from './models.js';

// Fixed origin, account validation and redirect refusal keep credentials away from user-controlled hosts.
export function cloudflareEmbeddings({accountId,token,model='@cf/baai/bge-m3',minScore=0.25,fetch:request=globalThis.fetch,timeoutMs=8000}={}){
 if(!/^[a-f0-9]{32}$/i.test(accountId??'')||typeof token!=='string'||!/^[-A-Za-z0-9_]{20,256}$/.test(token)||!cloudflareModels.some(item=>item.key===model))throw Error('Enter a valid Cloudflare Account ID, API token and model');
 let disposed=false;const controllers=new Set();
 const provider={id:`workers-ai:${model}:dense:v1`,minScore,async embed(texts){
  if(disposed)throw Error('Embedding provider disconnected');
  if(!Array.isArray(texts)||!texts.length||texts.length>8||texts.some(text=>typeof text!=='string'||text.length>16000))throw Error('Invalid embedding batch');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);controllers.add(controller);
  try{
   const response=await request(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`,{method:'POST',redirect:'error',signal:controller.signal,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({text:texts})});
   if(!response.ok){await response.body?.cancel();throw Error(response.status===429?'Cloudflare usage limit reached; keyword search remains available.':response.status===401||response.status===403?'Cloudflare rejected the credentials. Check the Account ID and Workers AI token permissions.':'Cloudflare embedding service is unavailable; keyword search remains available.');}
   // Bound response size; upstream diagnostics and response bodies are never included in errors.
   const reader=response.body.getReader();let size=0;const parts=[];
   while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1048576){await reader.cancel();throw Error('Invalid Cloudflare embedding response');}parts.push(value);}
   const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
   let result;try{result=JSON.parse(new TextDecoder().decode(bytes));}catch{throw Error('Invalid Cloudflare embedding response');}
   const vectors=result?.result?.data;
   if(result.success!==true||!Array.isArray(vectors)||vectors.length!==texts.length||vectors.some(vector=>!Array.isArray(vector)||vector.length!==1024||!vector.every(Number.isFinite)||!vector.some(v=>v!==0)))throw Error('Invalid Cloudflare embedding response');
   return vectors;
  }catch(error){if(controller.signal.aborted)throw Error('Cloudflare embedding request timed out or was cancelled.');if(['Cloudflare usage limit reached; keyword search remains available.','Cloudflare rejected the credentials. Check the Account ID and Workers AI token permissions.','Cloudflare embedding service is unavailable; keyword search remains available.','Invalid Cloudflare embedding response'].includes(error.message))throw error;throw Error('Cloudflare embedding request failed; check relay network access.');}
  finally{clearTimeout(timer);controllers.delete(controller);}
 },async warm(){await provider.embed(['SpoolDB connection test']);},async dispose(){disposed=true;for(const controller of controllers)controller.abort();}};
 return provider;
}
