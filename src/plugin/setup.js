import {hostname} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {repositoryAt} from '../repository.js';
import {discoveryRequest} from '../discovery.js';
import {localCommand} from '../management-cli.js';
import {projectRequest} from '../project.js';
import {WorkspaceClient} from '../team/workspace-client.js';
import {isWorkspaceLink,parseWorkspaceLink} from '../team/workspace.js';
import {workspaceRequest} from '../team/workspace-client.js';
import {previewInvite} from '../desktop/join.js';
import {legacyFiles,migrateLegacy,trustedPluginHooks} from './migration.js';
export const setupTool={name:'spool_setup',description:'Set up SpoolDB entirely in Codex: workspace_status lists saved workspaces, workspace_preview checks an invite, workspace_connect accepts it, and workspace_switch selects a saved workspace by name. These workspace actions work without a Git folder. Project status/preview/connect create or join projects after separate sharing approval. Ask separately whether to analyze existing local chats: retrospective records the explicit choice; history reads paginated private local conversation sources only after approval; complete retrospective with the saved handoffId. Raw conversation sharing is independent. Preview or delete shared conversations with delete_conversations after explicit user approval. Also configure opt-in updater settings with updates, pause/resume capture or migrate old configuration. Never assume an ordinary prompt authorizes sharing. Secrets belong only in the invitation argument, never a shell command.',inputSchema:{type:'object',additionalProperties:false,properties:{action:{enum:['status','preview','connect','workspace_status','workspace_preview','workspace_connect','workspace_switch','workspace_sharing','project_sharing','delete_conversations','ignore','pause','resume','migrate','updates','retrospective','history']},analyzeExisting:{type:'boolean'},handoffId:{type:'string',minLength:1,maxLength:200},recordId:{type:'string',minLength:1,maxLength:200},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:20},sharing:{type:'object',additionalProperties:false,properties:{handoffs:{type:['boolean','null']},decisions:{type:['boolean','null']},findings:{type:['boolean','null']},tasks:{type:['boolean','null']},conversations:{type:['boolean','null']}}},updateMode:{enum:['off','check','automatic']},updateNow:{type:'boolean'},sessionId:{type:'string',minLength:1,maxLength:200},deletionToken:{type:'string',minLength:64,maxLength:64},requestId:{type:'string',minLength:1,maxLength:120},expectedRevision:{type:'integer',minimum:0},workspace:{type:'string',minLength:1,maxLength:300},root:{type:'string',minLength:1,maxLength:4096},invitation:{type:'string',minLength:1,maxLength:40000},project:{type:'string',minLength:1,maxLength:160},create:{type:'boolean'},name:{type:'string',minLength:1,maxLength:160},confirm:{type:'boolean'}},required:['action']},annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:true}};
export async function pluginSetup(state,input,{cwd=process.cwd(),pluginRoot,trust,codexHome}={}){
 if(input.action==='updates'){
  const {updateStatus,configureUpdates,checkUpdate,applyUpdate}=await import('../update.js');
  const {desktopPaths}=await import('../desktop/paths.js');
  const config={...updateStatus(state),state,target:'plugin',paths:desktopPaths(),app:pluginRoot?join(pluginRoot,'app'):new URL('../..',import.meta.url).pathname};
  if(input.updateMode!==undefined||input.updateNow){if(input.confirm!==true)throw Error('Explicit approval is required to configure or install updates');}
  if(input.updateMode!==undefined)return configureUpdates({...config,mode:input.updateMode});
  if(input.updateNow)return applyUpdate(config);
  return {...config,check:await checkUpdate(config),message:'Choose off, check or automatic updates. Automatic plugin updates wait for active sessions to finish. Codex still requires review for changed hooks.'};
 }
 const workspace=new WorkspaceClient(state);
 const workspaceStatus=async()=>{const saved=await workspace.run({command:'profiles'});let active;try{active=await workspace.run({command:'list'});}catch(error){active={connected:false,configured:saved.connected,connectionError:error.message};}return {kind:'workspace',...active,workspaces:saved.workspaces,requiresProjectApproval:true,message:'Workspace access does not start capture or change existing project connections. Choose a Git folder separately to create or join a shared project.'};};
 const workspaceInvite=input.invitation&&isWorkspaceLink(input.invitation);
 if(input.action==='delete_conversations'){const data=await workspace.run({command:'list'}),matches=(data.projects??[]).filter(p=>p.name.toLowerCase()===input.project?.toLowerCase());if(matches.length!==1)throw Error('Choose a shared project by its unique name');return workspace.run({command:'delete-conversations',room:matches[0].room,sessionId:input.sessionId,confirm:input.confirm===true,deletionToken:input.deletionToken,requestId:input.requestId??randomUUID()});}
 if(input.action==='project_sharing'){if(input.sharing!==undefined&&input.confirm!==true)throw Error('Explicit user approval is required to change project sharing');const data=await workspace.run({command:'list'}),matches=(data.projects??[]).filter(p=>p.room===input.project||p.name.toLowerCase()===input.project?.toLowerCase());if(matches.length!==1)throw Error('Choose a shared project by its unique name');return workspace.run({command:'project-sharing',room:matches[0].room,...(input.sharing!==undefined?{sharing:input.sharing,expectedRevision:input.expectedRevision}:{})});}
 if(input.action==='workspace_sharing'){if(input.sharing!==undefined&&input.confirm!==true)throw Error('Explicit user approval is required to change workspace sharing');return workspace.run({command:'sharing',...(input.sharing!==undefined?{sharing:input.sharing,expectedRevision:input.expectedRevision}:{})});}
 if(input.action==='workspace_status')return workspaceStatus();
 if(input.action==='workspace_preview'||input.action==='preview'&&workspaceInvite){if(!workspaceInvite)throw Error('Paste a workspace invitation');const preview=await workspaceRequest(parseWorkspaceLink(input.invitation),'preview');return {kind:'workspace',workspace:preview.workspace,role:preview.role,canCreate:preview.canCreate,requiresWorkspaceApproval:true,requiresProjectApproval:true};}
 if(input.action==='workspace_switch'){if(input.confirm!==true)throw Error('Explicit user approval is required to switch the active workspace');await workspace.run({command:'profiles'});await workspace.run({command:'switch',workspace:input.workspace});return workspaceStatus();}
 if(input.action==='workspace_connect'||input.action==='connect'&&workspaceInvite){if(!workspaceInvite)throw Error('Paste a workspace invitation');if(input.confirm!==true)throw Error('Explicit user approval is required to connect this workspace');await workspace.run({command:'connect',link:input.invitation,device:hostname()});return workspaceStatus();}
 const repo=repositoryAt(input.root??cwd),root=repo.root;
 const discovery=command=>discoveryRequest(state,{...command,cwd:root});
 const status=async()=>{const project=await discovery({command:'propose'}),local=project.status==='enrolled'?await projectRequest(project.controlDirectory,{command:'status',projectId:project.projectId}):null;
 return {root,companion:(await discovery({command:'list'})).companion,superproject:repo.superproject,status:project.status,projectId:project.projectId,room:project.room,project:local?.team?.project??local?.name??project.name,relay:local?.team?.url,capture:local?.codex??null,retrospective:project.retrospective??{status:'offered'},legacyConfiguration:legacyFiles(root,{codexHome}),hookReviewRequired:pluginRoot?!await trustedPluginHooks(root,pluginRoot).catch(()=>false):true,message:'Automatic lifecycle actions require the current plugin hooks to be reviewed and trusted in Codex.'};};
 const finishConnection=async()=>{
  if(typeof input.analyzeExisting==='boolean')await discovery({command:'retrospective',analyzeExisting:input.analyzeExisting,confirm:true});
  const result=await status();return {...result,requiresRetrospectiveChoice:result.retrospective.status==='offered',message:result.retrospective.status==='offered'?'Project connected. Ask: Analyze existing local chats and save decisions, findings, tasks and handoffs? Offer Analyze existing chats or Skip. This is separate from sharing raw conversations.':result.retrospective.status==='pending'?'Historical analysis approved and pending. Follow the setup skill retrospective workflow before marking it complete.':result.message};
 };
 if(input.action==='retrospective')return discovery({command:'retrospective',analyzeExisting:input.analyzeExisting,handoffId:input.handoffId,confirm:input.confirm});
 if(input.action==='history'){
  const selected=await discovery({command:'resolve'});if(selected.status!=='enrolled'||selected.retrospective?.status!=='pending')throw Error('Historical analysis needs explicit approval for this connected project');
  return projectRequest(selected.controlDirectory,{command:'local-history',projectId:selected.projectId,input:input.recordId?{command:'get',snapshot:selected.retrospective.chosenAt,id:input.recordId,offset:input.offset??0,limit:6000}:{command:'search',snapshot:selected.retrospective.chosenAt,kinds:['conversation'],offset:input.offset??0,limit:input.limit??20}});
 }
 if(input.action==='status')return status();
 if(input.action==='preview'){
  if(input.invitation){if(isWorkspaceLink(input.invitation)){const preview=await workspaceRequest(parseWorkspaceLink(input.invitation),'preview');return {root,kind:'workspace',workspace:preview.workspace,role:preview.role,requiresProjectApproval:true};}return {root,kind:'project',...await previewInvite(input.invitation,{directory:join(state,'p')}),requiresSharingApproval:true};}
  return discovery({command:'preview'});
 }
 if(input.action==='ignore')return discovery({command:'ignore'});
 if(input.action==='pause'||input.action==='resume'){
  if(input.action==='resume'&&input.confirm!==true)throw Error('Explicit approval is required to resume conversation capture');const selected=await discovery({command:'resolve'});if(selected.status!=='enrolled')throw Error('Connect this project first');
  await localCommand(state,input.action==='pause'?'codex/disconnect':'codex/connect',{}, {project:selected.projectId});return status();
 }
 if(input.action==='migrate')return migrateLegacy({state,root,pluginRoot,confirm:input.confirm,trust,codexHome});
 if(input.confirm!==true)throw Error('Explicit user approval is required before connecting and sharing saved conversations');
 if(input.invitation){
  const joined=await localCommand(state,'invites/join',{link:input.invitation,root,device:hostname(),captureConversations:true,connectAgents:false});if(joined.captureError)throw Error('Project connected but capture failed: '+joined.captureError);
  await discovery({command:'approve-existing',confirm:true});
 }else{
  const existing=await discovery({command:'resolve'});
  if(existing.status==='enrolled'&&!input.project&&!input.create&&!input.name){await localCommand(state,'codex/connect',{}, {project:existing.projectId});return finishConnection();}
  const data=await workspace.run({command:'list'});if(!data.connected)throw Error('Paste a project or workspace invitation to connect this machine first');
  if(input.create===true&&input.project)throw Error('Choose either creating a new project or joining an existing project');
  if(input.create===true&&repo.repositoryKey){const match=await workspace.run({command:'repository-match',repositoryKey:repo.repositoryKey});if(match.project||match.ambiguous)return {root,status:'join_available',existingProject:match.project,matchingProjects:match.projects??[match.project],requiresJoinApproval:true,message:'This repository is already registered. Show the existing shared project name and ask whether to join it or continue without SpoolDB. Do not create a duplicate or connect until the user approves joining.'};}
  let room;if(input.project){const matches=data.projects.filter(p=>p.name.toLowerCase()===input.project.toLowerCase());if(matches.length!==1)throw Error('Choose one available shared project by its unique name');room=matches[0].room;}
  else if(input.create!==true)throw Error('Choose an existing project or explicitly request creating one');
  if(!room&&!repo.repositoryKey){room=(await workspace.run({command:'create',name:input.name??repo.name,requestId:'plugin-'+createHash('sha256').update(JSON.stringify([root,data.relay,input.name??repo.name])).digest('hex')})).project.room;}
  await discovery({command:'approve',confirm:true,...(room?{room}:{create:true}),name:input.name??repo.name});
 }
 return finishConnection();
}
