import {fail} from '../relay/wire.js';
export function gitReference(value){
 fail(value&&typeof value==='object'&&!Array.isArray(value),'GIT_REFERENCE','Invalid Git reference');
 const allowed=['path','repository','commit','branch','dirty','contentHash','legacySnapshotReference','verified','worktreeHash','remoteKnown','capturedAt','verificationError','submodules'];
 fail(Object.keys(value).every(key=>allowed.includes(key)),'GIT_REFERENCE','Only Git reference metadata is accepted');
 const out={};
 if(value.path!==undefined){fail(typeof value.path==='string'&&value.path.length>0&&value.path.length<=1000&&!value.path.startsWith('/')&&!value.path.split('/').some(p=>['..','.',''].includes(p)),'GIT_REFERENCE','Use a project-relative path');out.path=value.path;}
 for(const key of ['repository','branch','capturedAt','verificationError'])if(value[key]!==undefined){fail(value[key]===null||typeof value[key]==='string'&&value[key].length<=1000&&!/[\x00-\x1f]/.test(value[key]),'GIT_REFERENCE','Invalid Git '+key);out[key]=value[key];}
 if(value.commit!==undefined){fail(value.commit===null||typeof value.commit==='string'&&/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(value.commit),'GIT_REFERENCE','Use a full Git commit ID');out.commit=value.commit;}
 if(value.contentHash!==undefined){fail(typeof value.contentHash==='string'&&/^[a-f0-9]{64}$/.test(value.contentHash),'GIT_REFERENCE','Invalid content hash');out.contentHash=value.contentHash;}
 for(const key of ['dirty','legacySnapshotReference','verified','remoteKnown'])if(value[key]!==undefined){fail((typeof value[key]==='boolean'||['dirty','remoteKnown'].includes(key)&&value[key]===null),'GIT_REFERENCE','Invalid '+key);out[key]=value[key];}
 if(value.worktreeHash!==undefined){fail(value.worktreeHash===null||typeof value.worktreeHash==='string'&&/^[a-f0-9]{64}$/.test(value.worktreeHash),'GIT_REFERENCE','Invalid worktree hash');out.worktreeHash=value.worktreeHash;}
 if(value.submodules!==undefined){
  fail(Array.isArray(value.submodules)&&value.submodules.length<=256,'GIT_REFERENCE','Too many submodules');
  const seen=new Set();out.submodules=value.submodules.map(item=>{
   fail(item&&typeof item==='object'&&!Array.isArray(item)&&Object.keys(item).every(key=>['path','expectedCommit','commit','repository','dirty','verified','initialized'].includes(key)),'GIT_REFERENCE','Invalid submodule reference');
   const {expectedCommit,initialized,...reference}=item;
   fail(typeof initialized==='boolean'&&typeof expectedCommit==='string'&&/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(expectedCommit),'GIT_REFERENCE','Invalid submodule checkout');
   const clean=gitReference(reference);fail(clean.path&&!seen.has(clean.path),'GIT_REFERENCE','Invalid or duplicate submodule path');seen.add(clean.path);
   return {...clean,expectedCommit,initialized};
  });
 }
 return out;
}

// Old local captures refer to snapshots; shared records already contain Git metadata.
export function sharedFileReference(file){
 if(file&&('fileId' in file||'heads' in file))return gitReference({path:file.path,legacySnapshotReference:true});
 return gitReference(file);
}
