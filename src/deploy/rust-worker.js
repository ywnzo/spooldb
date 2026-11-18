import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {existsSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';

const files=['index.js','index_bg.wasm'];
const digest=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const release=root=>JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version;

export function rustWorkerSources(root){
 const hash=createHash('sha256');
 function visit(path){
  for(const entry of readdirSync(join(root,path),{withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){
   const name=path+'/'+entry.name;
   if(entry.isDirectory())visit(name);
   else if(entry.isFile())hash.update(JSON.stringify([name,digest(join(root,name))]));
  }
 }
 for(const path of ['rust/cloudflare/Cargo.toml','rust/cloudflare/Cargo.lock','rust/cloudflare/entry.js','package.json']){
  hash.update(JSON.stringify([path,digest(join(root,path))]));
 }
 for(const path of ['rust/cloudflare/src','rust/cloudflare/assets','rust/shared','src/cloudflare','src/review/public'])visit(path);
 return hash.digest('hex');
}


export function rustWorkerBuilt(root){
 const directory=join(root,'rust/cloudflare/build');
 try{
  const manifest=JSON.parse(readFileSync(join(directory,'spool-release.json'),'utf8'));
  return manifest.version===release(root)
   &&files.every(name=>manifest.files[name]===digest(join(directory,name)))
   &&(!existsSync(join(root,'rust/cloudflare/Cargo.toml'))||manifest.sources===rustWorkerSources(root));
 }catch{return false;}
}

export async function prepareRustWorker(root,{output=process.stdout,force=false}={}){
 if(!force&&rustWorkerBuilt(root))return;
 const sources=rustWorkerSources(root);
 await new Promise((resolve,reject)=>{
  const child=spawn('worker-build',['rust/cloudflare','--release','--locked'],{cwd:root,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',chunk=>output.write(chunk));
  child.stderr.on('data',chunk=>output.write(chunk));
  child.once('error',error=>reject(new Error(
   'Rust Worker build is unavailable. Use the release installer or install worker-build 0.9.0 and the wasm32-unknown-unknown Rust target.',{cause:error},
  )));
  child.once('close',code=>code===0?resolve():reject(new Error('Rust Worker build failed. Review the build output.')));
 });
 const directory=join(root,'rust/cloudflare/build');
 if(sources!==rustWorkerSources(root))throw Error('Rust Worker sources changed during compilation. Build again before deploying.');
 const manifest={version:release(root),sources,files:Object.fromEntries(files.map(name=>[name,digest(join(directory,name))]))};
 writeFileSync(join(directory,'spool-release.json'),JSON.stringify(manifest)+'\n');
}
