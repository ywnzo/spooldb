import {bootstrapScript} from './bootstrap.js';
import {onboardingHtml,onboardingCss} from './onboarding.js';
import {onboardingClient} from './public/onboarding.js';
// Wrangler preserves function names with this helper inside serialized browser code.
const browserPrelude='const __name=(value)=>value;\n';
const security={'x-content-type-options':'nosniff','referrer-policy':'no-referrer','x-frame-options':'DENY','cache-control':'no-store','content-security-policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"};
const response=(body,type,status=200,headers={})=>new Response(body,{status,headers:{...security,'content-type':type,...headers}});
async function manifest(env){if(!env.DOWNLOADS)return null;const r=await env.DOWNLOADS.fetch('https://assets.internal/manifest.json');return r.ok?await r.json():null;}
function range(header,size){if(!header)return {start:0,end:size-1,partial:false};const m=/^bytes=(\d*)-(\d*)$/.exec(header);if(!m||!m[1]&&!m[2])return null;const start=m[1]?Number(m[1]):Math.max(0,size-Number(m[2])),end=m[1]?(m[2]?Math.min(size-1,Number(m[2])):size-1):size-1;return Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&start>=0&&start<=end&&start<size?{start,end,partial:true}:null;}
export async function publicDownloads(req,env){
 const url=new URL(req.url),path=url.pathname;
 const routes=['/','/join','/onboarding.css','/onboarding.js','/onboarding-bootstrap.js','/install.sh'];if(!routes.includes(path)&&!path.startsWith('/downloads/'))return null;
 if(!['GET','HEAD'].includes(req.method))return response('Use GET or HEAD','text/plain',405,{allow:'GET, HEAD'});
 const text=(body,type)=>response(req.method==='HEAD'?null:body,type);
 if(path==='/'||path==='/join')return text(onboardingHtml,'text/html; charset=utf-8');
 if(path==='/onboarding.css')return text(onboardingCss,'text/css; charset=utf-8');
 if(path==='/onboarding.js')return text(browserPrelude+`import {bootstrapScript} from '/onboarding-bootstrap.js';\n(${onboardingClient.toString()})(bootstrapScript);`,'text/javascript; charset=utf-8');
 if(path==='/onboarding-bootstrap.js')return text(browserPrelude+'export '+bootstrapScript.toString(),'text/javascript; charset=utf-8');
 const data=await manifest(env);if(!data)return response('Installer downloads have not been published on this relay.','text/plain',503);
 if(path==='/downloads/manifest.json')return text(JSON.stringify(data),'application/json');
 if(path==='/install.sh'){
  const artifact=data.releases[data.current['spool-linux-x64.run']+'/spool-linux-x64.run'];return text(bootstrapScript({origin:url.origin,artifact}),'text/x-shellscript; charset=utf-8');
 }
 const match=/^\/downloads\/(?:([a-f0-9]{64})\/)?(spool-linux-x64(?:-node)?\.run|spooldb-codex-linux-x64\.tar\.gz)$/.exec(path);if(!match)return response('Download not found','text/plain',404);
 const artifact=data.releases[(match[1]??data.current[match[2]])+'/'+match[2]];if(!artifact)return response('Download not found','text/plain',404);
 const etag='"'+artifact.sha256+'"',cache=match[1]?'public, max-age=31536000, immutable':'public, max-age=60';
 if(req.headers.get('if-none-match')===etag&&!req.headers.has('range'))return response(null,'application/octet-stream',304,{etag,'cache-control':cache});
 const requested=range(req.headers.get('if-range')&&req.headers.get('if-range')!==etag?null:req.headers.get('range'),artifact.size);
 if(!requested)return response(null,'application/octet-stream',416,{'content-range':`bytes */${artifact.size}`});
 const {start,end,partial}=requested,headers={'content-length':String(end-start+1),'accept-ranges':'bytes',etag,'cache-control':cache,'content-disposition':`attachment; filename="${artifact.name}"`,...(partial?{'content-range':`bytes ${start}-${end}/${artifact.size}`}:{})};
 if(req.method==='HEAD')return response(null,'application/octet-stream',partial?206:200,headers);
 let offset=0;const segments=[];for(const part of artifact.parts){const a=Math.max(start,offset),b=Math.min(end,offset+part.size-1);if(a<=b)segments.push({part,start:a-offset,end:b-offset});offset+=part.size;}
 let index=0,reader,skip=0,remaining=0;
 const stream=new ReadableStream({async pull(controller){try{for(;;){if(!reader){if(index===segments.length){controller.close();return;}const segment=segments[index++],r=await env.DOWNLOADS.fetch(new Request('https://assets.internal/'+segment.part.path,{headers:{range:`bytes=${segment.start}-${segment.end}`}}));if(!r.ok||!r.body)throw Error('Installer part unavailable');reader=r.body.getReader();skip=r.status===206?0:segment.start;remaining=segment.end-segment.start+1;}
 const item=await reader.read();if(item.done){if(remaining)throw Error('Truncated installer part');reader=null;continue;}let chunk=item.value;if(skip){const n=Math.min(skip,chunk.length);skip-=n;chunk=chunk.subarray(n);}if(!chunk.length)continue;const n=Math.min(remaining,chunk.length);remaining-=n;controller.enqueue(chunk.subarray(0,n));if(!remaining){await reader.cancel();reader=null;}return;}}catch(error){await reader?.cancel().catch(()=>{});controller.error(error);}},async cancel(){await reader?.cancel();}});
 let output=stream;if(globalThis.FixedLengthStream){const fixed=new globalThis.FixedLengthStream(end-start+1);stream.pipeTo(fixed.writable).catch(()=>{});output=fixed.readable;}
 return response(output,'application/octet-stream',partial?206:200,headers);
}
