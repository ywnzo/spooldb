import {createHash} from 'node:crypto';
import {hostname} from 'node:os';
import {readFileSync} from 'node:fs';
import {repositoryAt} from './repository.js';
import {isWorkspaceLink,parseWorkspaceLink} from './team/workspace.js';
import {workspaceRequest} from './team/workspace-client.js';
import {enableDiscovery} from './discovery-install.js';
import {previewInvite} from './desktop/join.js';

// Project creation, joining and capture happen only after the final sharing approval.
export async function initializeCheckout({cwd=process.cwd(),state,options={},ask,output,workspace,local,preview=previewInvite,workspacePreview=link=>workspaceRequest(parseWorkspaceLink(link),'preview'),connectCodex=enableDiscovery}){
 let repo;try{repo=repositoryAt(cwd);}catch{throw Error('Run spool init from a Git project folder (or initialize Git first).');}
 const say=text=>output.write(text+'\n'),yes=async(label,defaultYes=false)=>/^y(es)?$/i.test(await ask(label,defaultYes?'Y':'N'));
 say('\nSpoolDB · Connect this project\nFolder: '+repo.root);
 const registry=await local('projects'),registered=registry.projects?.find(p=>p.root===repo.root);
 const current=registered?await local('status',undefined,{project:registered.id}):null;
 let data=await workspace({command:'list'}),plan,device=options.device??hostname();
 const invitePlan=async supplied=>{
  const link=supplied??await ask('Paste a project or workspace invitation (Enter to cancel)');if(!link)return null;
  if(isWorkspaceLink(link)){
   const info=await workspacePreview(link);if(!await yes('Connect this computer to workspace '+info.workspace.name+'?'))return null;
   data=await workspace({command:'connect',link,device});return 'workspace';
  }
  const info=await preview(link,{directory:state});return {kind:'invite',link,name:info.project,relay:info.relay};
 };
 const supplied=options['invite-file']?readFileSync(options['invite-file'],'utf8').trim():null;
 if(supplied){plan=await invitePlan(supplied);if(plan===null)return {cancelled:true};if(plan==='workspace')plan=null;}
 if(!plan&&current?.team?.configured){
  const existingName=data.relay===current.team.url?(data.projects?.find(p=>p.room===current.team.room)?.name??current.name):current.name;
  say('Already connected: '+existingName+' · '+current.team.url);
  if(await yes('Keep this shared project connection?',true))plan={kind:'existing',name:existingName,relay:current.team.url,room:current.team.room,project:registered};
 }
 if(!plan&&!data.connected){plan=await invitePlan();if(plan===null)return {cancelled:true};if(plan==='workspace')plan=null;}
 while(!plan){
  const projects=data.projects??[];let match=null,matches=[],restricted=false;
  if(repo.repositoryKey)try{const result=await workspace({command:'repository-match',repositoryKey:repo.repositoryKey});match=result.project;matches=result.projects??(match?[match]:[]);}catch(error){if(error.code!=='WORKSPACE_FORBIDDEN')throw error;restricted=true;say('This repository already has a shared project. Ask its administrator for an invitation.');}
  const choices=[];
  for(const project of matches)choices.push({kind:'join',project,label:'Join '+project.name+' (matches this repository)'});
  if(!matches.length&&!restricted&&data.member?.canCreate)choices.push({kind:'create',label:'Create a shared project'});
  if(!matches.length&&!restricted&&projects.length)choices.push({kind:'choose',label:'Choose an existing shared project'});
  choices.push({kind:'invitation',label:'Join using an invitation'});
  say('\nWorkspace: '+data.workspace.name);choices.forEach((item,index)=>say(`${index+1}. ${item.label}`));
  const choice=choices[Number(await ask('Choose an option','1'))-1];if(!choice)throw Error('Choose one of the numbered options. Nothing was connected.');
  if(choice.kind==='create'){
   const name=await ask('Project name',repo.name);if(!name.trim()||name.length>160)throw Error('Enter a project name (1–160 characters).');plan={kind:'create',name,relay:data.relay};
  }else if(choice.kind==='invitation'){
   plan=await invitePlan();if(!plan)return {cancelled:true};if(plan==='workspace'){plan=null;continue;}
  }else{
   let project=choice.project;if(!project){projects.forEach((p,index)=>say(`${index+1}. ${p.name}`));project=projects[Number(await ask('Choose a project','1'))-1];if(!project)throw Error('Choose one of the numbered projects. Nothing was connected.');}
   plan={kind:'join',room:project.room,name:project.name,relay:data.relay};
  }
 }
 say('\n'+(plan.kind==='create'?'Create':'Connect to')+': '+plan.name+'\nRelay: '+plan.relay+'\nCodex: automatic MCP context and lifecycle hooks (including Codex in Zed). Other folders still ask before sharing.\nSharing: saved Codex conversations, findings and handoffs. Code stays in Git.');
 if(!await yes('Connect this folder and enable sharing?')){say('Cancelled. No project was created or joined.');return {cancelled:true};}
 let joined;
 if(plan.kind==='invite')joined=await local('invites/join',{link:plan.link,root:repo.root,device,captureConversations:true,connectAgents:false});
 else if(plan.kind==='existing'){
  await local('codex/connect',{}, {project:plan.project.id});joined={project:plan.project};
 }else{
  let project;
  if(repo.repositoryKey){const enrollment=await workspace({command:'repository-enroll',repositoryKey:repo.repositoryKey,name:plan.name,...(plan.room?{mode:'join',room:plan.room}:{mode:'create',requestId:'init-'+createHash('sha256').update(JSON.stringify([repo.root,repo.repositoryKey,plan.relay,plan.name])).digest('hex')})});if(plan.kind==='create'&&enrollment.enrollmentMode!=='create')throw Error('Upgrade the relay before creating a separate repository project. No local connection was changed.');project=enrollment.project;}
  else if(plan.kind==='create')project=(await workspace({command:'create',name:plan.name,requestId:'init-'+createHash('sha256').update(JSON.stringify([repo.root,repo.repositoryKey,plan.relay,plan.name])).digest('hex')})).project;
  else project={room:plan.room,name:plan.name};
  joined=await local('workspace',{command:'join-local',room:project.room,root:repo.root,captureConversations:true,connectAgents:false});
 }
 if(!joined.project?.id)throw Error('The companion did not return a local project connection. Run spool init again to retry.');
 const enrollment=await local('discovery',{command:'approve-existing',cwd:repo.root,confirm:true});
 if(!enrollment.retrospective){const analyzeExisting=await yes('Analyze existing local chats into decisions, findings, tasks and handoffs in your next Codex session? Raw conversation sharing is unchanged.');
 await local('discovery',{command:'retrospective',cwd:repo.root,analyzeExisting,confirm:true});}
 await local('projects/select',{id:joined.project.id});
 const problems=[joined.captureError,joined.agentError].filter(Boolean);
 try{await connectCodex(state);}catch(error){problems.push(error.message);}
 say('\nConnected to '+plan.name+'. Shared project memory is ready.');
 if(problems.length){say('Codex setup needs attention: '+problems.join(' · ')+'\nRun spool init again to retry.');}
 else say('Codex is connected. Start a new Codex session to load shared context and automatic handoffs.');
 return {connected:true,project:joined.project,codexReady:!problems.length,problems};
}
