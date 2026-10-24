import {existsSync,readFileSync,chmodSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {isIP} from 'node:net';
import {hostname,networkInterfaces} from 'node:os';
import {execFileSync} from 'node:child_process';
import {request as httpsRequest} from 'node:https';
import {MAX_BODY,PROTOCOL,RelayError} from '../relay/wire.js';
export function localCertificate(dir,{dnsNames=[]}={}){
 const keyPath=join(dir,'relay.key'),certPath=join(dir,'relay.crt');
 if(!existsSync(keyPath)||!existsSync(certPath)){
  const addresses=[...new Set(['127.0.0.1',...dnsNames.filter(name=>isIP(name)),...Object.values(networkInterfaces()).flat().filter(n=>n.family==='IPv4').map(n=>n.address)])];const names=['localhost',hostname(),...dnsNames].filter(n=>!isIP(n)&&/^[A-Za-z0-9.-]+$/.test(n));
  try{execFileSync('openssl',['req','-x509','-newkey','rsa:3072','-sha256','-nodes','-keyout',keyPath,'-out',certPath,'-days','365','-subj','/CN=SpoolDB shared relay','-addext','subjectAltName='+[...addresses.map(ip=>'IP:'+ip),...names.map(name=>'DNS:'+name)].join(',')],{stdio:'ignore',timeout:20000});chmodSync(keyPath,0o600);chmodSync(certPath,0o644);}catch(error){for(const path of [keyPath,certPath])if(existsSync(path))unlinkSync(path);throw error;}
 }
 return {key:readFileSync(keyPath),cert:readFileSync(certPath),ca:readFileSync(certPath,'utf8'),minVersion:'TLSv1.2'};
}
export function pinnedRequest(config,action,input){
 return new Promise((resolve,reject)=>{
  const url=new URL(`/v1/rooms/${config.room}/${action}`,config.url);if(url.protocol!=='https:')return reject(new Error('Certificate connections require HTTPS'));
  const body=input===undefined?undefined:JSON.stringify(input);if(body&&Buffer.byteLength(body)>MAX_BODY)return reject(new Error('Request exceeds limit'));
  const request=httpsRequest(url,{method:body===undefined?'GET':'POST',ca:config.ca,rejectUnauthorized:true,minVersion:'TLSv1.2',timeout:5000,headers:{authorization:`Bearer ${config.token}`,...(body?{'content-type':'application/json','content-length':Buffer.byteLength(body)}:{})}},response=>{
   const chunks=[];let size=0;response.on('data',chunk=>{size+=chunk.length;if(size>MAX_BODY){response.destroy();reject(new Error('Relay response exceeds limit'));}else chunks.push(chunk);});response.on('error',reject);response.on('end',()=>{try{const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));if(data.protocol!==PROTOCOL)throw new Error('Unsupported relay protocol');if(response.statusCode>=400)throw new RelayError(data.error?.code??'HTTP_ERROR',data.error?.message??'Relay request failed',response.statusCode);if(data.room!==config.room)throw new Error('Relay project mismatch');resolve(data);}catch(error){reject(error);}});
  });request.on('timeout',()=>request.destroy(new Error('Shared relay TLS request timed out')));request.on('error',reject);request.end(body);
 });
}
