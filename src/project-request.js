import {createConnection} from 'node:net';
import {join} from 'node:path';
export function projectRequest(dir,input,{onEvent=()=>{}}={}) {
  return new Promise((resolve,reject)=>{
    const socket=createConnection(join(dir,'control.sock'));let pending='',done=false;
    socket.on('connect',()=>socket.write(JSON.stringify(input)+'\n'));
    socket.on('data',chunk=>{pending+=chunk.toString();let i;while((i=pending.indexOf('\n'))>=0){const line=pending.slice(0,i);pending=pending.slice(i+1);try{const value=JSON.parse(line);if(value.done){done=true;socket.end();value.error?reject(new Error(value.error)):resolve(value.result);}else onEvent(value);}catch(error){reject(error);socket.destroy();}}});
    socket.on('error',reject);socket.on('close',()=>{if(!done)reject(new Error('Project service disconnected; start it with the start command.'));});
  });
}
