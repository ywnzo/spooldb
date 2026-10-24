#!/usr/bin/env node
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {startTeamHost} from './team/host.js';
process.umask(0o077);
const directory=process.argv[2],config=JSON.parse(readFileSync(join(directory,'server.json')));
const server=await startTeamHost(directory,config);console.log(JSON.stringify({event:'workspace.ready',origin:server.origin}));let closing=false;for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{if(!closing){closing=true;await server.close();}});
