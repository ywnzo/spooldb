import {execFileSync} from 'node:child_process';
import {realpathSync} from 'node:fs';
import {basename} from 'node:path';
import {createHash} from 'node:crypto';
export function canonicalRemote(raw){
 if(typeof raw!=='string'||!raw.trim())return null;raw=raw.trim();let host,path;
 if(/^[^/@:]+@[^/:]+:.+/.test(raw)){const split=raw.indexOf(':');host=raw.slice(raw.indexOf('@')+1,split);path=raw.slice(split+1);}
 else{let url;try{url=new URL(raw);}catch{return null;}if(!['https:','http:','ssh:','git:'].includes(url.protocol))return null;host=url.hostname+(url.port&&url.port!==({'ssh:':'22','http:':'80','https:':'443','git:':'9418'}[url.protocol])?':'+url.port:'');path=url.pathname;}
 path=path.replace(/^\/+|\/+$/g,'').replace(/\.git$/,'');if(!host||!path||path.split('/').some(p=>p==='..'||p==='.'))return null;
 return host.toLowerCase()+'/'+path;
}
export function repositoryAt(cwd){
 const git=args=>execFileSync('git',['-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-C',cwd,...args],{encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe'],env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}}).trim();
 const root=realpathSync(git(['rev-parse','--show-toplevel']));let remote=null;try{remote=canonicalRemote(git(['remote','get-url','origin']));}catch{}
 return {root,name:basename(root),remote,repositoryKey:remote?createHash('sha256').update(remote).digest('hex'):null};
}
