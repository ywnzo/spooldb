import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {startTeamHost} from '../src/team/host.js';
import {startDesktop} from '../src/desktop/service.js';
import {PassThrough,Writable} from 'node:stream';
import {localCommand,runManagement,workspaceInviteOptions} from '../src/management-cli.js';
import {registerCLI} from '../src/desktop/cli-launcher.js';
const execute=promisify(execFile);
test('headless CLI controls enrollment, projects, local selection, memory and server administration',async t=>{
 const base=mkdtempSync(join(tmpdir(),'tw-cli-')),serverDir=join(base,'h'),root=join(base,'c'),host=await startTeamHost(serverDir,{port:0});let desktop;t.after(async()=>{await desktop?.close();await host.close();rmSync(base,{recursive:true,force:true});});
 const run=async(...args)=>JSON.parse((await execute(process.execPath,['src/cli.js',...args,'--state',root,'--json'],{cwd:process.cwd(),timeout:20000})).stdout);
 const invite=host.command({command:'workspace-init',name:'CLI workspace'}),invitePath=join(base,'invite');writeFileSync(invitePath,invite.link,{mode:0o600});assert.equal((await run('workspace','connect','--invite-file',invitePath,'--device','CLI owner')).member.role,'owner');const secret=JSON.parse(readFileSync(join(root,'workspace.json'))).token;assert.ok(!JSON.stringify(await run('workspace','status')).includes(secret));
 assert.equal((await run('workspace','saved')).workspaces[0].name,'CLI workspace');assert.equal((await run('workspace','switch','CLI workspace')).workspace.name,'CLI workspace');
 const created=await run('workspace','create','CLI project','--request-id','create-once');assert.equal((await run('workspace','create','CLI project','--request-id','create-once')).project.room,created.project.room);assert.equal((await run('workspace','projects')).length,1);
 assert.equal((await run('status')).running,false);desktop=await startDesktop(root,{port:0});const repo=join(base,'repo');mkdirSync(repo);execFileSync('git',['init','-q',repo]);writeFileSync(join(repo,'app.txt'),'CLI source remains local');const joined=await run('project','join',created.project.room,repo,'--no-capture','--no-agents');assert.equal(joined.joined,true);assert.equal((await run('status')).root,repo);assert.equal((await run('memory','context')).room,created.project.room);
 const textFile=join(base,'note.txt');writeFileSync(textFile,'CLI handoff evidence');await run('memory','task','cli-task','--revision','0','--status','in_progress','--title','CLI task','--text-file',textFile);const handoff=await run('memory','handoff','--task','cli-task','--title','Continue CLI work','--text-file',textFile,'--next-step','Inspect code','--file','app.txt');assert.equal((await run('memory','get',handoff.id)).kind,'handoff');
 const other=join(base,'other');mkdirSync(other);execFileSync('git',['init','-q',other]);writeFileSync(join(other,'b.txt'),'Local');const added=await run('project','add',other);assert.equal((await run('project','list')).projects.length,2);await run('project','select',added.project.id);assert.equal((await run('project','status')).root,other);await run('project','select',joined.project.id);assert.equal((await run('project','pause')).codex.enabled,false);
 assert.equal((await run('project','sharing','CLI project')).overrides.findings,null);
 const status=await run('server','status','--server-state',serverDir);assert.equal(status.projects[0].room,created.project.room);const invitation=await run('workspace','invite','--label','Restricted','--no-create');assert.match(invitation.link,/spool:\/\/workspace\//);assert.match((await run('project','invite',created.project.room)).link,/spool:\/\/join\//);const byName=await run('project','invite','CLI project');assert.match(byName.browserLink,/\/join#/);await run('workspace','create','Second shared project','--request-id','second-shared');const currentInvite=await run('project','invite');assert.match(currentInvite.browserLink,/\/join#/);const {parseInvite,inviteHttp}=await import('../src/team/invites.js');assert.equal((await inviteHttp(parseInvite(currentInvite.browserLink),'preview')).room,created.project.room);
 const cloudInvite=await run('project','invite','CLI project','--label','Cloud test'),cloudMember=await inviteHttp(parseInvite(cloudInvite.link),'redeem',{claim:(await import('node:crypto')).randomBytes(32).toString('base64url'),device:'Cloud test'});assert.ok((await run('project','connections','CLI project')).members.some(m=>m.id===cloudMember.memberId));await run('project','revoke','CLI project','Cloud test');assert.equal((await run('project','connections','CLI project')).members.find(m=>m.id===cloudMember.memberId).revoked,1);
 assert.equal(host.relay.engine.db.prepare("SELECT count(*) AS n FROM shard_changes WHERE doc LIKE 'f:%'").get().n,0);
});
test('installed CLI launcher works with paths containing shell characters and refuses unmanaged commands',async t=>{
 await assert.rejects(()=>localCommand('/tmp','status',undefined,{'local-url':'http://example.invalid'}),/loopback/);const base=mkdtempSync(join(tmpdir(),"tw-cli's "));t.after(()=>rmSync(base,{recursive:true,force:true}));const paths={data:join(base,'data'),bin:join(base,'bin')};const launcher=registerCLI({app:process.cwd(),state:join(base,'state'),paths,runtime:process.execPath});const result=await execute(launcher,['--help']);assert.match(result.stdout,/workspace connect/);assert.match(readFileSync(launcher,'utf8'),/SPOOL_STATE/);writeFileSync(launcher,'#!/bin/sh\nexit 0\n');assert.throws(()=>registerCLI({app:process.cwd(),paths,runtime:process.execPath}),/unmanaged/);
});


test('workspace invite prompts for omitted values and honors explicit permissions',async()=>{
 const collect=async(options,answers)=>{const prompts=[],messages=[];const result=await workspaceInviteOptions(options,{ask:async(label,value)=>{prompts.push(label);assert.ok(answers.length,'Unexpected prompt');return answers.shift()||value;},output:{write:s=>messages.push(s)}});assert.equal(answers.length,0);return {result,prompts,messages};};
 const all=await collect({},['ChatGPT','bad','1','maybe','n']);assert.deepEqual(all.result,{label:'ChatGPT',role:'writer',canCreate:false});assert.ok(all.messages.join('').includes('future projects'));
 const partial=await collect({role:'reader','no-create':true},['Audit']);assert.deepEqual(partial.result,{label:'Audit',role:'reader',canCreate:false});assert.equal(partial.prompts.length,1);
 const explicit=await collect({label:'Team',role:'member','allow-create':true},[]);assert.deepEqual(explicit.result,{label:'Team',role:'member',canCreate:true});assert.equal(explicit.prompts.length,0);
 await assert.rejects(()=>workspaceInviteOptions({'no-create':true,'allow-create':true}),/either/);
 assert.deepEqual(await workspaceInviteOptions({}),{label:'Teammate',role:'member',canCreate:true});
});

test('interactive workspace invite runs the real readline dialogue and creates the selected grant',async t=>{
 const base=mkdtempSync(join(tmpdir(),'spool-cli-invite-')),host=await startTeamHost(join(base,'host'),{port:0});t.after(async()=>{await host.close();rmSync(base,{recursive:true,force:true});});
 const {WorkspaceClient,workspaceRequest}=await import('../src/team/workspace-client.js'),{parseWorkspaceLink}=await import('../src/team/workspace.js');const state=join(base,'client'),client=new WorkspaceClient(state);await client.run({command:'connect',link:host.command({command:'workspace-init',name:'Interactive workspace'}).link,device:'Owner'});
 const input=new PassThrough();input.isTTY=true;let transcript='';const replies=[['Who is this invitation for?','ChatGPT'],['Choose access','1'],['Allow creating shared projects?','n']];
 const output=new Writable({write(chunk,encoding,done){const text=chunk.toString();transcript+=text;if(replies.length&&text.includes(replies[0][0])){const [,answer]=replies.shift();setImmediate(()=>input.write(answer+'\n'));}done();}});
 await runManagement(['workspace','invite','--state',state],{input,output});input.destroy();assert.equal(replies.length,0);const link=transcript.match(/http:\/\/[^\s]+/)?.[0];assert.ok(link);const preview=await workspaceRequest(parseWorkspaceLink(link),'preview');assert.equal(preview.role,'writer');assert.equal(preview.canCreate,false);assert.equal(preview.workspace.name,'Interactive workspace');
});
