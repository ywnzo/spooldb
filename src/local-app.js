import {randomBytes,timingSafeEqual} from 'node:crypto';
import {readJson,RelayError} from './relay/wire.js';
const fail=(ok,message,status=403)=>{if(!ok)throw new RelayError('LOCAL_ACCESS',message,status);};
export function localApp({discovery,workspace,getOrigin,getState,review,connect,disconnect,capture,projects,memory,memorySetup,connectAgents,getAgentState,teamConnect,teamState,teamHost,invitePending,inviteDismiss,invitePreview,inviteJoin}){
  const sessions=new Map();const primary={getState,review,connect,disconnect,capture,memory,teamConnect,teamState};
  const action=async fn=>{try{return await fn();}catch(error){if(error instanceof RelayError)throw error;throw new RelayError('PROJECT_ERROR',error.message,400);}};
  const selected=async(req,session)=>projects?{...await action(()=>projects.get(req.headers['x-spool-project']??session.projectId))}:primary;
  return async(req,res,path)=>{
    if(path==='/'&&req.method==='GET'){res.writeHead(302,{location:'/review/','cache-control':'no-store'});res.end();return true;}
    if(!path.startsWith('/local/'))return false;
    const origin=getOrigin();fail(req.headers.host===new URL(origin).host,'Open the app using its local address.');
    fail(['127.0.0.1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress),'Local access only.');
    fail(req.headers['sec-fetch-site']==='same-origin','Open SpoolDB in this browser first.');
    if(req.headers.origin)fail(req.headers.origin===origin,'Origin does not match.');
    const send=(status,value,extra={})=>{const body=JSON.stringify(value);res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-length':Buffer.byteLength(body),...extra});res.end(body);};
    if(path==='/local/session'&&req.method==='GET'){
      const now=Date.now();for(const [key,s]of sessions)if(s.expires<now)sessions.delete(key);
      if(sessions.size>=128)sessions.delete(sessions.keys().next().value);
      const preferred=/\bspool_project=([a-f0-9-]{36})(?:;|$)/.exec(req.headers.cookie??'')?.[1];
      const projectId=projects?.list().some(p=>p.id===preferred)?preferred:getState().id;
      const project=projects?(await action(()=>projects.get(projectId))).getState():getState();
      const token=randomBytes(32).toString('base64url'),csrf=randomBytes(32).toString('base64url');sessions.set(token,{csrf,projectId,expires:now+12*60*60*1000});
      send(200,{csrf,project},{'set-cookie':`spool_local=${token}; HttpOnly; SameSite=Strict; Path=/local; Max-Age=43200`});return true;
    }
    const cookie=/\bspool_local=([A-Za-z0-9_-]{43})(?:;|$)/.exec(req.headers.cookie??'')?.[1],session=sessions.get(cookie);
    fail(session&&session.expires>Date.now(),'Your local session expired. Reload the page.',401);
    const csrf=Buffer.from(req.headers['x-spool-csrf']??''),expected=Buffer.from(session.csrf);fail(csrf.length===expected.length&&timingSafeEqual(csrf,expected),'Invalid local session.');
    if(path==='/local/invites/pending'&&req.method==='GET'&&invitePending){send(200,{pending:invitePending()});return true;}
    if(path==='/local/projects'&&req.method==='GET'&&projects){send(200,{projects:projects.list()});return true;}
    if(path==='/local/agents'&&req.method==='GET'&&getAgentState){send(200,getAgentState((await selected(req,session)).getState()));return true;}
    if(path==='/local/memory-setup'&&req.method==='GET'&&memorySetup){send(200,memorySetup((await selected(req,session)).getState()));return true;}
    if(path==='/local/status'&&req.method==='GET'){send(200,(await selected(req,session)).getState());return true;}
    fail(req.method==='POST','Unsupported method.',405);fail(/^application\/json(?:;|$)/.test(req.headers['content-type']??''),'Use JSON.',415);
    fail(!req.headers['content-length']||Number(req.headers['content-length'])<=1000000,'Request exceeds limit.',413);const input=await readJson(req);fail(input&&typeof input==='object'&&!Array.isArray(input),'Expected a project action.',400);
    if(path==='/local/discovery'&&discovery){send(200,await action(()=>discovery(input)));}
    else if(path==='/local/workspace'&&workspace){const result=await action(()=>workspace(input));if(input.command==='connect')await inviteDismiss?.(input.link);if(result.joined)session.projectId=result.project.id;send(200,result,result.joined?{'set-cookie':`spool_project=${result.project.id}; HttpOnly; SameSite=Strict; Path=/local; Max-Age=31536000`}:{});}
    else if(path==='/local/invites/preview'&&invitePreview){send(200,await action(()=>invitePreview(input.link)));}
    else if(path==='/local/invites/dismiss'&&inviteDismiss){await inviteDismiss(input.link);send(200,{dismissed:true});}
    else if(path==='/local/invites/join'&&inviteJoin){const result=await action(()=>inviteJoin(input));session.projectId=result.project.id;await inviteDismiss?.(input.link);send(200,result,{'set-cookie':`spool_project=${result.project.id}; HttpOnly; SameSite=Strict; Path=/local; Max-Age=31536000`});}
    else if(path==='/local/team/host'&&teamHost){send(200,await action(()=>teamHost(input)));}
    else if(path==='/local/projects/add'&&projects){send(200,await action(()=>projects.add(input)));}
    else if(path==='/local/projects/browse'&&projects){send(200,await projects.pick());}
    else if(path==='/local/projects/select'&&projects){
      fail(typeof input.id==='string','Choose a project.',400);const app=await action(()=>projects.get(input.id));session.projectId=input.id;
      send(200,app.getState(),{'set-cookie':`spool_project=${input.id}; HttpOnly; SameSite=Strict; Path=/local; Max-Age=31536000`});
    }else{
      const app=await selected(req,session);
      if(path==='/local/team/connect'){send(200,await action(()=>app.teamConnect(input)));}
      else if(path==='/local/agents/connect'&&connectAgents){send(200,await action(()=>connectAgents(app.getState())));}
      else if(path==='/local/memory'){fail(!['remember','task_update','handoff'].includes(input.command),'Memory writes are available through the agent tools.');send(200,await app.memory(input));}
      else if(path==='/local/review'){fail(input?.command!=='publish','Local review is read-only.');send(200,app.review(input));}
      else if(path==='/local/codex/connect'){await app.connect();send(200,app.getState());}
      else if(path==='/local/codex/disconnect'){await app.disconnect();send(200,app.getState());}
      else if(path==='/local/capture'){await app.capture();send(200,app.getState());}
      else throw new RelayError('NOT_FOUND','Unknown local action',404);
    }
    return true;
  };
}
