#!/usr/bin/env node
import { readFileSync,openSync,closeSync } from 'node:fs';
import { resolve,join } from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import { initializeProject,startProject,projectRequest } from './project.js';
process.umask(0o077);
const [command,directory,...args]=process.argv.slice(2),dir=directory&&resolve(directory);
const output=value=>console.log(JSON.stringify(value));
try {
  if(!dir)throw new Error('Usage: node src/project-cli.js init STATE_DIR GIT_ROOT [--exclude=path] | start STATE_DIR [--port=8787] | open STATE_DIR | status STATE_DIR | capture STATE_DIR | access STATE_DIR | run STATE_DIR codex|claude [--write] < prompt.txt');
  if(command==='init'){const [root,...flags]=args;if(!root||flags.some(f=>!f.startsWith('--exclude=')))throw new Error('Expected Git root and optional --exclude=path flags');output(initializeProject(dir,root,{exclude:flags.map(f=>f.slice(10))}));}
  else if(command==='open'){
    let status;try{status=await projectRequest(dir,{command:'status'});}catch(error){
      if(!['ENOENT','ECONNREFUSED'].includes(error.code))throw error;
      const fd=openSync(join(dir,'service.log'),'a',0o600);try{const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'start',dir,'--port=8787'],{detached:true,stdio:['ignore',fd,fd]});child.unref();}finally{closeSync(fd);}
      const deadline=Date.now()+60000;while(Date.now()<deadline){try{status=await projectRequest(dir,{command:'status'});break;}catch{await delay(300);}}
      if(!status)throw new Error('The app could not start. See service.log in the project state folder.');
    }
    const url=status.origin+'/';const executable=process.platform==='darwin'?'open':process.platform==='win32'?'explorer':'xdg-open';const opener=spawn(executable,[url],{stdio:'ignore'});opener.on('error',()=>output({url}));opener.unref();
  }
  else if(command==='start'){
    if(args.some(a=>!/^--port=\d+$/.test(a)))throw new Error('Expected --port=NUMBER');const port=Number(args[0]?.slice(7)??8787);if(!Number.isInteger(port)||port<0||port>65535)throw new Error('Invalid port');
    const service=await startProject(dir,{port,onEvent:output});let stopping=false;for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{if(stopping)return;stopping=true;await service.close();});
  } else if(command==='access'){const info=JSON.parse(readFileSync(join(dir,'review.json'))),tokens=JSON.parse(readFileSync(join(dir,'tokens.json')));output({...info,token:tokens.reader});}
  else if(command==='run'){
    if(!['codex','claude'].includes(args[0])||args.slice(1).some(a=>a!=='--write'))throw new Error('Expected codex|claude [--write]');
    const prompt=readFileSync(0,'utf8');const result=await projectRequest(dir,{command:'run',harness:args[0],prompt,write:args.includes('--write')},{onEvent:output});output(result);if(result.status!=='completed')process.exitCode=1;
  } else if(['status','capture'].includes(command)){output(await projectRequest(dir,{command}));}
  else throw new Error('Unknown command');
} catch(error){console.error(JSON.stringify({error:error.message}));process.exitCode=1;}
