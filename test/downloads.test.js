import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {buildDownloadAssets} from '../scripts/build-download-assets.js';
import {publicDownloads} from '../src/cloudflare/downloads.js';
import {bootstrapScript} from '../src/cloudflare/bootstrap.js';
import {installerInvitation} from '../src/desktop/install.js';
import {resolveProjectName} from '../src/management-cli.js';
import {parseWorkspaceLink,isWorkspaceLink,workspaceLink} from '../src/team/workspace.js';
import {parseInvite,inviteLink} from '../src/team/invites.js';
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'spool-download-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'installer'),bytes=Buffer.from('#!/bin/sh\nset -eu\nprintf "installer started\\n"\nif [ "${1-}" = --invite-file ]; then test -s "$2"; printf "invite supplied\\n"; fi\n');writeFileSync(path,bytes);const directory=join(dir,'assets'),manifest=buildDownloadAssets({directory,files:[{path,name:'spool-linux-x64.run',runtime:'bun'}],chunkBytes:17}),artifact=Object.values(manifest.releases)[0];let corrupt=false;
 const env={DOWNLOADS:{async fetch(input){const path=new URL(typeof input==='string'?input:input.url).pathname;try{let data=readFileSync(join(directory,path));if(corrupt&&path.endsWith('.bin'))data=Buffer.from(data.map(v=>v^1));return new Response(data);}catch{return new Response('Not found',{status:404});}}}};
 return {dir,bytes,manifest,artifact,env,corrupt:()=>{corrupt=true;}};}
test('hosted installer streams across asset chunks, supports resumable ranges, HEAD and release checksums',async t=>{
 const f=fixture(t),url='https://relay.test/downloads/'+f.artifact.sha256+'/spool-linux-x64.run';
 const full=await publicDownloads(new Request(url),f.env);assert.equal(full.status,200);assert.deepEqual(Buffer.from(await full.arrayBuffer()),f.bytes);assert.match(full.headers.get('cache-control'),/immutable/);assert.equal(full.headers.get('content-length'),String(f.bytes.length));
 for(const [header,start,end]of [['bytes=13-51',13,51],['bytes=40-',40,f.bytes.length-1],['bytes=-9',f.bytes.length-9,f.bytes.length-1]]){const part=await publicDownloads(new Request(url,{headers:{range:header}}),f.env);assert.equal(part.status,206);assert.deepEqual(Buffer.from(await part.arrayBuffer()),f.bytes.subarray(start,end+1));assert.equal(part.headers.get('content-range'),`bytes ${start}-${end}/${f.bytes.length}`);}
 assert.equal((await publicDownloads(new Request(url,{headers:{range:'bytes=99999-'}}),f.env)).status,416);
 assert.equal((await publicDownloads(new Request(url,{method:'HEAD'}),f.env)).headers.get('content-length'),String(f.bytes.length));
 assert.equal((await publicDownloads(new Request(url,{headers:{'if-none-match':'"'+f.artifact.sha256+'"'}}),f.env)).status,304);
 assert.equal(await publicDownloads(new Request('https://relay.test/v1/workspace/action'),f.env),null);
 assert.equal((await publicDownloads(new Request('https://relay.test/downloads/../../private'),f.env)),null);
});
test('onboarding serves local scripts and strict privacy headers without sending a fragment to preview automatically',async()=>{
 const r=await publicDownloads(new Request('https://relay.test/join#secret'),{}),html=await r.text();assert.equal(r.status,200);assert.match(html,/Install SpoolDB/);assert.doesNotMatch(html,/secret/);assert.equal(r.headers.get('referrer-policy'),'no-referrer');assert.match(r.headers.get('content-security-policy'),/connect-src 'self'/);
 assert.equal((await publicDownloads(new Request('https://relay.test/install.sh'),{})).status,503);
 const client=await (await publicDownloads(new Request('https://relay.test/onboarding.js'),{})).text();assert.match(client,/onboarding-bootstrap.js/);
});
test('downloaded setup verifies its pinned checksum, passes an invite file and refuses corrupted installers',async t=>{
 const f=fixture(t),server=createServer(async(req,res)=>{try{const r=await publicDownloads(new Request('http://127.0.0.1'+req.url),f.env);res.writeHead(r.status,Object.fromEntries(r.headers));res.end(Buffer.from(await r.arrayBuffer()));}catch(e){res.writeHead(500);res.end(e.message);}});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const origin='http://127.0.0.1:'+server.address().port,invite=inviteLink({version:1,url:origin,code:'a'.repeat(43)}),script=join(f.dir,'install-spooldb.sh');writeFileSync(script,bootstrapScript({origin,artifact:f.artifact,invite}));
 const good=await promisify(execFile)('sh',[script,'--verify-only']);assert.match(good.stdout,/installer started/);assert.match(good.stdout,/invite supplied/);
 f.corrupt();await assert.rejects(()=>promisify(execFile)('sh',[script]),error=>{assert.match(error.stderr,/checksum mismatch/);assert.doesNotMatch(error.stdout,/installer started/);return true;});
});
test('project names replace internal IDs and supplied project/workspace invite files validate without consuming invitations',t=>{
 const f=fixture(t),projects=[{room:'id-one',name:'Wield'},{room:'id-two',name:'Other'}];assert.equal(resolveProjectName(projects,'wield').room,'id-one');assert.equal(resolveProjectName(projects,'id-two').name,'Other');assert.throws(()=>resolveProjectName(projects,'Missing'),/No shared project/);assert.throws(()=>resolveProjectName([...projects,{room:'id-three',name:'Wield'}],'Wield'),/Several projects/);
 const data={version:1,url:'https://relay.test',code:'b'.repeat(43)},encoded=Buffer.from(JSON.stringify(data)).toString('base64url'),browser=data.url+'/join#'+encoded,path=join(f.dir,'invite');writeFileSync(path,browser);assert.equal(installerInvitation(['--invite-file',path]),browser);assert.deepEqual(parseInvite(browser),data);
 const workspace=data.url+'/join#workspace.'+encoded;writeFileSync(path,workspace);assert.equal(isWorkspaceLink(workspace),true);assert.deepEqual(parseWorkspaceLink(workspace),data);assert.equal(installerInvitation(['--invite-file',path]),workspace);assert.deepEqual(parseWorkspaceLink(workspaceLink(data)),data);assert.throws(()=>installerInvitation(['--invite-file']),/Supply an invitation/);writeFileSync(path,'invalid');assert.throws(()=>installerInvitation(['--invite-file',path]));
});

test('invite page previews the project, prepares setup locally and rejects foreign or expired links',async t=>{
 const {runInNewContext}=await import('node:vm');const f=fixture(t),js=await (await publicDownloads(new Request('https://relay.test/onboarding.js'),{})).text();
 async function page({relay='https://relay.test',expired=false}={}){
  const elements=new Map(),calls=[];let downloaded,clipboard;
  const element=id=>{if(!elements.has(id))elements.set(id,{disabled:true,hidden:true,textContent:'',scrollIntoView(){},click(){}});return elements.get(id);};
  const data={version:1,url:relay,code:'c'.repeat(43)},hash='#'+Buffer.from(JSON.stringify(data)).toString('base64url');
  class BrowserURL extends URL{static createObjectURL(blob){downloaded=blob;return 'blob:local';}static revokeObjectURL(){}}
  const context={bootstrapScript,URL:BrowserURL,Blob,TextDecoder,Uint8Array,atob,location:{origin:'https://relay.test',pathname:'/join',hash},document:{getElementById:element,createElement:()=>({click(){}})},navigator:{clipboard:{async writeText(text){clipboard=text;}}},setTimeout(){},fetch:async(path,options)=>{calls.push({path,options});return path.includes('manifest')?Response.json(f.manifest):expired?Response.json({error:{message:'This invitation has expired'}},{status:403}):Response.json({project:'Wield'});}};
  runInNewContext(js.replace(/^import[^\n]+\n/m,''),context);for(let i=0;i<12;i++)await new Promise(setImmediate);
  return {elements,calls,get downloaded(){return downloaded;},get clipboard(){return clipboard;}};
 }
 const valid=await page();await valid.elements.get('copy-terminal').onclick();assert.equal(valid.clipboard,'curl -fsSL https://relay.test/install.sh -o install-spooldb.sh && sh install-spooldb.sh');assert.equal(valid.elements.get('copy-terminal').textContent,'Copied');assert.equal(valid.elements.get('title').textContent,'Join Wield');assert.equal(valid.elements.get('install').disabled,false);assert.deepEqual(valid.calls.map(c=>c.path),['/downloads/manifest.json','/v1/invites/preview']);assert.equal(valid.calls[1].options.headers.authorization,'Invite '+'c'.repeat(43));valid.elements.get('install').onclick();assert.match(await valid.downloaded.text(),/--invite-file/);assert.equal(valid.calls.length,2);
 const foreign=await page({relay:'https://other.test'});assert.equal(foreign.elements.get('install').disabled,true);assert.equal(foreign.calls.length,1);assert.match(foreign.elements.get('status').textContent,/another relay/);
 const expired=await page({expired:true});assert.equal(expired.elements.get('install').disabled,true);assert.match(expired.elements.get('status').textContent,/expired/);
});
test('Codex plugin archive is hosted with checksum identity and resumable byte transport',async t=>{
 const f=fixture(t),path=join(f.dir,'plugin.tar.gz'),bytes=Buffer.from('codex plugin archive fixture');writeFileSync(path,bytes);const directory=join(f.dir,'assets'),manifest=buildDownloadAssets({directory,files:[{path,name:'spooldb-codex-linux-x64.tar.gz',runtime:'bun'}],chunkBytes:9});
 const artifact=manifest.releases[manifest.current['spooldb-codex-linux-x64.tar.gz']+'/spooldb-codex-linux-x64.tar.gz'],response=await publicDownloads(new Request('https://relay.test/downloads/'+artifact.sha256+'/spooldb-codex-linux-x64.tar.gz'),f.env);assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);assert.match(response.headers.get('content-disposition'),/spooldb-codex-linux-x64.tar.gz/);
});
