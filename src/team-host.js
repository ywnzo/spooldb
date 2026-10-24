#!/usr/bin/env bun
import {startTeamHost,hostRequest} from './team/host.js';
process.umask(0o077);
const [command,dir,...args]=process.argv.slice(2);
if(command==='start'){
 const value=(key,fallback)=>args.find(a=>a.startsWith(`--${key}=`))?.slice(key.length+3)??fallback;
 const service=await startTeamHost(dir,{port:Number(value('port','8878')),host:value('host','127.0.0.1'),publicOrigin:value('origin',undefined),tls:args.includes('--tls')});console.log(JSON.stringify({event:'shared-relay.ready',origin:service.origin}));let stopped=false;for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{if(stopped)return;stopped=true;await service.close();});
}else if(['list','create','invite','create-invite','revoke','workspace-init','workspace-owner-invite'].includes(command)){const input=['create','workspace-init'].includes(command)?{command,name:args[0]}:command==='invite'||command==='create-invite'?{command,room:args[0],label:args[1]??'New computer',role:args[2]??'write'}:command==='revoke'?{command,room:args[0],memberId:args[1]}:{command};const result=await hostRequest(dir,input);console.log(['create-invite','workspace-init','workspace-owner-invite'].includes(command)&&result.link?result.link:JSON.stringify(result));}
else throw new Error('Usage: team-host start STATE [--port=8878 --host=127.0.0.1 --origin=https://host] | list STATE | create STATE NAME | invite STATE ROOM DEVICE [read|write] | revoke STATE ROOM MEMBER');
