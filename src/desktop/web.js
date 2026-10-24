import {createServer} from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {readJson} from '../relay/wire.js';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);
export async function pickFolder(){for(const [command,args]of [['kdialog',['--getexistingdirectory',process.env.HOME??'/','--title','Choose project folder']],['zenity',['--file-selection','--directory','--title=Choose project folder']]])try{return {root:(await execute(command,args,{timeout:120000,maxBuffer:8192})).stdout.trim()||null};}catch(error){if(error.code===1)return {root:null};if(error.code!=='ENOENT')throw error;}return {root:null,message:'No desktop folder picker is installed. Enter the project folder below.'};}
export async function localWeb({page,api,port=0}){
 const token=randomBytes(32).toString('base64url'),csrf=randomBytes(32).toString('base64url'),cookie='tw_setup_'+randomBytes(8).toString('hex');let origin;
 const send=(res,status,value,headers={})=>{const body=JSON.stringify(value);res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff',...headers});res.end(body);};
 const server=createServer(async(req,res)=>{try{
  if(req.headers.host!==new URL(origin).host||!['127.0.0.1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))throw new Error('Use the local setup window.');
  const path=new URL(req.url,origin).pathname;
  if(path==='/healthz')return send(res,200,{ok:true,protocol:'spool-relay/1',setup:true});
  const asset=path==='/'?page+'.html':{'/kiln.css':'kiln.css','/discovery.js':'discovery.js','/workspace.js':'workspace.js','/setup.js':'setup.js','/install.js':'install.js','/style.css':'style.css'}[path];
  if(asset&&req.method==='GET'){res.writeHead(200,{'content-type':asset.endsWith('.html')?'text/html; charset=utf-8':asset.endsWith('.css')?'text/css':'text/javascript','cache-control':'no-store','content-security-policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"});res.end(readFileSync(new URL(['kiln.css','workspace.js','discovery.js'].includes(asset)?'../review/public/'+asset:'./public/'+asset,import.meta.url)));return;}
  if(req.headers['sec-fetch-site']!=='same-origin'||req.headers.origin&&req.headers.origin!==origin)throw new Error('Open setup in its local window.');
  if(path==='/api/session'&&req.method==='GET')return send(res,200,{csrf},{'set-cookie':`${cookie}=${token}; HttpOnly; SameSite=Strict; Path=/`});
  const header=Buffer.from(req.headers['x-spool-csrf']??''),expected=Buffer.from(csrf);if(!req.headers.cookie?.split(';').map(x=>x.trim()).includes(cookie+'='+token)||header.length!==expected.length||!timingSafeEqual(header,expected))throw new Error('Reload this setup window.');
  if(req.method!=='POST'||!req.headers['content-type']?.startsWith('application/json'))throw new Error('Use the setup form.');
  const input=await readJson(req,100000);send(res,200,await api(path.slice(5),input));
 }catch(error){send(res,400,{error:error.message});}});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});origin=`http://127.0.0.1:${server.address().port}`;return {origin,close:async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
