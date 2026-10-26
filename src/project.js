import {localHistoryReader} from './local-history.js';
import {defaultEmbeddings} from './memory/embeddings.js';
import {repositoryAt} from './repository.js';
import {projectRequest} from './project-request.js';
import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, unlinkSync, existsSync } from 'node:fs';
import { resolve, join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createServer, createConnection } from 'node:net';
import { ShardedEngine } from './index.js';
import { Bridge } from './bridge.js';
import { RelayServer, SyncClient, createCredential } from './relay/index.js';
import { runHarness } from './adapters/index.js';
import { CodexHistory,storeNativeMessage } from './native-history.js';
import {RepositoryDiscovery,serveDiscovery} from './discovery.js';
import { ProjectManager } from './project-manager.js';
import {previewInvite,joinInvite} from './desktop/join.js';
import {readInbox,dismissInvite} from './desktop/inbox.js';
import {hostRequest} from './team/host.js';
import {WorkspaceClient} from './team/workspace-client.js';
import {TeamConnection} from './team/client.js';
import {connectCodexMemory,codexMemoryState} from './codex-connection.js';
import {existsSync as fileExists} from 'node:fs';
import { localApp } from './local-app.js';
const save=(path,value)=>{const temp=path+'.tmp';writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600});chmodSync(temp,0o600);renameSync(temp,path);};
const configAt=dir=>join(resolve(dir),'project.json');
export function initializeProject(dir,root,{exclude=[],captureFiles=true,onCreated=()=>{}}={}) {
  dir=resolve(dir);mkdirSync(dir,{mode:0o700});onCreated();
  const engine=new ShardedEngine(join(dir,'capture.sqlite'));
  try {
    const bridge=new Bridge(engine);root=repositoryAt(root).root;let capture;
    if(captureFiles){bridge.setExclusions(root,exclude);capture=bridge.attach('working',root);}else{engine.create('working');capture={files:0,excluded:[]};}
    engine.fork('working','main');
    const room=engine.ref('working').room,writer=createCredential('capture',{[room]:'write'}),reader=createCredential('review',{[room]:'read'});
    save(configAt(dir),{version:1,root,room,exclude,captureFiles,credentials:[writer.credential,reader.credential]});
    save(join(dir,'tokens.json'),{writer:writer.token,reader:reader.token});
    return {room,root,files:capture.files,excluded:capture.excluded};
  } finally {engine.close();}
}
export {projectRequest} from './project-request.js';
export async function startProject(dir,{port=8787,intervalMs=2000,onEvent=()=>{},runner=runHarness,history=new CodexHistory(),manageProjects=true,discoverRepositories=manageProjects,discoveryHandler,inviteInbox=process.env.SPOOL_INBOX,workspaceDirectory=dir}={}) {
  dir=resolve(dir);const config=JSON.parse(readFileSync(configAt(dir))),tokens=JSON.parse(readFileSync(join(dir,'tokens.json')));
  const socketPath=join(dir,'control.sock');
  if(existsSync(socketPath)) {
    try {await projectRequest(dir,{command:'status'});throw new Error('Project service is already running');}
    catch(error){if(error.code!=='ECONNREFUSED')throw error;unlinkSync(socketPath);}
  }
  const engine=new ShardedEngine(join(dir,'capture.sqlite')),bridge=new Bridge(engine),relay=new RelayServer(join(dir,'relay.sqlite'),{credentials:config.credentials,embeddings:await defaultEmbeddings()});
  const team=new TeamConnection(dir,relay.engine,config.room,config.root);
  let manager,discovery,closeDiscovery;const workspace=new WorkspaceClient(workspaceDirectory,{controlDirectory:dir,manager:async()=>manager});let lastSignature;let timer,busy=false,closing=false,cyclePromise=Promise.resolve(),runPromise=Promise.resolve(),activeRun;
  const integrationPath=join(dir,'integrations.json');
  const integration=existsSync(integrationPath)?JSON.parse(readFileSync(integrationPath)):{codex:false};
  let lastNativePoll=0;
  const state={id:config.room,name:basename(config.root),root:config.root,room:config.room,runningHarness:null,lastCapture:null,lastError:null,codex:{enabled:integration.codex,status:integration.codex?'connecting':'disconnected',threads:0,messages:0,lastSync:null,error:null}};
  const syncCodex=async()=>{
    if(!state.codex.enabled)return;lastNativePoll=Date.now();
    try{const result=await history.read(config.root,message=>storeNativeMessage(engine,'working',message));state.codex={...state.codex,status:'connected',threads:result.threads,messages:state.codex.messages+result.messages,lastSync:new Date().toISOString(),error:null};}
    catch(error){state.codex.status='error';state.codex.error=error.message;history.close();}
  };
  const control=createServer();let ownsSocket=false;
  const clients=new Map();
  async function publish(branch) {
    const ref=engine.ref(branch);const row=relay.engine.db.prepare('SELECT heads,revision FROM relay_review_branches WHERE room=? AND name=?').get(config.room,branch);const previous=row?{...row,heads:JSON.parse(row.heads)}:null;
    if(previous&&JSON.stringify(previous.heads)===JSON.stringify(ref.heads))return;
    let client=clients.get(branch);if(!client){client=new SyncClient(engine,{url:state.origin,room:config.room,branch,token:tokens.writer});clients.set(branch,client);}
    await client.publishBranch(branch,{expectedRevision:previous?.revision??0});
  }
  async function capture() {
    if(config.captureFiles===false){await publish('working');const observed={at:new Date().toISOString(),operations:0,files:0,mode:'memory-only'};state.lastCapture=observed;state.lastError=null;return observed;}
    const scan=bridge.scan(config.root),signature=createHash('sha256').update(JSON.stringify(scan)).digest('hex');
    const result=signature===lastSignature?{operations:0,files:Object.keys(scan.entries).length}:bridge.captureScan(scan);lastSignature=signature;const observed={at:new Date().toISOString(),operations:result.operations,files:result.files};
    await publish('working');state.lastCapture=observed;state.lastError=null;if(result.operations)onEvent({event:'project.captured',...state.lastCapture});return state.lastCapture;
  }
  const cycle=()=>{cyclePromise=cyclePromise.then(async()=>{if(!busy&&!closing){if(state.codex.enabled&&Date.now()-lastNativePoll>=10000)await syncCodex();await capture();if(team.config)try{await team.sync({background:true});}catch(error){onEvent({event:'team.sync-error',message:error.message});}}}).catch(error=>{state.lastError=error.message;onEvent({event:'project.error',message:error.message});});return cyclePromise;};
  const close=async()=>{
    if(closing)return;closing=true;clearInterval(timer);history.close();activeRun?.abort();await Promise.allSettled([runPromise,cyclePromise,team.tail]);
    await closeDiscovery?.();await manager?.close();if(ownsSocket)await new Promise(resolve=>control.close(resolve));if(ownsSocket&&existsSync(socketPath))unlinkSync(socketPath);
    await relay.close();engine.close();
  };
  try {
    const app={state,teamConnect:input=>team.connect(input),teamState:()=>team.publicState(),localHistory:localHistoryReader(relay.memory,config.room,dir),memory:(input,actor='local-agent')=>team.config?team.memory(input):(['search','context'].includes(input.command)&&input.query?relay.memory.retrieve(config.room,input,{id:actor}):relay.memory.run(config.room,input,{id:actor})),getState:()=>({...state,team:team.publicState()}),review:input=>({protocol:'spool-relay/1',room:config.room,...relay.review.run(config.room,input,{id:'local-review'})}),connect:async()=>{state.codex.enabled=true;state.codex.status='connecting';save(integrationPath,{codex:true});lastNativePoll=0;await cycle();},disconnect:async()=>{state.codex.enabled=false;state.codex.status='disconnected';history.close();save(integrationPath,{codex:false});await cyclePromise;state.codex.status='disconnected';},capture:async()=>{lastNativePoll=0;return cycle();}};
    if(manageProjects)manager=new ProjectManager(dir,{...app,state,close});
    relay.localHandler=localApp({discovery:input=>discoveryHandler?discoveryHandler(input):discovery.run(input),workspace:input=>workspace.run(input),invitePending:()=>readInbox(inviteInbox??join(dir,'pending-invite.json'))[0]??null,inviteDismiss:link=>dismissInvite(inviteInbox??join(dir,'pending-invite.json'),link),invitePreview:link=>previewInvite(link,{directory:dir}),inviteJoin:input=>joinInvite({directory:dir,manager,link:input.link,root:input.root,device:input.device,captureConversations:input.captureConversations!==false,connectAgents:input.connectAgents!==false}),teamHost:input=>hostRequest(process.env.SPOOL_TEAM_HOST??join(dirname(dir),'shared-relay'),input),connectAgents:project=>connectCodexMemory({directory:dir,discoveryDirectory:workspaceDirectory,room:project.id,root:project.root}),getAgentState:project=>codexMemoryState({directory:dir,discoveryDirectory:workspaceDirectory,root:project.root}),getOrigin:()=>state.origin,...app,projects:manager,memorySetup:project=>({mcpServers:{spool:{command:process.execPath,args:[fileURLToPath(new URL('./memory-mcp.js',import.meta.url)),dir,'--project',project.id]}}})});
    state.origin=await relay.listen({port});state.url=`${state.origin}/review/#room=${config.room}&branch=working&compare=main`;
    await publish('main');await capture();
    if(manageProjects){await new Promise((resolve,reject)=>{control.once('error',reject);control.listen(socketPath,resolve);});ownsSocket=true;chmodSync(socketPath,0o600);}
    control.on('connection',socket=>{
      let data='',handled=false;socket.setTimeout(3605000,()=>socket.destroy());
      const send=value=>{if(!socket.destroyed)socket.write(JSON.stringify(value)+'\n');};
      socket.on('error',()=>{});
      socket.on('data',chunk=>{
        if(handled)return;data+=chunk.toString();if(Buffer.byteLength(data)>1100000){handled=true;socket.end(JSON.stringify({done:true,error:'Request exceeds limit'})+'\n');return;}
        const end=data.indexOf('\n');if(end<0)return;handled=true;
        (async()=>{
          const request=JSON.parse(data.slice(0,end));
          if(request.command==='status')return (request.projectId&&request.projectId!==state.id?await manager.get(request.projectId):app).getState();
          if(request.command==='team-connect')return (request.projectId&&request.projectId!==state.id?await manager.get(request.projectId):app).teamConnect(request.input);
          if(request.command==='local-history')return (request.projectId&&request.projectId!==state.id?await manager.get(request.projectId):app).localHistory(request.input);
          if(request.command==='memory'){const selectedApp=request.projectId&&request.projectId!==state.id?await manager.get(request.projectId):app;if(request.actor!==undefined&&(typeof request.actor!=='string'||request.actor.length>128))throw new Error('Invalid agent identity');return selectedApp.memory(request.input,request.actor??'local-agent');}
          if(request.command==='capture'){if(request.projectId&&request.projectId!==state.id){const selected=await manager.get(request.projectId);await selected.capture();return selected.getState();}lastNativePoll=0;if(busy)throw new Error('A harness is running; capture occurs at its tool boundaries.');await cycle();if(state.lastError)throw new Error(state.lastError);return {...state};}
          if(request.command!=='run'||!['codex','claude'].includes(request.harness))throw new Error('Expected status, capture, or run codex|claude');
          if(busy)throw new Error('A harness is already running for this checkout');
          busy=true;state.runningHarness=request.harness;activeRun=new AbortController();const abort=()=>activeRun?.abort();socket.once('close',abort);
          runPromise=(async()=>{
            try {
              await cyclePromise;
              const result=await runner(engine,{root:config.root,branch:'working',harness:request.harness,prompt:request.prompt,write:request.write===true,timeoutMs:600000,signal:activeRun.signal,onRecord:record=>send({event:record.event})});
              await capture();return result;
            } finally {socket.removeListener('close',abort);state.runningHarness=null;activeRun=null;busy=false;}
          })();return await runPromise;
        })().then(result=>send({done:true,result}),error=>send({done:true,error:error.message}));
      });
    });
    if(discoverRepositories){discovery=new RepositoryDiscovery(workspaceDirectory,{workspace,manager:async()=>manager,controlDirectory:dir,origin:()=>state.origin});closeDiscovery=await serveDiscovery(discovery);}
    save(join(dir,'review.json'),{url:state.url,room:config.room});const schedule=()=>{timer=setTimeout(async()=>{await cycle();if(!closing)schedule();},intervalMs);};schedule();onEvent({event:'project.ready',...state});
    if(manager)for(const project of manager.list())if(project.id!==state.id)try{await manager.get(project.id);}catch(error){onEvent({event:'project.start-error',projectId:project.id,message:error.message});}
    return {state,close,app,manager};
  } catch(error){await close();throw error;}
}
