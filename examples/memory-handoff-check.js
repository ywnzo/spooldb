// Explicit live acceptance check. Uses two fresh Codex sessions; does not edit source.
import {spawn} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {projectRequest} from '../src/project.js';
process.umask(0o077);
const directory=resolve(process.argv[2]),root=resolve(process.argv[3]),runId=randomUUID(),taskId=`wield-continuity-${runId.slice(0,8)}`,marker=`handoff-${randomUUID()}`;
const secondDirectory=process.env.SPOOL_SECOND_STATE?resolve(process.env.SPOOL_SECOND_STATE):directory,secondRoot=process.env.SPOOL_SECOND_ROOT?resolve(process.env.SPOOL_SECOND_ROOT):root;
const destination=join(directory,'acceptance',runId);mkdirSync(destination,{recursive:true,mode:0o700});
const config=JSON.parse(readFileSync(join(directory,'project.json'))),server=fileURLToPath(new URL('../src/memory-mcp.js',import.meta.url));
function run(label,prompt){return new Promise((resolve,reject)=>{
 const targetDir=label==='handoff-agent-b'?secondDirectory:directory,targetRoot=label==='handoff-agent-b'?secondRoot:root,targetConfig=JSON.parse(readFileSync(join(targetDir,'project.json')));
 const options={command:process.execPath,args:[server,targetDir,'--project',targetConfig.room,'--actor',label]};
 const args=['exec','--json','--color','never','--sandbox','read-only','--ephemeral','--skip-git-repo-check','-C',targetRoot,
 '-c',`mcp_servers.spool.command=${JSON.stringify(options.command)}`,'-c',`mcp_servers.spool.args=${JSON.stringify(options.args)}`,'-c','mcp_servers.spool.required=true','-c','mcp_servers.spool.startup_timeout_sec=30','-c','mcp_servers.spool.tool_timeout_sec=60','-'];
 writeFileSync(join(destination,label+'.prompt.txt'),prompt,{mode:0o600});
 const child=spawn('codex',args,{stdio:['pipe','pipe','pipe'],detached:true,cwd:targetRoot});let stdout='',stderrBytes=0,buffer='';const events=[];
 const stop=()=>{try{process.kill(-child.pid,'SIGTERM');}catch{}};const timer=setTimeout(stop,300000);
 child.stdin.on('error',()=>{});child.stdin.end(prompt);child.stderr.on('data',chunk=>stderrBytes+=chunk.length);
 child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{stdout+=chunk;buffer+=chunk;let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);try{const event=JSON.parse(line);events.push(event);if(event.type==='item.completed'&&event.item?.type==='mcp_tool_call')console.log(JSON.stringify({session:label,event:'mcp_tool',tool:event.item.tool,status:event.item.status}));}catch{}}});
 child.on('error',reject);child.on('close',code=>{clearTimeout(timer);writeFileSync(join(destination,label+'.jsonl'),stdout,{mode:0o600});const sessionId=events.find(e=>e.type==='thread.started')?.thread_id;
 const text=events.filter(e=>e.type==='item.completed'&&e.item?.type==='agent_message').map(e=>e.item.text).join('\n');
 const tools=events.filter(e=>e.type==='item.completed'&&e.item?.type==='mcp_tool_call').map(e=>({tool:e.item.tool,status:e.item.status}));
 if(code!==0||!events.some(e=>e.type==='turn.completed'))return reject(new Error(`${label} did not complete; inspect local JSONL at ${destination}`));resolve({sessionId,tools,text,stderrBytes,exitCode:code});});
});}
const promptA=`You are the first agent in a real project-memory continuity acceptance test for Wield. Work read-only: do not edit files or run tests. Use only local read tools and the spool MCP server; no web or other external tools.
Start with project_context. Investigate why Wield needs queue-time validation and resolve-time checks, reading AGENTS.md and the relevant portions of server/core/actions.ts, server/core/app.ts and server/core/tick.ts as needed.
Create task ${taskId} with task_update expectedRevision=0 and status=in_progress. Record one concrete invariant you verified through remember, with captured source file references. In that finding include this continuity verification marker exactly: ${marker}.
Then leave a handoff for the same task through the handoff tool, cite the finding ID, explain what was checked and leave one specific resolve-time behavior for the next agent to verify. Do NOT mark the task done. Do not claim tests were run. Finish with a short acknowledgement. All useful context must be committed through MCP, not merely written in your final response.`;
const promptB=`You are a new Codex session continuing task ${taskId} on Wield. Use only local read tools and the spool MCP server; no web or other external tools. Do not edit files or run tests.
You have no recap from the previous agent. Retrieve project_context for this task, then use memory_get to read the cited finding and handoff. Claim the task using its current revision. Continue the unfinished verification using current captured source via file_read or local source reads. Record your additional finding with source references and mark the task done using the current revision. Clearly distinguish source inspection from executed tests.
In your final response report: the continuity verification marker you actually retrieved; the previous agent's verified invariant; the behavior you additionally checked; the memory IDs used as evidence. Do not invent missing context.`;
try{
 console.log(JSON.stringify({event:'handoff.started',taskId,destination}));const a=await run('handoff-agent-a',promptA);
 const between=await projectRequest(directory,{command:'memory',input:{command:'context',taskId}});writeFileSync(join(destination,'after-a.json'),JSON.stringify(between,null,2),{mode:0o600});
 if(!between.notes.some(n=>n.kind==='handoff')||!between.notes.some(n=>n.text.includes(marker)))throw new Error('Agent A did not commit the required finding and handoff');
 const b=await run('handoff-agent-b',promptB);const after=await projectRequest(secondDirectory,{command:'memory',input:{command:'context',taskId}});
 const checks={separateNativeSessions:Boolean(a.sessionId&&b.sessionId&&a.sessionId!==b.sessionId),aCommittedHandoff:between.notes.some(n=>n.kind==='handoff'),bRetrievedMarker:b.text.includes(marker),bUsedRetrieval:['project_context','memory_get'].every(name=>b.tools.some(t=>t.tool===name&&t.status==='completed')),bAddedFinding:after.notes.some(n=>n.kind==='finding'&&(secondDirectory===directory?n.actor==='handoff-agent-b':n.actor!==between.tasks[0]?.actor)),bCompletedTask:after.tasks[0]?.status==='done'&&(secondDirectory===directory?after.tasks[0]?.actor==='handoff-agent-b':after.tasks[0]?.actor!==between.tasks[0]?.actor),bPromptContainsNoMarker:!promptB.includes(marker)};
 const report={runId,taskId,project:root,secondClient:secondDirectory!==directory,secondProjectRoot:secondRoot,marker,checks,passed:Object.values(checks).every(Boolean),agentA:a,agentB:b,finalMemory:after};writeFileSync(join(destination,'report.json'),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify({event:'handoff.completed',passed:report.passed,checks,taskId,report:join(destination,'report.json')}));if(!report.passed)process.exitCode=1;
}catch(error){writeFileSync(join(destination,'failure.json'),JSON.stringify({error:error.message,taskId},null,2),{mode:0o600});console.error(JSON.stringify({error:error.message,taskId,destination}));process.exitCode=1;}
