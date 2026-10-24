#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { RelayServer,createCredential } from './relay/index.js';

if(process.argv.includes('--help')) {
  console.log('Usage: spool-relay DATABASE CONFIG.json [--host=127.0.0.1] [--port=8787]\n       spool-relay credential PRINCIPAL ROOM [read|write]\n       spool-relay backup DATABASE NEW_BACKUP_FILE\nConfig: {"credentials":[{"id":"alice","tokenHash":"SHA256_HEX","rooms":{"ROOM":"write"}}]}\nRemote access requires a TLS reverse proxy. Tokens are never accepted in URLs.');process.exit(0);
}
if(process.argv[2]==='backup') {
  if(process.argv.length!==5) throw new Error('Backup requires DATABASE NEW_BACKUP_FILE');
  const relay=new RelayServer(process.argv[3]);try {console.log(JSON.stringify(relay.backup(process.argv[4])));}finally {await relay.close();}
} else if(process.argv[2]==='credential') {
  const [, , ,id,room,role='write']=process.argv;
  if(!id||!room||!['read','write'].includes(role)) throw new Error('Credential requires principal, room and read|write');
  console.log(JSON.stringify(createCredential(id,{[room]:role}),null,2));
} else {
  const [, ,filename,configPath,...args]=process.argv;
  if(!filename||!configPath||args.some(a=>!/^--(?:host|port)=.+$/.test(a))) throw new Error('See --help for relay arguments');
  const value=(name,fallback)=>args.find(a=>a.startsWith(`--${name}=`))?.slice(name.length+3)??fallback;
  const port=Number(value('port','8787'));if(!Number.isSafeInteger(port)||port<0||port>65535) throw new Error('Invalid port');
  const config=JSON.parse(readFileSync(configPath,'utf8'));const relay=new RelayServer(filename,config);
  let stopping=false;
  const stop=async()=>{if(stopping)return;stopping=true;await relay.close();};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  process.on('SIGHUP',()=>{
    try {relay.setCredentials(JSON.parse(readFileSync(configPath,'utf8')).credentials);console.log(JSON.stringify({event:'relay.credentials-reloaded'}));}
    catch {console.error(JSON.stringify({event:'relay.reload-failed',message:'Credential configuration rejected; previous grants retained'}));}
  });
  try {const url=await relay.listen({host:value('host','127.0.0.1'),port});console.log(JSON.stringify({event:'relay.listening',url,protocol:'spool-relay/1'}));}
  catch(error) {await stop();throw error;}
}
