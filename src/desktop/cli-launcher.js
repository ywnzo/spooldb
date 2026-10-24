import {bundledRuntime} from '../runtime.js';
import {existsSync,mkdirSync,readFileSync,writeFileSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
const marker='# Managed by SpoolDB CLI installer';
const shell=value=>"'"+value.replaceAll("'","'\\''")+"'";
export function assertCLIWritable(paths){const path=join(paths.bin??join(paths.data,'spool/bin'),'spool');if(existsSync(path)&&!readFileSync(path,'utf8').includes(marker))throw new Error('An unmanaged spool command already exists at '+path);return path;}
export function registerCLI({app,state,serverState,paths,runtime}){
 const bin=paths.bin??join(paths.data,'spool/bin'),path=assertCLIWritable(paths);
 if(existsSync(path)&&!readFileSync(path,'utf8').includes(marker))throw new Error('An unmanaged spool command already exists at '+path);
 mkdirSync(bin,{recursive:true});const node=runtime??bundledRuntime(app);
 const variables=[...(state?[`SPOOL_STATE=${shell(state)}; export SPOOL_STATE`]:[]),...(serverState?[`SPOOL_SERVER_STATE=${shell(serverState)}; export SPOOL_SERVER_STATE`]:[])];
 writeFileSync(path,`#!/bin/sh\n${marker}\n${variables.join('\n')}\nexec ${shell(node)} ${shell(join(app,'src/cli.js'))} "$@"\n`,{mode:0o755});chmodSync(path,0o755);return path;
}
