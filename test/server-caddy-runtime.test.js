import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,existsSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {request} from 'node:https';
import {spawn,execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {managedCaddyfile} from '../src/server-caddy.js';
import {startTeamHost} from '../src/team/host.js';
const binary=process.env.SPOOL_TEST_CADDY;
test('real Caddy validates the managed site and serves the relay over certificate-verified HTTPS',{skip:!binary,timeout:30000},async t=>{
 const base=mkdtempSync(join(tmpdir(),'spool-caddy-runtime-'));let child;const host=await startTeamHost(join(base,'relay'),{port:0});t.after(async()=>{child?.kill();await host.close();rmSync(base,{recursive:true,force:true});});
 const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
 const global=`{\n admin off\n auto_https disable_redirects\n skip_install_trust\n https_port ${port}\n}\n`,config=managedCaddyfile(global,{domain:'spool.example.com',port:Number(new URL(host.origin).port),probe:'local-smoke'}).replace('    @spoolHealth','    tls internal\n    @spoolHealth'),path=join(base,'Caddyfile');writeFileSync(path,config);
 const env={...process.env,HOME:base,XDG_DATA_HOME:join(base,'data'),XDG_CONFIG_HOME:join(base,'config')};mkdirSync(env.XDG_DATA_HOME);execFileSync(resolve(binary),['validate','--config',path,'--adapter','caddyfile'],{env,stdio:'pipe'});
 let errors='';child=spawn(resolve(binary),['run','--config',path,'--adapter','caddyfile'],{env,stdio:['ignore','ignore','pipe']});child.stderr.on('data',chunk=>errors+=chunk);
 const caPath=join(base,'data/caddy/pki/authorities/local/root.crt');let success=false;
 for(let attempt=0;attempt<80;attempt++){
  if(existsSync(caPath))try{const response=await new Promise((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port,servername:'spool.example.com',path:'/healthz',headers:{host:'spool.example.com'},ca:readFileSync(caPath)},res=>{let body='';res.on('data',part=>body+=part);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body,authorized:res.socket?.authorized}));});req.on('error',reject);req.end();});assert.equal(response.status,200);assert.equal(response.headers['x-spooldb-setup'],'local-smoke');assert.equal(JSON.parse(response.body).ok,true);success=true;break;}catch{}
  await delay(100);
 }
 assert.equal(success,true,errors);
});
