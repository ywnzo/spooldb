import {loadRepositoryOnboarding} from '../repository-onboarding.js';
import {existsSync} from 'node:fs';
import {isAbsolute,resolve,dirname} from 'node:path';
import {repositoryAt} from '../repository.js';
import {discoveryRequest} from '../discovery-request.js';
export const repositoryRootSchema={type:'string',minLength:1,maxLength:4096,description:'Absolute directory in the Git repository being worked on now. Required on every call. Resolve nested repositories/submodules separately; never reuse the chat starting project for work in another repo.'};
export const repositoryMemoryTools=tools=>tools.map(tool=>({...tool,inputSchema:{...tool.inputSchema,properties:{root:repositoryRootSchema,...tool.inputSchema.properties},required:[...new Set(['root',...(tool.inputSchema.required??[])])]}}));
export async function resolveMemoryRepository(directory,root,{discover=discoveryRequest}={}){
 if(typeof root!=='string'||!isAbsolute(root)||root.includes('\0'))throw Error('Pass the absolute directory of the repository being worked on as root. No default project was used.');
 const repo=repositoryAt(root),project=await discover(directory,{command:'resolve',cwd:repo.root});
 if(project.root!==repo.root)throw Error('Repository binding mismatch. No memory request was sent.');
 if(project.status!=='enrolled'){const error=new Error(`Repository ${repo.root} is ${project.status}; explicit user approval is required to connect this repository. No parent or chat-start project was used.`);error.code=project.status==='ignored'?'PROJECT_SKIPPED':'PROJECT_CONNECTION_REQUIRED';error.onboarding=await loadRepositoryOnboarding(directory,{...repo,...project},{discover});throw error;}
 return {...repo,...project};
}

export function assertRepositoryFiles(root,files=[]){
 for(const file of files){
  if(typeof file!=='string')continue;
  const absolute=resolve(root,file);let parent=dirname(absolute);
  while(!existsSync(parent)&&dirname(parent)!==parent)parent=dirname(parent);
  const referenced=repositoryAt(parent);
  if(referenced.root!==root)throw Error(`File ${file} belongs to ${referenced.root}. Use that repository as root; no cross-repository memory was written.`);
 }
}
