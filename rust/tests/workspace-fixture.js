import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {copyFileSync,existsSync,mkdirSync,readFileSync,readdirSync,rmSync,unlinkSync,writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {dirname,join} from 'node:path';
import {repositoryAt} from '../../src/repository.js';
import {storeNativeMessage} from '../../src/native-history.js';
import {ShardedEngine} from '../../src/index.js';
import {RelayServer} from '../../src/relay/server.js';
import {startTeamHost} from '../../src/team/host.js';

const [binary,directory] = process.argv.slice(2);
const publicOrigin = 'https://workspace.example.test';
const claim = () => randomBytes(32).toString('base64url');
const inviteCode = link => JSON.parse(Buffer.from(new URL(link).pathname.slice(4),'base64url')).code;
let old, native, base, control;
const call = async (path,key,input,status=200) => {
  const response = await fetch(base+path,{method:'POST',headers:{authorization:key,'content-type':'application/json'},body:JSON.stringify(input)});
  const result = await response.json();
  assert.equal(response.status,status,JSON.stringify(result));
  assert.equal(result.protocol,'spool-relay/1');
  return result;
};
const nativeMemory = async (connection,body) => {
  const process = Bun.spawn([binary,'relay-request','memory'],{
    stdin:'pipe',stdout:'pipe',stderr:'pipe',
  });
  process.stdin.write(JSON.stringify({url:base,room:connection.room,token:connection.token,body}));
  await process.stdin.end();
  const [stdout,stderr,code] = await Promise.all([
    new Response(process.stdout).text(),new Response(process.stderr).text(),process.exited,
  ]);
  assert.equal(code,0,stderr);
  return JSON.parse(stdout);
};
try {
  old = await startTeamHost(directory,{port:0,embeddings:null});
  base = old.origin;
  const setup = await old.command({command:'workspace-init',name:'Existing workspace'});
  const enrolled = await call('/v1/workspace/enroll','Invite '+inviteCode(setup.link),{claim:claim(),device:'Owner'});
  const ws = input => call('/v1/workspace/action','Workspace '+enrolled.connection.token,input);
  const {project} = await ws({command:'create',name:'Existing project',requestId:'existing'});
  const {connection} = await ws({command:'join',room:project.room});
  const memory = input => call('/v1/rooms/'+project.room+'/memory','Bearer '+connection.token,input);
  const finding = await memory({command:'remember',kind:'finding',title:'Existing evidence',text:'Reuse old credentials.',requestId:'old-finding'});
  assert.equal((await nativeMemory({...connection,room:project.room},{command:'get',id:finding.id})).text,'Reuse old credentials.');
  const source = '/v1/rooms/'+project.room+'/source';
  const originalPage = {requestId:'original-page',records:[{kind:'message',id:'old-item',role:'assistant',
    text:'Existing conversation.',provenance:{sessionId:'old-session',itemId:'old-item',harness:'codex'}}]};
  const removedPage = {requestId:'remove-page',records:[{...originalPage.records[0],id:'removed-item',
    provenance:{sessionId:'removed-session',harness:'codex'}}]};
  await call(source,'Bearer '+connection.token,removedPage);
  const removal = await ws({command:'delete-conversations',room:project.room,sessionId:'removed-session'});
  assert.equal(removal.messages,1);
  await ws({command:'delete-conversations',room:project.room,sessionId:'removed-session',
    confirm:true,deletionToken:removal.deletionToken,requestId:'original-removal'});
  const originalReceipt = await call(source,'Bearer '+connection.token,originalPage);
  const pending = await ws({command:'invite-member',role:'reader',label:'Reader'});
  const nativeInvite = await ws({command:'invite-member',role:'reader',label:'Rust workspace client'});
  const nativeProfileState = join(directory,'native-workspace-state');
  const nativeEnroll = async (link,...args) => {
    const child = Bun.spawn([binary,'workspace-invite',...args],{
      env:{...Bun.env,SPOOL_STATE:nativeProfileState},stdin:Buffer.from(link),stdout:'pipe',stderr:'pipe',
    });
    const [out,error,status] = await Promise.all([
      new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited,
    ]);
    assert.equal(status,0,error);
    assert.equal(out.includes('"token"'),false);
    return JSON.parse(out);
  };
  const previewed = await nativeEnroll(nativeInvite.browserLink);
  assert.equal(previewed.workspace.name,'Existing workspace');
  const nativeJoined = await nativeEnroll(nativeInvite.link,'Rust client');
  assert.equal(nativeJoined.member.role,'reader');
  assert.deepEqual(await nativeEnroll(nativeInvite.browserLink,'Rust client'),nativeJoined);
  const nativeProfile = JSON.parse(readFileSync(join(nativeProfileState,'workspace-profiles',nativeJoined.workspaceProfile+'.json')));
  assert.equal((await call('/v1/workspace/action','Workspace '+nativeProfile.connection.token,{command:'list'})).member.role,'reader');
  const snapshot = await ws({command:'list'});
  await old.close();
  old = undefined;

  const configFile = join(directory,'host.json');
  const settings = JSON.parse(readFileSync(configFile,'utf8'));
  const controlSocket = join(directory,'ctl');
  if (process.platform === 'darwin') assert(Buffer.byteLength(controlSocket)<104,'Unix socket path exceeds macOS limit');
  writeFileSync(configFile,JSON.stringify({...settings,publicOrigin,controlSocket}));
  native = Bun.spawn([binary,'team-host','start',directory,'--port=0','--origin='+publicOrigin],{stdout:'pipe',stderr:'inherit'});
  const {value} = await native.stdout.getReader().read();
  base = 'http://'+new TextDecoder().decode(value).trim();
  const healthProbe=Bun.spawnSync([binary,'relay-health',base]);
  assert.equal(healthProbe.exitCode,0,healthProbe.stderr.toString());
  assert.equal(JSON.parse(healthProbe.stdout).protocol,'spool-relay/1');
  assert.equal(JSON.parse(healthProbe.stdout).ok,true);

  assert.deepEqual(await ws({command:'list'}),snapshot);
  const legacyWorkspaceState=join(directory,'legacy-workspace-client');
  mkdirSync(legacyWorkspaceState,{mode:0o700});
  const legacyConnection={...enrolled.connection,url:base};
  writeFileSync(join(legacyWorkspaceState,'workspace.json'),JSON.stringify(legacyConnection),{mode:0o600});
  const readLegacyWorkspace=async (...args)=>{
    const child=Bun.spawn([binary,'workspace',...args,'--json'],{
      env:{...Bun.env,SPOOL_STATE:legacyWorkspaceState},stdout:'pipe',stderr:'pipe',
    });
    const [out,error,status]=await Promise.all([
      new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited,
    ]);
    assert.equal(status,0,error);
    assert.equal(out.includes(legacyConnection.token),false);
    return JSON.parse(out);
  };
  const migratedProfiles=await readLegacyWorkspace('saved');
  assert.equal(migratedProfiles.workspaces[0].name,'Existing workspace');
  assert.equal(existsSync(join(legacyWorkspaceState,'workspace.json')),false);
  const backupName=readdirSync(legacyWorkspaceState).find(name=>name.startsWith('workspace.json.migrated-'));
  assert.deepEqual(JSON.parse(readFileSync(join(legacyWorkspaceState,backupName))),legacyConnection);
  assert.deepEqual(await readLegacyWorkspace('saved'),migratedProfiles);
  assert.equal((await readLegacyWorkspace('status')).workspace.name,'Existing workspace');

  const hostRequest = body => {
    const result = Bun.spawnSync([binary,'team-host','request',directory],{
      stdin:Buffer.from(JSON.stringify(body)),
    });
    assert.equal(result.exitCode,0,result.stderr.toString());
    return JSON.parse(result.stdout);
  };
  const hostStatus = hostRequest({command:'list'});
  assert.equal(hostStatus.url,publicOrigin);
  assert.deepEqual(hostStatus.projects.map(({room,name})=>({room,name})),[{room:project.room,name:project.name}]);
  assert(hostStatus.projects[0].members.some(member=>member.label==='Owner'));
  const ownerRecovery = hostRequest({command:'workspace-owner-invite'});
  const recover = await call('/v1/workspace/preview','Invite '+inviteCode(ownerRecovery.link),{});
  assert.equal(recover.role,'owner');
  assert.equal(new URL(ownerRecovery.browserLink).origin,publicOrigin);

  assert.equal((await nativeMemory({...connection,room:project.room},{command:'get',id:finding.id})).text,'Reuse old credentials.');
  assert.equal((await ws({command:'join',room:project.room})).connection.token,connection.token);
  assert.equal((await memory({command:'get',id:finding.id})).text,'Reuse old credentials.');
  const removedReplay = await call(source,'Bearer '+connection.token,{requestId:'removed-replay',
    records:[{...removedPage.records[0],id:'changed-item-id'}]});
  assert.equal(removedReplay.skipped,1);
  assert.equal(removedReplay.operations,0);
  assert.deepEqual(await call(source,'Bearer '+connection.token,originalPage),originalReceipt);
  const newPage = {requestId:'native-page',records:[{kind:'message',id:'new-item',role:'assistant',
    text:'Rust accepted the companion capture.',provenance:{sessionId:'new-session',itemId:'new-item',harness:'codex'}}]};
  const nativeReceipt = await call(source,'Bearer '+connection.token,newPage);
  assert.equal(nativeReceipt.operations,1);
  assert.deepEqual(await call(source,'Bearer '+connection.token,newPage),nativeReceipt);
  const capturedMemory = {protocol:'spool-memory/1',kind:'finding',title:'Imported local evidence',
    text:'Validated with the existing client.',actor:'local-agent',files:[{path:'src/index.js',fileId:'snapshot',heads:['old']}],refs:['old-item']};
  const structured = await call(source,'Bearer '+connection.token,{requestId:'structured',
    records:[{kind:'message',id:'local-finding',role:'system',text:JSON.stringify(capturedMemory)}]});
  assert.equal(structured.operations,1);
  const found = (await memory({command:'search',query:'validated',mode:'keyword',kinds:['finding']})).results[0];
  assert.equal(found.importedFromLocal,true);
  assert.deepEqual(found.files,[{path:'src/index.js',legacySnapshotReference:true}]);
  assert.match(found.refs[0],/^captured-[0-9a-f]{64}$/);
  await call(source,'Bearer '+connection.token,{requestId:'file',
    records:[{kind:'file',id:'file',text:'private contents'}]},426);
  const imported = await memory({command:'search',query:'companion',mode:'keyword',kinds:['conversation']});
  assert.equal(imported.results[0].source.messageId,'new-item');
  await ws({command:'project-sharing',room:project.room,sharing:{conversations:false},expectedRevision:0});
  const privatePage = {requestId:'private-page',records:[{...newPage.records[0],id:'private',text:'Keep local only'}]};
  assert.equal((await call(source,'Bearer '+connection.token,privatePage)).skipped,1);
  await ws({command:'project-sharing',room:project.room,sharing:{conversations:true},expectedRevision:1});
  assert.equal((await call(source,'Bearer '+connection.token,{...privatePage,requestId:'retry-private'})).skipped,1);
  const reader = await call('/v1/workspace/enroll','Invite '+inviteCode(pending.link),{claim:claim(),device:'Reader'});
  const readerKey = 'Workspace '+reader.connection.token;
  const readSettings = await call('/v1/workspace/action',readerKey,{command:'retrieval'},403);
  assert.equal(readSettings.error.code,'WORKSPACE_ROLE');
  const status = await ws({command:'retrieval'});
  assert.equal(status.revision,0);
  const retrievalConfig = {...status.settings,enabled:true,provider:'cloudflare',model:'@cf/baai/bge-m3',accountId:'a'.repeat(32)};
  const configure = {command:'retrieval',action:'configure',settings:retrievalConfig,expectedRevision:0,token:'b'.repeat(24)};
  const ownerKey = 'Workspace '+enrolled.connection.token;
  const consent = await call('/v1/workspace/action',ownerKey,configure,400);
  assert.equal(consent.error.code,'RETRIEVAL_CONSENT');
  const updated = await ws({...configure,externalProcessingApproved:true});
  assert.equal(updated.revision,1);
  assert.equal(updated.cloudflare.configured,true);
  assert.equal(JSON.stringify(updated).includes(configure.token),false);
  const limits = await ws({command:'retrieval',action:'limits',expectedRevision:0,
    limits:{dailyRequests:2,dailyCharacters:2000,projectDailyCharacters:100}});
  assert.equal(limits.usage.limits.revision,1);
  assert.equal(limits.usage.limits.projectDailyCharacters,100);
  const disabled = await ws({command:'retrieval',action:'configure',expectedRevision:1,
    settings:{...retrievalConfig,enabled:false},clearToken:true});
  assert.equal(disabled.status,'disabled');
  assert.equal(disabled.cloudflare.configured,false);

  if (process.platform !== 'win32') {
    const admin = {command:'relay-admin',action:'status'};
    assert.equal((await ws(admin)).supported,false);
    let requests = 0;
    control = createServer(socket => {
      let body = '';
      socket.on('data',chunk => {
        body += chunk;
        if (!body.includes('\n')) return;
        assert.deepEqual(JSON.parse(body),{action:'status'});
        requests++;
        socket.end(JSON.stringify({supported:true,state:'idle'})+'\n');
      });
    });
    await new Promise((resolve,reject) => control.once('error',reject).listen(controlSocket,resolve));
    const gate = join(directory,'.spool-update-gate');
    writeFileSync(gate,'1',{flag:'wx'});
    try {
      assert.equal((await ws(admin)).state,'idle');
      const denied = await call('/v1/workspace/action',readerKey,admin,403);
      assert.equal(denied.error.code,'WORKSPACE_ROLE');
      const blocked = await call('/v1/workspace/action','Workspace '+enrolled.connection.token,
        {command:'list'},503);
      assert.equal(blocked.error.code,'UPDATING');
      assert.equal(requests,1);
    } finally {
      unlinkSync(gate);
      await new Promise(resolve => control.close(resolve));
      control = undefined;
    }
  }
  const readConnection = (await call('/v1/workspace/action',readerKey,{command:'join',room:project.room})).connection;
  assert.equal((await call('/v1/rooms/'+project.room+'/memory','Bearer '+readConnection.token,
    {command:'get',id:finding.id})).id,finding.id);
  const request = {command:'repository-enroll',mode:'create',requestId:'nested',repositoryKey:'c'.repeat(64),
    name:'Nested',parentRoom:project.room};
  const {project: nested} = await ws(request);
  assert.equal(nested.parentRoom,project.room);
  const nestedConnection = (await ws({command:'join',room:nested.room})).connection;
  const nativeWrite = await call('/v1/rooms/'+nested.room+'/memory','Bearer '+nestedConnection.token,
    {command:'remember',kind:'finding',title:'New evidence',text:'Native workspace created this record.',requestId:'native-finding'});
  const invite = await ws({command:'invite-project',room:nested.room,label:'Original host',role:'read'});
  await call('/v1/workspace/action',readerKey,{command:'delete-conversations',room:project.room},403);
  await ws({command:'revoke-member',memberId:reader.memberId});
  await call('/v1/rooms/'+project.room+'/memory','Bearer '+readConnection.token,{command:'get',id:finding.id},401);

  const victimPage={requestId:'delete-this-page',records:[{...newPage.records[0],id:'victim',
    text:'Delete this specific conversation.',provenance:{sessionId:'victim-session',harness:'codex'}}]};
  await call(source,'Bearer '+connection.token,victimPage);
  const scope={command:'delete-conversations',room:project.room,sessionId:'victim-session'};
  const stale=await ws(scope);
  await memory({command:'remember',kind:'decision',title:'Concurrent record',text:'Keep this record.',requestId:'during-preview'});
  await call('/v1/workspace/action','Workspace '+enrolled.connection.token,
    {...scope,confirm:true,deletionToken:stale.deletionToken,requestId:'stale-delete'},409);
  const preview=await ws(scope);
  assert.equal(preview.messages,1);
  const deletedInput={...scope,confirm:true,deletionToken:preview.deletionToken,requestId:'delete-native'};
  const deletion=await ws(deletedInput);
  assert.equal(deletion.removed,1);
  assert.deepEqual(await ws(deletedInput),deletion);
  assert.equal((await memory({command:'search',query:'specific conversation',mode:'keyword',kinds:['conversation']}))
    .results.some(record=>record.text==='Delete this specific conversation.'),false);
  assert.equal((await memory({command:'get',id:finding.id})).id,finding.id);
  const state = join(directory,'client-state');
  const primary = join(state,'p');
  const sibling = join(primary,'projects','sibling');
  const repo = join(directory,'original-repo');
  const subrepo = join(repo,'subrepo');
  const working = join(subrepo,'src');
  mkdirSync(working,{recursive:true});
  mkdirSync(sibling,{recursive:true});
  const git = (cwd,...args) => {
    const result = Bun.spawnSync(['git','-C',cwd,...args]);
    assert.equal(result.exitCode,0,result.stderr.toString());
  };
  for (const [root,dir,grant,remote] of [
    [repo,primary,{...connection,room:project.room},'https://example.test/org/root.git'],
    [subrepo,sibling,{...nestedConnection,room:nested.room},'git@example.test:org/sub.git'],
  ]) {
    git(root,'init','-q');
    git(root,'remote','add','origin',remote);
    writeFileSync(join(dir,'project.json'),JSON.stringify({root,room:'local-'+grant.room}));
    writeFileSync(join(dir,'team.json'),JSON.stringify({...grant,url:base}));
  }
  writeFileSync(join(primary,'projects.json'),JSON.stringify({
    projects:[{root:repo,dir:primary,id:'local-'+project.room},
      {root:subrepo,dir:sibling,id:'local-'+nested.room}],
  }));
  writeFileSync(join(state,'discovery.json'),JSON.stringify({
    entries:[[repo,project.room],[subrepo,nested.room]].map(([root,room])=>({
      root,room,projectId:'local-'+room,repositoryKey:repositoryAt(root).repositoryKey,status:'enrolled',
      ...(root===subrepo?{parent:{root:repo,room:project.room}}:{}),
    })),
  }));
  const bound = async (cwd,id) => {
    const process = Bun.spawn([binary,'project-request',cwd,'memory'],{
      env:{...Bun.env,SPOOL_STATE:state},
      stdin:Buffer.from(JSON.stringify({command:'get',id})),stdout:'pipe',stderr:'pipe',
    });
    const [out,error,code] = await Promise.all([
      new Response(process.stdout).text(),new Response(process.stderr).text(),process.exited,
    ]);
    return {out,error,code};
  };
  for (const [path,id] of [[repo,finding.id],[working,nativeWrite.id]]) {
    const {out,error,code} = await bound(path,id);
    assert.equal(code,0,error);
    assert.equal(JSON.parse(out).id,id);
  }
  writeFileSync(join(repo,'evidence.txt'),'checked evidence');
  git(repo,'add','evidence.txt');
  git(repo,'-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-qm','Evidence');
  const requests = [
    {method:'initialize',params:{protocolVersion:'2025-11-25'}},
    {method:'tools/list'},
    {method:'tools/call',params:{name:'project_context',arguments:{root:working,maxChars:1000}}},
    {method:'tools/call',params:{name:'remember',arguments:{root:repo,kind:'finding',
      title:'Native MCP cross-check',text:'The nested checkout resolves to its own relay grant.',files:['evidence.txt'],requestId:'mcp-fixture-save'}}},
    {method:'tools/call',params:{name:'remember',arguments:{root:repo,kind:'finding',
      title:'Invalid scope',text:'This should never be written.',files:['subrepo/src/example.js']}}},
    {method:'tools/call',params:{name:'memory_get',arguments:{root:working,id:finding.id,sourceProject:'parent'}}},
    {method:'tools/call',params:{name:'memory_get',arguments:{root:working,id:finding.id}}},

  ];
  const mcpProcess = Bun.spawn([binary,'project-mcp'],{
    env:{...Bun.env,SPOOL_STATE:state},
    stdin:Buffer.from(requests.map((request,id)=>JSON.stringify({jsonrpc:'2.0',id,...request})).join('\n')+'\n'),
    stdout:'pipe',stderr:'pipe',
  });
  const [mcpOutput,mcpError,mcpStatus] = await Promise.all([
    new Response(mcpProcess.stdout).text(),new Response(mcpProcess.stderr).text(),mcpProcess.exited,
  ]);
  assert.equal(mcpStatus,0,mcpError);
  const replies = mcpOutput.trim().split('\n').map(line=>JSON.parse(line).result);
  assert.equal(replies[1].tools.filter(tool=>tool.name!=='spool_setup').every(tool=>tool.inputSchema.required.includes('root')),true);
  assert.equal(replies[2].structuredContent.repository.room,nested.room);
  const saved = replies[3].structuredContent;
  const recordedEvidence = await memory({command:'get',id:saved.id});
  assert.equal(recordedEvidence.title,'Native MCP cross-check');
  assert.match(recordedEvidence.git.commit,/^[a-f0-9]{40,64}$/);
  assert.equal(recordedEvidence.git.verified,true);
  assert.match(recordedEvidence.files[0].contentHash,/^[a-f0-9]{64}$/);
  assert.equal(replies[4].isError,true);
  assert.match(replies[4].content[0].text,/nested repository/);
  assert.equal(replies[2].structuredContent.parentContext.repository.room,project.room);
  assert.equal(replies[2].structuredContent.continuity.taskExists,false);
  assert.match(replies[2].structuredContent.continuity.taskId,/^codex-[a-f0-9]{24}$/);
  assert.equal(replies[5].structuredContent.id,finding.id);
  assert.equal(replies[5].structuredContent.sourceRepository.room,project.room);
  assert.equal(replies[6].isError,true);

  const localState = join(directory,'local-only-state');
  mkdirSync(localState);
  const localRoom = 'local-only';
  writeFileSync(join(localState,'project.json'),JSON.stringify({root:repo,room:localRoom}));
  const localRelay = new RelayServer(join(localState,'relay.sqlite'));
  localRelay.engine.create('relay-'+localRoom,{room:localRoom});
  const localRecord = localRelay.memory.run(localRoom,{command:'remember',kind:'finding',
    title:'Local predecessor',text:'This was saved before connecting a relay.',requestId:'local-predecessor'},
    {id:'local-agent'});
  await localRelay.close();
  const local = Bun.spawn([binary,'project-request',repo,'memory'],{
    env:{...Bun.env,SPOOL_STATE:localState},
    stdin:Buffer.from(JSON.stringify({command:'get',id:localRecord.id})),stdout:'pipe',stderr:'pipe',
  });
  const [localOut,localError,localStatus] = await Promise.all([
    new Response(local.stdout).text(),new Response(local.stderr).text(),local.exited,
  ]);
  assert.equal(localStatus,0,localError);
  assert.equal(JSON.parse(localOut).text,'This was saved before connecting a relay.');
  assert.deepEqual(JSON.parse(localOut).sharing,{mode:'local',uploaded:false});
  const nativeLocalWrite = Bun.spawnSync([binary,'project-request',repo,'memory'],{
    env:{...Bun.env,SPOOL_STATE:localState},
    stdin:Buffer.from(JSON.stringify({command:'remember',kind:'finding',
      title:'Native local write',text:'The older client can read this record.',requestId:'native-local-write'})),
  });
  assert.equal(nativeLocalWrite.exitCode,0,nativeLocalWrite.stderr.toString());
  const nativeLocalRecord = JSON.parse(nativeLocalWrite.stdout);
  assert.deepEqual(nativeLocalRecord.sharing,{mode:'local',uploaded:false});
  const legacyReader = new RelayServer(join(localState,'relay.sqlite'));
  try {
    const readBack = legacyReader.memory.run(localRoom,
      {command:'get',id:nativeLocalRecord.id},{id:'local-agent'});
    assert.equal(readBack.text,'The older client can read this record.');
  } finally {
    await legacyReader.close();
  }
  const installState = join(directory,'native-new-state');
  const isolatedEnv = {...Bun.env,SPOOL_STATE:installState};
  const runInit = (cwd=repo) => {
    const result = Bun.spawnSync([binary,'project-init',cwd],{env:isolatedEnv});
    assert.equal(result.exitCode,0,result.stderr.toString());
    return JSON.parse(result.stdout);
  };
  const initialized = runInit();
  assert.equal(initialized.existing,false);
  assert.deepEqual(runInit(),{project:initialized.project,existing:true});
  const legacyConfig = JSON.parse(readFileSync(join(installState,'p','project.json')));
  assert.equal(legacyConfig.captureFiles,false);
  assert.equal(legacyConfig.room,initialized.project.room);
  const legacyInitialized = new RelayServer(join(installState,'p','relay.sqlite'));
  try {
    assert.deepEqual(legacyInitialized.memory.run(legacyConfig.room,{command:'context'},{id:'local-agent'}).tasks,[]);
  } finally {
    await legacyInitialized.close();
  }
  const captureDb = join(installState,'p','capture.sqlite');
  const legacyMessage = {source:'codex-history',sessionId:'session',turnId:'first-turn',
    itemId:'first-message',harness:'codex',role:'user',text:'Previously captured'};
  const rustMessage = {...legacyMessage,itemId:'second-message',role:'assistant',text:'New evidence 🧪'};
  const oldCapture = new ShardedEngine(captureDb);
  assert.equal(storeNativeMessage(oldCapture,'working',legacyMessage),1);
  oldCapture.close();
  const capture = records => Bun.spawnSync([binary,'capture-import',captureDb,'working'],{
    stdin:Buffer.from(JSON.stringify(records)),
  });
  const captureResult = capture([legacyMessage,rustMessage]);
  assert.equal(captureResult.exitCode,0,captureResult.stderr.toString());
  assert.equal(JSON.parse(captureResult.stdout).stored,1);
  assert.equal(JSON.parse(capture([rustMessage]).stdout).stored,0);
  assert.equal(capture([{...rustMessage,itemId:'atomic-rollback'},
    {...rustMessage,itemId:'invalid-message',role:'invalid'}]).exitCode,1);
  const readCapture = new ShardedEngine(captureDb);
  try {
    assert.equal(storeNativeMessage(readCapture,'working',rustMessage),0);
    assert.deepEqual(Object.values(readCapture.read('working').messages).map(message=>message.text).sort(),
      [legacyMessage.text,rustMessage.text].sort());
  } finally {
    readCapture.close();
  }
  if (process.platform !== 'win32') {
    const fakeCodex = join(directory,'codex-history-fixture');
    writeFileSync(fakeCodex,`#!/usr/bin/env bun
import {createInterface} from 'node:readline';
const root = ${JSON.stringify(repo)};
for await (const line of createInterface({input:process.stdin})) {
  const m = JSON.parse(line);
  if (m.id === undefined) continue;
  let result = {};
  if (m.method === 'thread/list') result = {data:[{id:'poll',cwd:root},{id:'foreign',cwd:'/'}]};
  if (m.method === 'thread/turns/list') {
    if (m.params.threadId !== 'poll' || m.params.itemsView !== 'full') process.exit(4);
    result = m.params.cursor ? {data:[]} : {nextCursor:'next',data:[
      {id:'complete',status:'completed',items:[
        {id:'prompt',type:'userMessage',content:[{type:'text',text:'Polled prompt'}]},
        {id:'delegated',type:'functionCallOutput',name:'create_thread',output:{text:'<codex_delegation><source_thread_id>parent</source_thread_id><input>Delegated prompt</input></codex_delegation>'}},
        {id:'private',type:'reasoning',text:'Private reasoning'},
        {id:'reply',type:'agentMessage',text:'Polled answer'}]},
      {id:'active',status:'inProgress',items:[{id:'ignore',type:'agentMessage',text:'Partial message'}]}]};
  }
  process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');
}
`,{mode:0o700});
    const poll = () => {
      const result = Bun.spawnSync([binary,'capture-codex',repo,fakeCodex],{env:isolatedEnv});
      assert.equal(result.exitCode,0,result.stderr.toString());
      return JSON.parse(result.stdout);
    };
    assert.deepEqual(poll(),{threads:1,messages:3});
    assert.deepEqual(poll(),{threads:1,messages:0});
    const integration = join(installState,'p','integrations.json');
    const companionOnce = executable => {
      const result = Bun.spawnSync([binary,'companion','once',executable],{env:isolatedEnv});
      assert.equal(result.exitCode,0,result.stderr.toString());
      return JSON.parse(result.stdout).projects[0];
    };
    writeFileSync(integration,JSON.stringify({codex:true}));
    assert.deepEqual(companionOnce(fakeCodex).capture,{threads:1,messages:0});
    writeFileSync(integration,JSON.stringify({codex:false}));
    const inactive = companionOnce(join(directory,'missing-codex'));
    assert.equal(inactive.status,'idle');
    assert.equal(inactive.capture,undefined);
    const manual = Bun.spawnSync([binary,'project','capture','--root',repo,'--json'],{env:isolatedEnv});
    assert.equal(manual.exitCode,0,manual.stderr.toString());
    const manualState = JSON.parse(manual.stdout);
    assert.equal(manualState.root,repo);
    assert.equal(manualState.codex.enabled,false);
    assert.equal(manualState.captureRun.status,'idle');
    assert.equal(manualState.captureRun.capture,undefined);
    const codexHome = join(directory,'manual-agents-codex');
    const agents = Bun.spawnSync([binary,'project','agents','--root',repo,'--json'],{
      env:{...isolatedEnv,CODEX_HOME:codexHome},
    });
    assert.equal(agents.exitCode,0,agents.stderr.toString());
    assert.equal(JSON.parse(agents.stdout).configured,true);
    assert.match(readFileSync(join(codexHome,'config.toml'),'utf8'),/\[mcp_servers\.spool\]/);
    assert.deepEqual(JSON.parse(readFileSync(integration,'utf8')),{codex:false});
    const daemon = Bun.spawn([binary,'companion','start',join(directory,'missing-codex')],{
      env:isolatedEnv,stdout:'pipe',stderr:'inherit',
    });
    try {
      const first = await daemon.stdout.getReader().read();
      assert.equal(JSON.parse(new TextDecoder().decode(first.value)).projects[0].status,'idle');
      const readiness=JSON.parse(readFileSync(join(installState,'service.json')));
      assert.equal(readiness.backend,'rust');
      assert.equal(readiness.mode,'ready');
      assert.equal((await (await fetch(readiness.origin+'/healthz')).json()).protocol,'spool-relay/1');

      const open=Bun.spawnSync([binary,'open','--state',installState],{
        env:{...isolatedEnv,SPOOL_NO_OPEN:'1'},
      });
      assert.equal(open.exitCode,0,open.stderr.toString());
      assert.equal(JSON.parse(open.stdout).origin,readiness.origin);
      const contender = Bun.spawnSync([binary,'companion','start'],{env:isolatedEnv});
      assert.equal(contender.exitCode,1);
      assert.match(contender.stderr.toString(),/companion lock/);
    } finally {
      daemon.kill();
      assert.equal(await daemon.exited,0);
      assert.throws(()=>readFileSync(join(installState,'service.json')), {code:'ENOENT'});
    }


    const published = Bun.spawnSync([binary,'capture-publish',repo],{env:isolatedEnv});
    assert.equal(published.exitCode,0,published.stderr.toString());
    assert.equal(JSON.parse(published.stdout).pages,0);
    const foundHistory = Bun.spawnSync([binary,'project-request',repo,'memory'],{
      env:isolatedEnv,stdin:Buffer.from(JSON.stringify({command:'search',query:'Delegated',kinds:['conversation']})),
    });
    assert.equal(foundHistory.exitCode,0,foundHistory.stderr.toString());
    const polledRecord = JSON.parse(foundHistory.stdout).results[0];
    assert.equal(polledRecord.text,'Delegated prompt');
    assert.equal(polledRecord.source.sessionId,'poll');

    const captured = new ShardedEngine(captureDb);
    try {
      const texts = Object.values(captured.read('working').messages).map(message=>message.text);
      assert.ok(texts.includes('Delegated prompt'));
      assert.ok(texts.includes('Polled answer'));
      assert.ok(!texts.includes('Private reasoning') && !texts.includes('Partial message'));
    } finally {
      captured.close();
    }
  }
  const hook = (event,prompt='')=>{
    const result=Bun.spawnSync([binary,'codex-hook',event],{env:isolatedEnv,
      stdin:Buffer.from(JSON.stringify({cwd:repo,session_id:'native-hook-fixture',prompt}))});
    assert.equal(result.exitCode,0,result.stderr.toString());
    return JSON.parse(result.stdout);
  };
  const hint=hook('SessionStart').hookSpecificOutput;
  assert.equal(hint.hookEventName,'SessionStart');
  assert.match(hint.additionalContext,/SpoolDB is optional/);
  assert.match(hint.additionalContext,/requires explicit user approval/);
  assert.deepEqual(hook('Stop'),{});
  assert.deepEqual(hook('UserPromptSubmit','This is an app-generated request for a suggested next user message. The user did not write this message.'),{});
  const ignoredMcp=Bun.spawnSync([binary,'project-mcp'],{
    env:{...isolatedEnv,CODEX_THREAD_ID:'native-hook-fixture'},
    stdin:Buffer.from([
      {jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25'}},
      {jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'remember',arguments:{
        root:repo,kind:'finding',title:'Ignore this',text:'Background fixture',
      }}},
    ].map(value=>JSON.stringify(value)).join('\n')+'\n'),
  });
  assert.equal(ignoredMcp.exitCode,0,ignoredMcp.stderr.toString());
  const ignoredReply=JSON.parse(ignoredMcp.stdout.toString().trim().split('\n')[1]);
  assert.equal(ignoredReply.result.isError,true);
  assert.match(ignoredReply.result.content[0].text,/Background suggestion/);
  const added = runInit(working);
  assert.equal(added.existing,false);
  assert.notEqual(added.project.room,initialized.project.room);
  assert.deepEqual(runInit(working),{project:added.project,existing:true});
  assert.deepEqual(runInit(),{project:initialized.project,existing:true});
  const nativeRegistry = JSON.parse(readFileSync(join(installState,'p','projects.json')));
  assert.deepEqual(nativeRegistry.projects.map(item=>[item.id,item.root]),[
    [initialized.project.room,repo],[added.project.room,subrepo],
  ]);
  const web = Bun.spawn([binary,'local-web','0'],{env:{...isolatedEnv,SPOOL_TEAM_HOST:directory},stdout:'pipe',stderr:'inherit'});
  try {
    const {value} = await web.stdout.getReader().read();
    const url = 'http://'+new TextDecoder().decode(value).trim();
    assert.equal((await fetch(url+'/review/kiln.css')).status,200);
    assert.equal((await fetch(url+'/local/session')).status,403);
    const unbound = await fetch(url+'/local/session',{headers:{'sec-fetch-site':'same-origin',origin:'https://unrelated.example'}});
    assert.equal(unbound.status,403);
    const session = await fetch(url+'/local/session',{headers:{'sec-fetch-site':'same-origin'}});
    assert.equal(session.status,200);
    const {csrf,project:stateProject} = await session.json();
    assert.equal(stateProject.id,initialized.project.room);
    const cookie = session.headers.get('set-cookie').split(';')[0];
    const headers = {cookie,'sec-fetch-site':'same-origin','x-spool-csrf':csrf,'content-type':'application/json'};
    assert.equal((await fetch(url+'/local/projects',{headers:{...headers,'x-spool-csrf':'wrong'}})).status,401);
    const listed = await (await fetch(url+'/local/projects',{headers})).json();
    assert.deepEqual(listed.projects.map(project=>project.id),[initialized.project.room,added.project.room]);
    const selected = await fetch(url+'/local/projects/select',{method:'POST',headers,body:JSON.stringify({id:added.project.room})});
    assert.equal(selected.status,200);
    assert.equal((await selected.json()).id,added.project.room);
    const searched = await fetch(url+'/local/memory',{method:'POST',headers,body:JSON.stringify({command:'search',query:'New evidence'})});
    assert.equal(searched.status,200);
    const record=(await searched.json()).results.find(record=>record.text==='New evidence 🧪');
    assert(record);
    const local=(route,body)=>fetch(url+'/local/'+route,{
      headers,...(body?{method:'POST',body:JSON.stringify(body)}:{}),
    });
    assert.equal((await (await local('memory-setup')).json()).mcpServers.spool.args[0],'project-mcp');
    const localHost=await local('team/host',{command:'list'});
    assert.equal(localHost.status,200);
    assert((await localHost.json()).projects.some(item=>item.room===project.room));
    assert.equal((await local('team/host',{command:'workspace-owner-invite'})).status,400);
    assert.equal(typeof (await (await local('agents')).json()).configured,'boolean');
    const file=await local('memory',{command:'file_read',path:'evidence.txt',limit:4});
    assert.equal(file.status,200);
    assert.equal((await file.json()).text,readFileSync(join(repo,'evidence.txt'),'utf8').slice(0,4));
    assert.equal((await local('memory',{command:'file_read',path:'../host.json'})).status,400);
    const created=Bun.spawnSync([binary,'memory','remember','--root',subrepo,'--title','Archive fixture',
      '--text-stdin','--json'],{env:isolatedEnv,stdin:Buffer.from('Separate UI test record')});
    assert.equal(created.exitCode,0,created.stderr.toString());
    const archiveRecord=JSON.parse(created.stdout);
    const other=(route,body)=>fetch(url+'/local/'+route,{
      method:'POST',headers:{...headers,'x-spool-project':added.project.room},body:JSON.stringify(body),
    });
    const archived=await other('memory/update',{id:archiveRecord.id,action:'archive',reason:'UI archives old evidence',
      expectedRevision:archiveRecord.lifecycle?.revision??0,requestId:'fixture-ui-archive'});
    assert.equal(archived.status,200,await archived.text());
    const savedRecord=await (await other('memory',{command:'get',id:archiveRecord.id})).json();
    assert.equal(savedRecord.lifecycle.status,'archived');
    const restored=await other('memory/update',{id:archiveRecord.id,action:'restore',reason:'UI restores verified evidence',
      expectedRevision:savedRecord.lifecycle.revision,requestId:'fixture-ui-restore'});
    assert.equal(restored.status,200,await restored.text());
    assert.equal((await (await other('memory',{command:'get',id:archiveRecord.id})).json()).lifecycle.status,'active');
  } finally {
    web.kill();
    await web.exited;
  }
  git(subrepo,'remote','set-url','origin','https://example.test/org/different.git');
  const changed = await bound(working,nativeWrite.id);
  assert.equal(changed.code,1);
  assert.match(changed.error,/explicit SpoolDB enrollment/);
  native.kill();
  assert.equal(await native.exited,0);
  native = undefined;
  const rollbackVolume=join(directory,'relay-rollback-volume'), coldBackup=join(directory,'relay-cold-backup');
  mkdirSync(rollbackVolume,{mode:0o700});
  mkdirSync(coldBackup,{mode:0o700});
  for(const file of ['host.json','shared.sqlite','shared.sqlite-wal','shared.sqlite-shm','invite-key','workspace-key']){
    const source=join(directory,file);
    if(existsSync(source))copyFileSync(source,join(rollbackVolume,file));
  }
  const volumeAction=action=>{
    const result=Bun.spawnSync([binary,'relay-volume',action,rollbackVolume,coldBackup]);
    assert.equal(result.exitCode,0,result.stderr.toString());
  };
  const readColdStore=input=>{
    const result=Bun.spawnSync([binary,'team-host','request',rollbackVolume],{stdin:Buffer.from(JSON.stringify(input))});
    assert.equal(result.exitCode,0,result.stderr.toString());
    return JSON.parse(result.stdout);
  };
  const initialColdProjects=readColdStore({command:'list'});
  volumeAction('snapshot');
  assert(existsSync(join(rollbackVolume,'.spool-update-gate')));
  volumeAction('commit');
  readColdStore({command:'create',name:'Candidate-only project'});
  assert(readColdStore({command:'list'}).projects.some(project=>project.name==='Candidate-only project'));
  volumeAction('restore');
  assert.deepEqual(readColdStore({command:'list'}),initialColdProjects);
  const restoredRelay=Bun.spawn([binary,'team-host','start',rollbackVolume,'--port=0'],{stdout:'pipe',stderr:'inherit'});
  try{
    const adminStatus = Bun.spawnSync([binary,'server','status','--server-state',rollbackVolume,'--json'],{
      env:Object.fromEntries(Object.entries(Bun.env).filter(([name])=>name!=='SPOOL_CONTAINER_CONFIG')),
    });
    assert.equal(adminStatus.exitCode,0,adminStatus.stderr.toString());
    const existing = JSON.parse(adminStatus.stdout).projects.find(item=>item.room===project.room);
    assert(existing.members.length > 0);
    assert.equal(JSON.stringify(existing).includes(connection.token),false);
    const {value}=await restoredRelay.stdout.getReader().read();
    base='http://'+new TextDecoder().decode(value).trim();
    const restored=await call('/v1/rooms/'+nested.room+'/memory','Bearer '+nestedConnection.token,{command:'get',id:nativeWrite.id});
    assert.equal(restored.text,'Native workspace created this record.');
    assert.equal((await ws({command:'list'})).workspace.id,snapshot.workspace.id);
  }finally{
    restoredRelay.kill();
    assert.equal(await restoredRelay.exited,0);
  }
  old = await startTeamHost(directory,{port:0,embeddings:null});
  base = old.origin;
  assert.equal((await call(source,'Bearer '+connection.token,newPage)).operations,0);
  assert.equal((await call(source,'Bearer '+connection.token,{...victimPage,requestId:'victim-reupload'})).skipped,1);
  assert.equal((await ws({command:'repository-match',repositoryKey:request.repositoryKey})).project.room,nested.room);
  assert.equal((await call('/v1/rooms/'+nested.room+'/memory','Bearer '+nestedConnection.token,
    {command:'get',id:nativeWrite.id})).text,'Native workspace created this record.');
  assert.equal((await call('/v1/invites/preview','Invite '+inviteCode(invite.link),{})).room,nested.room);
  const profileId = 'a'.repeat(64);
  mkdirSync(join(installState,'workspace-profiles'));
  writeFileSync(join(installState,'workspace-profiles',profileId+'.json'),JSON.stringify({
    id:profileId,workspace:snapshot.workspace,member:snapshot.member,
    connection:{url:base,token:enrolled.connection.token},
  }));
  const enroll = async (...args) => {
    const child = Bun.spawn([binary,'project-enroll',profileId,...args],{
      env:isolatedEnv,stdout:'pipe',stderr:'pipe',
    });
    const [out,error,status] = await Promise.all([
      new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited,
    ]);
    return {out,error,status};
  };
  const firstShared = await enroll(repo,'create','Rust Enrolled');
  assert.equal(firstShared.status,0,firstShared.error);
  const shared = JSON.parse(firstShared.out).project;
  git(subrepo,'remote','set-url','origin','git@example.test:org/root.git');
  const duplicate = await enroll(working,'create','Duplicate');
  assert.equal(duplicate.status,1);
  assert.match(duplicate.error,/already has a shared project/);
  assert.equal((await ws({command:'list'})).projects.some(project=>project.name==='Duplicate'),false);
  const joinedExisting = await enroll(working,'join',shared.room);
  assert.equal(joinedExisting.status,0,joinedExisting.error);
  assert.equal(JSON.parse(joinedExisting.out).project.room,shared.room);
  const repeatJoin = await enroll(working,'join',shared.room);
  assert.equal(repeatJoin.status,0,repeatJoin.error);
  assert.equal(JSON.parse(repeatJoin.out).existing,true);
  const module = join(repo,'independent-module');
  mkdirSync(module);
  git(module,'init','-q');
  git(module,'remote','add','origin','https://example.test/org/module.git');
  const moduleLocal = runInit(module);
  const rejectedParent = await enroll(module,'create','Invalid parent',subrepo);
  assert.equal(rejectedParent.status,1);
  assert.match(rejectedParent.error,/enclosing parent repository/);
  const moduleShared = await enroll(module,'create','Linked module',repo);
  assert.equal(moduleShared.status,0,moduleShared.error);
  const moduleRoom = JSON.parse(moduleShared.out).project.room;
  const moduleView = (await ws({command:'list'})).projects.find(project=>project.room===moduleRoom);
  assert.equal(moduleView.parentRoom,shared.room);
  const moduleBinding = JSON.parse(readFileSync(join(installState,'discovery.json')))
    .entries.find(entry=>entry.projectId===moduleLocal.project.projectId);
  assert.deepEqual(moduleBinding.parent,{root:repo,room:shared.room});
  const runMemoryCLI=async (cwd, args, input)=>{
    const child=Bun.spawn([binary,'memory',...args],{cwd,env:isolatedEnv,
      stdin:input?Buffer.from(input):'ignore',stdout:'pipe',stderr:'pipe'});
    const [out,error,status]=await Promise.all([
      new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited,
    ]);
    assert.equal(status,0,error);
    return JSON.parse(out);
  };
  const runManagementCLI=async (cwd,args,input)=>{
    const child=Bun.spawn([binary,...args,'--json'],{cwd,env:isolatedEnv,stdin:input?Buffer.from(input):'ignore',stdout:'pipe',stderr:'pipe'});
    const [out,error,status]=await Promise.all([
      new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited,
    ]);
    assert.equal(status,0,error);
    return JSON.parse(out);
  };
  const updater = await runManagementCLI(repo,['update','status','--target','plugin']);
  assert.equal(updater.target,'plugin');
  assert.equal(updater.state,installState);
  assert.equal(updater.mode,'off');
  const updateConfig=join(directory,'scheduled-updater.json');
  const scheduledUpdate=()=>{
    const result=Bun.spawnSync([binary,'update-scheduled',updateConfig],{env:isolatedEnv});
    assert.equal(result.exitCode,0,result.stderr.toString());
    return JSON.parse(result.stdout);
  };
  assert.equal(scheduledUpdate().skipped,'disabled');
  writeFileSync(updateConfig,JSON.stringify({mode:'check',target:'plugin',lastCheck:new Date().toISOString()}));
  assert.equal(scheduledUpdate().skipped,'checked recently');
  mkdirSync(updateConfig+'.lock');
  assert.equal(scheduledUpdate().skipped,'another update is running');
  rmSync(updateConfig+'.lock',{recursive:true});
  const leaseState=join(directory,'scheduler-lease-state');
  mkdirSync(join(leaseState,'plugin-leases'),{recursive:true});
  writeFileSync(join(leaseState,'plugin-leases','test.json'),JSON.stringify({pid:process.pid}));
  writeFileSync(updateConfig,JSON.stringify({mode:'automatic',target:'plugin',state:leaseState}));
  assert.equal(scheduledUpdate().skipped,'an agent session is active');
  if(process.platform==='linux'){
    const schedulerState=join(directory,'native-scheduler-state');
    const tools=join(directory,'native-scheduler-tools');
    const schedulerHome=join(directory,'native-scheduler-home');
    const schedulerConfig=join(schedulerHome,'config');
    const schedulerData=join(schedulerHome,'data');
    mkdirSync(tools);
    writeFileSync(join(tools,'systemctl'),'#!/bin/sh\nprintf \'%s\\n\' "$*"\n',{mode:0o700});
    writeFileSync(join(tools,'codex'),'#!/bin/sh\nexit 99\n',{mode:0o700});
    const env={...isolatedEnv,SPOOL_STATE:schedulerState,HOME:schedulerHome,
      XDG_CONFIG_HOME:schedulerConfig,XDG_DATA_HOME:schedulerData,PATH:tools+':'+Bun.env.PATH};
    const runUpdater=(...args)=>Bun.spawnSync([binary,'update',...args,'--target','plugin','--json'],{env});
    assert.notEqual(runUpdater('enable').exitCode,0);
    const enabled=runUpdater('enable','--mode','check','--yes');
    assert.equal(enabled.exitCode,0,enabled.stderr.toString());
    assert.equal(JSON.parse(enabled.stdout).mode,'check');
    const unit=join(schedulerConfig,'systemd/user/spool-update-plugin.service');
    assert.match(readFileSync(unit,'utf8'),/spool-native.*update-scheduled/);
    assert(existsSync(join(schedulerData,'spool/updater/spool-native')));
    const service=Bun.spawnSync([binary,'service','client','status'],{env});
    assert.equal(service.exitCode,0,service.stderr.toString());
    assert.equal(service.stdout.toString().trim(),'--user status spool.service --no-pager');
    const disabled=runUpdater('disable');
    assert.equal(disabled.exitCode,0,disabled.stderr.toString());
    assert.equal(JSON.parse(disabled.stdout).mode,'off');
    assert(!existsSync(unit));
  }
  if(process.platform==='linux'){
    const desktopRoot=join(directory,'native-desktop-rollback');
    const bundle=join(desktopRoot,'bundle');
    const tools=join(desktopRoot,'commands');
    mkdirSync(tools,{recursive:true});
    writeFileSync(join(tools,'systemctl'),
      '#!/bin/sh\nif [ "$2" = enable ] && [ "$FAIL_NEXT_SERVICE" = 1 ]; then exit 1; fi\nexit 0\n',{mode:0o700});
    const data=join(desktopRoot,'data'), state=join(desktopRoot,'state');
    const env={...isolatedEnv,XDG_DATA_HOME:data,XDG_STATE_HOME:state,XDG_CONFIG_HOME:join(desktopRoot,'config'),
      SPOOL_BIN_HOME:join(desktopRoot,'bin'),PATH:tools+':'+Bun.env.PATH};
    const setupPackage=version=>{
      const files={};
      for(const [name,body] of Object.entries({'package.json':JSON.stringify({version}),
        'runtime/spool-native-linux-x64':'stub '+version,'src/desktop/icon.svg':'<svg/>'})){
        const path=join(bundle,name);
        mkdirSync(dirname(path),{recursive:true});
        writeFileSync(path,body);
        files[name]=new Bun.CryptoHasher('sha256').update(body).digest('hex');
      }
      writeFileSync(join(bundle,'manifest.json'),JSON.stringify({version,files}));
    };
    const update=extra=>Bun.spawnSync([binary,'desktop-install',bundle,'--update'],{env:{...env,...extra}});
    setupPackage('1.2.3');
    const initial=update({});
    assert.equal(initial.exitCode,0,initial.stderr.toString());
    writeFileSync(join(state,'spool','retained-memory'),'old memory');
    const before=readFileSync(join(data,'spool','installation.json'),'utf8');
    setupPackage('1.2.4');
    const failed=update({FAIL_NEXT_SERVICE:'1'});
    assert.notEqual(failed.exitCode,0);
    assert.equal(readFileSync(join(data,'spool','installation.json'),'utf8'),before);
    assert.equal(readFileSync(join(data,'spool/app/runtime/spool-native-linux-x64'),'utf8'),'stub 1.2.3');
    assert.equal(readFileSync(join(state,'spool','retained-memory'),'utf8'),'old memory');
  }
  const vpsRoot=join(directory,'disposable-vps-install');
  const vpsApp=join(vpsRoot,'releases','0.4.43-00000000-0000-0000-0000-000000000001');
  mkdirSync(vpsApp,{recursive:true});
  const vpsConfig=join(vpsRoot,'containers.json');
  writeFileSync(vpsConfig,JSON.stringify({managedBy:'SpoolDB',engine:'/usr/bin/podman',app:vpsApp}));
  writeFileSync(join(vpsApp,'package.json'),JSON.stringify({version:'0.4.43'}));
  writeFileSync(join(vpsRoot,'relay-updates.json'),JSON.stringify({enabled:true,backupRetention:{keep:7}}));
  const relayStatus=Bun.spawnSync([binary,'update','status','--target','relay','--json'],{
    env:{...isolatedEnv,SPOOL_CONTAINER_CONFIG:vpsConfig},
  });
  assert.equal(relayStatus.exitCode,0,relayStatus.stderr.toString());
  assert.deepEqual(JSON.parse(relayStatus.stdout),{config:vpsConfig,current:'0.4.43',enabled:true,
    backupRetention:{keep:7,maxAgeDays:30},artifactRetention:{keep:3,maxAgeDays:30}});
  const modulePreview=await runManagementCLI(module,['discovery','preview',module]);
  assert.equal(modulePreview.parentCandidate.room,shared.room);
  assert.equal(modulePreview.workspaceProfile,profileId);
  const linked=await runManagementCLI(module,['discovery','link-parent',module,'--yes']);
  assert.equal(linked.linked,true);
  assert.equal(linked.project.parentRoom,shared.room);
  const sharedStatus=await runManagementCLI(module,['status']);
  assert.equal(sharedStatus.team.room,moduleRoom);
  const savedProfiles=await runManagementCLI(module,['workspace','saved']);
  assert(savedProfiles.workspaces.some(profile=>profile.id===profileId));
  const visible=await runManagementCLI(module,['workspace','projects']);
  assert(visible.some(project=>project.room===moduleRoom));
  const localProjects=await runManagementCLI(module,['project','list']);
  assert(localProjects.projects.some(project=>project.root===module));
  const issuedByCLI=await runManagementCLI(repo,['project','invite',shared.room,'--label','Rust CLI invite','--role','read']);
  assert.match(issuedByCLI.link,/^spool:\/\/join\/v1\//);
  const selectedLocal=localProjects.projects.find(project=>project.root===module);
  assert.equal((await runManagementCLI(repo,['project','select',selectedLocal.id])).root,module);
  assert.equal((await runManagementCLI(repo,['project','status'])).root,repo);
  const invitedCheckout=join(directory,'native-cli-invite-checkout');
  mkdirSync(invitedCheckout);
  git(invitedCheckout,'init','-q');
  git(invitedCheckout,'remote','add','origin','git@example.test:org/root.git');
  const invited=await runManagementCLI(repo,['project','join-invite',invitedCheckout,'--invite-stdin',
    '--no-agents','--no-capture','--device','Rust invite client'],issuedByCLI.link);
  assert.equal(invited.joined,true);
  assert.equal(invited.project.root,invitedCheckout);
  const joinedStatus=await runManagementCLI(invitedCheckout,['project','status']);
  assert.equal(joinedStatus.team.room,shared.room);
  assert.equal(joinedStatus.codex.enabled,false);
  const pendingCheckout=join(directory,'discovery-cli-pending');
  mkdirSync(pendingCheckout);
  git(pendingCheckout,'init','-q');
  git(pendingCheckout,'remote','add','origin','git@example.test:org/root.git');
  const proposal=await runManagementCLI(repo,['discovery','propose',pendingCheckout]);
  assert.equal(proposal.status,'pending');
  assert((await runManagementCLI(repo,['discovery','list'])).entries
    .some(entry=>entry.id===proposal.id && entry.status==='pending'));
  assert.equal((await runManagementCLI(repo,['discovery','ignore',pendingCheckout])).status,'ignored');
  assert.equal((await runManagementCLI(repo,['discovery','propose',pendingCheckout])).status,'ignored');
  const cliMembers=await runManagementCLI(repo,['project','connections',shared.room]);
  assert(cliMembers.members.some(member=>member.label==='Rust invite client'));
  const removedByCLI=await runManagementCLI(repo,['project','revoke',shared.room,'Rust invite client']);
  assert.equal(removedByCLI.revoked,true);
  const workspacePolicy=await runManagementCLI(repo,['workspace','sharing']);
  assert.equal(typeof workspacePolicy.sharing.conversations,'boolean');
  const projectPolicy=await runManagementCLI(repo,['project','sharing',shared.room]);
  assert.equal(typeof projectPolicy.sharingRevision,'number');
  const usageCLI=await runManagementCLI(repo,['workspace','usage']);
  assert.equal(typeof usageCLI.limits.dailyRequests,'number');
  const deletionCLI=await runManagementCLI(repo,['project','delete-conversations',shared.room,'--dry-run']);
  assert.equal(typeof deletionCLI.messages,'number');


  const note=await runMemoryCLI(repo,['remember','--title','Checkout CLI evidence','--text-stdin',
    '--request-id','native-cli-evidence'],'Memory CLI recognizes the repository binding.');
  assert.equal(note.room,shared.room);
  const record=await runMemoryCLI(repo,['get',note.id]);
  assert.equal(record.text,'Memory CLI recognizes the repository binding.');
  const fromModule=await runMemoryCLI(module,['search','checkout','CLI']);
  assert.equal(fromModule.room,moduleRoom);
  assert.equal(fromModule.linkedParent.project.room,shared.room);
  assert(fromModule.linkedParent.memory.results.some(result=>result.id===note.id));

  const runCaptureCommand = action => {
    const result = Bun.spawnSync([binary,action,repo],{env:isolatedEnv});
    assert.equal(result.exitCode,0,result.stderr.toString());
    return JSON.parse(result.stdout);
  };
  const share = async () => {
    const child = Bun.spawn([binary,'capture-share',repo],{
      env:isolatedEnv,stdout:'pipe',stderr:'pipe',
    });
    const [out,error,status] = await Promise.all([
      new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited,
    ]);
    assert.equal(status,0,error);
    return JSON.parse(out);
  };
  await ws({command:'project-sharing',room:shared.room,sharing:{conversations:false},expectedRevision:0});
  runCaptureCommand('capture-publish');
  const withheld = await share();
  assert.equal(withheld.accepted,0);
  assert.ok(withheld.retainedLocally>=2);
  await ws({command:'project-sharing',room:shared.room,sharing:{conversations:true},expectedRevision:1});
  const freshCapture = capture([{...rustMessage,itemId:'new-shared-item',text:'New shared material'}]);
  assert.equal(freshCapture.exitCode,0,freshCapture.stderr.toString());
  runCaptureCommand('capture-publish');
  assert.equal((await share()).accepted,1);
  assert.equal((await share()).pages,0);
  const grant = (await ws({command:'join',room:shared.room})).connection;
  const sharedConversations = await call('/v1/rooms/'+shared.room+'/memory','Bearer '+grant.token,
    {command:'search',query:'shared',kinds:['conversation']});
  assert.deepEqual(sharedConversations.results.map(result=>result.text),['New shared material']);
  const previous = await call('/v1/rooms/'+shared.room+'/memory','Bearer '+grant.token,
    {command:'search',query:'Previously',kinds:['conversation']});
  assert.deepEqual(previous.results,[]);
  const privateRequest = async body => {
    const proc = Bun.spawn([binary,'project-request',repo,'memory'],{
      env:isolatedEnv,stdin:Buffer.from(JSON.stringify(body)),stdout:'pipe',stderr:'pipe',
    });
    const [out,error,status] = await Promise.all([
      new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited,
    ]);
    assert.equal(status,0,error);
    return JSON.parse(out);
  };
  await ws({command:'project-sharing',room:shared.room,sharing:{findings:false},expectedRevision:2});
  const privateFinding = {command:'remember',kind:'finding',title:'Restricted finding',
    text:'This evidence remains private.',requestId:'native-private-finding'};
  const privateSaved = await privateRequest(privateFinding);
  assert.deepEqual(privateSaved.sharing,{mode:'local',uploaded:false});
  assert.equal((await privateRequest(privateFinding)).id,privateSaved.id);
  assert.equal((await privateRequest({command:'get',id:privateSaved.id})).text,privateFinding.text);
  assert.equal((await privateRequest({command:'search',query:'Restricted',kinds:['finding']})).results[0].id,privateSaved.id);
  await ws({command:'project-sharing',room:shared.room,sharing:{findings:true},expectedRevision:3});
  assert.equal((await share()).pages,0);
  assert.deepEqual((await call('/v1/rooms/'+shared.room+'/memory','Bearer '+grant.token,
    {command:'search',query:'Restricted',kinds:['finding']})).results,[]);
  const viaWeb = join(directory,'web-enrollment-checkout');
  mkdirSync(viaWeb);
  git(viaWeb,'init','-q');
  git(viaWeb,'remote','add','origin','git@example.test:org/root.git');
  const webEnrollment = Bun.spawn([binary,'local-web','0'],{env:isolatedEnv,stdout:'pipe',stderr:'inherit'});
  try {
    const {value} = await webEnrollment.stdout.getReader().read();
    const endpoint='http://'+new TextDecoder().decode(value).trim();
    const session=await fetch(endpoint+'/local/session',{headers:{'sec-fetch-site':'same-origin'}});
    const {csrf} = await session.json();
    const headers={'sec-fetch-site':'same-origin',cookie:session.headers.get('set-cookie').split(';')[0],
      'x-spool-csrf':csrf,'content-type':'application/json'};
    const discover = async (input,status=200)=>{
      const response=await fetch(endpoint+'/local/discovery',{method:'POST',headers,body:JSON.stringify({
        cwd:viaWeb,workspace:profileId,...input,
      })});
      const result=await response.json();
      assert.equal(response.status,status,JSON.stringify(result));
      return result;
    };
    const preview=await discover({command:'preview'});
    assert.equal(preview.status,'pending');
    assert.deepEqual(preview.matches.map(project=>project.room),[shared.room]);
    const denied=await discover({command:'approve',room:shared.room},400);
    assert.match(denied.error,/Explicit confirmation/);
    const connected=await discover({command:'approve',room:shared.room,confirm:true});
    assert.equal(connected.status,'enrolled');
    assert.equal(connected.room,shared.room);
    assert.equal((await discover({command:'preview'})).projectId,connected.projectId);
  } finally {
    webEnrollment.kill();
    await webEnrollment.exited;
  }
  const cliCheckout=join(directory,'cli-enrollment-checkout');
  const codexHome=join(directory,'cli-codex-home');
  mkdirSync(cliCheckout);
  git(cliCheckout,'init','-q');
  git(cliCheckout,'remote','add','origin','git@example.test:org/root.git');
  const initCli=async answers=>{
    const helper=`
import os, pty, subprocess, sys
master, slave = pty.openpty()
child = subprocess.Popen(sys.argv[1:], stdin=slave)
os.close(slave)
try:
    os.write(master, sys.stdin.buffer.read())
    sys.exit(child.wait(timeout=20))
finally:
    if child.poll() is None:
        child.kill()
        child.wait()
    os.close(master)
`;
    const child=Bun.spawn(['python3','-c',helper,binary,'init','--workspace',profileId,'--json'],{
      cwd:cliCheckout,env:{...isolatedEnv,CODEX_HOME:codexHome},
      stdin:Buffer.from(answers),stdout:'pipe',stderr:'pipe',
    });
    const [out,error,status]=await Promise.all([
      new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited,
    ]);
    assert.equal(status,0,error);
    assert.match(error,/matches this repository/);
    return JSON.parse(out);
  };
  assert.deepEqual(await initCli('1\nn\n'),{cancelled:true});
  const cliInitialized=await initCli('1\ny\nn\nn\ny\n');
  assert.equal(cliInitialized.connected,true);
  assert.equal(cliInitialized.project.room,shared.room);
  assert.equal(cliInitialized.codexReady,true);
  assert.match(readFileSync(join(codexHome,'config.toml'),'utf8'),/project-mcp/);
  assert.equal((await ws({command:'list'})).projects.filter(project=>project.room===shared.room).length,1);
  const mcpCheckout=join(directory,'mcp-enrollment-checkout');
  mkdirSync(mcpCheckout);
  git(mcpCheckout,'init','-q');
  git(mcpCheckout,'remote','add','origin','https://example.test/org/root.git');
  const runMcp=async requests=>{
    const commands=[{method:'initialize'},...requests.map(([name,args])=>({
      method:'tools/call',params:{name,arguments:{root:mcpCheckout,...args}},
    }))];
    const child=Bun.spawn([binary,'project-mcp'],{env:isolatedEnv,stdout:'pipe',stderr:'pipe',
      stdin:Buffer.from(commands.map((msg,id)=>JSON.stringify({jsonrpc:'2.0',id,...msg})).join('\n')+'\n')});
    const [out,error,code]=await Promise.all([
      new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited,
    ]);
    assert.equal(code,0,error);
    return out.trim().split('\n').slice(1).map(line=>JSON.parse(line).result);
  };
  const [onboarding,setupPreview,setupDenied,detectDuplicate,setupApproved]=await runMcp([
    ['project_context',{}],
    ['spool_setup',{action:'preview',workspace:profileId}],
    ['spool_setup',{action:'connect',workspace:profileId,project:shared.room}],
    ['spool_setup',{action:'connect',workspace:profileId,create:true,confirm:true}],
    ['spool_setup',{action:'connect',workspace:profileId,project:shared.room,confirm:true}],
  ]);
  assert.equal(onboarding.structuredContent.code,'PROJECT_CONNECTION_REQUIRED');
  assert.deepEqual(setupPreview.structuredContent.matches.map(project=>project.room),[shared.room]);
  assert.equal(setupDenied.isError,true);
  assert.equal(detectDuplicate.structuredContent.status,'join_available');
  assert.equal(setupApproved.structuredContent.room,shared.room);
  const [sharingPreview,deniedSharing,deletionPreview,deniedDelete,deniedUpdate]=await runMcp([
    ['spool_setup',{action:'project_sharing'}],
    ['spool_setup',{action:'project_sharing',sharing:{conversations:false},expectedRevision:0}],
    ['spool_setup',{action:'delete_conversations'}],
    ['spool_setup',{action:'delete_conversations',confirm:true}],
    ['spool_setup',{action:'relay_update',updateNow:true}],
  ]);
  assert.equal(sharingPreview.isError??false,false);
  assert.equal(deniedSharing.isError,true);
  assert.equal(typeof deletionPreview.structuredContent.messages,'number');
  assert.equal(deniedDelete.isError,true);
  assert.equal(deniedUpdate.isError,true);
  const [historyBefore,choice,historyPage] = await runMcp([
    ['history_read',{root:repo,limit:2}],
    ['spool_setup',{root:repo,action:'retrospective',analyzeExisting:true,confirm:true}],
    ['history_read',{root:repo,limit:2}],
  ]);
  assert.equal(historyBefore.isError,true);
  assert.equal(choice.structuredContent.retrospective.status,'pending');
  assert.equal(historyPage.structuredContent.sourceScope,'local-only');
  assert.equal(historyPage.structuredContent.results.length,2);
  assert.equal(historyPage.structuredContent.nextOffset,2);
  const id=historyPage.structuredContent.results[0].id;
  const [historicalRecord,foreign,task,handoff] = await runMcp([
    ['history_read',{root:repo,recordId:id}],
    ['history_read',{root:mcpCheckout,recordId:id}],
    ['task_update',{root:repo,taskId:'retrospective-fixture',title:'Review historical captures',
      text:'Checked the approved local conversation snapshot for durable findings.',status:'in_progress',expectedRevision:0}],
    ['handoff',{root:repo,taskId:'retrospective-fixture',title:'Historical review complete',
      text:'Reviewed the approved conversation snapshot for existing evidence.',nextSteps:['Use the verified evidence when applicable.']}],
  ]);
  assert.equal(historicalRecord.structuredContent.id,id);
  assert.equal(foreign.isError,true);
  assert.equal(task.isError,false,JSON.stringify(task));
  assert.equal(handoff.isError,false,JSON.stringify(handoff));
  const [completed,historyAfter]=await runMcp([
    ['history_complete',{root:repo,handoffId:handoff.structuredContent.id}],
    ['history_read',{root:repo,limit:2}],
  ]);
  assert.equal(completed.structuredContent.retrospective.status,'completed');
  assert.equal(historyAfter.isError,true);
  const freshState=join(directory,'fresh-setup-state');
  const setupWeb=Bun.spawn([binary,'local-web','0'],{
    env:{...Bun.env,SPOOL_STATE:freshState},stdout:'pipe',stderr:'inherit',
  });
  try {
    const {value}=await setupWeb.stdout.getReader().read();
    const origin='http://'+new TextDecoder().decode(value).trim();
    const started=await fetch(origin+'/');
    assert.match(await started.text(),/Join a project/);
    assert.equal((await fetch(origin+'/setup.js')).status,200);
    const session=await fetch(origin+'/api/session',{headers:{'sec-fetch-site':'same-origin'}});
    assert.equal(session.status,200);
    const {csrf}=await session.json();
    const headers={'sec-fetch-site':'same-origin',cookie:session.headers.get('set-cookie').split(';')[0],
      'x-spool-csrf':csrf,'content-type':'application/json'};
    const setup=async (path,body)=>{
      const response=await fetch(origin+'/api/'+path,{method:'POST',headers,body:JSON.stringify(body)});
      const result=await response.json();
      assert.equal(response.status,200,JSON.stringify(result));
      return result;
    };
    assert.equal((await setup('status',{})).pending,null);
    mkdirSync(freshState,{recursive:true});
    writeFileSync(join(freshState,'discovery.json'),JSON.stringify({entries:[
      {root:viaWeb,status:'pending',repositoryKey:repositoryAt(viaWeb).repositoryKey},
    ]}));
    const direct=await old.command({command:'create-invite',room:shared.room,label:'Direct setup'});
    assert.equal((await setup('preview',{link:direct.link})).room,shared.room);
    const accepted=await setup('join',{link:direct.link,root:viaWeb,device:'Fresh fixture',captureConversations:false});
    assert.equal(accepted.joined,true);
    assert.equal(accepted.origin,origin);
    assert.equal((await setup('join',{link:direct.link,root:viaWeb,device:'Fresh fixture',captureConversations:false})).project.id,accepted.project.id);
    const ready=await fetch(origin+'/',{redirect:'manual'});
    assert.equal(ready.status,302);
    assert.equal(ready.headers.get('location'),'/review/');
    const config=JSON.parse(readFileSync(join(freshState,'p','team.json')));
    assert.equal(config.room,shared.room);
    const directBinding=JSON.parse(readFileSync(join(freshState,'discovery.json'))).entries[0];
    assert.equal(directBinding.status,'enrolled');
    assert.equal(directBinding.room,shared.room);

    assert.throws(()=>readFileSync(join(freshState,'p','integrations.json')),{code:'ENOENT'});
  } finally {
    setupWeb.kill();
    await setupWeb.exited;
  }
  const memberInvite=await runManagementCLI(repo,['workspace','invite','--role','reader','--label','Native admin fixture','--no-create']);
  const joinedMember=await call('/v1/workspace/enroll','Invite '+inviteCode(memberInvite.link),{claim:claim(),device:'Native workspace invite fixture'});
  const membership=await call('/v1/workspace/action','Workspace '+joinedMember.connection.token,{command:'list'});
  assert.equal(membership.member.role,'reader');
  const revokedMember=await runManagementCLI(repo,['workspace','revoke',joinedMember.memberId]);
  assert.equal(revokedMember.revoked,true);
  const disconnected=await runManagementCLI(repo,['workspace','disconnect','--workspace',profileId]);
  assert.equal(disconnected.removedConnection,profileId);
  assert((await runManagementCLI(repo,['workspace','saved'])).workspaces.every(profile=>profile.id!==profileId));
  assert.equal((await runManagementCLI(repo,['project','status'])).team.room,shared.room);
  assert.equal((await runMemoryCLI(repo,['get',note.id])).id,note.id);
} finally {
  if (native) {native.kill();await native.exited;}
  await old?.close();
}
