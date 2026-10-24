import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
export function buildDownloadAssets({directory,files,chunkBytes=20*1024*1024}){
 mkdirSync(directory,{recursive:true});const path=join(directory,'manifest.json'),manifest=existsSync(path)?JSON.parse(readFileSync(path)):{version:1,current:{},releases:{}};
 for(const {path:input,name,runtime}of files){if(!/^(?:[a-z0-9-]+\.run|spooldb-codex-linux-x64\.tar\.gz)$/.test(name))throw Error('Invalid installer name');const data=readFileSync(input),sha256=createHash('sha256').update(data).digest('hex'),parts=[];
  for(let offset=0;offset<data.length;offset+=chunkBytes){const part=`packages/${sha256}/part-${String(parts.length).padStart(3,'0')}.bin`,bytes=data.subarray(offset,offset+chunkBytes);mkdirSync(join(directory,'packages',sha256),{recursive:true});writeFileSync(join(directory,part),bytes);parts.push({path:part,size:bytes.length});}
  const artifact={name,runtime,platform:'linux-x64',sha256,size:data.length,parts};manifest.current[name]=sha256;manifest.releases[`${sha256}/${name}`]=artifact;
 }
 writeFileSync(path,JSON.stringify(manifest,null,2)+'\n');return manifest;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const root=fileURLToPath(new URL('../',import.meta.url)),directory=join(root,'work/download-assets');
 const manifest=buildDownloadAssets({directory,files:[{path:join(root,'installers/spool-linux-x64.run'),name:'spool-linux-x64.run',runtime:'bun'},{path:join(root,'installers/spool-linux-x64-node.run'),name:'spool-linux-x64-node.run',runtime:'node'},...(existsSync(join(root,'installers/spooldb-codex-linux-x64.tar.gz'))?[{path:join(root,'installers/spooldb-codex-linux-x64.tar.gz'),name:'spooldb-codex-linux-x64.tar.gz',runtime:'bun'}]:[])]});console.log(JSON.stringify({directory,installers:Object.keys(manifest.current)}));
}
