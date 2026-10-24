import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,statSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Writable} from 'node:stream';
import {deployCloudflare,cloudflareConfig} from '../src/deploy/cloudflare.js';
const output=()=>new Writable({write(_c,_e,done){done();}});
test('deploy dry-run builds without login, publication, enrollment or changing the existing workspace',async t=>{
 const state=mkdtempSync(join(tmpdir(),'spool-deploy-'));t.after(()=>rmSync(state,{recursive:true,force:true}));const existing='{"url":"https://existing.test","token":"existing-private"}\n';writeFileSync(join(state,'workspace.json'),existing);const commands=[];
 const result=await deployCloudflare({state,input:{isTTY:false},output:output(),options:{'dry-run':true,name:'spool-test'},run:async args=>{commands.push(args);return '';},fetcher:()=>{throw Error('Unexpected remote request');}});
 assert.equal(result.deployed,false);assert.equal(commands.length,1);assert.ok(commands[0].includes('--dry-run'));assert.equal(readFileSync(join(state,'workspace.json'),'utf8'),existing);const config=JSON.parse(readFileSync(result.configPath));assert.equal(config.durable_objects.bindings.length,2);assert.equal(statSync(result.configPath).mode&0o777,0o600);assert.match(config.vars.BOOTSTRAP_TOKEN_HASH,/^[a-f0-9]{64}$/);
});
test('authorized deploy validates login account, builds before publish, checks health, bootstraps and preserves connection by default',async t=>{
 const state=mkdtempSync(join(tmpdir(),'spool-deploy-live-'));t.after(()=>rmSync(state,{recursive:true,force:true}));const commands=[],calls=[];let connected=false;
 const run=async args=>{commands.push(args);return args[0]==='kv'?JSON.stringify([{id:'b'.repeat(32),title:'spool-test-oauth'}]):args[0]==='whoami'?JSON.stringify({accounts:[{id:'a'.repeat(32),name:'Company'}]}):args.includes('--dry-run')?'build':'https://spool-test.example.workers.dev';};
 const fetcher=async(url,init)=>{calls.push([url,init]);return Response.json(url.endsWith('/healthz')?{protocol:'spool-relay/1',backend:'cloudflare'}:{protocol:'spool-relay/1',workspace:{id:'ws',name:'Company'},link:'spool://workspace/v1/private-owner'});};
 const result=await deployCloudflare({state,input:{isTTY:false},output:output(),options:{yes:true,name:'spool-test','account-id':'a'.repeat(32),'workspace-name':'Company'},run,fetcher,connect:()=>{connected=true;}});
 assert.equal(result.deployed,true);assert.ok(commands[1].includes('--dry-run'));assert.equal(commands[3].includes('--dry-run'),false);assert.equal(JSON.parse(readFileSync(result.configPath)).kv_namespaces[0].binding,'OAUTH_KV');assert.equal(calls.length,2);assert.match(calls[1][1].headers.authorization,/^Bootstrap /);assert.equal(connected,false);const receipt=JSON.parse(readFileSync(result.receiptPath));assert.equal(receipt.ownerLink,'spool://workspace/v1/private-owner');assert.equal(statSync(result.receiptPath).mode&0o777,0o600);
});
test('deploy rejects invalid names and unauthorized noninteractive deployment',async()=>{
 assert.throws(()=>cloudflareConfig({name:'../bad'}));await assert.rejects(()=>deployCloudflare({state:'/tmp',input:{isTTY:false},output:output()}),/interactive terminal/);
});
test('resume survives an HTML edge error, never republishes and keeps saved owner invitation',async t=>{
 const state=mkdtempSync(join(tmpdir(),'spool-resume-'));t.after(()=>rmSync(state,{recursive:true,force:true}));const folder=join(state,'deployment');const {mkdirSync}=await import('node:fs');mkdirSync(folder);
 const path=join(folder,'deployment.json'),receipt={name:'spool-test',origin:'https://spool-test.example.workers.dev',bootstrapToken:'private-bootstrap',workspaceName:'Company',configPath:join(folder,'wrangler.json')};writeFileSync(path,JSON.stringify(receipt));let attempts=0;
 const result=await deployCloudflare({state,input:{isTTY:false},output:output(),options:{resume:true,name:'spool-test','deploy-dir':folder,'no-connect':true},run:()=>{throw Error('Resume attempted to publish');},fetcher:async url=>{if(url.endsWith('/healthz'))return ++attempts===1?new Response('<!DOCTYPE html><title>Not ready</title>',{status:503,headers:{'content-type':'text/html'}}):Response.json({protocol:'spool-relay/1',backend:'cloudflare'});return Response.json({workspace:{id:'ws'},link:'spool://workspace/v1/private-owner'});}});
 assert.equal(result.deployed,true);assert.equal(attempts,2);assert.equal(JSON.parse(readFileSync(path)).ownerLink,'spool://workspace/v1/private-owner');
});
test('HTML access failures report HTTP status and Cloudflare ray instead of a JSON parse exception',async()=>{
 const {cloudflareJson}=await import('../src/deploy/cloudflare.js');await assert.rejects(()=>cloudflareJson(new Response('<!DOCTYPE html><p>error code: 1010</p>',{status:403,headers:{'content-type':'text/html','cf-ray':'test-ray'}}),'Health check'),/HTTP 403.*Cloudflare error 1010.*Ray test-ray.*--resume/);
});

test('interactive resume skips deployment questions and reuses the initialized workspace',async t=>{
 const {mkdirSync}=await import('node:fs');const {PassThrough}=await import('node:stream');
 const state=mkdtempSync(join(tmpdir(),'spool-resume-tty-'));t.after(()=>rmSync(state,{recursive:true,force:true}));
 const folder=join(state,'deployments/cloudflare/spooldb');mkdirSync(folder,{recursive:true});
 writeFileSync(join(folder,'deployment.json'),JSON.stringify({name:'spooldb',origin:'https://existing.workers.dev',bootstrapToken:'private',workspaceName:'Company',workspace:{id:'existing'},ownerLink:'private-invite'}));
 const input=new PassThrough();input.isTTY=true;let text='';const out=new Writable({write(c,e,done){text+=c;done();}});
 const result=await deployCloudflare({state,input,output:out,options:{resume:true,'no-connect':true},run:()=>{throw Error('Unexpected Wrangler');},fetcher:async url=>{assert.ok(url.endsWith('/healthz'));return Response.json({protocol:'spool-relay/1',backend:'cloudflare'});}});
 assert.equal(result.workspace.id,'existing');assert.doesNotMatch(text,/Worker name|Cloudflare deployment|Account number|Workspace name|Publish this/);assert.match(text,/Relay ready/);input.destroy();
});

test('missing DNS reports the hostname and skips pointless deployment retries',async t=>{
 const {mkdirSync}=await import('node:fs');const state=mkdtempSync(join(tmpdir(),'spool-resume-dns-'));t.after(()=>rmSync(state,{recursive:true,force:true}));
 const folder=join(state,'deployments/cloudflare/spooldb');mkdirSync(folder,{recursive:true});
 writeFileSync(join(folder,'deployment.json'),JSON.stringify({name:'spooldb',origin:'https://missing.workers.dev',bootstrapToken:'private',workspaceName:'Company'}));let calls=0;
 await assert.rejects(()=>deployCloudflare({state,input:{isTTY:false},output:output(),options:{resume:true},fetcher:async()=>{calls++;throw new TypeError('fetch failed',{cause:Object.assign(new Error('DNS'),{code:'ENOTFOUND'})});}}),/missing.workers.dev.*no DNS record.*ENOTFOUND/);
 assert.equal(calls,1);
});

test('resume can correct a changed workers.dev origin without publishing or replacing the invite',async t=>{
 const {mkdirSync}=await import('node:fs');const {workspaceLink,parseWorkspaceLink}=await import('../src/team/workspace.js');
 const state=mkdtempSync(join(tmpdir(),'spool-resume-url-'));t.after(()=>rmSync(state,{recursive:true,force:true}));const folder=join(state,'deployments/cloudflare/spooldb');mkdirSync(folder,{recursive:true});
 const path=join(folder,'deployment.json');writeFileSync(path,JSON.stringify({name:'spooldb',origin:'https://old.workers.dev',bootstrapToken:'private',workspaceName:'Company',workspace:{id:'existing'},ownerLink:workspaceLink({version:1,url:'https://old.workers.dev',code:'a'.repeat(43)})}));
 await deployCloudflare({state,input:{isTTY:false},output:output(),options:{resume:true,url:'https://new.workers.dev','no-connect':true},run:()=>{throw Error('Unexpected publish');},fetcher:async url=>{assert.equal(url,'https://new.workers.dev/healthz');return Response.json({protocol:'spool-relay/1',backend:'cloudflare'});}});
 const saved=JSON.parse(readFileSync(path));assert.equal(saved.origin,'https://new.workers.dev');assert.equal(saved.workspace.id,'existing');assert.equal(parseWorkspaceLink(saved.ownerLink).url,saved.origin);assert.equal(parseWorkspaceLink(saved.ownerLink).code,'a'.repeat(43));
});
