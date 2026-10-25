import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,mkdirSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {request} from 'node:https';
import {setTimeout as delay} from 'node:timers/promises';
import {configureVPS,containerRequest} from '../src/server-vps.js';
import {markRelayBackup} from '../src/relay-backups.js';
import {applyRelayBundle} from '../src/relay-update.js';
import {rootRun} from '../src/server-caddy.js';
const engine=process.env.SPOOL_TEST_CONTAINER_ENGINE;
test('real engine runs relay and verified HTTPS, retains memory across installer rerun',{skip:!engine,timeout:600000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'spool-container-runtime-')),paths={app:join(dir,'app'),cli:join(dir,'cli'),unit:join(dir,'unit')},bundle=resolve('work/linux-package/SpoolDB');
 const run=(command,args,options)=>{if(command==='systemctl')return '';if(command==='ufw')throw Error('not used');if(command.endsWith('/docker')||command.endsWith('/podman')){if(command!==engine)throw Error('test selects '+engine);if(args[0]==='cp'){const file=args[1];writeFileSync(file,readFileSync(file,'utf8').replace('{\n','{\n tls internal\n'));}}return rootRun(command,args,options);};
 const configPath=join(paths.app,'containers.json');
 const checkHTTPS=async(domain,probe)=>{let last;for(let i=0;i<80;i++){try{const ca=run(engine,['exec','spool-caddy','cat','/data/caddy/pki/authorities/local/root.crt']);const result=await new Promise((resolve,reject)=>{const req=request({host:'127.0.0.1',port:443,path:'/healthz',servername:domain,headers:{host:domain},ca,timeout:2000},res=>{let body='';res.on('data',part=>body+=part);res.on('end',()=>resolve({status:res.statusCode,probe:res.headers['x-spooldb-setup'],body}));});req.on('timeout',()=>req.destroy(Error('timeout')));req.on('error',reject);req.end();});assert.equal(result.status,200);assert.equal(result.probe,probe);assert.equal(JSON.parse(result.body).ok,true);return;}catch(error){last=error;await delay(500);}}throw last;};
 try{
  const options={domain:'spool.example.com',bundle,paths,run,checkDNS:async()=>{},firewall:()=>{},checkHTTPS};const first=await configureVPS(options);assert(first.ownerLink);const initial=containerRequest(configPath,{command:'list'},{run});const created=containerRequest(configPath,{command:'create',name:'Persistent project'},{run});assert(created);
  await configureVPS(options);const after=containerRequest(configPath,{command:'list'},{run});assert(JSON.stringify(after).includes('Persistent project'));assert(!JSON.stringify(initial).includes('Persistent project'));
  // Exercise the same bundle as a newer candidate without downloading a release.
  const installed=JSON.parse(readFileSync(configPath));const packagePath=join(installed.app,'package.json'),pkg=JSON.parse(readFileSync(packagePath));pkg.version='0.0.1';writeFileSync(packagePath,JSON.stringify(pkg));
  let checks=0;await assert.rejects(applyRelayBundle(configPath,bundle,{run,cli:paths.cli,health:async(...args)=>{if(++checks===2){containerRequest(configPath,{command:'create',name:'Must be rolled back'},{run});throw Error('injected candidate failure');}await checkHTTPS(...args);}}),/Previous relay and memory restored/);
  assert(JSON.stringify(containerRequest(configPath,{command:'list'},{run})).includes('Persistent project'));assert(!JSON.stringify(containerRequest(configPath,{command:'list'},{run})).includes('Must be rolled back'));
  const expired=join(paths.app,'relay-backups','00000000-0000-4000-8000-000000000001');mkdirSync(expired,{recursive:true});markRelayBackup(expired,{createdAt:'2000-01-01T00:00:00Z'});
  const updated=await applyRelayBundle(configPath,bundle,{run,cli:paths.cli,health:checkHTTPS});
  assert(!existsSync(expired));assert(existsSync(join(updated.backup,'data','shared.sqlite')));assert(updated.backupCleanup.removed.length>=1);
  assert(JSON.stringify(containerRequest(configPath,{command:'list'},{run})).includes('Persistent project'));
  assert.equal(JSON.parse(readFileSync(configPath)).app===installed.app,false);
 }finally{for(const name of ['spool-caddy','spool-relay'])try{rootRun(engine,['rm','-f',name]);}catch{}for(const name of ['spool-relay-data','spool-caddy-data','spool-caddy-config'])try{rootRun(engine,['volume','rm',name]);}catch{}try{rootRun(engine,['network','rm','spool-network']);}catch{}rmSync(dir,{recursive:true,force:true});}
});
