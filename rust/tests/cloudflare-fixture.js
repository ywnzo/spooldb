import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {copyFileSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {ShardedEngine} from '../../src/index.js';
import {SyncClient} from '../../src/relay/client.js';
import {buildDownloadAssets} from '../../scripts/build-download-assets.js';

const [nativeEntry] = process.argv.slice(2);
assert(nativeEntry, 'Pass the built Rust Worker shim path');
const directory = mkdtempSync(join(tmpdir(), 'spool-rust-worker-'));
const oldBundle = join(directory, 'original');
const persistence = join(directory, 'data');
const bootstrap = randomBytes(32).toString('base64url');
const bootstrapHash = createHash('sha256').update(bootstrap).digest('hex');
const assetDirectory=join(directory,'downloads'), installer=join(directory,'fixture.run');
const installerBytes=Buffer.from('#!/bin/sh\nprintf "test installer\\n"\n');
writeFileSync(installer,installerBytes);
const manifest=buildDownloadAssets({directory:assetDirectory,chunkBytes:7,
  files:[{path:installer,name:'spool-linux-x64.run',runtime:'bun'}]});
const installerHash=manifest.current['spool-linux-x64.run'];
const assetService=async req=>{
  const path = new URL(req.url).pathname.slice(1);
  if(path==='manifest.json')return Response.json(manifest);
  if(!manifest.releases[installerHash+'/spool-linux-x64.run'].parts.some(part=>part.path===path))
    return new Response(null,{status:404});
  const bytes=readFileSync(join(assetDirectory,path));
  // Alternate range-aware and range-ignorant assets to exercise both stream paths.
  const range=/^bytes=(\d+)-(\d+)$/.exec(req.headers.get('range')??'');
  if(range&&path.includes('part-001')){
    const start=Number(range[1]),end=Number(range[2]);
    return new Response(bytes.subarray(start,end+1),{status:206});
  }
  return new Response(bytes);
};
const start = (modules, modulesRoot, target=persistence) => new Miniflare({
  ...convertV4MiniflareOptions({
    name: 'spool-interop',
    modules, modulesRoot,
    compatibilityDate: '2026-10-19',
    compatibilityFlags: ['nodejs_compat','global_fetch_strictly_public'],
    durableObjects: {
      WORKSPACE: {className: 'SpoolWorkspace', useSQLite: true},
      PROJECTS: {className: 'SpoolProject', useSQLite: true},
    },
    durableObjectsPersist: target,
    bindings: {BOOTSTRAP_TOKEN_HASH: bootstrapHash},
    serviceBindings: {DOWNLOADS:assetService},
  }),
  isolatedResourcePersistencePath: target,
  resourcePersistencePath: target,
});

let mf;
const call = async (path, auth, input, expected=200) => {
  const response = await mf.dispatchFetch(new URL(path, await mf.ready).href, {
    method: input ? 'POST' : 'GET',
    headers: {...(auth ? {authorization: auth} : {}), 'content-type': 'application/json'},
    ...(input ? {body: JSON.stringify(input)} : {}),
  });
  const body = await response.json();
  assert.equal(response.status, expected, JSON.stringify(body));
  return body;
};
try {
  execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js','deploy','--dry-run','--outdir',oldBundle], {
    env: {...process.env, WRANGLER_LOG_PATH: join(directory, 'wrangler.log')},
    stdio: 'pipe', timeout: 60_000,
  });
  const originalModules = [
    {type:'ESModule',path:join(oldBundle,'worker.js')},
    ...readdirSync(oldBundle).filter(name=>name.endsWith('.wasm')).map(name=>({type:'CompiledWasm',path:join(oldBundle,name)})),
  ];
  mf = start(originalModules, oldBundle);
  const setup = await call('/v1/setup', 'Bootstrap '+bootstrap, {name:'Rust relay compatibility fixture'});
  const invite = JSON.parse(Buffer.from(new URL(setup.link).pathname.slice(4), 'base64url')).code;
  const {connection: owner} = await call('/v1/workspace/enroll', 'Invite '+invite, {
    claim:randomBytes(32).toString('base64url'), device:'Fixture',
  });
  const ws = (input) => call('/v1/workspace/action', 'Workspace '+owner.token, input);
  const {project} = await ws({command:'create',name:'Fixture project',requestId:'create'});
  const {project: stale} = await ws({command:'create',name:'Stale index project',requestId:'stale-project'});
  const {connection: staleConnection} = await ws({command:'join',room:stale.room});
  const staleAuth = 'Bearer '+staleConnection.token;
  const stalePath = '/v1/rooms/'+stale.room+'/memory';
  const staleRecord = await call(stalePath,staleAuth,{command:'remember',kind:'finding',title:'Pending index',
    text:'Rust must replay this record from the existing Cloudflare history.',requestId:'leave-stale'});
  const legacyPage = {requestId:'original-capture',records:[{kind:'message',id:'original-local',role:'assistant',
    text:'Existing captured conversation',provenance:{sessionId:'old-session',itemId:'old-item',harness:'codex'}}]};
  const legacyReceipt = await call('/v1/rooms/'+stale.room+'/source',staleAuth,legacyPage);
  assert.equal(legacyReceipt.operations,1);
  const {project: untouched} = await ws({command:'create',name:'New project',requestId:'new-project'});
  const {connection: untouchedConnection} = await ws({command:'join',room:untouched.room});
  const {connection: projectConnection} = await ws({command:'join',room:project.room});
  await ws({command:'project-sharing',room:project.room,expectedRevision:0,sharing:{conversations:false}});
  const auth = 'Bearer '+projectConnection.token;
  const roomPath = '/v1/rooms/'+project.room;
  const saved = await call(roomPath+'/memory', auth, {
    command:'remember',kind:'finding',title:'Existing evidence',text:'Compatibility fixture from the original relay.',
    requestId:'legacy-finding',
  });
  const invitation = await ws({command:'invite-member',label:'Former member',role:'reader'});
  const memberInvite = JSON.parse(Buffer.from(new URL(invitation.link).pathname.slice(4), 'base64url')).code;
  const former = await call('/v1/workspace/enroll', 'Invite '+memberInvite, {
    claim:randomBytes(32).toString('base64url'), device:'Former member',
  });
  const {connection: retired} = await call('/v1/workspace/action', 'Workspace '+former.connection.token,
    {command:'join',room:project.room});
  await ws({command:'revoke-member',memberId:former.memberId});
  await call(roomPath+'/memory', auth, {
    command:'remember',kind:'finding',title:'Novější evidence',text:'Compatibility evidence from Wield.',
    requestId:'legacy-finding-2',
  });
  const searchInput = {command:'search',query:'please evidence',kinds:['finding'],limit:1,mode:'keyword'};
  const searchBefore = await call(roomPath+'/memory', auth, searchInput);
  assert.equal(searchBefore.results.length, 1);
  assert.equal(searchBefore.nextOffset, 1);
  const nextSearch = {...searchInput,offset:1};
  await call(roomPath+'/memory', auth, {command:'task_update',requestId:'task-start',taskId:'fixture-task',title:'Check evidence',text:'Verify the fixture.',expectedRevision:0,status:'in_progress'});
  const contextInput = {command:'context',query:'evidence',mode:'keyword'};
  const contextBefore = await call(roomPath+'/memory', auth, contextInput);
  assert.equal(contextBefore.tasks.length,1);
  const memoryBefore = await call(roomPath+'/memory', auth, {command:'get',id:saved.id});
  const searchFinal = await call(roomPath+'/memory', auth, searchInput);
  const nextFinal = await call(roomPath+'/memory', auth, nextSearch);
  const pending = await ws({command:'invite-member',label:'Pending enrollment',role:'reader'});
  const pendingCode = JSON.parse(Buffer.from(new URL(pending.link).pathname.slice(4),'base64url')).code;
  const workspaceBefore = await ws({command:'list'});
  const timelineInput={command:'timeline',limit:1};
  const timelineBefore=await call(roomPath+'/review',auth,timelineInput);
  const before = await call(roomPath+'/state', auth);
  await mf.dispose();
  mf = undefined;

  const entry = resolve(nativeEntry);
  const moduleDirectory = dirname(entry);
  const shim = basename(entry);
  const modules = [{type:'ESModule',path:entry}];
  for (const file of readdirSync(moduleDirectory, {recursive:true})) {
    if (file === shim) continue;
    if (file.endsWith('.wasm')) modules.push({type:'CompiledWasm',path:join(moduleDirectory,file)});
    if (/\.m?js$/.test(file)) modules.push({type:'ESModule',path:join(moduleDirectory,file)});
  }
  mf = start(modules, moduleDirectory);
  assert.deepEqual(await ws({command:'list'}),workspaceBefore);
  assert.equal((await ws({command:'join',room:project.room})).connection.token,projectConnection.token);
  const claim = randomBytes(32).toString('base64url');
  assert.equal((await call('/v1/workspace/preview','Invite '+pendingCode,{})).role,'reader');
  const joined = await call('/v1/workspace/enroll','Invite '+pendingCode,{claim,device:'Pending enrollment'});
  assert.deepEqual(await call('/v1/workspace/enroll','Invite '+pendingCode,{claim,device:'Pending enrollment'}),joined);
  assert.equal((await call('/v1/workspace/enroll','Invite '+pendingCode,
    {claim:randomBytes(32).toString('base64url'),device:'Another device'},409)).error.code,'INVITE_USED');
  const issued = await ws({command:'invite-project',room:project.room,label:'Rust invitation',role:'read'});
  const issuedCode = JSON.parse(Buffer.from(new URL(issued.link).pathname.slice(4),'base64url')).code;
  assert.equal((await call('/v1/invites/preview','Invite '+issuedCode,{})).room,project.room);
  const repo = {command:'repository-enroll',mode:'create',requestId:'rust-subproject',
    name:'Rust subproject',parentRoom:project.room,repositoryKey:'e'.repeat(64)};
  const linked = await ws(repo);
  assert.equal(linked.project.parentRoom,project.room);
  assert.deepEqual(await ws(repo),linked);
  const match = await ws({command:'repository-match',repositoryKey:repo.repositoryKey});
  assert.deepEqual(match.project,linked.project);
  const blockedDuplicate = await call('/v1/workspace/action','Workspace '+owner.token,{...repo,requestId:'duplicate-project'},409);
  assert.equal(blockedDuplicate.error.code,'REPOSITORY_EXISTS');
  const settings = await ws({command:'project-sharing',room:linked.project.room,sharing:{findings:false},expectedRevision:0});
  assert.equal(settings.sharing.findings,false);
  const nestedConnection = (await ws({command:'join',room:linked.project.room})).connection;
  const nestedAuth = 'Bearer '+nestedConnection.token;
  assert.equal((await call('/v1/rooms/'+linked.project.room+'/state',nestedAuth)).sharing.findings,false);
  assert.equal((await call('/v1/rooms/'+linked.project.room+'/memory',nestedAuth,
    {command:'remember',kind:'finding',title:'Private',text:'Should remain local.',requestId:'private'},403)).error.code,'SHARING_DISABLED');
  const download=async (path,options)=>mf.dispatchFetch(new URL(path,await mf.ready).href,options);
  const install=await download('/install.sh');
  assert.equal(install.status,200);
  const setupScript=await install.text();
  assert.match(setupScript,new RegExp(installerHash));
  const bootstrapPath=join(directory,'install.sh');
  writeFileSync(bootstrapPath,setupScript,{mode:0o700});
  const bootstrapProcess=Bun.spawn(['sh',bootstrapPath],{stdout:'pipe',stderr:'pipe'});
  const [code,stdout,stderr]=await Promise.all([bootstrapProcess.exited,
    new Response(bootstrapProcess.stdout).text(), new Response(bootstrapProcess.stderr).text()]);
  assert.equal(code,0,stderr);
  assert.match(stdout,/test installer/);
  const html=await download('/join#invite-secret');
  assert.match(await html.text(),/Install SpoolDB/);
  assert.equal(html.headers.get('referrer-policy'),'no-referrer');
  const link='/downloads/'+installerHash+'/spool-linux-x64.run';
  const whole=await download(link);
  assert.equal(whole.status,200);
  assert.deepEqual(Buffer.from(await whole.arrayBuffer()),installerBytes);
  assert.equal(whole.headers.get('content-length'),String(installerBytes.length));
  const part=await download(link,{headers:{range:'bytes=2-19'}});
  assert.equal(part.status,206);
  assert.deepEqual(Buffer.from(await part.arrayBuffer()),installerBytes.subarray(2,20));
  assert.equal(part.headers.get('content-range'),'bytes 2-19/'+installerBytes.length);
  const tail=await download(link,{headers:{range:'bytes=-5'}});
  assert.deepEqual(Buffer.from(await tail.arrayBuffer()),installerBytes.subarray(-5));
  assert.equal((await download(link,{method:'HEAD'})).headers.get('content-length'),String(installerBytes.length));
  assert.equal((await download(link,{headers:{'if-none-match':'"'+installerHash+'"'}})).status,304);
  assert.equal((await download(link,{headers:{range:'bytes=99999-'}})).status,416);
  assert.equal((await call('/healthz')).backend, 'cloudflare');
  const rebuilt = await call(stalePath,staleAuth,{command:'get',id:staleRecord.id});
  assert.equal(rebuilt.text,'Rust must replay this record from the existing Cloudflare history.');
  assert.deepEqual(await call('/v1/rooms/'+stale.room+'/source',staleAuth,legacyPage),legacyReceipt);
  assert.equal((await call('/v1/rooms/'+stale.room+'/source',staleAuth,
    {...legacyPage,records:[{...legacyPage.records[0],text:'Changed retry'}]},409)).error.code,'REQUEST_CONFLICT');
  const sourcePage = {requestId:'native-capture',records:[{kind:'message',id:'new-local',role:'assistant',
    text:'Rust imported this existing client capture.',provenance:{sessionId:'current-session',itemId:'current-item',harness:'codex',source:'transcript'}}]};
  const captureResult = await call('/v1/rooms/'+stale.room+'/source',staleAuth,sourcePage);
  assert.equal(captureResult.operations,1);
  assert.deepEqual(await call('/v1/rooms/'+stale.room+'/source',staleAuth,sourcePage),captureResult);
  const sourceSearch = await call(stalePath,staleAuth,{command:'search',query:'imported',kinds:['conversation'],mode:'keyword'});
  assert.equal(sourceSearch.results[0].source.messageId,'current-item');
  assert.equal(sourceSearch.results[0].source.originalSource,'transcript');
  assert.equal(rebuilt.source.harness,'spool-memory');
  const scope = {command:'delete-conversations',room:stale.room,sessionId:'current-session'};
  const preview = await ws(scope);
  assert.equal(preview.messages,1);
  const confirmed = {...scope,confirm:true,deletionToken:preview.deletionToken,requestId:'cloud-delete'};
  const deletion = await ws(confirmed);
  assert.equal(deletion.removed,1);
  assert.deepEqual(await ws(confirmed),deletion);
  assert.equal((await call(stalePath,staleAuth,{command:'get',id:staleRecord.id})).id,staleRecord.id);
  const replay = await call('/v1/rooms/'+stale.room+'/source',staleAuth,{...sourcePage,requestId:'replay-after-deletion'});
  assert.equal(replay.skipped,1);
  const empty = await call('/v1/rooms/'+untouched.room+'/state','Bearer '+untouchedConnection.token);
  assert.equal(empty.heads.length,1);
  const firstWrite = await call('/v1/rooms/'+untouched.room+'/memory','Bearer '+untouchedConnection.token,
    {command:'remember',kind:'finding',title:'First write',text:'Native initialization worked.',requestId:'first'});
  assert.equal(firstWrite.kind,'finding');
  assert.deepEqual(await call(roomPath+'/review',auth,timelineInput),timelineBefore);
  assert.equal((await call(roomPath+'/review',auth,{command:'publish'},403)).error.code,'GIT_ONLY');
  assert.deepEqual(await call(roomPath+'/state', auth), before);
  assert.deepEqual(await call(roomPath+'/memory', auth, contextInput), contextBefore);
  assert.deepEqual(await call(roomPath+'/memory', auth, searchInput), searchFinal);
  assert.deepEqual(await call(roomPath+'/memory', auth, nextSearch), nextFinal);
  assert.deepEqual(await call(roomPath+'/memory', auth, {command:'get',id:saved.id}), memoryBefore);
  assert.equal((await call(roomPath+'/memory', auth, {command:'get',id:'missing'}, 404)).error.code, 'MEMORY_NOT_FOUND');
  assert.equal((await call(roomPath+'/state', 'Bearer '+randomBytes(32).toString('base64url'), undefined, 401)).error.code, 'UNAUTHORIZED');
  assert.equal((await call(roomPath+'/state', 'Bearer '+retired.token, undefined, 401)).error.code, 'UNAUTHORIZED');
  assert.equal((await call(roomPath+'/push', auth, {}, 403)).error.code, 'GIT_ONLY');
  const save = body => call(roomPath+'/memory',auth,body);
  const update = {command:'task_update',requestId:'rust-task',taskId:'fixture-task',title:'Check evidence',
    text:'Rust preserved the existing finding.',status:'done',expectedRevision:1};
  const updated = await save(update);
  assert.equal(updated.revision,2);
  assert.deepEqual(await save(update),updated);
  assert.equal((await call(roomPath+'/memory',auth,{...update,text:'Changed retry'},409)).error.code,'REQUEST_CONFLICT');
  const handoff = {command:'handoff',requestId:'rust-handoff',taskId:'fixture-task',title:'Follow up',
    text:'Verify the existing relay reads the Rust write.',refs:[saved.id],nextSteps:['Switch to the original relay']};
  const first = await save(handoff);
  assert.equal((await save({...handoff,requestId:'rust-handoff-repeat'})).id,first.id);
  const improved = await save({...handoff,requestId:'rust-handoff-new',text:'The compatibility test passed.'});
  assert.notEqual(improved.id, first.id);
  assert.equal((await save({command:'get',id:first.id})).lifecycle.replacementId,improved.id);
  const consumer = new ShardedEngine();
  try {
    const client = new SyncClient(consumer,{url:(await mf.ready).href,token:projectConnection.token,room:project.room,retries:0});
    assert((await client.sync({mode:'pull'})).pullPages > 0);
    const exported = consumer.read('main');
    assert.equal(JSON.parse(exported.messages[saved.id].text).title,'Existing evidence');
    assert.equal(JSON.parse(exported.messages[improved.id].text).text,'The compatibility test passed.');
    assert.equal((await client.sync({mode:'pull'})).pullPages,0);
  } finally {
    consumer.close();
  }
  const frontier = await call(roomPath+'/state',auth);
  assert.deepEqual(frontier.heads, improved.heads);
  await mf.dispose();
  mf = start(originalModules,oldBundle);
  assert.deepEqual(await call(roomPath+'/state',auth),frontier);
  assert.deepEqual((await ws({command:'repository-match',repositoryKey:repo.repositoryKey})).project,linked.project);
  const redeemed = await call('/v1/invites/redeem','Invite '+issuedCode,
    {claim:randomBytes(32).toString('base64url'),device:'Original client'});
  assert.equal(redeemed.connection.room,project.room);
  assert.equal((await call(stalePath,staleAuth,{command:'search',query:'imported',kinds:['conversation'],mode:'keyword'})).results.length,0);
  assert.deepEqual(await ws(confirmed),deletion);
  const restored = await save({command:'get',id:improved.id});
  assert.equal(restored.text,'The compatibility test passed.');
  assert.equal(restored.source.harness,'spool-memory');
  assert.equal((await save({command:'get',id:first.id})).lifecycle.status,'superseded');
  const pulled = await call(roomPath+'/pull',auth,{since:before.heads});
  assert.deepEqual(pulled.bundle.heads,improved.heads);
  assert(pulled.bundle.documents.some(doc=>doc.key==='m:'+improved.id));
  assert.equal((await save({command:'context',taskId:'fixture-task'})).tasks[0].revision,2);

  await mf.dispose();
  mf = start(modules,moduleDirectory,join(directory,'fresh'));
  await call('/v1/setup','Bootstrap invalid',{name:'Wrong'},401);
  const fresh = await call('/v1/setup','Bootstrap '+bootstrap,{name:'New workspace'});
  const freshCode = JSON.parse(Buffer.from(new URL(fresh.link).pathname.slice(4),'base64url')).code;
  const enrolled = await call('/v1/workspace/enroll','Invite '+freshCode,
    {claim:randomBytes(32).toString('base64url'),device:'Fresh owner'});
  assert.equal(enrolled.workspace.name,'New workspace');
  const freshAuth = 'Workspace '+enrolled.connection.token;
  const created = await call('/v1/workspace/action',freshAuth,{command:'create',name:'New project',requestId:'first'});
  const connected = await call('/v1/workspace/action',freshAuth,{command:'join',room:created.project.room});
  assert.equal((await call('/v1/rooms/'+created.project.room+'/state','Bearer '+connected.connection.token)).heads.length,1);
  assert.equal((await call('/v1/setup','Bootstrap '+bootstrap,{name:'Existing'})).alreadyConfigured,true);

  const aiDirectory=join(directory,'test-ai');
  mkdirSync(aiDirectory);
  copyFileSync(join(moduleDirectory,'index.js'),join(aiDirectory,'index.js'));
  copyFileSync(join(moduleDirectory,'index_bg.wasm'),join(aiDirectory,'index_bg.wasm'));
  const aiEntrypoint=join(aiDirectory,'fixture.js');
  writeFileSync(aiEntrypoint,`
    import {DurableObject} from 'cloudflare:workers';
    import Worker, {SpoolWorkspace, SpoolProject as RustProject} from './index.js';
    export {SpoolWorkspace};
    export default Worker;
    class Ai {
      async run(_model,{text}) {
        return {data:text.map(value=>/heavens|blue/i.test(value)?[0,1]:[1,0])};
      }
    }
    export class SpoolProject extends DurableObject {
      constructor(ctx,env) {super(ctx,env);this.inner=new RustProject(ctx,{...env,AI:new Ai()});}
      fetch(request) {return this.inner.fetch(request);}
    }
  `);
  await mf.dispose();
  mf=start([{type:'ESModule',path:aiEntrypoint},{type:'ESModule',path:join(aiDirectory,'index.js')},
     {type:'CompiledWasm',path:join(aiDirectory,'index_bg.wasm')}],aiDirectory,join(directory,'fresh'));
  const semanticPath='/v1/rooms/'+created.project.room+'/memory', semanticAuth='Bearer '+connected.connection.token;
  const interesting=await call(semanticPath,semanticAuth,{command:'remember',kind:'finding',title:'Atmospheric observation',
    text:'Blue is the answer.',requestId:'semantic-relevant'});
  await call(semanticPath,semanticAuth,{command:'remember',kind:'finding',title:'Pasta',
    text:'Dinner takes ten minutes.',requestId:'semantic-irrelevant'});
  const semanticQuery={command:'search',query:'color of heavens',kinds:['finding']};
  assert.equal((await call(semanticPath,semanticAuth,{...semanticQuery,mode:'keyword'})).results.length,0);
  let searchResult;
  for(let attempt=0;attempt<10;attempt++){
    searchResult=await call(semanticPath,semanticAuth,semanticQuery);
    if(searchResult.retrieval.semanticStatus==='ready')break;
    await Bun.sleep(25);
  }
  assert.equal(searchResult.retrieval.mode,'hybrid');
  assert.equal(searchResult.retrieval.semanticStatus,'ready');
  assert.deepEqual(searchResult.results.map(record=>record.id),[interesting.id]);
  await call(semanticPath,semanticAuth,{command:'remember',kind:'decision',title:'Archive outdated observation',
    text:'Replaced by current evidence.',requestId:'semantic-archive',lifecycle:{id:interesting.id,action:'archive',expectedRevision:0}});
  assert.equal((await call(semanticPath,semanticAuth,semanticQuery)).results.length,0);

} finally {
  await mf?.dispose();
  rmSync(directory, {recursive:true,force:true});
}
