import {createConnection} from 'node:net';
import {join} from 'node:path';
export function discoveryRequest(directory,input){return new Promise((resolve,reject)=>{
 const socket=createConnection(join(directory,'discovery.sock'));let buffer='';const timer=setTimeout(()=>socket.destroy(new Error('SpoolDB discovery timed out')),60000);
 socket.on('connect',()=>socket.write(JSON.stringify(input)+'\n'));socket.on('error',reject);socket.on('close',()=>clearTimeout(timer));socket.on('data',chunk=>{buffer+=chunk;if(buffer.length>1000000)return socket.destroy(new Error('Discovery response too large'));if(!buffer.includes('\n'))return;try{const value=JSON.parse(buffer.split('\n')[0]);socket.end();value.error?reject(new Error(value.error)):resolve(value.result);}catch(error){reject(error);socket.destroy();}});
});}
