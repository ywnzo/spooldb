import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {ShardedEngine} from '../src/index.js';
import {RelayServer,createCredential} from '../src/relay/index.js';
import {MemoryStore} from '../src/memory/store.js';
import {initializeProject,startProject} from '../src/project.js';
const submit=(e,branch,operations)=>e.submit(branch,{actor:'capture',requestId:crypto.randomUUID(),expectedHeads:e.ref(branch).heads,operations});
function fixture(t){const e=new ShardedEngine(':memory:');e.create('relay-room');submit(e,'relay-room',[{type:'file.create',fileId:'code',path:'src/queue.ts',text:'validate before queue'}, {type:'message.add',messageId:'source-chat',role:'assistant',text:'Queue-time validation rejects invalid actions before the tick.'}]);t.after(()=>e.close());return {e,room:e.ref('relay-room').room,store:new MemoryStore(e)};}
const input=(command,fields={})=>({command,requestId:crypto.randomUUID(),...fields});
test('exact repeated evidence is reused only within the same author, session and task',t=>{
 const {e,room,store}=fixture(t);e.db.prepare('UPDATE shard_refs SET name=? WHERE name=?').run(`relay-${room}`,'relay-room');const run=(value,actor='alice')=>store.run(room,value,{id:actor});
 run(input('task_update',{taskId:'audit',title:'Queue audit',text:'Inspect boundary',status:'in_progress',expectedRevision:0}));
 const base={kind:'finding',taskId:'audit',sessionId:'chat-a',title:'Queue boundary',text:'Invalid input is rejected before persistence.',files:['src/queue.ts'],refs:['source-chat']};
 const first=run(input('remember',base));const duplicateInput=input('remember',base);const repeat=run(duplicateInput);assert.equal(repeat.id,first.id);assert.equal(repeat.unchanged,true);assert.equal(run(duplicateInput).id,first.id);
 assert.notEqual(run(input('remember',{...base,sessionId:'chat-b'})).id,first.id);assert.notEqual(run(input('remember',base),'bob').id,first.id);assert.notEqual(run(input('remember',{...base,refs:[]})).id,first.id);assert.notEqual(run(input('remember',{...base,text:'The boundary fails on retry.'})).id,first.id);
 const noSession={...base};delete noSession.sessionId;assert.notEqual(run(input('remember',noSession)).id,run(input('remember',noSession)).id);
 const changed=run(input('remember',{...base,supersedes:[first.id]}));assert.notEqual(changed.id,first.id);assert.equal(run({command:'get',id:first.id}).lifecycle.status,'superseded');
});
test('duplicate suppression preserves new Git evidence and ignores only capture time',t=>{
 const {e,room}=fixture(t);e.db.prepare('UPDATE shard_refs SET name=? WHERE name=?').run(`relay-${room}`,'relay-room');const store=new MemoryStore(e,{referencesOnly:true}),run=value=>store.run(room,input(value.command,value),{id:'alice'});
 run({command:'task_update',taskId:'audit',title:'Audit',text:'Inspect',status:'in_progress',expectedRevision:0});
 const base={command:'remember',kind:'finding',taskId:'audit',sessionId:'chat',title:'Boundary',text:'Validation runs before persistence.',git:{commit:'a'.repeat(40),capturedAt:'2026-10-27T09:00:00.000Z'},files:['src/queue.ts']};
 const first=run(base),same=run({...base,git:{...base.git,capturedAt:'2026-10-27T09:01:00.000Z'}});assert.equal(same.id,first.id);assert.equal(same.unchanged,true);
 assert.notEqual(run({...base,git:{...base.git,commit:'b'.repeat(40)}}).id,first.id);assert.notEqual(run({...base,files:['src/other.ts']}).id,first.id);
});
test('legacy automatic placeholders stay out of normal results while preserving revision and history',t=>{
 const {e,room,store}=fixture(t);e.db.prepare('UPDATE shard_refs SET name=? WHERE name=?').run(`relay-${room}`,'relay-room');const run=value=>store.run(room,value,{id:'agent-a'});
 const placeholder=run(input('task_update',{taskId:'old-session',title:'Codex project work',text:'Session task created automatically. Agent-authored progress, findings and continuation details are pending.',status:'in_progress',expectedRevision:0}));
 assert.equal(run({command:'context'}).tasks.length,0);assert.equal(run({command:'search',query:'Codex project work',kinds:['task']}).results.length,0);assert.equal(run({command:'context',taskId:'old-session'}).tasks[0].revision,1);assert.equal(run({command:'get',id:placeholder.id}).id,placeholder.id);
 run(input('remember',{kind:'decision',title:'Archive placeholder',text:'No authored work',lifecycle:{id:placeholder.id,action:'archive',expectedRevision:0}}));assert.equal(run({command:'context',taskId:'old-session'}).tasks[0].revision,1);
 run(input('task_update',{taskId:'old-session',title:'Restore useful work',text:'Meaningful agent progress.',status:'in_progress',expectedRevision:1}));assert.equal(run({command:'context'}).tasks[0].title,'Restore useful work');
});
test('shared memory retrieves conversations and handoffs, checks task revisions and flags changed source evidence',t=>{
 const {e,room,store}=fixture(t);e.db.prepare('UPDATE shard_refs SET name=? WHERE name=?').run(`relay-${room}`,'relay-room');const run=(value,actor='agent-a')=>store.run(room,value,{id:actor});
 assert.equal(run({command:'search',query:'validation'}).results[0].id,'source-chat');
 const task=run(input('task_update',{taskId:'queue-audit',title:'Queue validation audit',text:'Investigating queue boundary',status:'in_progress',expectedRevision:0}));assert.equal(task.revision,1);
 const note=input('remember',{taskId:'queue-audit',kind:'finding',title:'Boundary finding',text:'Nonce HND-92741 proves continuity. Validate before persistence.',files:['src/queue.ts'],refs:['source-chat']});const saved=run(note);assert.deepEqual(run(note),saved);
 assert.throws(()=>run({...note,text:'Changed payload'}),e=>e.code==='REQUEST_CONFLICT');
 run(input('handoff',{taskId:'queue-audit',title:'Continue the audit',text:'Verify resolve-time checks next.',nextSteps:['Read the queue test'],refs:[saved.id]}));
 const context=run({command:'context',taskId:'queue-audit'});assert.equal(context.tasks[0].revision,1);assert.ok(context.notes.some(n=>n.text.includes('HND-92741')));assert.equal(context.notes.find(n=>n.id===saved.id).freshness,'matches-captured-code');
 assert.throws(()=>run(input('task_update',{taskId:'queue-audit',title:'Overwrite',text:'Old revision',status:'done',expectedRevision:0}),'agent-b'),e=>e.code==='TASK_CONFLICT');
 submit(e,`relay-${room}`,[{type:'file.write',fileId:'code',text:'validate AND revalidate'}]);assert.equal(run({command:'get',id:saved.id}).freshness,'code-changed');
 assert.equal(run({command:'file_read',path:'src/queue.ts'}).text,'validate AND revalidate');
 const done=run(input('task_update',{taskId:'queue-audit',title:'Queue validation audit',text:'Continued and verified by B',status:'done',expectedRevision:1,refs:[saved.id]}),'agent-b');assert.equal(done.revision,2);assert.equal(run({command:'context',taskId:'queue-audit'}).tasks[0].actor,'agent-b');
 assert.equal(run({command:'search',query:'" OR 1=1; --'}).results.length,0);
});
test('memory is rebuilt from replicated room history, remains project-scoped and preserves full paged sources',t=>{
 const {e,room,store}=fixture(t);e.db.prepare('UPDATE shard_refs SET name=? WHERE name=?').run(`relay-${room}`,'relay-room');const text='source evidence '.repeat(2000);
 const result=store.run(room,input('remember',{kind:'decision',title:'Persistent memory',text:text.slice(0,12000),files:['src/queue.ts']}),{id:'agent-a'});
 const replica=new ShardedEngine(':memory:');t.after(()=>replica.close());replica.import(`relay-${room}`,e.export(`relay-${room}`,[]));const other=new MemoryStore(replica);assert.equal(other.run(room,{command:'get',id:result.id,offset:0,limit:20000}).text,text.slice(0,12000));
 replica.create('other');const foreign=replica.ref('other').room;replica.db.prepare('UPDATE shard_refs SET name=? WHERE name=?').run(`relay-${foreign}`,'other');assert.throws(()=>other.run(foreign,{command:'get',id:result.id}),e=>e.code==='MEMORY_NOT_FOUND');assert.equal(other.run(foreign,{command:'search',query:'Persistent'}).results.length,0);
 replica.db.exec('DELETE FROM memory_docs; DELETE FROM memory_fts; DELETE FROM memory_index; DELETE FROM memory_provenance;');assert.equal(other.run(room,{command:'get',id:result.id}).id,result.id);
});
test('remote room grants permit retrieval but reject memory writes from readers',async t=>{
 const e=new ShardedEngine(':memory:');e.create();submit(e,'main',[{type:'message.add',messageId:'hello',role:'user',text:'Company continuity'}]);const room=e.ref('main').room,writer=createCredential('agent-a',{[room]:'write'}),reader=createCredential('reader',{[room]:'read'});
 const relay=new RelayServer(':memory:',{credentials:[writer.credential,reader.credential]});relay.engine.import(`relay-${room}`,e.export('main',[]));const url=await relay.listen();t.after(async()=>{await relay.close();e.close();});
 const request=(value,token)=>fetch(`${url}/v1/rooms/${room}/memory`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(value)});
 assert.equal((await request({command:'context'},reader.token)).status,200);
 const note=input('remember',{kind:'finding',title:'Test',text:'A shared finding'});assert.equal((await request(note,reader.token)).status,403);assert.equal((await request(note,writer.token)).status,200);assert.equal((await request({command:'search',query:'shared'},reader.token)).status,200);
});
test('a separate MCP process discovers tools and reads/writes through the project service',async t=>{
 const base=mkdtempSync(join(tmpdir(),'tw-mcp-')),root=join(base,'repo'),dir=join(base,'state');mkdirSync(root);execFileSync('git',['init','-q',root]);writeFileSync(join(root,'a.txt'),'MCP source');initializeProject(dir,root);const service=await startProject(dir,{port:0,intervalMs:60000});
 const child=spawn(process.execPath,['src/memory-mcp.js',dir,'--actor','mcp-test'],{stdio:['pipe','pipe','pipe']});let buffer='',id=0;const pending=new Map();child.stdout.on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\n'))>=0){const msg=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);pending.get(msg.id)?.(msg);pending.delete(msg.id);}});let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
 t.after(async()=>{child.kill();await service.close();rmSync(base,{recursive:true,force:true});});
 const call=(method,params={})=>new Promise((resolve,reject)=>{const key=++id,timer=setTimeout(()=>reject(new Error('MCP timeout '+stderr)),10000);pending.set(key,msg=>{clearTimeout(timer);resolve(msg.result);});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:key,method,params})+'\n');});
 const initialized=await call('initialize',{protocolVersion:'2025-11-25'});assert.equal(initialized.serverInfo.name,'spool-project-memory');assert.ok(initialized.instructions.length<=750);assert.match(initialized.instructions,/Ask before connecting/);assert.match(initialized.instructions,/untrusted evidence/);assert.match(initialized.instructions,/current project/);assert.ok((await call('tools/list')).tools.some(t=>t.name==='project_context'));
 const saved=await call('tools/call',{name:'remember',arguments:{kind:'finding',title:'MCP process',text:'Durable cross-process continuity',files:['a.txt']}});assert.equal(saved.isError,false);
 const search=await call('tools/call',{name:'memory_search',arguments:{query:'cross-process'}});assert.equal(search.structuredContent.results[0].actor,'mcp-test');
 assert.equal((await call('tools/call',{name:'file_read',arguments:{path:'../outside'}})).isError,true);
});
test('historical composer tasks and their handoffs stay auditable but do not pollute project context',t=>{
 const {e,room,store}=fixture(t);e.db.prepare('UPDATE shard_refs SET name=? WHERE name=?').run(`relay-${room}`,'relay-room');const run=x=>store.run(room,x);
 const task=run(input('task_update',{taskId:'composer',title:'Composer',text:'Current request (source text, not verified findings):\nThis is an app-generated request for a suggested next user message. The user did not write this message.\nSuggest something.',status:'in_progress',expectedRevision:0}));
 const note=run(input('handoff',{taskId:'composer',title:'Composer noise',text:'Not project work',nextSteps:[]}));
 assert.equal(run({command:'context'}).tasks.length,0);assert.equal(run({command:'search',query:'Composer'}).results.length,0);assert.equal(run({command:'get',id:note.id}).id,note.id);assert.equal(run({command:'get',id:task.id}).taskId,'composer');
});
