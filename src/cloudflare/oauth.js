import OAuthProvider,{AuthorizationError,OAuthError} from '@cloudflare/workers-oauth-provider';
import {randomBytes} from 'node:crypto';
import {isWorkspaceLink,parseWorkspaceLink} from '../team/workspace.js';
import {parseInvite} from '../team/invites.js';
import {consentPage,consentClient} from './oauth-page.js';
import {remoteMcp,limitedText,workspaceStub,READ_SCOPE,WRITE_SCOPE,acceptableOrigin,authorizationState} from './remote-mcp.js';
const security={'cache-control':'no-store','referrer-policy':'same-origin','x-content-type-options':'nosniff','x-frame-options':'DENY','content-security-policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"};
const reply=(body,status=200,headers={})=>new Response(body,{status,headers:{...security,...headers}});
const json=(body,status=200)=>reply(JSON.stringify(body),status,{'content-type':'application/json'});
async function invitation(req,env,origin,link,action='preview',input={}){
 const workspace=isWorkspaceLink(link),invite=workspace?parseWorkspaceLink(link):parseInvite(link);if(invite.url!==origin||invite.ca)throw Error('Use an invitation from this SpoolDB server');
 const path=workspace?'/v1/workspace/'+(action==='redeem'?'enroll':'preview'):'/v1/invites/'+action;
 const response=await workspaceStub(env).fetch(new Request(origin+path,{method:'POST',headers:{authorization:'Invite '+invite.code,'content-type':'application/json'},body:JSON.stringify(input)}));
 const data=await response.json();if(!response.ok)throw Error(data.error?.message??'Invitation unavailable');
 if(!workspace)return {...data,kind:'project'};
 return {...data,kind:'workspace',...(data.connection?{connection:{...data.connection,kind:'workspace'}}:{}),role:data.role==='reader'?'read':'write'};
}
export async function checkProject(env,origin,connection){
 return (await authorizationState(env,origin,connection)).ok;
}
async function consent(req,env,origin){
 const path=new URL(req.url).pathname,helpers=env.OAUTH_PROVIDER;
 if(path==='/oauth/consent.js')return req.method==='GET'?reply('const __name=(value)=>value;\n('+consentClient.toString()+')();',200,{'content-type':'text/javascript; charset=utf-8'}):reply('Use GET',405);
 if(path==='/oauth/style.css')return reply('.oauth-input{display:block;width:100%;margin:10px 0;background:var(--bg);color:var(--ink);border:1px solid var(--line);padding:12px;border-radius:8px}',200,{'content-type':'text/css'});
 if(!['/authorize','/oauth/project-preview'].includes(path))return null;
 try{
  if(path==='/authorize'&&req.method==='GET'){
   const auth=await helpers.parseAuthRequest(req);if(!auth.codeChallenge||auth.codeChallengeMethod!=='S256')throw new AuthorizationError('invalid_request',{description:'PKCE S256 is required'});const details=await helpers.describeConsent(auth),transaction=await helpers.beginConsent(auth);
   const headers=new Headers(transaction.headers);for(const [k,v]of Object.entries(security))headers.set(k,v);headers.set('content-type','text/html; charset=utf-8');headers.set('content-security-policy',security['content-security-policy'].replace("form-action 'self'","form-action 'self' "+new URL(auth.redirectUri).origin));return new Response(consentPage(details,transaction.handle),{headers});
  }
  if(req.method!=='POST')return reply('Use POST',405);
  if(req.headers.get('origin')!==origin||req.headers.has('content-encoding'))return json({error:'Request origin is not allowed'},403);
  const content=await limitedText(req,50000);
  if(path==='/oauth/project-preview'){
   if(!/^application\/json(?:;|$)/i.test(req.headers.get('content-type')??''))return json({error:'Use JSON'},415);
   return json(await invitation(req,env,origin,JSON.parse(content).link));
  }
  if(!/^application\/x-www-form-urlencoded(?:;|$)/i.test(req.headers.get('content-type')??''))return json({error:'Use a consent form'},415);
  const form=new URLSearchParams(content),handle=form.get('handle');
  if(form.get('decision')==='deny'){const denied=await helpers.denyConsent(req,handle);return new Response(null,{status:302,headers:denied.headers});}
  if(form.get('decision')!=='approve')throw Error('Choose Authorize or Deny');
  const preview=await invitation(req,env,origin,form.get('invite'));
  const scopes=[READ_SCOPE];if(form.getAll('scope').includes(WRITE_SCOPE)){if(preview.role!=='write')throw Error('This invitation is read only');scopes.push(WRITE_SCOPE);}
  const approved=await helpers.approveConsent(req,handle,{scope:scopes});
  const details=await helpers.describeConsent(approved.request);
  const {connection,memberId}=await invitation(req,env,origin,form.get('invite'),'redeem',{claim:randomBytes(32).toString('base64url'),device:('Cloud MCP · '+details.clientName).slice(0,120)});
  const completed=await helpers.completeAuthorization({request:approved.request,userId:memberId,metadata:connection.kind==='workspace'?{workspace:preview.workspace?.name}:{project:connection.project,room:connection.room},scope:scopes,props:{connection}});
  const headers=new Headers(approved.headers);headers.set('location',completed.redirectTo);headers.set('cache-control','no-store');return new Response(null,{status:302,headers});
 }catch(error){
  if(req.method==='GET'&&error instanceof AuthorizationError&&error.redirectTo)return new Response(null,{status:302,headers:{location:error.redirectTo,'cache-control':'no-store'}});
  // Never log consent bodies, invitation codes, authorization codes or tokens.
  return json({error:error instanceof AuthorizationError?error.description??'Authorization request rejected':error.message??'Authorization failed'},400);
 }
}
export function authenticatedRelay(relay){return {async fetch(req,env,ctx){
 const origin=env.PUBLIC_ORIGIN||new URL(req.url).origin,path=new URL(req.url).pathname,oauth=path==='/mcp'||path==='/authorize'||path.startsWith('/oauth/')||path.startsWith('/.well-known/oauth-');
 if(!oauth)return relay.fetch(req,env,ctx);
 if(!acceptableOrigin(req,origin))return json({error:'Origin is not allowed'},403);
 if(req.method==='OPTIONS')return reply(null,204,{'access-control-allow-origin':req.headers.get('origin')??origin,'access-control-allow-methods':'GET, POST, OPTIONS','access-control-allow-headers':'Authorization, Content-Type, MCP-Protocol-Version','access-control-expose-headers':'WWW-Authenticate',vary:'Origin'});
 if(!env.OAUTH_KV)return json({error:'Remote MCP is not configured. Redeploy with an OAUTH_KV namespace.'},503);
 const provider=new OAuthProvider({apiRoute:'/mcp',apiHandler:{fetch:remoteMcp},defaultHandler:{async fetch(r,e,c){return await consent(r,e,origin)??relay.fetch(r,e,c);}},authorizeEndpoint:'/authorize',tokenEndpoint:'/oauth/token',clientRegistrationEndpoint:'/oauth/register',scopesSupported:[READ_SCOPE,WRITE_SCOPE,'offline_access'],requiredScopes:[READ_SCOPE],accessTokenTTL:3600,refreshTokenTTL:30*86400,clientIdMetadataDocumentEnabled:true,resourceMetadata:{resource:origin+'/mcp',authorization_servers:[origin]},tokenExchangeCallback:async({props,env:e})=>{if(!await checkProject(e,origin,props?.connection))throw new OAuthError('invalid_grant',{description:'Project access was revoked or is unavailable'});}});
 const response=await provider.fetch(req,env,ctx),headers=new Headers(response.headers);headers.set('cache-control','no-store');headers.set('x-content-type-options','nosniff');if(req.headers.has('origin')){headers.set('access-control-allow-origin',req.headers.get('origin'));headers.set('access-control-expose-headers','WWW-Authenticate');headers.append('vary','Origin');}return new Response(response.body,{status:response.status,headers});
}};}
