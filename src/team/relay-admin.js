import {createConnection} from 'node:net';
export function relayAdminRequest(input,{socketPath='/run/spool-control/agent.sock',timeout=8000}={}){
 return new Promise((resolve,reject)=>{let text='';const socket=createConnection(socketPath),timer=setTimeout(()=>{socket.destroy();reject(Error('Relay maintenance service timed out'));},timeout);const done=()=>clearTimeout(timer);
 socket.on('connect',()=>socket.end(JSON.stringify(input)+'\n'));socket.on('data',chunk=>{text+=chunk;if(text.length>200000){socket.destroy();done();reject(Error('Maintenance response too large'));}});
 socket.on('end',()=>{done();try{const result=JSON.parse(text);if(result.error)throw Error(result.error);resolve(result);}catch(error){reject(error);}});
 socket.on('error',error=>{done();if(['ENOENT','ECONNREFUSED'].includes(error.code))resolve({supported:false,message:'Host maintenance is not installed or is unavailable on this relay.'});else reject(error);});
 });
}
