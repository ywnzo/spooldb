import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {installApp,verifyBundle} from '../src/desktop/install.js';
import {startTeamHost} from '../src/team/host.js';
import {parseInvite,inviteHttp} from '../src/team/invites.js';
import {startDesktop} from '../src/desktop/service.js';
import {execFileSync} from 'node:child_process';
test('per-user install checks integrity, preserves state on updates and refuses an unrelated service',async t=>{
 const root=mkdtempSync(join(tmpdir(),'tw-install-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const bundle=join(root,'bundle'),paths={data:join(root,'data'),config:join(root,'config'),state:join(root,'state')};mkdirSync(bundle);writeFileSync(join(bundle,'payload'),'release one');const manifest=()=>writeFileSync(join(bundle,'manifest.json'),JSON.stringify({version:'test',files:{payload:createHash('sha256').update(readFileSync(join(bundle,'payload'))).digest('hex')}}));manifest();
 const installed=await installApp({bundle,paths,activate:false});assert.match(readFileSync(installed.unit,'utf8'),/Restart=on-failure/);assert.match(readFileSync(installed.desktop,'utf8'),/x-scheme-handler\/spool/);writeFileSync(join(installed.state,'keep'),'private state');
 writeFileSync(join(bundle,'payload'),'tampered');assert.throws(()=>verifyBundle(bundle),/integrity/);assert.equal(readFileSync(join(installed.app,'payload'),'utf8'),'release one');manifest();await installApp({bundle,paths,activate:false});assert.equal(readFileSync(join(installed.state,'keep'),'utf8'),'private state');
 writeFileSync(installed.unit,'[Service]\nExecStart=/custom/server\n');await assert.rejects(()=>installApp({bundle,paths,activate:false}),/independently managed/);assert.equal(existsSync(join(paths.data,'spool/install.lock')),false);
});
test('first-run setup joins a real local checkout and retrieves shared memory through the companion',async t=>{
 const root=mkdtempSync(join(tmpdir(),'tw-setup-'));const host=await startTeamHost(join(root,'h'),{port:0});let connected=0;const desktop=await startDesktop(join(root,'s'),{port:0,connector:async()=>{connected++;}});t.after(async()=>{await desktop.close();await host.close();rmSync(root,{recursive:true,force:true});});
 const project=host.command({command:'create',name:'Company project'}).project,issued=host.command({command:'create-invite',room:project.room,label:'Setup test'});const repo=join(root,'repo');mkdirSync(repo);execFileSync('git',['init','-q',repo]);writeFileSync(join(repo,'readme.txt'),'Shared project evidence');
 const session=await fetch(desktop.origin+'/api/session',{headers:{'sec-fetch-site':'same-origin'}}),cookie=session.headers.get('set-cookie').split(';')[0],auth=await session.json();const response=await fetch(desktop.origin+'/api/join',{method:'POST',headers:{'sec-fetch-site':'same-origin',origin:desktop.origin,cookie,'x-spool-csrf':auth.csrf,'content-type':'application/json'},body:JSON.stringify({link:issued.link,root:repo,device:'Test laptop',captureConversations:false,connectAgents:true})});const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));assert.equal(result.joined,true);assert.equal(connected,1);
 const localSession=await fetch(result.origin+'/local/session',{headers:{'sec-fetch-site':'same-origin'}}),localCookie=localSession.headers.get('set-cookie').split(';')[0],localAuth=await localSession.json();const memory=await fetch(result.origin+'/local/memory',{method:'POST',headers:{'sec-fetch-site':'same-origin',origin:result.origin,cookie:localCookie,'x-spool-csrf':localAuth.csrf,'content-type':'application/json'},body:JSON.stringify({command:'file_read',path:'readme.txt'})});assert.equal(memory.status,200);assert.equal((await memory.json()).text,'Shared project evidence');
});
test('invite redemption is single-use, recoverable for the same machine and revocable after host restart',async t=>{
 const root=mkdtempSync(join(tmpdir(),'tw-invite-'));let host=await startTeamHost(root,{port:0});t.after(async()=>{await host.close();rmSync(root,{recursive:true,force:true});});const project=host.command({command:'create',name:'Shared project'}).project;
 const issued=host.command({command:'create-invite',room:project.room,label:'Teammate'}),invite=parseInvite(issued.link);assert.equal((await inviteHttp(invite,'preview')).project,'Shared project');assert.equal(host.command({command:'list'}).projects[0].members.length,0);
 const input={claim:randomBytes(32).toString('base64url'),device:'Alice laptop'},first=await inviteHttp(invite,'redeem',input);assert.equal((await inviteHttp(invite,'redeem',input)).connection.token,first.connection.token);
 await assert.rejects(()=>inviteHttp(invite,'redeem',{...input,claim:randomBytes(32).toString('base64url')}),/another computer/);await assert.rejects(()=>inviteHttp(invite,'preview'),/already been used/);
 const port=Number(new URL(host.origin).port);await host.close();host=await startTeamHost(root,{port});assert.equal((await inviteHttp(invite,'redeem',input)).connection.token,first.connection.token);host.command({command:'revoke',room:project.room,memberId:first.memberId});await assert.rejects(()=>inviteHttp(invite,'redeem',input),/revoked/);
 const expired=host.command({command:'create-invite',room:project.room,label:'Expired'});host.relay.engine.db.prepare('UPDATE team_invites SET expires=0').run();await assert.rejects(()=>inviteHttp(parseInvite(expired.link),'preview'),/expired/);
});

test('a failed upgrade restores the previous application and service without changing project state',async t=>{
 const base=mkdtempSync(join(tmpdir(),'spool-rollback-'));t.after(()=>rmSync(base,{recursive:true,force:true}));const bundle=join(base,'bundle'),paths={data:join(base,'data'),config:join(base,'config'),state:join(base,'state')};mkdirSync(bundle);
 const prepare=(value,version)=>{writeFileSync(join(bundle,'payload'),value);writeFileSync(join(bundle,'manifest.json'),JSON.stringify({version,files:{payload:createHash('sha256').update(value).digest('hex')}}));};
 prepare('old','1.0.0');const installed=await installApp({bundle,paths,activate:false});writeFileSync(join(installed.state,'project-memory'),'preserve');const unit=readFileSync(installed.unit,'utf8');prepare('new','1.1.0');
 await assert.rejects(()=>installApp({bundle,paths,activate:false,onProgress:message=>{if(message.startsWith('Registering'))throw Error('simulated registration failure');}}),/simulated registration failure/);
 assert.equal(readFileSync(join(installed.app,'payload'),'utf8'),'old');assert.equal(readFileSync(installed.unit,'utf8'),unit);assert.equal(readFileSync(join(installed.state,'project-memory'),'utf8'),'preserve');assert.equal(JSON.parse(readFileSync(join(paths.data,'spool/installation.json'))).version,'1.0.0');
});
