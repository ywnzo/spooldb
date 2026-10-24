#!/usr/bin/env node
import {existsSync,readFileSync,writeFileSync,mkdirSync,renameSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const BEGIN='# BEGIN SPOOL MANAGED',END='# END SPOOL MANAGED';
const quote=value=>JSON.stringify(value),shell=value=>"'"+value.replaceAll("'","'\\''")+"'";
export function installCodex({directory,room,root}){
 directory=realpathSync(directory);root=realpathSync(root);if(!/^[a-zA-Z0-9-]+$/.test(room))throw new Error('Invalid project identity');
 const folder=join(root,'.codex');mkdirSync(folder,{recursive:true});const path=join(folder,'config.toml'),before=existsSync(path)?readFileSync(path,'utf8'):'';
 const legacyBegin='# BEGIN THREADWEAVE MANAGED',legacyEnd='# END THREADWEAVE MANAGED';
 const activeBegin=before.includes(BEGIN)?BEGIN:legacyBegin,activeEnd=before.includes(BEGIN)?END:legacyEnd;
 const start=before.indexOf(activeBegin),end=before.indexOf(activeEnd);if((start<0)!==(end<0))throw new Error('Incomplete managed configuration; repair before connecting');
 const prior=start<0?before:before.slice(0,start)+before.slice(end+activeEnd.length).replace(/^\n/,'');
 if(/^\s*\[mcp_servers\.spool\]/m.test(prior))throw new Error('A SpoolDB MCP server already exists outside the managed block');
 const mcp=fileURLToPath(new URL('./memory-mcp.js',import.meta.url)),hook=fileURLToPath(new URL('./codex-hooks.js',import.meta.url));
 let block=`${BEGIN}\n[mcp_servers.spool]\ncommand = ${quote(process.execPath)}\nargs = ${quote([mcp,directory,'--project',room])}\nstartup_timeout_sec = 30\ntool_timeout_sec = 30\n`;
 for(const event of ['SessionStart','UserPromptSubmit','Stop','Interrupt']){const command=[process.execPath,hook,directory,room,root,event].map(shell).join(' ');block+=`\n[[hooks.${event}]]\n[[hooks.${event}.hooks]]\ntype = "command"\ncommand = ${quote(command)}\ntimeout = ${event==='Interrupt'?3:20}\n${['SessionStart','UserPromptSubmit'].includes(event)?'additionalContextLimit = 7000\n':''}`;}
 block+=END+'\n';const after=prior.trimEnd()+'\n\n'+block;
 if(after!==before){const backups=join(directory,'integration-backups');mkdirSync(backups,{recursive:true,mode:0o700});const backup=join(backups,`codex-${Date.now()}.toml`);writeFileSync(backup,before,{mode:0o600});writeFileSync(path+'.spool-tmp',after,{mode:0o600});renameSync(path+'.spool-tmp',path);}
 return {root,room,config:path,changed:after!==before,hookCommandPrefix:[process.execPath,hook,directory,room,root].map(shell).join(' '),restartRequired:true};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const [directory,root,room]=process.argv.slice(2);console.log(JSON.stringify(installCodex({directory,root,room})));}
