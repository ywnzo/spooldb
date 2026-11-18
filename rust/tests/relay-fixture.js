import {Database} from 'bun:sqlite';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {unlinkSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import release from '../../package.json';
import {ShardedEngine} from '../../src/index.js';
import {SyncClient} from '../../src/relay/client.js';

const [binary, database, config] = process.argv.slice(2);
const room = 'rust-relay-fixture';
const issued = Bun.spawnSync([binary, 'credential', 'writer', room]);
assert.equal(issued.exitCode,0,issued.stderr.toString());
const {token,credential} = JSON.parse(issued.stdout);
assert.match(token,/^[-A-Za-z0-9_]{43}$/);
assert.equal(credential.tokenHash,createHash('sha256').update(token).digest('hex'));
const readToken = 'r'.repeat(32);
const credentials = [credential,{
  id: 'reader',
  tokenHash: createHash('sha256').update(readToken).digest('hex'),
  rooms: {[room]:'read'},
}];
writeFileSync(config, JSON.stringify({credentials}), {mode: 0o600});
const writer = new ShardedEngine();
const reader = new ShardedEngine();
const relay = Bun.spawn([binary, 'relay', database, config, '127.0.0.1:0'], {
  stdout: 'pipe', stderr: 'inherit',
});
try {
  const {value} = await relay.stdout.getReader().read();
  const address = new TextDecoder().decode(value).trim();
  assert.match(address, /^127\.0\.0\.1:[0-9]+$/);
  const url = 'http://'+address;
  const create = (engine, token) => new SyncClient(engine, {url, token, room, retries: 0});
  const write = create(writer, token);
  const read = create(reader, readToken);
  const response = await fetch(url+'/healthz');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true, protocol: 'spool-relay/1', version: release.version, updating: false,
  });
  const gate = join(dirname(database), '.spool-update-gate');
  writeFileSync(gate, '1', {flag: 'wx'});
  try {
    assert.equal((await (await fetch(url+'/healthz')).json()).updating, true);
    const blocked = await fetch(url+'/v1/rooms/'+room+'/state', {
      headers: {authorization: 'Bearer '+token},
    });
    assert.equal(blocked.status, 503);
    assert.equal(blocked.headers.get('retry-after'), '30');
    assert.equal((await blocked.json()).error.code, 'UPDATING');
  } finally {
    unlinkSync(gate);
  }
  const unauthorized = await fetch(url+'/v1/rooms/'+room+'/state');
  assert.equal(unauthorized.status, 401);
  const forbidden = await fetch(url+'/v1/rooms/other/state', {headers: {authorization: 'Bearer '+token}});
  assert.equal(forbidden.status, 403);

  let {heads} = writer.create('main', {room});
  ({heads} = writer.submit('main',{actor:'fixture',requestId:'create-file',expectedHeads:heads,
    operations:[{type:'file.create',fileId:'sample',path:'sample.txt',text:'old\nkeep'}]}));
  const originalFile=heads;
  ({heads} = writer.submit('main',{actor:'fixture',requestId:'update-file',expectedHeads:heads,
    operations:[{type:'file.splice',fileId:'sample',index:0,deleteCount:3,insert:'new'},
      {type:'comment.add',commentId:'comment',fileId:'sample',start:0,end:3,text:'Review this change'}]}));
  for (let n=0; n<35; n++) {
    ({heads} = writer.submit('main', {
      expectedHeads: heads, actor: 'fixture', requestId: 'add-'+n,
      operations: [{type: 'message.add', messageId: 'message-'+n, role: 'assistant', text: 'Evidence '+n}],
    }));
  }
  await assert.rejects(create(writer, readToken).sync({mode: 'push'}), {code: 'FORBIDDEN'});
  const pushed = await write.sync({mode: 'push'});
  assert.equal(pushed.pushPages, 2);
  const pulled = await read.sync({mode: 'pull'});
  assert.equal(pulled.pullPages, 2);
  assert.deepEqual(reader.ref('main').heads, writer.ref('main').heads);
  assert.equal(reader.read('main').messages['message-34'].text, 'Evidence 34');
  assert.equal((await read.sync({mode: 'pull'})).pullPages, 0);
  const backup = database+'.backup';
  const saved = Bun.spawnSync([binary,'backup',database,backup]);
  assert.equal(saved.exitCode,0,saved.stderr.toString());
  assert.deepEqual(JSON.parse(saved.stdout).heads,[{branch:'relay-'+room,room,heads}]);
  const copy = new ShardedEngine(backup);
  try {
    assert.equal(copy.read('relay-'+room).messages['message-34'].text,'Evidence 34');
  } finally {
    copy.close();
  }
  assert.notEqual(Bun.spawnSync([binary,'backup',database,backup]).exitCode,0);


  const apiMetrics = {requests:0,retries:0,uploadedBytes:0,downloadedBytes:0};
  const record = await read.request('memory', {command:'get',id:'message-34',offset:1,limit:4}, undefined, apiMetrics);
  assert.equal(record.text, 'vide');
  assert.equal(record.nextOffset, 5);
  assert.equal(record.kind, 'conversation');
  assert.equal(record.lifecycle.status, 'active');
  assert.equal(record.source.actor, 'fixture');
  assert.equal(record.sourcePrefix, '@machines/reader/');
  await assert.rejects(read.request('memory', {command:'get',id:'missing'}, undefined, apiMetrics), {code:'MEMORY_NOT_FOUND'});

  const css = await fetch(url+'/review/style.css');
  assert.match(css.headers.get('content-type'),/^text\/css/);
  assert.equal((await fetch(url+'/review/',{method:'HEAD'})).status,200);
  assert.match((await fetch(url+'/review/')).headers.get('content-security-policy'),/frame-ancestors 'none'/);
  const review = (request, client=read) => client.request('review',request,undefined,apiMetrics);
  await assert.rejects(review({command:'publish',name:'review',heads:originalFile,expectedRevision:0,requestId:'base'}),{code:'FORBIDDEN'});
  const published = await review({command:'publish',name:'review',heads:originalFile,expectedRevision:0,requestId:'base'},write);
  assert.equal(published.revision,1);
  assert.deepEqual(await review({command:'publish',name:'review',heads:originalFile,expectedRevision:0,requestId:'base'},write),published);
  assert.equal((await review({command:'branches'})).branches[1].name,'review');
  assert.equal((await review({command:'files',compare:'review'})).files[0].status,'modified');
  const diff = await review({command:'diff',fileId:'sample',compare:'review'});
  assert.equal(diff.added,1);
  assert.equal(diff.removed,1);
  assert.equal(diff.comments[0].resolved.text,'new');
  assert.equal((await review({command:'file',fileId:'sample'})).file.text,'new\nkeep');
  assert.equal((await review({command:'message',messageId:'message-34'})).message.text,'Evidence 34');
  assert.equal((await review({command:'timeline',limit:1})).entries[0].messages[0].id,'message-34');
  const search = {command:'search',query:'please evidence',kinds:['conversation'],limit:2,mode:'keyword'};
  const hits = await read.request('memory', search, undefined, apiMetrics);
  assert.deepEqual(hits.results.map(item=>item.id), ['message-34','message-33']);
  assert.equal(hits.nextOffset, 2);
  const next = await read.request('memory', {...search,offset:2}, undefined, apiMetrics);
  assert.equal(next.results[0].id, 'message-32');

  const context = await read.request('memory', {command:'context',query:'evidence',mode:'keyword'}, undefined, apiMetrics);
  assert.equal(context.relatedConversations.length, 5);
  assert.equal(context.notes.length, 0);
  assert.equal(context.memoryLifecycle, 1);

  const save = input => write.request('memory', input, undefined, apiMetrics);
  const lookup = id => read.request('memory', {command:'get',id}, undefined, apiMetrics);
  const task = {command:'task_update',requestId:'task-start',taskId:'repair',title:'Repair',
    text:'Investigate compatibility',status:'in_progress',expectedRevision:0,sessionId:'fixture'};
  await assert.rejects(read.request('memory', task, undefined, apiMetrics), {code:'FORBIDDEN'});
  const created = await save(task);
  assert.equal(created.revision,1);
  assert.deepEqual(await save(task),created);
  await assert.rejects(save({...task,text:'different request'}),{code:'REQUEST_CONFLICT'});
  await assert.rejects(save({...task,requestId:'stale-task'}),{code:'TASK_CONFLICT'});
  const noChange = await save({...task,requestId:'repeat-task',expectedRevision:1});
  assert.equal(noChange.unchanged,true);
  assert.equal(noChange.id,created.id);
  const finding = {command:'remember',kind:'finding',requestId:'finding',taskId:'repair',
    sessionId:'fixture',title:'Verified behavior',text:'Original client supports the Rust relay.'};
  const found = await save(finding);
  assert.equal((await save({...finding,requestId:'repeat-finding'})).id,found.id);
  const handoff = {command:'handoff',requestId:'handoff',taskId:'repair',sessionId:'fixture',
    title:'Resume verification',text:'The original client can read native writes.',refs:[found.id],
    nextSteps:['Verify relay restart'],blockers:[]};
  const first = await save(handoff);
  assert.equal((await save({...handoff,requestId:'duplicate-handoff'})).id,first.id);
  await assert.rejects(save({...handoff,requestId:'oversized',text:'a'.repeat(1501)}),{code:'HANDOFF_TOO_LONG'});
  const later = await save({...handoff,requestId:'changed-handoff',text:'Relay restart passed.'});
  assert.notEqual(later.id,first.id);
  assert.equal((await lookup(first.id)).lifecycle.status,'superseded');
  assert.equal((await lookup(first.id)).lifecycle.replacementId,later.id);
  const authored = await save({...handoff,requestId:'automatic',title:'Automatic Codex checkpoint',text:'No changes.'});
  assert.equal(authored.id,later.id);
  const archived = await save({command:'remember',kind:'decision',requestId:'archive-finding',title:'Archive',
    text:'Historical only',lifecycle:{id:found.id,action:'archive',expectedRevision:0}});
  assert.equal((await lookup(found.id)).lifecycle.sourceId,archived.id);
  const received = await read.sync({mode:'pull'});
  assert(received.pullPages > 0);
  const oldState = reader.read('main');
  assert.equal(JSON.parse(oldState.messages[later.id].text).text,'Relay restart passed.');
  assert.equal(JSON.parse(oldState.messages[archived.id].text).lifecycleChanges[0].targetId,found.id);

  const nativeLocal = database+'.client';
  const nativeSync = (access,mode) => {
    const process = Bun.spawnSync([binary,'sync',nativeLocal,'main',mode],{
      stdin: Buffer.from(JSON.stringify({url,room,token:access})),
    });
    assert.equal(process.exitCode,0,process.stderr.toString());
    return JSON.parse(process.stdout);
  };
  const nativePull = nativeSync(readToken,'pull');
  assert.ok(nativePull.pullPages>=2);
  assert.deepEqual(nativePull.heads,reader.ref('main').heads);
  const clientDb = new ShardedEngine(nativeLocal);
  try {
    assert.equal((await create(clientDb,readToken).sync({mode:'pull'})).pullPages,0);
    const appended = clientDb.submit('main',{
      expectedHeads:nativePull.heads,actor:'fixture',requestId:'native-client',
      operations:[{type:'message.add',messageId:'native-client',role:'assistant',text:'Native upload.'}],
    });
    assert.equal(nativeSync(token,'push').pushPages,1);
    assert.equal(nativeSync(token,'both').pushPages,0);
    assert.deepEqual((await read.sync({mode:'pull'})).heads,appended.heads);
  } finally {
    clientDb.close();
  }


  const policyDb = new Database(database);
  try {
    policyDb.exec(
      'CREATE TABLE IF NOT EXISTS workspace_sharing(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL,data TEXT NOT NULL);'+
      'CREATE TABLE IF NOT EXISTS project_sharing(room TEXT PRIMARY KEY,revision INTEGER NOT NULL,data TEXT NOT NULL);',
    );
    policyDb.prepare('INSERT INTO workspace_sharing VALUES(1,1,?)').run(JSON.stringify({conversations:false}));
    policyDb.prepare('INSERT INTO project_sharing VALUES(?,1,?)').run(room,JSON.stringify({handoffs:false}));
  } finally {
    policyDb.close();
  }
  await assert.rejects(save({...handoff,requestId:'sharing-blocked'}),{code:'SHARING_DISABLED'});
  assert.equal((await lookup(later.id)).text,'Relay restart passed.');
  const policyState = await read.request('state',undefined,undefined,apiMetrics);
  assert.equal(policyState.sharing.handoffs,false);
  assert.equal(policyState.sharing.conversations,false);
  assert.equal(policyState.sharingRevision,1);

  const semanticDb = new Database(database);
  const model = '@cf/baai/bge-m3';
  const modelId = 'workers-ai:'+model+':dense:v1';
  const semanticQuery = 'entirely unrelated words';
  const queryHash = createHash('sha256').update(semanticQuery).digest('hex');
  const vector = Buffer.alloc(4096);
  vector.writeFloatLE(1);
  try {
    semanticDb.exec(`CREATE TABLE retrieval_settings(id INTEGER PRIMARY KEY,revision INTEGER,data TEXT);
      CREATE TABLE retrieval_credentials(id INTEGER PRIMARY KEY,account TEXT,token TEXT);
      CREATE TABLE IF NOT EXISTS retrieval_usage_limits(id INTEGER PRIMARY KEY,revision INTEGER,data TEXT);
      CREATE TABLE IF NOT EXISTS memory_vectors(room TEXT,id TEXT,model TEXT,fingerprint TEXT,chunk INTEGER,vector BLOB,
        PRIMARY KEY(room,id,model,chunk));
      CREATE TABLE native_embedding_queries(provider TEXT,query_hash TEXT,vector BLOB,updated INTEGER,
        PRIMARY KEY(provider,query_hash));`);
    const accountId = 'a'.repeat(32);
    semanticDb.prepare('INSERT INTO retrieval_settings VALUES(1,1,?)')
      .run(JSON.stringify({enabled:true,provider:'cloudflare',model,accountId}));
    semanticDb.prepare('INSERT INTO retrieval_credentials VALUES(1,?,?)').run(accountId,'b'.repeat(24));
    semanticDb.prepare('INSERT INTO retrieval_usage_limits VALUES(1,1,?)').run(JSON.stringify({dailyCharacters:1}));
    semanticDb.prepare('INSERT INTO native_embedding_queries VALUES(?,?,?,unixepoch())').run(modelId,queryHash,vector);
    semanticDb.prepare('INSERT INTO memory_vectors SELECT room,id,?,fingerprint,0,? FROM memory_docs WHERE room=? AND id IN (?,?)')
      .run(modelId,vector,room,later.id,found.id);
  } finally {
    semanticDb.close();
  }
  const hybrid = await read.request('memory',{command:'search',query:semanticQuery,kinds:['finding','handoff']},undefined,apiMetrics);
  assert.equal(hybrid.retrieval.mode,'hybrid');
  assert.deepEqual(hybrid.results.map(record=>record.id),[later.id]);
  const keyword = await read.request('memory',{command:'search',query:semanticQuery,mode:'keyword'},undefined,apiMetrics);
  assert.deepEqual(keyword.results,[]);
  const capped = await read.request('memory',{command:'search',query:'another uncached query'},undefined,apiMetrics);
  assert.equal(capped.retrieval.semanticStatus,'budget_exceeded');
  writeFileSync(config, JSON.stringify({credentials: [credentials[0]]}));
  await assert.rejects(read.sync({mode: 'pull'}), {code: 'UNAUTHORIZED'});
} finally {
  relay.kill();
  await relay.exited;
  writer.close();
  reader.close();
}
