// Acceptance against the GUI app-server protocol and Zed's installed ACP adapter.
import {CodexRpc} from '../src/codex-rpc.js';
import {projectRequest} from '../src/project.js';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
const [directory,root,acp]=process.argv.slice(2),destination=join(directory,'acceptance','automatic-'+randomUUID());mkdirSync(destination,{mode:0o700});
const prompt='Read-only source inspection: explain why a queued Wield move still needs resolve-time checks. Use captured project evidence. Do not edit files, run tests or use the web. Keep the answer brief.';
const task=session=>`codex-${createHash('sha256').update(session).digest('hex').slice(0,24)}`;
async function verify(sessionId,label,events){const context=await projectRequest(directory,{command:'memory',input:{command:'context',taskId:task(sessionId)}});const handoff=context.notes.find(n=>n.kind==='handoff');const checks={taskCreated:context.tasks.length===1,handoffSaved:Boolean(handoff),agentHandoff:handoff?.actor!=='codex-lifecycle',retrievedContextViaMcp:events.some(e=>JSON.stringify(e).includes('project_context')&&(/mcpToolCall|tool_call/.test(JSON.stringify(e)))),hookEventsExposedByClient:events.some(e=>JSON.stringify(e).includes('sessionStart'))};writeFileSync(join(destination,label+'.json'),JSON.stringify({sessionId,checks,context,events},null,2),{mode:0o600});return {sessionId,checks};}
const gui=new CodexRpc({cwd:root});let guiResult,zedResult;
try{await gui.start();const created=await gui.request('thread/start',{cwd:root,ephemeral:true,sandbox:'read-only'});const id=created.thread.id;await gui.request('turn/start',{threadId:id,input:[{type:'text',text:prompt}]});const deadline=Date.now()+240000;while(!gui.notifications.some(e=>e.method==='turn/completed'&&e.params?.threadId===id)){if(Date.now()>deadline)throw new Error('GUI backend turn timeout');await new Promise(r=>setTimeout(r,500));}guiResult=await verify(id,'gui-app-server',gui.notifications);console.log(JSON.stringify({event:'gui.completed',...guiResult}));}finally{gui.close();}
const zed=new CodexRpc({command:process.execPath,args:[acp],cwd:root});
try{await zed.request('initialize',{protocolVersion:1,clientInfo:{name:'spool-zed-check',version:'0.1.0'},clientCapabilities:{}});const created=await zed.request('session/new',{cwd:root,mcpServers:[]});writeFileSync(join(destination,'zed-session.json'),JSON.stringify(created,null,2),{mode:0o600});
 // The adapter's read-only mode is selected when exposed. Otherwise use its prompt-only mode.
 const modes=created.modes?.availableModes??[],mode=modes.find(m=>/read.only/i.test(m.id+' '+m.name))??modes.find(m=>m.id==='read-only');if(mode)await zed.request('session/set_mode',{sessionId:created.sessionId,modeId:mode.id});
 const response=await Promise.race([zed.request('session/prompt',{sessionId:created.sessionId,prompt:[{type:'text',text:prompt}]}),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('ACP turn timeout')),240000);timer.unref();})]);
 zedResult=await verify(created.sessionId,'zed-acp',zed.notifications);console.log(JSON.stringify({event:'zed.completed',...zedResult}));
}finally{zed.close();}
const passed=[guiResult,zedResult].every(result=>result.checks.taskCreated&&result.checks.handoffSaved&&result.checks.agentHandoff&&result.checks.retrievedContextViaMcp);const report={passed,prompt,gui:guiResult,zed:zedResult,destination};writeFileSync(join(destination,'report.json'),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report));if(!passed)process.exitCode=1;
