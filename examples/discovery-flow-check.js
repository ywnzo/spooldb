// Explicit live acceptance: actual Codex app-server sessions, isolated relay and checkout.
// Uses the configured model and a private symlink to the existing sign-in; never copies credentials.
import {spawn,execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync,existsSync,symlinkSync,mkdtempSync,unlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {startTeamHost} from '../src/team/host.js';
import {startDesktop} from '../src/desktop/service.js';
import {WorkspaceClient} from '../src/team/workspace-client.js';
import {enableDiscovery} from '../src/discovery-install.js';
import {discoveryRequest} from '../src/discovery.js';
import {projectRequest} from '../src/project.js';
process.umask(0o077);
const base=resolve(process.argv[2]??mkdtempSync(join(tmpdir(),'spool-flow-'))),root=join(base,'quantity-demo'),state=join(base,'client'),home=join(base,'codex');
for(const p of [base,root,state,home])mkdirSync(p,{recursive:true,mode:0o700});
const reportPath=join(base,'report.json'),marker='SPOOL-FLOW-'+randomUUID(),realHome=process.env.CODEX_HOME??join(homedir(),'.codex');
const config=readFileSync(join(realHome,'config.toml'),'utf8');const header=config.split(/\n\[/)[0];writeFileSync(join(home,'config.toml'),header+'\n');
if(!existsSync(join(realHome,'auth.json')))throw new Error('This test requires an existing Codex sign-in');symlinkSync(join(realHome,'auth.json'),join(home,'auth.json'));
process.env.CODEX_HOME=home;
writeFileSync(join(root,'total.js'),'export function total(items) {\n  return items.reduce((sum, item) => sum + item.price, 0);\n}\n');
writeFileSync(join(root,'total.test.js'),"import {test} from 'node:test';\nimport assert from 'node:assert/strict';\nimport {total} from './total.js';\ntest('counts each item quantity',()=>assert.equal(total([{price:7,quantity:3}]),21));\n");
writeFileSync(join(root,'package.json'),JSON.stringify({name:'quantity-demo',type:'module',scripts:{test:'node --test'}})+'\n');
const git=args=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();git(['init','-q']);git(['remote','add','origin','https://example.com/spool-acceptance/'+randomUUID()+'.git']);git(['add','.']);git(['-c','user.name=Acceptance','-c','user.email=acceptance@example.com','commit','-qm','Fixture']);
const original=readFileSync(join(root,'total.js'),'utf8'),checks={},sessions=[],approvalEvents=[];let host,desktop;
const save=(file,value)=>writeFileSync(join(base,file),JSON.stringify(value,null,2)+'\n',{mode:0o600});
const emit=(event,data={})=>console.log(JSON.stringify({event,...data}));
class Rpc{
 constructor(label){this.label=label;this.events=[];this.pending=new Map();this.id=0;this.child=spawn('codex',['app-server','--listen','stdio://'],{cwd:root,env:process.env,stdio:['pipe','pipe','pipe']});let buffer='';this.child.stderr.on('data',()=>{});this.child.stdin.on('error',()=>{});this.child.stdout.setEncoding('utf8');this.child.stdout.on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);let m;try{m=JSON.parse(line);}catch{continue;}const pending=this.pending.get(m.id);if(pending){clearTimeout(pending.timer);this.pending.delete(m.id);m.error?pending.reject(new Error(m.error.message)):pending.resolve(m.result);}else{this.events.push(m);if(m.id!==undefined&&m.method)this.serverRequest(m);if(m.method==='item/completed'){const item=m.params?.item;if(item?.type==='agentMessage')emit(this.label+'.message',{text:item.text?.slice(0,300)});if(item?.type==='mcpToolCall')emit(this.label+'.mcp',{tool:item.tool,status:item.status});}}}});this.child.on('error',e=>this.fail(e));this.child.on('close',()=>this.fail(new Error('Codex app-server closed')));}
 fail(e){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(e);}this.pending.clear();}
 async serverRequest(m){try{let result;
  if(m.method==='item/tool/requestUserInput'){
   const snapshot=await beforeApproval();approvalEvents.push({type:'native-question',questions:m.params.questions,snapshot});
   result={answers:Object.fromEntries(m.params.questions.map(q=>[q.id,{answers:[q.options?.find(o=>/create/i.test(o.label))?.label??'Create a shared project. I approve sharing this fixture checkout’s conversations and memory.']}]))};emit('approval.native-question-answered');
  }else throw new Error('Unexpected client request: '+m.method);
  this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\n');
 }catch(e){this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:e.message}})+'\n');}}
 request(method,params){return new Promise((resolve,reject)=>{const id=++this.id,timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(method+' timed out'));},30000);this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});}
 async start(){await this.request('initialize',{clientInfo:{name:'spool-flow-check',version:'0.1.0'},capabilities:{experimentalApi:true}});this.child.stdin.write(JSON.stringify({method:'initialized'})+'\n');const created=await this.request('thread/start',{cwd:root,sandbox:'workspace-write',approvalPolicy:'never'});this.threadId=created.thread.id;return created;}
 async turn(text){const start=this.events.length;const created=await this.request('turn/start',{threadId:this.threadId,input:[{type:'text',text}],sandboxPolicy:{type:'workspaceWrite',writableRoots:[root],networkAccess:true},approvalPolicy:'never'});const id=created.turn.id,deadline=Date.now()+240000;while(!this.events.slice(start).some(e=>e.method==='turn/completed'&&e.params?.turn?.id===id)){if(Date.now()>deadline){await this.request('turn/interrupt',{threadId:this.threadId,turnId:id});throw new Error('Codex turn exceeded 4 minutes');}await new Promise(r=>setTimeout(r,300));}const events=this.events.slice(start),done=events.find(e=>e.method==='turn/completed'&&e.params?.turn?.id===id);save(this.label+'-'+id+'.json',events);if(done.params.turn.status!=='completed')throw new Error('Codex turn status '+done.params.turn.status);return events;}
 close(){save(this.label+'-events.json',this.events);this.child.kill('SIGTERM');this.fail(new Error('Closed'));}
}
async function beforeApproval(){const proposals=await discoveryRequest(state,{command:'list'}),snapshot={projects:host.command({command:'list'}).projects.length,captureInitialized:existsSync(join(state,'p/project.json')),sourceUnchanged:readFileSync(join(root,'total.js'),'utf8')===original,pending:proposals.entries.some(e=>e.root===root&&e.status==='pending')};if(snapshot.projects!==0||snapshot.captureInitialized||!snapshot.sourceUnchanged||!snapshot.pending)throw new Error('Pre-approval boundary failed');return snapshot;}
const memory=input=>projectRequest(join(state,'p'),{command:'memory',input});
try{
 host=await startTeamHost(join(base,'relay'),{port:0});desktop=await startDesktop(state,{port:0});const ws=new WorkspaceClient(state);await ws.run({command:'connect',link:host.command({command:'workspace-init',name:'SpoolDB isolated flow test'}).link,device:'Acceptance client'});const enabled=await enableDiscovery(state,{codexHome:home});checks.globalHooksTrusted=enabled.trusted;emit('ready',{base,ui:desktop.origin});save('location.json',{base,root,state,ui:desktop.origin,relay:host.origin,marker});
 const a=new Rpc('first');sessions.push(a);await a.start();emit('first.opened',{threadId:a.threadId});
 const firstPrompt=`Inspect this project’s total calculation. Do not edit source yet. Record one verified finding and leave an actionable handoff for another session to fix the quantity handling and run the test. Keep the task in progress. Include this verification marker in the finding and handoff: ${marker}.`;
 const question=await a.turn(firstPrompt);
 if(!approvalEvents.length){const snapshot=await beforeApproval(),questionText=question.filter(e=>e.method==='item/completed'&&e.params?.item?.type==='agentMessage').map(e=>e.params.item.text).join('\n');checks.firstResponseAsked=/SpoolDB/i.test(questionText)&&/\?|connect|create/i.test(questionText);if(!checks.firstResponseAsked)throw new Error('First session did not ask about connection');approvalEvents.push({type:'chat-question',question:questionText,snapshot});emit('approval.pending-verified',snapshot);await a.turn('Yes, create a shared project for this checkout. I approve connecting it and sharing its saved Codex conversations and project memory. Then continue my original request, leaving a handoff without changing source.');}
 else checks.firstResponseAsked=true;
 checks.noEnrollmentBeforeApproval=approvalEvents.every(e=>e.snapshot.projects===0&&!e.snapshot.captureInitialized&&e.snapshot.sourceUnchanged&&e.snapshot.pending);
 const connected=await discoveryRequest(state,{command:'resolve',cwd:root});checks.approved=connected.status==='enrolled';if(!checks.approved)throw new Error('Agent did not complete approval');
 const between=await memory({command:'context'});save('after-first.json',between);const handoff=between.notes.find(n=>n.kind==='handoff'&&n.text.includes(marker)&&n.actor!=='codex-lifecycle'&&!['Automatic Codex checkpoint','Interrupted Codex checkpoint'].includes(n.title));checks.firstLeftAgentHandoff=Boolean(handoff);checks.singleInitialTask=between.tasks.length===1;checks.noUnnecessaryFallback=between.notes.every(n=>!['Automatic Codex checkpoint','Interrupted Codex checkpoint'].includes(n.title));checks.firstLeftSourceUnchanged=readFileSync(join(root,'total.js'),'utf8')===original;checks.onlyOneProject=host.command({command:'list'}).projects.length===1;if(!handoff)throw new Error('First session did not leave the required handoff');
 a.close();sessions.splice(sessions.indexOf(a),1);emit('first.handoff-verified',{id:handoff.id,taskId:handoff.taskId});
 const b=new Rpc('second');sessions.push(b);await b.start();checks.independentSessions=a.threadId!==b.threadId;emit('second.opened',{threadId:b.threadId});
 const secondPrompt='Pick up the previous agent’s unfinished work on this project. Start from shared project memory, read the actual handoff with memory_get, finish its task using its current revision, verify the result and leave a handoff of your own. Report the verification marker you retrieved and what tests you actually ran. Do not ask for a recap.';
 checks.secondPromptContainsNoRecap=!secondPrompt.includes(marker)&&!secondPrompt.includes(handoff.id)&&!secondPrompt.includes('quantity');await b.turn(secondPrompt);
 const toolEvents=b.events.filter(e=>e.method==='item/completed'&&e.params?.item?.type==='mcpToolCall').map(e=>e.params.item);save('second-tools.json',toolEvents);
 checks.secondRetrievedContext=toolEvents.some(e=>e.tool==='project_context');checks.secondReadHandoff=toolEvents.some(e=>e.tool==='memory_get'&&JSON.stringify(e).includes(marker)&&JSON.stringify(e).includes(handoff.id));
 const after=await memory({command:'context'});save('after-second.json',after);checks.previousTaskCompleted=after.tasks.some(task=>task.taskId===handoff.taskId&&task.status==='done');checks.secondLeftHandoff=after.notes.some(n=>n.kind==='handoff'&&n.sessionId!==handoff.sessionId&&n.actor!=='codex-lifecycle');
 const test=execFileSync(process.execPath,['--test'],{cwd:root,encoding:'utf8'});writeFileSync(join(base,'verified-test-output.txt'),test);checks.fixtureTestPasses=true;checks.sourceChanged=readFileSync(join(root,'total.js'),'utf8')!==original;
 const deadline=Date.now()+25000;let chats;while(Date.now()<deadline){chats=await memory({command:'search',query:marker,kinds:['conversation'],limit:30});if(chats.results.length)break;await new Promise(r=>setTimeout(r,1000));}checks.conversationCaptured=Boolean(chats?.results.length);checks.relayContainsNoSource=host.relay.engine.db.prepare("SELECT count(*) AS n FROM shard_changes WHERE doc LIKE 'f:%'").get().n===0;
 const report={passed:Object.values(checks).every(Boolean),checks,base,root,marker,firstThreadId:a.threadId,secondThreadId:b.threadId,handoffId:handoff.id,taskId:handoff.taskId,approvalEvents};save('report.json',report);emit('completed',{passed:report.passed,checks,report:reportPath});if(!report.passed)process.exitCode=1;
}catch(error){save('failure.json',{error:error.message,checks,approvalEvents});emit('failed',{error:error.message,base});process.exitCode=1;}
finally{for(const rpc of sessions)rpc.close();await desktop?.close();await host?.close();unlinkSync(join(home,'auth.json'));}
