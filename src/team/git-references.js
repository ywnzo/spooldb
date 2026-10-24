import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,lstatSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
export const contentHash=text=>createHash('sha256').update(text).digest('hex');
const sha=value=>typeof value==='string'&&/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(value);
export function gitRead(root,args){try{return {ok:true,value:execFileSync('git',['-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-C',root,...args],{encoding:'utf8',timeout:10000,maxBuffer:4000000,stdio:['ignore','pipe','ignore'],env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_NO_LAZY_FETCH:'1'}}).trim()};}catch{return {ok:false,value:null};}}
function sanitizedRepository(value){if(!value)return null;try{const url=new URL(value);url.username='';url.password='';url.search='';url.hash='';return ['https:','http:','ssh:'].includes(url.protocol)?url.toString():null;}catch{return /^[\w.-]+@[\w.-]+:[\w./-]+$/.test(value)?value.replace(/^[^@]+@/,''):null;}}
export function repositoryIdentity(value){if(!value)return null;try{const url=new URL(value);if(!url.hostname)throw new Error('SCP-style remote');return url.hostname.toLowerCase()+'/'+url.pathname.replace(/^\/+|\/+$/g,'').replace(/\.git$/,'');}catch{return value.replace(/^[^@]+@/,'').replace(':','/').replace(/\.git$/,'').replace(/\/$/,'');}}
export function repositoryState(root){
 const status=gitRead(root,['status','--porcelain=v1','--untracked-files=normal']),head=gitRead(root,['rev-parse','--verify','HEAD']),valid=gitRead(root,['rev-parse','--show-toplevel']);
 const repository=sanitizedRepository(gitRead(root,['config','--get','remote.origin.url']).value),commit=head.ok&&sha(head.value)?head.value:null;
 const unborn=!head.ok?gitRead(root,['rev-list','--all','--max-count=1']):null;
 const remotes=commit?gitRead(root,['for-each-ref','--contains',commit,'--format=%(refname)','refs/remotes']):{ok:false};
 return {repository,commit,branch:gitRead(root,['symbolic-ref','--short','HEAD']).value,dirty:status.ok?Boolean(status.value):null,verified:valid.ok&&status.ok&&(Boolean(commit)||unborn?.ok&&unborn.value===''),worktreeHash:status.ok?contentHash(status.value):null,remoteKnown:remotes.ok?Boolean(remotes.value?.split('\n').some(ref=>ref&&!ref.endsWith('/HEAD'))):null};
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
  if(before.verified&&after.verified&&JSON.stringify(before)===JSON.stringify(after)&&JSON.stringify(hashes)===JSON.stringify(finalHashes))return {git:{...after,capturedAt:new Date().toISOString()},files:unique.map((path,i)=>({path,...after,...(hashes[i]?{contentHash:hashes[i]}:{})}))};
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
  const expectedRepository=repositoryIdentity(reference?.repository),actualRepository=repositoryIdentity(local.repository);let status;
  if(!reference||reference.verified!==true||!local.verified)status='unverified';
  else if(expectedRepository&&actualRepository&&expectedRepository!==actualRepository)status='repository_mismatch';
  else if(expectedRepository&&!actualRepository)status='unverified';
  else if(reference.dirty)status='uncommitted_evidence';
  else if(commitAvailable===false)status='commit_unavailable';
  else if(!reference.commit)status='unverified';
  else if(reference.commit!==local.commit||local.dirty||fileChecks.some(file=>file.state==='different'))status='different_revision';
  else if(fileChecks.some(file=>file.state==='unverified'||file.state==='unavailable'))status='unverified';
  else status='matching';
  const reconciliation={status,message:guidance[status],checkedAt:new Date().toISOString(),referenceCommit:reference?.commit??null,currentCommit:local.commit,currentBranch:local.branch,currentDirty:local.dirty,commitAvailable,files:fileChecks,remoteKnownAtCapture:reference?.remoteKnown??null,remoteNotice:'Remote availability uses locally known remote-tracking refs; no fetch or push was performed.'};
  const comparable=fileChecks.length&&fileChecks.every(file=>['matching','different','unavailable'].includes(file.state));
  return {...item,reconciliation,...(comparable?{freshness:fileChecks.every(file=>file.state==='matching')?'matches-local-content':'code-changed'}:{})};
 };
}
