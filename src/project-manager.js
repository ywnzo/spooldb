import {readFileSync,writeFileSync,renameSync,mkdirSync,rmSync,realpathSync,lstatSync,existsSync} from 'node:fs';
import {join,resolve,relative,basename} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {execFileSync,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {initializeProject,startProject} from './project.js';
const execute=promisify(execFile);
export class ProjectManager {
 constructor(dir,primary,{start=startProject}={}){
  this.dir=dir;this.primary=primary;this.start=start;this.running=new Map([[primary.state.room,Promise.resolve(primary)]]);this.registry=join(dir,'projects.json');this.adding=false;this.idle=Promise.resolve();this.closing=false;
  this.entries=existsSync(this.registry)?JSON.parse(readFileSync(this.registry)).projects:[];
  if(!this.entries.some(e=>e.id===primary.state.room))this.entries.unshift({id:primary.state.room,name:primary.state.name,root:primary.state.root,dir});
 }
 save(){writeFileSync(this.registry+'.tmp',JSON.stringify({projects:this.entries},null,2)+'\n',{mode:0o600});renameSync(this.registry+'.tmp',this.registry);}
 list(){return this.entries.map(({id,name,root})=>({id,name,root}));}
 async get(id){
  const entry=this.entries.find(e=>e.id===id);if(!entry)throw new Error('Project not found. Choose a project from the list.');
  if(!this.running.has(id)){const pending=this.start(entry.dir,{port:0,manageProjects:false}).then(service=>({...service.app,state:service.state,close:service.close}));this.running.set(id,pending);pending.catch(()=>this.running.delete(id));}
  return this.running.get(id);
 }
 async add(input){
  if(this.closing)throw new Error('The app is shutting down. Reopen it to add projects.');
  if(this.adding)throw new Error('Another project is being added. Please wait.');this.adding=true;let finish;this.idle=new Promise(resolve=>finish=resolve);let ownedDir,service;
  try{
   if(typeof input.root!=='string'||!input.root.trim()||input.root.length>4096||input.root.includes('\0'))throw new Error('Choose a project folder.');
   let root;try{root=realpathSync(resolve(input.root.trim().replace(/^~(?=\/|$)/,homedir())));}catch(error){throw new Error(error.code==='ENOENT'?'That folder does not exist. Choose another project folder.':'SpoolDB could not read that folder. Choose a folder you can access.');}
   const within=relative(root,this.dir);if(within===''||(!within.startsWith('../')&&!within.startsWith('..\\')&&!within.startsWith('/')))throw new Error('Choose a source folder outside SpoolDB’s history folder.');
   const prior=this.entries.find(e=>e.root===root);if(prior){const app=await this.get(prior.id);if(input.connectCodex===true&&!app.state.codex.enabled)await app.connect();return {project:{id:prior.id,name:prior.name,root:prior.root},existing:true};}
   const git=(args)=>execFileSync('git',['-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-C',root,...args],{encoding:'utf8',maxBuffer:16000000,timeout:10000,env:{...process.env,GIT_OPTIONAL_LOCKS:'0'},stdio:['ignore','pipe','pipe']});
   let top;try{top=realpathSync(git(['rev-parse','--show-toplevel']).trim());}catch{throw new Error('This folder is not a Git project. Choose the folder containing .git.');}
   if(top!==root)throw new Error(`Choose the project’s top-level folder: ${top}`);
   if(input.exclude!==undefined&&(!Array.isArray(input.exclude)||input.exclude.length>100||input.exclude.some(p=>typeof p!=='string')))throw new Error('Enter one relative path per excluded line.');
   const exclude=new Set(['.codex','.claude','.hermes','node_modules','dist','build','.next','.cache','.preview',...(input.exclude??[])]);
   for(const path of git(['ls-files','--cached','--others','--exclude-standard','-z']).split('\0').filter(Boolean)){try{if(lstatSync(join(root,path)).size>1000000)exclude.add(path);}catch(error){if(error.code!=='ENOENT')throw error;}}
   if(this.entries.length>=16)throw new Error('This preview supports up to 16 connected projects.');
   const container=join(this.dir,'projects');mkdirSync(container,{recursive:true,mode:0o700});const candidate=join(container,randomUUID());
   const result=initializeProject(candidate,root,{exclude:[...exclude],onCreated:()=>{ownedDir=candidate;}});service=await this.start(ownedDir,{port:0,manageProjects:false});
   if(input.connectCodex===true)await service.app.connect();
   const entry={id:result.room,name:basename(root),root,dir:ownedDir};this.entries.push(entry);
   try{this.save();}catch(error){this.entries.pop();throw error;}
   this.running.set(entry.id,Promise.resolve({...service.app,state:service.state,close:service.close}));ownedDir=null;
   return {project:{id:entry.id,name:entry.name,root},files:result.files,excluded:result.excluded,existing:false};
  }catch(error){if(service)await service.close();if(ownedDir)rmSync(ownedDir,{recursive:true,force:true});throw error;}
  finally{this.adding=false;finish();}
 }
 async pick(){
  try{const result=await execute('kdialog',['--getexistingdirectory',process.env.HOME??'/','--title','Choose a project for SpoolDB'],{timeout:120000,maxBuffer:8192});return {root:result.stdout.trim()||null};}
  catch(error){if(error.code===1)return {root:null};return {root:null,manual:true,message:'Paste the project folder path below.'};}
 }
 async close(){this.closing=true;await this.idle;await Promise.allSettled([...this.running].filter(([id])=>id!==this.primary.state.room).map(async([,pending])=>(await pending).close()));}
}
