import {execFileSync} from 'node:child_process';
import {lookup} from 'node:dns/promises';
import {createServer,isIP} from 'node:net';
import {existsSync,readFileSync,writeFileSync,mkdirSync,renameSync,rmSync,lstatSync,chmodSync,chownSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {domainToASCII} from 'node:url';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
export const proxyMarker='# BEGIN SpoolDB managed relay';
const proxyEnd='# END SpoolDB managed relay';
export const rootRun=(command,args,options={})=>execFileSync(command,args,{encoding:'utf8',stdio:[options.input!==undefined?'pipe':'ignore','pipe','pipe'],timeout:30000,env:{...process.env,PATH:'/usr/sbin:/usr/bin:/sbin:/bin'},...options});
export function normalizeDomain(input){
 if(typeof input!=='string')throw Error('Enter your public domain, for example spool.example.com');
 const raw=input.trim().replace(/^https:\/\//i,'').replace(/\/$/,'');if(/[\x00-\x20\x7f/\\:@?#*{}\[\],%]/.test(raw))throw Error('Enter a public DNS name without a path, port or wildcard');const domain=domainToASCII(raw).toLowerCase();
 if(!domain||domain.length>253||isIP(domain)||!domain.includes('.')||!domain.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))||/^\d+$/.test(domain.split('.').at(-1))||/\.(?:localhost|local|invalid|test)$/.test(domain))throw Error('Enter a public DNS name without a path, port or wildcard');
 return domain;
}
export async function inspectDomain(domain,{resolve=lookup}={}){domain=normalizeDomain(domain);let addresses;try{addresses=await resolve(domain,{all:true});}catch{throw Error('DNS is not ready for '+domain+'. Point its A/AAAA records at this VPS, then retry.');}if(!addresses.length)throw Error('No DNS addresses found for '+domain);return addresses.map(value=>value.address);}
export function managedCaddyfile(existing,{domain,port=8878,probe}){
 domain=normalizeDomain(domain);if(!Number.isInteger(port)||port<1||port>65535||!/^[-a-zA-Z0-9]{1,80}$/.test(probe))throw Error('Invalid Caddy relay settings');
 const starts=existing.split(proxyMarker).length-1,ends=existing.split(proxyEnd).length-1;if(starts!==ends||starts>1)throw Error('The managed Caddy block is incomplete or ambiguous; inspect the Caddyfile before retrying');
 let outside=existing;if(starts){const start=existing.indexOf(proxyMarker),end=existing.indexOf(proxyEnd);if(end<start)throw Error('Invalid managed Caddy block');outside=existing.slice(0,start)+existing.slice(end+proxyEnd.length);}
 const escaped=domain.replaceAll('.','\\.');if(new RegExp('(^|[\\s,])'+escaped+'(?=[\\s,{:]|$)','m').test(outside.replace(/^\s*#.*$/gm,'')))throw Error('This domain already has an unmanaged Caddy site. Use advanced setup to preserve its routing.');
 const block=`${proxyMarker}\n${domain} {\n    @spoolHealth path /healthz\n    header @spoolHealth X-SpoolDB-Setup ${probe}\n    reverse_proxy 127.0.0.1:${port}\n}\n${proxyEnd}\n`;
 return outside.trimEnd()+'\n\n'+block;
}
async function available(port){return new Promise((resolve,reject)=>{const server=createServer();server.once('error',reject);server.listen(port,'0.0.0.0',()=>server.close(resolve));});}
export async function inspectProxyPorts({run=rootRun,bind=available}={}){
 let listeners;try{listeners=run('ss',['-H','-ltnp']);}catch{}
 if(listeners!==undefined){for(const line of listeners.split('\n')){const parts=line.trim().split(/\s+/);if(parts.length<4||!/:\b(?:80|443)$/.test(parts[3]))continue;if(!/\(\("caddy"[,)]/.test(line))throw Error('Port 80 or 443 is already used by another service. It was not stopped. Choose advanced setup for your existing proxy.');}return;}
 let caddyActive=false;try{caddyActive=run('systemctl',['is-active','caddy']).trim()==='active';}catch{}
 for(const port of [80,443])try{await bind(port);}catch(error){if(error.code!=='EADDRINUSE'||!caddyActive)throw Error('Port '+port+' is unavailable. Inspect the existing web server before using automatic setup.');}
}
export function openWebFirewall({run=rootRun}={}){let status;try{status=run('ufw',['status']);}catch{return {managed:false};}if(!/^Status: active/m.test(status))return {managed:false};run('ufw',['allow','80/tcp']);run('ufw',['allow','443/tcp']);return {managed:true};}
export async function waitForHTTPS(domain,probe,{fetcher=fetch,sleep=delay,attempts=24,progress=()=>{}}={}){
 domain=normalizeDomain(domain);let last='not reachable';
 for(let attempt=0;attempt<attempts;attempt++){
  try{const response=await fetcher('https://'+domain+'/healthz',{redirect:'error',signal:AbortSignal.timeout(5000)});if(response.ok&&response.headers.get('x-spooldb-setup')===probe&&(await response.json()).ok===true)return {https:true,origin:'https://'+domain};last='the domain did not reach this relay';}catch(error){last=error.cause?.code??error.code??error.message;}
  progress('Waiting for the public HTTPS certificate…');if(attempt+1<attempts)await sleep(2500);
 }
 throw Error('HTTPS is not ready for '+domain+' ('+last+'). Check its public A/AAAA records and allow TCP 80/443 in the VPS provider firewall. Retry the installer after correcting them.');
}
