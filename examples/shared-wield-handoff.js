// Two isolated client services, two Codex sessions, one live multi-project relay.
import {mkdirSync,copyFileSync,readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {initializeProject,startProject} from '../src/project.js';
import {hostRequest} from '../src/team/host.js';
process.umask(0o077);
const [directory,root,hostDir,scratch]=process.argv.slice(2),peerRoot=join(scratch,'wield-peer-'+randomUUID()),peerDir=join(dirname(directory),'p-'+randomUUID().slice(0,6));mkdirSync(peerRoot,{recursive:true,mode:0o700});
for(const name of ['AGENTS.md','server/core/actions.ts','server/core/app.ts','server/core/tick.ts']){mkdirSync(dirname(join(peerRoot,name)),{recursive:true});copyFileSync(join(root,name),join(peerRoot,name));}
execFileSync('git',['init','-q',peerRoot]);initializeProject(peerDir,peerRoot,{exclude:['.codex']});const localConfig=JSON.parse(readFileSync(join(directory,'team.json'))),invite=await hostRequest(hostDir,{command:'invite',room:localConfig.room,label:'Independent acceptance client',role:'write'});
let peer;
try{peer=await startProject(peerDir,{port:0,intervalMs:60000});await peer.app.teamConnect(invite.connection);console.log(JSON.stringify({event:'independent-client.ready',sharedRoom:localConfig.room}));const code=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['examples/memory-handoff-check.js',directory,root],{stdio:'inherit',env:{...process.env,SPOOL_SECOND_STATE:peerDir,SPOOL_SECOND_ROOT:peerRoot}});child.on('error',reject);child.on('close',resolve);});if(code!==0)process.exitCode=1;}
finally{await peer?.close();await hostRequest(hostDir,{command:'revoke',room:localConfig.room,memberId:invite.memberId});}
