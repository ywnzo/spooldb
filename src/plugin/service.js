import {readdirSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {startDesktop} from '../desktop/service.js';
import {isAlive} from './companion.js';
process.umask(0o077);
const state=process.argv[2],service=await startDesktop(state,{port:0}),leases=join(state,'plugin-leases');let lastActive=Date.now(),closing=false;
const close=async()=>{if(closing)return;closing=true;clearInterval(timer);await service.close();};
const timer=setInterval(async()=>{let active=0;for(const name of readdirSync(leases)){const path=join(leases,name);try{if(isAlive(JSON.parse(readFileSync(path)).pid))active++;else rmSync(path,{force:true});}catch(error){if(error.code!=='ENOENT')console.error('Could not inspect a plugin lease');}}if(active)lastActive=Date.now();else if(Date.now()-lastActive>30000)await close();},5000);
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,close);
