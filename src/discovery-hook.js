#!/usr/bin/env bun
import {loadRepositoryOnboarding,onboardingText} from './repository-onboarding.js';
import {readFileSync,existsSync,mkdirSync,writeFileSync,renameSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {discoveryRequest} from './discovery-request.js';
import {repositoryAt} from './repository.js';
import {runHook} from './codex-hooks.js';
export async function runDiscoveryHook({directory,event,input,plugin=false}){
 const sessionHash=createHash('sha256').update(String(input.session_id??'')).digest('hex'),pendingPath=join(directory,'onboarding',sessionHash+'.json');
 if(event==='UserPromptSubmit'&&/^This is an app-generated request for a suggested next user message\. The user did not write this message\./.test(input.prompt??'')){
  mkdirSync(join(directory,'lifecycle'),{recursive:true,mode:0o700});let root=input.cwd;try{root=repositoryAt(input.cwd).root;}catch{}const scoped=sessionHash+'-'+createHash('sha256').update(root).digest('hex').slice(0,16)+'.json';writeFileSync(join(directory,'lifecycle',scoped),JSON.stringify({sessionId:input.session_id,root,ignored:true}),{mode:0o600});return {hookSpecificOutput:{hookEventName:event,additionalContext:'Background composer suggestion only. Do not call SpoolDB tools or save project memory for this request.'}};
 }
 const project=await discoveryRequest(directory,{command:'propose',cwd:input.cwd});
 if(plugin){const {legacyFiles}=await import('./plugin/legacy.js');if(legacyFiles(project.root).length)return {systemMessage:'SpoolDB is using the existing integration. Run the SpoolDB setup workflow to migrate its managed configuration, then start a new session.'};}
 // Existing project-local hooks already handle this checkout. Avoid double task updates/reminders.
 const config=join(project.root,'.codex/config.toml');
 if(project.status==='enrolled'&&existsSync(config)&&readFileSync(config,'utf8').includes('# BEGIN SPOOL MANAGED')){return {};}
 else if(project.status==='enrolled'){
  if(plugin){const {projectRequest}=await import('./project-request.js');const status=await projectRequest(project.controlDirectory,{command:'status',projectId:project.projectId});if(!status.codex?.enabled)return {};if(event==='Stop')await projectRequest(project.controlDirectory,{command:'capture',projectId:project.projectId});}
  let onboardingStartedAt;if(['Stop','Interrupt'].includes(event)&&existsSync(pendingPath)){const pending=JSON.parse(readFileSync(pendingPath));if(pending.root===project.root&&pending.turnId===(input.turn_id??'session'))onboardingStartedAt=pending.startedAt;}
  const result=await runHook({directory:project.controlDirectory,room:project.projectId,root:project.root,event,input,onboardingStartedAt});if(['Stop','Interrupt'].includes(event)&&!result.decision)rmSync(pendingPath,{force:true});
  if(['SessionStart','UserPromptSubmit'].includes(event)&&!['completed','declined'].includes(project.retrospective?.status)){
   const context=project.retrospective?.status==='pending'?'Historical analysis was explicitly approved and is pending. Follow the setup skill retrospective workflow: page through spool_setup history, deduplicate against project memory, save distilled evidence-backed decisions/findings/tasks/handoffs respecting category sharing, then complete retrospective with its saved handoffId. Do not claim completion before finishing all available pages.':'Ask one optional clarifying question during project connection: "Analyze existing local chats and save decisions, findings, tasks and handoffs?" Offer Analyze existing chats or Skip. Save the explicit answer using spool_setup action=retrospective analyzeExisting=true/false confirm=true. This choice is separate from raw conversation sharing. Do not read historical chats or backfill before approval. Connection and normal work can continue if skipped.';
   result.hookSpecificOutput={...(result.hookSpecificOutput??{}),hookEventName:event,additionalContext:(result.hookSpecificOutput?.additionalContext??'')+'\n'+context};
  }return result;
 }
 else if(project.status==='pending'&&['SessionStart','UserPromptSubmit'].includes(event)){
  const lifecycle=join(directory,'lifecycle',sessionHash+'.json');mkdirSync(join(directory,'lifecycle'),{recursive:true,mode:0o700});if(!existsSync(lifecycle))writeFileSync(lifecycle,JSON.stringify({sessionId:input.session_id,root:project.root,startedAt:new Date().toISOString()}),{mode:0o600});
  if(event==='UserPromptSubmit'){mkdirSync(join(directory,'onboarding'),{recursive:true,mode:0o700});writeFileSync(pendingPath+'.tmp',JSON.stringify({root:project.root,turnId:input.turn_id??'session',startedAt:new Date().toISOString()}),{mode:0o600});renameSync(pendingPath+'.tmp',pendingPath);}
  const shell=s=>"'"+s.replaceAll("'","'\\''")+"'";
  const command=[process.execPath,fileURLToPath(new URL('./cli.js',import.meta.url)),'discovery','approve',project.root,'--state',directory];
  const plan=await loadRepositoryOnboarding(directory,project,{discover:discoveryRequest});
  let context='SpoolDB onboarding is pending for this checkout. No enrollment or capture is authorized yet. '+onboardingText(plan);
  if(plugin)context+='\nUse the bundled spool_setup tool with this repository root. Do not install another MCP server, add hooks or redirect the user to the web UI. After successful connection, retrieve project_context for this root and resume the original request.';
  else context+='\nFor the shared CLI integration, after explicit approval run '+command.map(shell).join(' ')+' --yes, with --workspace NAME_OR_ID for the selected connection and --room ROOM_ID when joining an approved existing project. Preview the selected connection before creating anything. After connection, retrieve project_context for this root.';
  context+='\nTask for this Codex session: codex-'+sessionHash.slice(0,24)+'. In the newly connected repository, retrieve the task revision (or create it with expectedRevision=0 if absent). Save newly verified useful findings and maintain its handoff only when continuation information materially changes. Offer optional existing-chat analysis separately; do not read historical chats before approval.';
  return {hookSpecificOutput:{hookEventName:event,additionalContext:context}};
 }
 else return {};
}
if(process.argv[1]&&new URL(import.meta.url).pathname===process.argv[1]){let text='';try{for await(const chunk of process.stdin){text+=chunk;if(text.length>1000000)throw new Error('Hook input too large');}const [directory,event]=process.argv.slice(2);console.log(JSON.stringify(await runDiscoveryHook({directory,event,input:JSON.parse(text)})));}catch(error){
 // Non-Git folders are outside discovery scope; service failures remain visible.
 console.log(JSON.stringify(/not a git repository|rev-parse|ENOENT/.test(error.message)?{}:{systemMessage:'SpoolDB discovery unavailable: '+error.message}));
}

}
