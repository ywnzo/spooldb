import {loadRepositoryOnboarding} from '../repository-onboarding.js';
import {existsSync} from 'node:fs';
import {isAbsolute,resolve,dirname,relative} from 'node:path';
import {repositoryAt} from '../repository.js';
import {discoveryRequest} from '../discovery-request.js';
export const repositoryRootSchema={type:'string',minLength:1,maxLength:4096,description:'Absolute directory in the current Git repository. Required on every call.'};
export const repositoryMemoryTools=tools=>tools.map(tool=>({...tool,inputSchema:{...tool.inputSchema,properties:{root:repositoryRootSchema,...tool.inputSchema.properties,...(tool.name==='memory_get'?{sourceProject:{enum:['current','parent'],description:'Read a cited parent result using parent; defaults to the current project.'}}:{})},required:[...new Set(['root',...(tool.inputSchema.required??[])])]}}));
export async function resolveMemoryRepository(directory,root,{discover=discoveryRequest}={}){
 if(typeof root!=='string'||!isAbsolute(root)||root.includes('\0'))throw Error('Pass the absolute directory of the repository being worked on as root. No default project was used.');
 const repo=repositoryAt(root),project=await discover(directory,{command:'resolve',cwd:repo.root});
 if(project.root!==repo.root)throw Error('Repository binding mismatch. No memory request was sent.');
 if(project.status!=='enrolled'){const error=new Error(`Repository ${repo.root} is ${project.status}; explicit user approval is required to connect this repository. No parent or chat-start project was used.`);error.code=project.status==='ignored'?'PROJECT_SKIPPED':'PROJECT_CONNECTION_REQUIRED';error.onboarding=await loadRepositoryOnboarding(directory,{...repo,...project},{discover});throw error;}
 return {...repo,...project};
}

export async function assertRepositoryFiles(root,files=[],{directory,selected,discover=discoveryRequest}={}){
 for(const file of files){
  if(typeof file!=='string')continue;
  const absolute=resolve(root,file),within=relative(root,absolute);if(within==='..'||within.startsWith('../')||isAbsolute(within))throw Error('File paths must remain inside the current repository');let parent=dirname(absolute);
  while(!existsSync(parent)&&dirname(parent)!==parent)parent=dirname(parent);
  const referenced=repositoryAt(parent);
  if(referenced.root!==root&&directory&&selected){const binding=await discover(directory,{command:'resolve',cwd:referenced.root});if(binding.inherited&&binding.projectId===selected.projectId&&binding.workspace===selected.workspace&&(binding.bindingRoot??binding.root)===(selected.bindingRoot??selected.root))continue;}
  if(referenced.root!==root)throw Error(`File ${file} belongs to ${referenced.root}. Use that repository as root; no cross-repository memory was written.`);
 }
}

export function repositoryMemoryInput(selected,input){if(!selected?.inherited)return input;const prefix=selected.pathPrefix;return {...input,...(input.files?{files:input.files.map(file=>prefix+'/'+file)}:{}),...(input.path?{path:prefix+'/'+input.path}:{})};}
