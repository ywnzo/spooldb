import {readFileSync,existsSync,writeFileSync,renameSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createInterface} from 'node:readline/promises';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {desktopPaths,defaultState} from './desktop/paths.js';
import {WorkspaceClient} from './team/workspace-client.js';
import {hostRequest} from './team/host.js';
import {containerRequest} from './server-vps.js';
import {enableDiscovery} from './discovery-install.js';
import {projectRequest} from './project.js';
import {launch} from './desktop/launcher.js';
export const managementHelp=`SpoolDB management CLI
Usage: spool COMMAND [--state DIR] [--json]

  update [check|status|enable|disable] [--target plugin|client] [--yes]
                                              Daily opt-in updates; run without a subcommand to update now
  plugin install                              Install the self-contained Codex plugin
  init                                        Connect the current Git project interactively
  deploy cloudflare [--dry-run | --resume] [--name NAME] [--account-id ID]
  discovery enable | list
  discovery propose|preview|approve|ignore FOLDER [--room ROOM] [--name NAME]
  status                                      Local capture status
  workspace connect [--invite-file FILE | --invite-stdin] [--device NAME]
  workspace status | projects | members | saved | disconnect
  project sharing [NAME]                     Guided per-project category overrides
  workspace sharing                          Guided category sharing settings
  workspace switch NAME
  workspace create NAME [--request-id KEY]
  workspace invite                            Guided invitation (flags optional)
    [--label NAME] [--no-create | --allow-create] [--role member|reader|writer|admin]
  workspace revoke MEMBER_ID
  project list | add FOLDER | select LOCAL_ID
  project join PROJECT_NAME FOLDER [--no-capture] [--no-agents]
  project accept-invite [--invite-file FILE | --invite-stdin]
  project invite [PROJECT_NAME] [--label NAME]
  project connections [PROJECT_NAME]
  project revoke PROJECT_NAME CONNECTION_LABEL
  project join-invite FOLDER [--invite-file FILE | --invite-stdin]
  project capture | status | pause | resume | agents
  memory context [--task ID] | search QUERY | get ID
  memory remember --title TITLE --text-file FILE [--kind decision|finding|blocker]
  memory task TASK_ID --revision N --status STATUS --title TITLE --text-file FILE
  memory handoff --task TASK_ID --title TITLE --text-file FILE --next-step TEXT
  Memory writes accept repeated --file PATH, --ref ID and --next-step TEXT.
  server setup | status
  server workspace init NAME | owner-invite
  server project create NAME | invite ROOM [--label NAME] | revoke ROOM MEMBER
  project delete-conversations [PROJECT] [--dry-run | --yes]
  service client|server start|stop|restart|status|logs

Workspace commands work headlessly without a local web service.
Local project operations use the running companion, starting an installed companion if needed.
Use --server-state DIR for server-local administration; Unix socket ownership is required.
Invites are prompted for, read from a file or stdin; avoid putting them in shell history.
The server exposes an API, not a hosted administration dashboard. The local UI and CLI use that API.`;
export function parseManagementArgs(args){const options={},words=[];const flags=new Set(['json','invite-stdin','allow-create','no-create','no-capture','no-agents','help','text-stdin','yes','dry-run','resume','connect','no-connect']);for(let i=0;i<args.length;i++){const value=args[i];if(value.startsWith('--')){const [key,inline]=value.slice(2).split(/=(.*)/s,2);if(['file','ref','next-step','blocker','resolve-id'].includes(key)){const next=inline??args[++i];if(!next||next.startsWith('--'))throw new Error('Missing value for --'+key);(options[key]??=[]).push(next);}else if(flags.has(key)){if(inline!==undefined)throw new Error('Unexpected value for --'+key);options[key]=true;}else{if(!['state','server-state','invite-file','device','label','role','request-id','project','task','local-url','title','text-file','kind','revision','status','offset','limit','room','name','account-id','workspace-name','deploy-dir','url','target','mode'].includes(key))throw new Error('Unknown option --'+key);const next=inline??args[++i];if(!next||next.startsWith('--'))throw new Error('Missing value for --'+key);options[key]=next;}}else words.push(value);}return {options,words};}
async function invite(options,io){if(options['invite-file'])return readFileSync(resolve(options['invite-file']),'utf8').trim();if(options['invite-stdin'])return readFileSync(0,'utf8').trim();if(!io.input.isTTY)throw new Error('Supply --invite-file FILE or --invite-stdin');const rl=createInterface({input:io.input,output:io.output});try{return (await rl.question('Paste the private invitation link: ')).trim();}finally{rl.close();}}
function localOrigin(value){const url=new URL(value);if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('The companion URL must be loopback HTTP');return url.origin;}
export async function localCommand(state,path,input,options={}){
 let origin=options['local-url'],setup=false;
 if(!origin&&existsSync(join(state,'service.json'))){const service=JSON.parse(readFileSync(join(state,'service.json')));origin=service.origin;setup=service.mode==='setup';}
 if(!origin&&existsSync(join(state,'review.json')))origin=new URL(JSON.parse(readFileSync(join(state,'review.json'))).url).origin;
 if(!origin&&path==='status')return {running:false,configured:existsSync(join(state,'workspace.json'))};
 if(!origin){origin=(await launch({root:state,noOpen:true})).origin;setup=JSON.parse(readFileSync(join(state,'service.json'))).mode==='setup';}
 origin=localOrigin(origin);try{const health=await fetch(origin+'/healthz',{signal:AbortSignal.timeout(2000),redirect:'error'});if(!health.ok)throw new Error('Companion is unavailable');}catch{if(path==='status')return {running:false,origin};if(options['local-url']||!existsSync(join(state,'service.json'))||existsSync(join(state,'project.json')))throw new Error('The companion is not running. Use spool service client start');origin=(await launch({root:state,noOpen:true})).origin;setup=JSON.parse(readFileSync(join(state,'service.json'))).mode==='setup';}
 const preferences=join(state,'cli.json'),selected=options.project??(existsSync(preferences)?JSON.parse(readFileSync(preferences)).project:null);
 origin=localOrigin(origin);
 if(setup&&path==='status')return {setup:true,origin,notice:'Waiting for a project. Connect a workspace and join a project, or use project add.'};if(setup&&path==='projects')return {projects:[]};if(setup&&path==='projects/add')path='join';if(setup&&path==='invites/join')path='join';
 if(setup&&!['workspace','join','discovery'].includes(path))throw new Error('Connect a workspace and join a project first');
 const prefix=setup?'api':'local',session=await fetch(origin+'/'+prefix+'/session',{headers:{'sec-fetch-site':'same-origin'},signal:AbortSignal.timeout(10000),redirect:'error'}),cookie=session.headers.get('set-cookie')?.split(';')[0],auth=await session.json();if(!session.ok||!cookie)throw new Error('Cannot authenticate with the local companion');const configPath=existsSync(join(state,'project.json'))?join(state,'project.json'):join(state,'p/project.json');if(!setup&&existsSync(configPath)&&auth.project?.id!==JSON.parse(readFileSync(configPath)).room)throw new Error('Companion belongs to a different state directory');
 const response=await fetch(origin+'/'+prefix+'/'+path,{method:input?'POST':'GET',headers:{origin,'sec-fetch-site':'same-origin',cookie,'x-spool-csrf':auth.csrf,...(selected?{'x-spool-project':selected}:{}),...(input?{'content-type':'application/json'}:{})},...(input?{body:JSON.stringify(input)}:{}),signal:AbortSignal.timeout(60000),redirect:'error'});const result=await response.json();if(!response.ok)throw new Error(typeof result.error==='string'?result.error:result.error?.message??'Companion request failed');if(path==='projects/select'){writeFileSync(preferences+'.tmp',JSON.stringify({project:result.id})+'\n',{mode:0o600});renameSync(preferences+'.tmp',preferences);}return result;
}
export function resolveProjectName(projects,selector){
 const exact=projects.find(p=>p.room===selector);if(exact)return exact;
 const matches=projects.filter(p=>p.name.toLowerCase()===selector.toLowerCase());
 if(matches.length===1)return matches[0];
 if(matches.length>1)throw new Error('Several projects are named '+selector+'. Run spool project invite without a name to choose one.');
 throw new Error('No shared project named '+selector+'. Run spool workspace projects to see your projects.');
}
export async function workspaceInviteOptions(options,{ask,output}={}){
 if(options['no-create']&&options['allow-create'])throw Error('Choose either --no-create or --allow-create');
 let label=options.label,role=options.role,canCreate=options['no-create']?false:options['allow-create']?true:undefined;
 if(ask){
  if(label===undefined){do{label=await ask('Who is this invitation for?','Teammate');if(!label.trim()||label.length>120)output?.write('Enter a name of 1–120 characters.\n');}while(!label.trim()||label.length>120);}
  if(role===undefined){
   output?.write('\nProject access (all projects includes future projects):\n1. All projects — read and write memory\n2. All projects — read only\n3. Selected projects only\n4. Workspace administrator\n');
   const roles={'1':'writer','2':'reader','3':'member','4':'admin'};
   while(!role){const answer=await ask('Choose access','1');role=roles[answer]??(['writer','reader','member','admin'].includes(answer)?answer:undefined);if(!role)output?.write('Choose 1, 2, 3 or 4.\n');}
  }
  if(canCreate===undefined){
   let answer;do{answer=(await ask('Allow creating shared projects? (y/n)','N')).toLowerCase();if(!['y','yes','n','no'].includes(answer))output?.write('Enter yes or no.\n');}while(!['y','yes','n','no'].includes(answer));canCreate=['y','yes'].includes(answer);
  }
 }
 if(label!==undefined&&(!label.trim()||label.length>120))throw Error('Enter a name of 1–120 characters');
 if(role!==undefined&&!['member','reader','writer','admin'].includes(role))throw Error('Choose role member, reader, writer or admin');
 return {label:label?.trim()??'Teammate',role:role??'member',canCreate:canCreate??true};
}
export async function runManagement(args,{input=process.stdin,output=process.stdout}={}){
 process.umask(0o077);const {options,words}=parseManagementArgs(args),[group,action,...rest]=words;
 const print=value=>output.write(typeof value==='string'?value+'\n':!options.json&&value?.link?(value.browserLink??value.link)+'\n'+(value.expiresAt?'Expires: '+value.expiresAt+'\n':''):JSON.stringify(value,null,options.json?0:2)+'\n');
 if(options.help||!group){print(managementHelp);return;}
 const state=resolve(options.state??process.env.SPOOL_STATE??defaultState()),serverState=resolve(options['server-state']??process.env.SPOOL_SERVER_STATE??join(desktopPaths().state,'spool-server'));
 if(group==='update'){
  const {updateStatus,configureUpdates,checkUpdate,applyUpdate}=await import('./update.js');
  const paths=desktopPaths(),target=options.target??(existsSync(join(paths.data,'spool/installation.json'))?'client':'plugin');
  if(!['plugin','client'].includes(target))throw Error('Choose --target plugin or client');
  const config={...updateStatus(state,target),target,paths,state,app:resolve(new URL('..',import.meta.url).pathname)};
  if(action==='status'){print(config);return;}
  if(action==='disable'||action==='enable'){
   const mode=action==='disable'?'off':options.mode??'automatic';
   if(action==='enable'&&!options.yes){if(!input.isTTY)throw Error('Use --yes to opt in to scheduled updates');const rl=createInterface({input,output});try{if(!/^y(es)?$/i.test((await rl.question('Enable daily '+mode+' updates for '+target+'? Changed plugin hooks still require review. (y/N): ')).trim()))return;}finally{rl.close();}}
   print(configureUpdates({...config,mode}));return;
  }
  if(action&&action!=='check')throw Error('Use spool update [check|status|enable|disable]');
  const checked=await checkUpdate(config);if(action==='check'||!checked.available){print(checked);return;}
  if(!options.yes){if(!input.isTTY)throw Error('Update available: '+checked.latest+'. Run spool update --yes to install it.');const rl=createInterface({input,output});try{if(!/^y(es)?$/i.test((await rl.question('Update '+target+' from '+checked.current+' to '+checked.latest+'? (y/N): ')).trim()))return;}finally{rl.close();}}
  print(await applyUpdate(config));return;
 }
 if(group==='plugin'){if(action!=='install')throw Error('Use spool plugin install');const {installPlugin}=await import('./plugin/package.js');print(installPlugin({state}));return;}
 if(group==='init'){if(action)throw new Error('Run spool init from inside your Git project folder.');if(!input.isTTY)throw new Error('spool init needs an interactive terminal so you can choose a project and approve sharing.');const {initializeCheckout}=await import('./init.js');const rl=createInterface({input,output});try{const result=await initializeCheckout({state,options,output,workspace:input=>new WorkspaceClient(state).run(input),local:(path,body,selected={})=>localCommand(state,path,body,{...options,...selected}),ask:async(label,value='')=>(await rl.question(label+(value?' ['+value+']':'')+': ')).trim()||value});if(options.json)print(result);if(result.problems?.length)process.exitCode=1;}finally{rl.close();}return;}
 if(group==='deploy'){if(action!=='cloudflare')throw new Error('Use spool deploy cloudflare');const {deployCloudflare}=await import('./deploy/cloudflare.js');const result=await deployCloudflare({state,options,input,output});if(options.json)print(result);return;}
 let workspace;const ws=input=>(workspace??=new WorkspaceClient(state)).run(input);
 const sharedProject=async selector=>{
  const data=await ws({command:'list'}),projects=data.projects??[];if(!data.connected)throw new Error('Connect to a workspace first.');
  if(selector)return resolveProjectName(projects,selector);
  try{const current=await localCommand(state,'status',undefined,options);if(current.team?.url===data.relay){const selected=projects.find(p=>p.room===current.team.room);if(selected)return selected;}}catch{}
  if(projects.length===1)return projects[0];if(!projects.length)throw new Error('This workspace has no projects yet.');
  if(!input.isTTY)throw new Error('Specify a project name, for example: spool project invite Wield');
  output.write(projects.map((p,i)=>`${i+1}. ${p.name}`).join('\n')+'\n');const rl=createInterface({input,output});try{const selected=projects[Number(await rl.question('Choose a project: '))-1];if(!selected)throw new Error('Choose one of the numbered projects');return selected;}finally{rl.close();}
 };

 const need=(value,message)=>{if(!value)throw new Error(message);return value;};const local=(path,body)=>localCommand(state,path,body,options);
 if(group==='discovery'){
  if(action==='enable'){print(await enableDiscovery(state));return;}
  const cwd=action==='list'?undefined:resolve(rest[0]??process.cwd());
  if(action==='approve'){
   const preview=await local('discovery',{command:'preview',cwd});print(preview);
   if(!options.yes){if(!input.isTTY)throw new Error('Explicit approval required: use an interactive terminal or --yes after user confirmation');const rl=createInterface({input,output});let answer;try{answer=await rl.question('Connect this checkout and share its Codex conversations and memory? [y/N] ');}finally{rl.close();}if(!/^y(es)?$/i.test(answer.trim())){print({connected:false,cancelled:true});return;}}
   print(await local('discovery',{command:'approve',cwd,confirm:true,...(options.room?{room:options.room}:{}),...(options.name?{name:options.name}:{})}));return;
  }
  if(!['list','propose','preview','ignore'].includes(action))throw new Error('Use discovery enable|list|propose|preview|approve|ignore');print(await local('discovery',{command:action,...(cwd?{cwd}:{})}));return;
 }
 if(group==='workspace'){
  if(action==='connect'){const link=await invite(options,{input,output});print(await ws({command:'connect',link,device:options.device}));return;}
  if(['status','projects','members'].includes(action)){const result=await ws({command:'list'});print(action==='projects'?result.projects??[]:action==='members'?result.members??[]:result);return;}
  if(action==='sharing'){const current=await ws({command:'sharing'});if(!input.isTTY||options.json){print(current);return;}const rl=createInterface({input,output});try{const sharing={};for(const [key,value]of Object.entries(current.sharing)){const answer=(await rl.question(`Share ${key}? (${value?'Y/n':'y/N'}): `)).trim().toLowerCase();if(answer&&!['y','yes','n','no'].includes(answer))throw Error('Answer yes or no; settings were not changed');sharing[key]=answer?['y','yes'].includes(answer):value;}print(await ws({command:'sharing',sharing,expectedRevision:current.sharingRevision}));}finally{rl.close();}return;}
  if(action==='create'){print(await ws({command:'create',name:need(rest[0],'Specify the project name (quote names containing spaces)'),requestId:options['request-id']??randomUUID()}));return;}
  if(action==='invite'){
   let rl;try{
    const interactive=input.isTTY&&!options.json;
    const ask=interactive?async(label,value='')=>{rl??=createInterface({input,output});return (await rl.question(label+(value?' ['+value+']':'')+': ')).trim()||value;}:null;
    const invitation=await workspaceInviteOptions(options,{ask,output});
    print(await ws({command:'invite-member',...invitation}));
   }finally{rl?.close();}return;
  }
  if(action==='revoke'){print(await ws({command:'revoke-member',memberId:need(rest[0],'Specify a member ID')}));return;}
  if(action==='saved'){print(await ws({command:'profiles'}));return;}
  if(action==='switch'){print(await ws({command:'switch',workspace:need(rest[0],'Choose a saved workspace name')}));return;}
  if(action==='disconnect'){print(await ws({command:'disconnect'}));return;}
 }
 if(group==='project'){
  if(action==='delete-conversations'){const project=await sharedProject(rest[0]),preview=await ws({command:'delete-conversations',room:project.room});print({...preview,project:project.name});if(options['dry-run']||!preview.messages)return;if(!options.yes){if(!input.isTTY)throw Error('Deletion requires an interactive confirmation or --yes after user approval');const rl=createInterface({input,output});try{if(!/^y(es)?$/i.test((await rl.question(`Delete ${preview.messages} shared messages from ${project.name}? Local chats and other memory stay. (y/N): `)).trim()))return;}finally{rl.close();}}print(await ws({command:'delete-conversations',room:project.room,confirm:true,deletionToken:preview.deletionToken,requestId:options['request-id']??randomUUID()}));return;}

  if(action==='sharing'){const project=await sharedProject(rest[0]),current=await ws({command:'project-sharing',room:project.room});if(!input.isTTY||options.json){print(current);return;}const rl=createInterface({input,output});try{const sharing={};for(const [key,value]of Object.entries(current.overrides)){const defaultValue=value===null?'inherit':value?'shared':'private';const answer=(await rl.question(`${key}: shared/private/inherit [${defaultValue}]: `)).trim().toLowerCase()||defaultValue;if(!['shared','private','inherit'].includes(answer))throw Error('Choose shared, private, or inherit; settings were not changed');sharing[key]=answer==='inherit'?null:answer==='shared';}print(await ws({command:'project-sharing',room:project.room,sharing,expectedRevision:current.sharingRevision}));}finally{rl.close();}return;}
  if(['connections','revoke'].includes(action)){const project=await sharedProject(rest[0]),data=await ws({command:'project-members',room:project.room});if(action==='connections'){print(data);return;}const selector=need(rest[1],'Specify a connection label'),matches=data.members.filter(m=>!m.revoked&&(m.id===selector||m.label===selector));if(matches.length!==1)throw new Error('Connection label must match one active connection; use spool project connections');print(await ws({command:'revoke-project-member',room:project.room,memberId:matches[0].id}));return;}
  if(action==='invite'){print(await ws({command:'invite-project',room:(await sharedProject(rest[0])).room,label:options.label??'Teammate',role:options.role??'write'}));return;}
  if(action==='accept-invite'){print(await ws({command:'accept-project',link:await invite(options,{input,output})}));return;}
  if(action==='join'){print(await local('workspace',{command:'join-local',room:(await sharedProject(need(rest[0],'Specify a project name'))).room,root:resolve(need(rest[1],'Specify a local Git checkout')),captureConversations:!options['no-capture'],connectAgents:!options['no-agents']}));return;}
  if(action==='join-invite'){print(await local('invites/join',{link:await invite(options,{input,output}),root:resolve(need(rest[0],'Specify a local Git checkout')),device:options.device??'CLI client',captureConversations:!options['no-capture'],connectAgents:!options['no-agents']}));return;}
  if(action==='list'){print(await local('projects'));return;}
  if(action==='add'){print(await local('projects/add',{root:resolve(need(rest[0],'Specify a local Git checkout')),connectCodex:false}));return;}
  if(action==='select'){print(await local('projects/select',{id:need(rest[0],'Specify a local project ID')}));return;}
  const controls={status:['status'],capture:['capture',{}],pause:['codex/disconnect',{}],resume:['codex/connect',{}],agents:['agents/connect',{}]};if(controls[action]){print(await local(...controls[action]));return;}
 }
 if(group==='status'){print(await local('status'));return;}
 if(group==='memory'){const command={context:'context',search:'search',get:'get'}[action];if(command){print(await local('memory',{command,...(['search','context'].includes(action)?{query:rest.join(' ')}:{}),...(action==='get'?{id:need(rest[0],'Specify a memory record ID')}:{}),...(options.task?{taskId:options.task}:{}),...(options.offset?{offset:Number(options.offset)}:{}),...(options.limit?{limit:Number(options.limit)}:{}),...(action==='search'&&options.kind?{kinds:[options.kind]}:{})}));return;}}
 if(group==='memory'&&['remember','handoff','task'].includes(action)){
  const status=await local('status');if(status.setup)throw new Error('Join or add a project before recording memory');
  const text=options['text-file']?readFileSync(resolve(options['text-file']),'utf8'):options['text-stdin']?readFileSync(0,'utf8'):null;need(text,'Supply --text-file FILE or --text-stdin');need(options.title,'Supply --title TITLE');
  const command=action==='task'?'task_update':action,body={command,title:options.title,text,requestId:options['request-id']??randomUUID(),files:options.file??[],refs:options.ref??[],...(options.task?{taskId:options.task}:{}),...(action==='remember'?{kind:options.kind??'finding'}:{}),...(action==='handoff'?{nextSteps:options['next-step']??[],blockers:options.blocker??[]}:{})};
  if(action==='task'){body.taskId=need(rest[0],'Supply a task ID');body.expectedRevision=Number(need(options.revision,'Supply --revision (0 creates a task)'));body.status=need(options.status,'Supply --status');body.resolveIds=options['resolve-id']??[];}
  const preferences=join(state,'cli.json'),projectId=options.project??(existsSync(preferences)?JSON.parse(readFileSync(preferences)).project:null),directory=existsSync(join(state,'project.json'))?state:join(state,'p');print(await projectRequest(directory,{command:'memory',projectId,actor:'spool-cli',input:body}));return;
 }
 if(group==='server'){
  if(action==='setup'){const {interactiveServerSetup}=await import('./server-setup.js');await interactiveServerSetup();return;}
  let request;if(action==='status')request={command:'list'};
  if(action==='workspace'&&rest[0]==='init')request={command:'workspace-init',name:need(rest[1],'Specify the workspace name')};
  if(action==='workspace'&&rest[0]==='owner-invite')request={command:'workspace-owner-invite'};
  if(action==='project'&&rest[0]==='create')request={command:'create',name:need(rest[1],'Specify a project name')};
  if(action==='project'&&rest[0]==='invite')request={command:'create-invite',room:need(rest[1],'Specify a room ID'),label:options.label??'Teammate'};
  if(action==='project'&&rest[0]==='revoke')request={command:'revoke',room:need(rest[1],'Specify a room ID'),memberId:need(rest[2],'Specify a member ID')};
  if(request){print(await (process.env.SPOOL_CONTAINER_CONFIG?containerRequest(process.env.SPOOL_CONTAINER_CONFIG,request):hostRequest(serverState,request)));return;}
 }
 if(group==='service'){const unit={client:'spool.service',server:'spool-shared.service'}[action],operation=rest[0];if(!unit||!['start','stop','restart','status','logs'].includes(operation))throw new Error('Use service client|server start|stop|restart|status|logs');try{const result=execFileSync(operation==='logs'?'journalctl':'systemctl',operation==='logs'?[...(action==='server'&&process.env.SPOOL_SYSTEM_SERVICE==='1'?[]:['--user']),'-u',unit,'-n','100','--no-pager']:[...(action==='server'&&process.env.SPOOL_SYSTEM_SERVICE==='1'?[]:['--user']),operation,unit,'--no-pager'],{encoding:'utf8',timeout:15000});if(result)print(result.trim());}catch(error){if(error.stdout)print(error.stdout.trim());throw new Error('Service command failed; check the service output');}return;}
 throw new Error('Unknown management command. Run spool --help');
}
