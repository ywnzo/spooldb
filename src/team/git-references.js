import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,lstatSync,realpathSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
export const contentHash=text=>createHash('sha256').update(text).digest('hex');
const sha=value=>typeof value==='string'&&/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(value);
export function gitRead(root,args){try{return {ok:true,value:execFileSync('git',['-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-C',root,...args],{encoding:'utf8',timeout:10000,maxBuffer:4000000,stdio:['ignore','pipe','ignore'],env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_NO_LAZY_FETCH:'1'}}).trim()};}catch{return {ok:false,value:null};}}
function sanitizedRepository(value){if(!value)return null;try{const url=new URL(value);url.username='';url.password='';url.search='';url.hash='';return ['https:','http:','ssh:'].includes(url.protocol)?url.toString():null;}catch{return /^[\w.-]+@[\w.-]+:[\w./-]+$/.test(value)?value.replace(/^[^@]+@/,''):null;}}
export function repositoryIdentity(value){if(!value)return null;try{const url=new URL(value);if(!url.hostname)throw new Error('SCP-style remote');return url.hostname.toLowerCase()+'/'+url.pathname.replace(/^\/+|\/+$/g,'').replace(/\.git$/,'');}catch{return value.replace(/^[^@]+@/,'').replace(':','/').replace(/\.git$/,'').replace(/\/$/,'');}}
// Gitlinks are references, never directories to copy into shared memory.
export function submoduleStates(root,{limit=256,maxDepth=8}={}){
 root=realpathSync(root);const result=[];
 function visit(directory,prefix,depth){
  const index=gitRead(directory,['ls-files','--stage','-z']);if(!index.ok)throw Error('Could not read submodule index');
  const links=new Map();for(const line of index.value.split('\0')){const match=/^160000 ([a-f0-9]{40}(?:[a-f0-9]{24})?) ([0-3])\t([\s\S]+)$/.exec(line);if(match){const prior=links.get(match[3]);links.set(match[3],{commit:match[1],conflicted:match[2]!=='0'||Boolean(prior)});}}
  for(const [path,link] of [...links].sort(([a],[b])=>a.localeCompare(b))){
   if(result.length>=limit||depth>maxDepth)throw Error('Submodule inspection exceeds its safety limit');
   if(path.startsWith('/')||path.split('/').some(part=>['','.','..','.git'].includes(part)))throw Error('Unsafe submodule path');
   let safe=true,current=directory;try{for(const segment of path.split('/')){current=join(current,segment);if(lstatSync(current).isSymbolicLink())safe=false;}}catch{safe=false;}
   const top=safe?gitRead(current,['rev-parse','--show-toplevel']):{ok:false};
   let initialized=false;try{initialized=top.ok&&realpathSync(top.value)===realpathSync(current);}catch{}
   const commit=initialized?gitRead(current,['rev-parse','--verify','HEAD']):{ok:false};
   const status=initialized?gitRead(current,['status','--porcelain=v1','--untracked-files=normal','--ignore-submodules=none']):{ok:false};
   const item={path:prefix+path,expectedCommit:link.commit,initialized,commit:commit.ok&&sha(commit.value)?commit.value:null,repository:initialized?sanitizedRepository(gitRead(current,['config','--get','remote.origin.url']).value):null,dirty:status.ok?Boolean(status.value):null,verified:initialized&&commit.ok&&status.ok&&!link.conflicted};
   result.push(item);if(initialized)visit(current,prefix+path+'/',depth+1);
  }
 }
 visit(root,'',0);return result;
}
export function repositoryState(root){
 const status=gitRead(root,['status','--porcelain=v1','--untracked-files=normal','--ignore-submodules=none']),head=gitRead(root,['rev-parse','--verify','HEAD']),valid=gitRead(root,['rev-parse','--show-toplevel']);
 const repository=sanitizedRepository(gitRead(root,['config','--get','remote.origin.url']).value),commit=head.ok&&sha(head.value)?head.value:null;
 const unborn=!head.ok?gitRead(root,['rev-list','--all','--max-count=1']):null;
 const remotes=commit?gitRead(root,['for-each-ref','--contains',commit,'--format=%(refname)','refs/remotes']):{ok:false};
 let submodules=[],submodulesVerified=true;try{submodules=submoduleStates(root);}catch{submodulesVerified=false;}
 return {...(submodules.length?{submodules}:{}),repository,commit,branch:gitRead(root,['symbolic-ref','--short','HEAD']).value,dirty:status.ok?Boolean(status.value):null,verified:submodulesVerified&&valid.ok&&status.ok&&(Boolean(commit)||unborn?.ok&&unborn.value===''),worktreeHash:status.ok?contentHash(JSON.stringify([status.value,submodules])):null,remoteKnown:remotes.ok?Boolean(remotes.value?.split('\n').some(ref=>ref&&!ref.endsWith('/HEAD'))):null};
}
export function localFileHash(root,path){
 if(typeof path!=='string'||!path||path.startsWith('/')||path.split('/').some(p=>['..','.',''].includes(p)))return null;
 try{let current=resolve(root);for(const segment of path.split('/')){current=join(current,segment);const stat=lstatSync(current);if(stat.isSymbolicLink())return null;}
 const stat=lstatSync(current);if(!stat.isFile()||stat.size>1000000||relative(resolve(root),current).startsWith('..'))return null;const data=readFileSync(current);if(data.includes(0))return null;return contentHash(data);
 }catch{return null;}
}
export function captureCheckpoint(root,paths=[],{readState=repositoryState,readHash=localFileHash,attempts=3}={}){
 const unique=[...new Set(paths)];if(unique.length>30||unique.some(path=>typeof path!=='string'||!path||path.length>1000||path.startsWith('/')||path.split('/').some(p=>['..','.',''].includes(p))))throw new Error('Use project-relative file paths (at most 30)');
 let git;
 for(let attempt=0;attempt<attempts;attempt++){
  const before=readState(root),hashes=unique.map(path=>readHash(root,path)),after=readState(root),finalHashes=unique.map(path=>readHash(root,path));git=after;
  if(before.verified&&after.verified&&JSON.stringify(before)===JSON.stringify(after)&&JSON.stringify(hashes)===JSON.stringify(finalHashes)){const {submodules,...fileState}=after;return {git:{...after,capturedAt:new Date().toISOString()},files:unique.map((path,i)=>({path,...fileState,...(submodules?.some(item=>path.startsWith(item.path+'/'))?{submodules:submodules.filter(item=>path.startsWith(item.path+'/'))}:{}),...(hashes[i]?{contentHash:hashes[i]}:{})}))};}
 }
 return {git:{...git,verified:false,verificationError:'Git state changed during capture or could not be read',capturedAt:new Date().toISOString()},files:unique.map(path=>({path,verified:false}))};
}
// Kept for callers that only need a local content comparison.
export function fileReference(engine,room,path,git){const branch=`relay-${room}`,version=engine.version(branch),entry=[...engine.manifest.entries(version.root)].find(([key,value])=>key.startsWith('f:')&&value.path===path&&!value.deleted);const file=entry?engine.readFile(branch,entry[0].slice(2)).file:null;return {path,...git,...(file?.kind==='text'?{contentHash:contentHash(file.text)}:{})};}
const guidance={matching:'The referenced commit and files match this checkout. Findings remain agent claims; check relevant evidence.',different_revision:'This checkout differs from the handoff. Inspect the cited commit and current changes before relying on its results.',commit_unavailable:'The referenced commit is unavailable locally. Fetch through your normal Git workflow; ask the author to push if it remains missing.',uncommitted_evidence:'The handoff depended on uncommitted work. Its commit alone cannot reproduce that work; ask the author to commit and push it.',repository_mismatch:'This handoff references a different repository. Verify project identity before using it.',unverified:'Git evidence could not be verified. Inspect the checkout and cited sources before relying on this handoff.'};
export function createReconciler(root,{checkpoint=captureCheckpoint,read=gitRead}={}){
 const commits=new Map(),checkpoints=new Map();const inspect=paths=>{const key=JSON.stringify([...new Set(paths)].sort());if(!checkpoints.has(key))checkpoints.set(key,checkpoint(root,paths));return checkpoints.get(key);};
 return item=>{
  if(!item||!item.kind||!['task','finding','decision','blocker','handoff'].includes(item.kind))return item;
  const files=Array.isArray(item.files)?item.files:[],reference=item.git,paths=files.map(file=>file.path).filter(Boolean);
  // Hash referenced files from disk, independent of the background capture interval.
  let current;try{current=inspect(paths);}catch{current={git:{verified:false,commit:null,branch:null,dirty:null},files:[]};}const local=current.git;
  const fileChecks=files.map(file=>{const hash=current.files.find(value=>value.path===file.path)?.contentHash;return {path:file.path,state:!file.contentHash?'unverified':!hash?'unavailable':hash===file.contentHash?'matching':'different'};});
  let commitAvailable=null;if(sha(reference?.commit)){if(!commits.has(reference.commit))commits.set(reference.commit,read(root,['cat-file','-e',reference.commit+'^{commit}']).ok);commitAvailable=commits.get(reference.commit);}
  const submoduleChecks=(reference?.submodules??[]).map(expected=>{const actual=local.submodules?.find(value=>value.path===expected.path);return {path:expected.path,referenceCommit:expected.commit,currentCommit:actual?.commit??null,state:!actual?.initialized?'unavailable':!expected.verified||!actual.verified?'unverified':expected.commit!==actual.commit||expected.expectedCommit!==actual.expectedCommit||actual.dirty?'different':'matching'};});
  const expectedRepository=repositoryIdentity(reference?.repository),actualRepository=repositoryIdentity(local.repository);let status;
  if(!reference||reference.verified!==true||!local.verified)status='unverified';
  else if(expectedRepository&&actualRepository&&expectedRepository!==actualRepository)status='repository_mismatch';
  else if(expectedRepository&&!actualRepository)status='unverified';
  else if(local.submodules?.length&&!Array.isArray(reference.submodules))status='unverified';
  else if(submoduleChecks.some(value=>value.state==='unavailable'))status='commit_unavailable';
  else if(submoduleChecks.some(value=>value.state==='unverified'))status='unverified';
  else if(reference.dirty)status='uncommitted_evidence';
  else if(commitAvailable===false)status='commit_unavailable';
  else if(!reference.commit)status='unverified';
  else if(submoduleChecks.some(value=>value.state==='different')||reference.commit!==local.commit||local.dirty||fileChecks.some(file=>file.state==='different'))status='different_revision';
  else if(fileChecks.some(file=>file.state==='unverified'||file.state==='unavailable'))status='unverified';
  else status='matching';
  const reconciliation={status,message:submoduleChecks.some(value=>value.state==='unavailable')?'A referenced submodule is not initialized in this checkout. Initialize it through your normal Git workflow before relying on this handoff.':guidance[status],submodules:submoduleChecks,checkedAt:new Date().toISOString(),referenceCommit:reference?.commit??null,currentCommit:local.commit,currentBranch:local.branch,currentDirty:local.dirty,commitAvailable,files:fileChecks,remoteKnownAtCapture:reference?.remoteKnown??null,remoteNotice:'Remote availability uses locally known remote-tracking refs; no fetch or push was performed.'};
  const comparable=fileChecks.length&&fileChecks.every(file=>['matching','different','unavailable'].includes(file.state));
  return {...item,reconciliation,...(comparable?{freshness:fileChecks.every(file=>file.state==='matching')?'matches-local-content':'code-changed'}:{})};
 };
}
