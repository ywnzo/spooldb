import assert from 'node:assert/strict';
import {join} from 'node:path';
import {mkdirSync,readFileSync,readlinkSync,renameSync,symlinkSync,writeFileSync} from 'node:fs';
import {Bridge} from '../../src/bridge.js';
import {AdapterIngress} from '../../src/adapters/ingress.js';
import {Engine,ShardedEngine} from '../../src/index.js';

const [binary,directory]=process.argv.slice(2);
const database=join(directory,'legacy-shards.sqlite'),copy=join(directory,'import.sqlite');
const commands=(requests,path=database,flags=[])=>{
  const input=requests.map((request,id)=>JSON.stringify({id,...request})).join('\n')+'\n';
  const response=Bun.spawnSync([binary,'storage',path,...flags],{stdin:Buffer.from(input)});
  assert.equal(response.exitCode,0,response.stderr.toString());
  return response.stdout.toString().trim().split('\n').map((line,id)=>{
    const result=JSON.parse(line);
    assert.equal(result.id,id);
    assert.equal(result.ok,true,result.error);
    return result.result;
  });
};
const engine=new ShardedEngine(database);
const genesis=engine.create('main',{room:'shared'});
const submit=(branch,requestId,operations)=>engine.submit(branch,{
  actor:'fixture',requestId,expectedHeads:engine.ref(branch).heads,operations,
});
const base=submit('main','initial',[
  {type:'file.create',fileId:'test-file',path:'file.txt',text:'Original 🧪'},
  {type:'message.add',messageId:'one',role:'assistant',text:'First record'},
  {type:'message.add',messageId:'two',role:'user',text:'Second record'},
]);
const [forked]=commands([{command:'fork',source:'main',target:'feature',heads:base.heads}]);
assert.deepEqual(forked,{branch:'feature',room:'shared',heads:base.heads});
submit('main','rename-left',[{type:'file.rename',fileId:'test-file',path:'left.txt'}]);
submit('feature','rename-right',[{type:'file.rename',fileId:'test-file',path:'right.txt'}]);
const [merged]=commands([{command:'merge',target:'main',source:'feature'}]);
assert.deepEqual(merged.heads,engine.ref('main').heads);
const [refs,files,records,history,before,after,file,bundle,trace]=commands([
  {command:'refs'},
  {command:'files.list',branch:'main',options:{limit:1}},
  {command:'records.read',branch:'main',options:{limit:1}},
  {command:'history',branch:'main',options:{after:1,limit:2}},
  {command:'read',branch:'main',heads:genesis.heads},
  {command:'read',branch:'main'},
  {command:'file.read',branch:'main',fileId:'test-file'},
  {command:'export',branch:'main'},
  {command:'trace',branch:'main',fileId:'test-file'},
]);
assert.deepEqual(refs,engine.refs());
assert.deepEqual(files,engine.listFiles('main',{limit:1}));
assert.deepEqual(records,engine.readRecords('main',{limit:1}));
assert.deepEqual(history,engine.history('main',{after:1,limit:2}));
assert.deepEqual(before,engine.read('main',genesis.heads));
assert.deepEqual(after,engine.read('main'));
assert.deepEqual(file,engine.readFile('main','test-file'));
assert.deepEqual(bundle,engine.export('main'));
assert.deepEqual(trace,engine.trace('main','test-file'));
const [anchor]=commands([{command:'anchor',branch:'main',fileId:'test-file',start:9,end:11}]);
assert.deepEqual(anchor,engine.anchor('main','test-file',9,11));
const [resolved]=commands([{command:'resolve',branch:'main',anchor}]);
assert.deepEqual(resolved,engine.resolve('main',anchor));
assert.equal(resolved.text,'🧪');
engine.close();

const [imported,restored]=commands([
  {command:'import',branch:'restored',bundle},
  {command:'read',branch:'restored'},
],copy);
assert.deepEqual(imported.heads,merged.heads);
assert.deepEqual(restored,after);
const reopened=new ShardedEngine(copy);
assert.deepEqual(reopened.read('restored'),after);
reopened.close();

const editing=new ShardedEngine(database);
const nativeInput={
  actor:'native',requestId:'mixed-batch',expectedHeads:editing.ref('main').heads,sessionId:'session',
  operations:[
    {type:'file.create',fileId:'new-file',path:'new.txt',text:'A 🧪'},
    {type:'file.splice',fileId:'new-file',index:2,deleteCount:0,insert:'big '},
    {type:'comment.add',commentId:'annotation',fileId:'new-file',start:6,end:8,text:'Keep this'},
    {type:'file.rename',fileId:'new-file',path:'renamed.txt'},
    {type:'message.add',messageId:'native-record',role:'assistant',text:'Mixed batch evidence'},
    {type:'file.create',fileId:'binary',path:'asset.bin',kind:'binary',data:'AP8='},
    {type:'file.write',fileId:'binary',kind:'symlink',target:'renamed.txt'},
    {type:'file.delete',fileId:'binary'},
    {type:'file.restore',fileId:'binary'},
  ],
};
const [written]=commands([{command:'submit',branch:'main',input:nativeInput}]);
assert.deepEqual(commands([{command:'submit',branch:'main',input:nativeInput}]),[written]);
assert.deepEqual(editing.submit('main',nativeInput),written);
const writtenState=editing.read('main');
assert.equal(writtenState.files.find(file=>file.fileId==='new-file').text,'A big 🧪');
assert.equal(writtenState.files.find(file=>file.fileId==='new-file').path,'renamed.txt');
assert.equal(writtenState.files.find(file=>file.fileId==='binary').kind,'symlink');
assert.equal(writtenState.comments.annotation.text,'Keep this');
assert.equal(writtenState.messages['native-record'].text,'Mixed batch evidence');
assert.equal(editing.resolve('main',writtenState.comments.annotation).text,'🧪');
assert.equal(editing.trace('main','new-file').at(-1).messages[0].messageId,'native-record');
assert.deepEqual(commands([{command:'read',branch:'main'}]),[writtenState]);
const abortInput={
  actor:'native',requestId:'failed-batch',expectedHeads:written.heads,
  operations:[
    {type:'message.add',messageId:'rolled-back',role:'assistant',text:'Uncommitted work'},
    {type:'file.create',fileId:'unsafe',path:'../bad',text:'Rejected path'},
  ],
};
const failure=Bun.spawnSync([binary,'storage',database],{
  stdin:Buffer.from(JSON.stringify({id:1,command:'submit',branch:'main',input:abortInput})+'\n'),
});
assert.equal(failure.exitCode,0);
assert.equal(JSON.parse(failure.stdout.toString()).ok,false);
assert.deepEqual(editing.read('main'),writtenState);
const bothWays=new ShardedEngine(copy);
bothWays.import('restored',editing.export('main',merged.heads));
assert.deepEqual(bothWays.read('restored'),writtenState);
bothWays.close();
editing.close();

const beforeCompact=new ShardedEngine(database);
const checkpointed=commands([
  {command:'storage.checkpoint',branch:'main',options:{fileId:'new-file'}},
  {command:'storage.stats'},
]);
assert.equal(checkpointed[0].documents,1);
assert.ok(checkpointed[0].bytes>0);
assert.equal(checkpointed[1].checkpoints,beforeCompact.storageStats().checkpoints);
beforeCompact.db.prepare("INSERT INTO shard_nodes(hash,body) VALUES('unused','{}')").run();
const compressed=beforeCompact.db.prepare("SELECT typeof(input) AS type FROM shard_receipts WHERE request_id='mixed-batch'").get();
assert.equal(compressed.type,'blob');
beforeCompact.close();
const [compacted,afterCompact]=commands([
  {command:'storage.compact'},
  {command:'read',branch:'main'},
]);
assert.ok(compacted.removedNodes>=1);
assert.deepEqual(afterCompact,writtenState);
const afterRestart=new ShardedEngine(database);
assert.deepEqual(afterRestart.read('main'),writtenState);
assert.deepEqual(afterRestart.submit('main',nativeInput),written);
assert.deepEqual(afterRestart.read('main',genesis.heads),before);
afterRestart.close();

const legacyPath=join(directory,'legacy.sqlite');
const legacyCopy=join(directory,'legacy-import.sqlite');
const legacy=new Engine(legacyPath);
const legacyInitial=legacy.create('main');
const legacyOldInput={
  actor:'old',requestId:'old-format',expectedHeads:legacyInitial.heads,
  operations:[
    {type:'file.create',fileId:'original',path:'original.txt',text:'old 🧪'},
    {type:'message.add',messageId:'initial-message',role:'user',text:'Original memory'},
  ],
};
const legacyFirst=legacy.submit('main',legacyOldInput);
const [legacyRefs,legacyRead,legacyRetry]=commands([
  {command:'refs'},
  {command:'read'},
  {command:'submit',input:legacyOldInput},
],legacyPath);
assert.deepEqual(legacyRefs,legacy.refs());
assert.deepEqual(legacyRead,legacy.read('main'));
assert.deepEqual(legacyRetry,legacyFirst);
const [branch]=commands([{command:'fork',source:'main',target:'feature'}],legacyPath);
const legacyNewInput={
  actor:'new',requestId:'new-format',expectedHeads:branch.heads,
  operations:[
    {type:'file.write',fileId:'original',text:'new 🧪'},
    {type:'comment.add',commentId:'legacy-comment',fileId:'original',start:4,end:6,text:'Save this range'},
    {type:'message.add',messageId:'linked',role:'assistant',text:'Verified with Rust'},
  ],
};
const [legacyWritten]=commands([{command:'submit',branch:'feature',input:legacyNewInput}],legacyPath);
assert.deepEqual(legacy.submit('feature',legacyNewInput),legacyWritten);
commands([{command:'merge',target:'main',source:'feature'}],legacyPath);
const [postMerge,legacyHistory,legacyTrace,legacyAnchor,legacyBundle]=commands([
  {command:'read'},
  {command:'history'},
  {command:'trace',fileId:'original'},
  {command:'anchor',fileId:'original',start:4,end:6},
  {command:'export'},
],legacyPath);
assert.deepEqual(postMerge,legacy.read('main'));
assert.deepEqual(legacyHistory,legacy.history('main'));
assert.deepEqual(legacyTrace,legacy.trace('main','original'));
assert.deepEqual(legacyAnchor,legacy.anchor('main','original',4,6));
assert.deepEqual(commands([{command:'resolve',anchor:legacyAnchor}],legacyPath),[legacy.resolve('main',legacyAnchor)]);
assert.deepEqual(legacyBundle,legacy.export('main'));
legacy.close();
commands([{command:'import',branch:'imported',bundle:legacyBundle}],legacyCopy,['--legacy']);
const legacyReopened=new Engine(legacyCopy);
assert.deepEqual(legacyReopened.read('imported'),postMerge);
legacyReopened.close();

const bridgePath=join(directory,'bridge.sqlite');
const checkout=join(directory,'checkout');
mkdirSync(checkout);
const git=(...args)=>{
  const result=Bun.spawnSync(['git','-C',checkout,...args]);
  assert.equal(result.exitCode,0,result.stderr.toString());
};
git('init','-q');
writeFileSync(join(checkout,'document.txt'),'Capture this');
writeFileSync(join(checkout,'.env'),'IGNORED=example');
writeFileSync(join(checkout,'asset.bin'),Buffer.from([0,255]));
symlinkSync('document.txt',join(checkout,'link'));
const bridgeEngine=new Engine(bridgePath);
const bridge=new Bridge(bridgeEngine);
const attached=bridge.attach('main',checkout);
const [noEdits,sources]=commands([
  {command:'git.capture',root:checkout},
  {command:'git.sources'},
],bridgePath);
assert.equal(noEdits.operations,0);
assert.equal(noEdits.diskBranch,attached.diskBranch);
assert.deepEqual(sources,JSON.parse(JSON.stringify(bridge.sources())));
const initialFile=bridgeEngine.read('main').files.find(file=>file.path==='document.txt');
renameSync(join(checkout,'document.txt'),join(checkout,'renamed.txt'));
writeFileSync(join(checkout,'asset.bin'),Buffer.from([0,255,23]));
const [captured]=commands([{command:'git.capture',root:checkout}],bridgePath);
assert.equal(captured.operations,2);
assert.deepEqual(captured.excluded,[{path:'.env',reason:'local-state-or-secret-pattern'}]);
const changed=bridgeEngine.read('main');
assert.equal(changed.files.find(file=>file.path==='renamed.txt').fileId,initialFile.fileId);
assert.equal(bridge.capture(checkout).operations,0);
assert.equal(changed.files.find(file=>file.path==='asset.bin').data,'AP8X');
assert.equal(changed.files.find(file=>file.path==='link').target,'document.txt');
bridgeEngine.close();

const nativeBridgePath=join(directory,'native-bridge.sqlite');
const [nativeAttached]=commands([{command:'git.attach',root:checkout}],nativeBridgePath);
assert.equal(nativeAttached.files,3);
const nativeBridgeEngine=new ShardedEngine(nativeBridgePath);
assert.equal(new Bridge(nativeBridgeEngine).capture(checkout).operations,0);
assert.equal(nativeBridgeEngine.read('main').files.find(file=>file.path==='renamed.txt').text,'Capture this');
nativeBridgeEngine.close();

const snapshotEngine=new Engine(bridgePath);
const snapshotBridge=new Bridge(snapshotEngine);
const interrupted=join(directory,'interrupted-snapshot');
assert.throws(()=>snapshotBridge.materialize('main',interrupted,undefined,{
  afterWrite:()=>{throw Error('simulated interruption');},
}),/simulated interruption/);
const oldSnapshot=snapshotBridge.snapshots().find(job=>job.root===interrupted);
assert.equal(oldSnapshot.complete,0);
const [resumed]=commands([{command:'snapshot.recover',snapshotId:oldSnapshot.id}],bridgePath);
assert.equal(resumed.complete,true);
assert.equal(readFileSync(join(interrupted,'renamed.txt'),'utf8'),'Capture this');
assert.equal(readlinkSync(join(interrupted,'link')),'document.txt');

const destination=join(directory,'native-snapshot');
const [materialized,snapshots]=commands([
  {command:'snapshot.create',branch:'main',target:destination},
  {command:'snapshot.list'},
],bridgePath);
assert.equal(materialized.complete,true);
assert.equal(readFileSync(join(destination,'asset.bin')).toString('base64'),'AP8X');
assert.equal(snapshotBridge.recover(materialized.id).complete,true);
assert.deepEqual(snapshots,JSON.parse(JSON.stringify(snapshotBridge.snapshots())));
writeFileSync(join(destination,'renamed.txt'),'Local edits');
assert.throws(()=>commands([{command:'snapshot.recover',snapshotId:materialized.id}],bridgePath),/Snapshot has local edits/);
assert.equal(readFileSync(join(destination,'renamed.txt'),'utf8'),'Local edits');
snapshotEngine.close();

const adapterPath=join(directory,'adapter.sqlite');
const adapterEngine=new ShardedEngine(adapterPath);
adapterEngine.create();
const adapter=new AdapterIngress(adapterEngine);
adapter.open({branch:'main',harness:'codex',streamId:'codex-test',prompt:'Summarize the checkout'});
const start={type:'thread.started',thread_id:'existing-thread'};
const originalEvent=adapter.ingest('codex-test',0,start);
const [retry,turn,assistant]=commands([
  {command:'adapter.ingest',streamId:'codex-test',sequence:0,nativeEvent:start},
  {command:'adapter.ingest',streamId:'codex-test',sequence:1,nativeEvent:{type:'turn.started'}},
  {command:'adapter.ingest',streamId:'codex-test',sequence:2,nativeEvent:{
    type:'item.completed',item:{type:'agent_message',id:'answer',text:'Verified result'},
  }},
],adapterPath);
assert.deepEqual(retry,originalEvent);
assert.equal(turn.events[0].kind,'turn.started');
assert.equal(assistant.events[0].payload.text,'Verified result');
assert.deepEqual(adapter.ingest('codex-test',2,{type:'item.completed',item:{type:'agent_message',id:'answer',text:'Verified result'}}),assistant);
const completion=adapter.ingest('codex-test',3,{type:'turn.completed'});
assert.equal(completion.events[0].kind,'turn.completed');
const [closed,claude]=commands([
  {command:'adapter.close',streamId:'codex-test',result:{exitCode:0}},
  {command:'adapter.open',options:{branch:'main',harness:'claude',streamId:'claude-test'}},
],adapterPath);
assert.equal(closed.status,'completed');
assert.deepEqual(adapter.close('codex-test',{exitCode:0}),closed);
assert.equal(claude.status,'opened');
const init={type:'system',subtype:'init',session_id:'claude-session'};
const [claudeStart,thinking,contents]=commands([
  {command:'adapter.ingest',streamId:'claude-test',sequence:0,nativeEvent:init},
  {command:'adapter.ingest',streamId:'claude-test',sequence:1,nativeEvent:{
    type:'assistant',session_id:'claude-session',message:{id:'hidden',content:[{type:'thinking',thinking:'never retain this'}]},
  }},
  {command:'adapter.ingest',streamId:'claude-test',sequence:2,nativeEvent:{
    type:'assistant',session_id:'claude-session',message:{id:'response',content:[{type:'text',text:'Public result'}]},
  }},
],adapterPath);
assert.equal(claudeStart.events.length,2);
assert.equal(thinking.events[0].payload.reason,'reasoning-omitted');
assert.equal(contents.events[0].payload.text,'Public result');
assert.equal(JSON.stringify(adapterEngine.read('main')).includes('never retain this'),false);
assert.deepEqual(adapter.ingest('claude-test',0,init),claudeStart);
assert.deepEqual(commands([{command:'adapter.streams'}],adapterPath),[adapter.list()]);
adapterEngine.close();

const watcher=Bun.spawn([binary,'storage',nativeBridgePath,'watch',checkout,'200','--sharded'],{
  stdout:'pipe',stderr:'inherit',
});
try{
  const reader=watcher.stdout.getReader();
  const next=async()=>{
    let timeout;
    try{
      return await Promise.race([reader.read(),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('Git watch timed out')),4000);})]);
    }finally{clearTimeout(timeout);}
  };
  const decoder=new TextDecoder();
  let pending='';
  const readEvent=async()=>{
    while(!pending.includes('\n')){
      const chunk=await next();
      assert.equal(chunk.done,false);
      pending+=decoder.decode(chunk.value,{stream:true});
    }
    const eol=pending.indexOf('\n');
    const event=JSON.parse(pending.slice(0,eol));
    pending=pending.slice(eol+1);
    return event;
  };
  assert.equal((await readEvent()).event,'watching');
  writeFileSync(join(checkout,'renamed.txt'),'Captured by the watch command');
  const event=await readEvent();
  assert.equal(event.event,'capture');
  assert.equal(event.result.operations,1);
  const inspected=new ShardedEngine(nativeBridgePath);
  assert.equal(inspected.read('main').files.find(file=>file.path==='renamed.txt').text,'Captured by the watch command');
  inspected.close();
}finally{
  watcher.kill();
  await watcher.exited;
}

const fixtureBin=join(directory,'fixture-harness');
mkdirSync(fixtureBin);
const executable=join(fixtureBin,'codex');
writeFileSync(executable,`#!/bin/sh
case "$*" in *'--sandbox workspace-write'*) ;; *) exit 8 ;; esac
cat >/dev/null
printf '%s\\n' '{"type":"thread.started","thread_id":"fixture-thread"}' '{"type":"turn.started"}'
printf '%s' 'Updated by the disposable harness' > renamed.txt
printf '%s\\n' '{"type":"item.completed","item":{"type":"command_execution","id":"tool","status":"completed"}}'
printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","id":"answer","text":"Fixture result"}}' '{"type":"turn.completed"}'
printf '%s' 'Diagnostics stay out of memory' >&2
`,{mode:0o755});
const runnerEnv={...Bun.env,PATH:fixtureBin+':'+Bun.env.PATH};
const executed=Bun.spawnSync([binary,'storage',nativeBridgePath,'run','codex',checkout,'main','--write','--sharded'],{
  stdin:Buffer.from('Use disposable fixture input'),env:runnerEnv,
});
assert.equal(executed.exitCode,0,executed.stderr.toString()+'\n'+executed.stdout.toString());
const runEvents=executed.stdout.toString().trim().split('\n').map(line=>JSON.parse(line));
assert(runEvents.some(event=>event.event==='filesystem.observed'&&event.result.operations===1));
const finished=runEvents.at(-1);
assert.equal(finished.event,'adapter.finished');
assert.equal(finished.result.status,'completed');
assert.equal(finished.result.events,5);
assert(finished.result.stderrBytes>0);
const inspectedRun=new ShardedEngine(nativeBridgePath);
const observed=inspectedRun.read('main');
assert.equal(observed.files.find(file=>file.path==='renamed.txt').text,'Updated by the disposable harness');
assert.equal(JSON.stringify(observed).includes('Diagnostics stay out of memory'),false);
const provenance=inspectedRun.trace('main',observed.files.find(file=>file.path==='renamed.txt').fileId).at(-1).provenance;
assert.equal(provenance.toolCallId,'tool');
assert.equal(provenance.sessionId,'fixture-thread');
assert.equal(provenance.evidence,'observed-disk-snapshot');
inspectedRun.close();

writeFileSync(executable,`#!/bin/sh
case "$*" in *'--sandbox read-only'*) ;; *) exit 8 ;; esac
cat >/dev/null
printf '%s\\n' '{"type":"thread.started","thread_id":"cancel-thread"}'
exec sleep 8
`,{mode:0o755});
const cancelled=Bun.spawn([binary,'storage',nativeBridgePath,'run','codex',checkout,'--sharded'],{
  stdin:Buffer.from('Cancel disposable fixture'),stdout:'pipe',stderr:'pipe',env:runnerEnv,
});
try{
  const reader=cancelled.stdout.getReader();
  const ready=await reader.read();
  assert.match(new TextDecoder().decode(ready.value),/adapter.recorded/);
  assert.equal(process.kill(cancelled.pid,'SIGTERM'),true);
  const output=[];
  while(true){
    const packet=await reader.read();
    if(packet.done)break;
    output.push(packet.value);
  }
  assert.equal(await cancelled.exited,130,Buffer.concat(output).toString());
  assert.match(Buffer.concat(output).toString(),/"reason":"cancelled"/);
}finally{
  cancelled.kill();
  await cancelled.exited;
}
