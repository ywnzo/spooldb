import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {realpathSync} from 'node:fs';
const digest=value=>createHash('sha256').update(value).digest('hex');
export class CodexHistory {
  constructor({command='codex',args=['app-server','--listen','stdio://']}={}) {this.command=command;this.args=args;this.pending=new Map();this.id=0;}
  async start(){
    if(this.child)return;
    const child=this.child=spawn(this.command,this.args,{stdio:['pipe','pipe','pipe']});let buffer='';const decoder=new TextDecoder('utf-8',{fatal:true});
    child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
    const fail=error=>{for(const entry of this.pending.values()){clearTimeout(entry.timer);entry.reject(error);}this.pending.clear();if(this.child===child)this.child=null;};
    child.on('error',fail);child.on('close',()=>fail(new Error('Codex history connection closed')));
    child.stdout.on('data',chunk=>{
      try{buffer+=decoder.decode(chunk,{stream:true});}catch{fail(new Error('Invalid Codex history encoding'));child.kill();return;}if(Buffer.byteLength(buffer)>16_000_000){fail(new Error('Codex history response exceeds limit'));child.kill();return;}
      let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);try{const message=JSON.parse(line),entry=this.pending.get(message.id);if(entry){clearTimeout(entry.timer);this.pending.delete(message.id);message.error?entry.reject(new Error(message.error.message)):entry.resolve(message.result);}}catch{/* Ignore non-JSON diagnostics. */}}
    });
    await this.request('initialize',{clientInfo:{name:'spool',title:'SpoolDB',version:'0.1.0'},capabilities:{experimentalApi:true}});
    child.stdin.write(JSON.stringify({method:'initialized'})+'\n');
  }
  request(method,params){
    if(!['initialize','thread/list','thread/turns/list'].includes(method))throw new Error('History connection is read-only');
    return new Promise((resolve,reject)=>{if(!this.child)return reject(new Error('Codex is not connected'));const id=++this.id,timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('Codex history request timed out'));},20000);this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({id,method,params})+'\n');});
  }
  async read(root,onMessage){
    await this.start();let cursor=null,threads=0,messages=0;
    for(let page=0;page<50;page++){
      const result=await this.request('thread/list',{cwd:root,limit:50,cursor,sortKey:'updated_at',useStateDbOnly:true,sourceKinds:['cli','vscode','appServer','exec']});
      for(const thread of result.data??[]){
        let cwd;try{cwd=realpathSync(thread.cwd);}catch{continue;}if(cwd!==root)continue;threads++;
        let turnCursor=null;
        for(let turnPage=0;turnPage<100;turnPage++){
          const turns=await this.request('thread/turns/list',{threadId:thread.id,limit:10,itemsView:'full',sortDirection:'asc',cursor:turnCursor});
          for(const turn of turns.data??[]){if(turn.status!=='completed'&&turn.status!=='interrupted'&&turn.status!=='failed')continue;
            for(const item of turn.items??[]){let role,text;
              if(item.type==='userMessage'){role='user';text=(item.content??[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');}
              else if(item.type==='functionCallOutput'&&item.name==='create_thread'){const raw=typeof item.output==='string'?item.output:item.output?.text;const match=raw?.match(/<codex_delegation>\s*<source_thread_id>[^<]+<\/source_thread_id>\s*<input>([\s\S]*?)<\/input>\s*<\/codex_delegation>/);if(!match)continue;role='user';text=match[1];}
              else if(item.type==='agentMessage'){role='assistant';text=item.text;}
              else continue;
              if(typeof text!=='string'||!text.trim())continue;
              if(text.length>500000)throw new Error('A Codex message exceeds the capture limit');
              messages+=await onMessage({source:'codex-history',sessionId:thread.id,turnId:turn.id,itemId:item.id,role,text,harness:'codex'});
            }
          }
          turnCursor=turns.nextCursor;if(!turnCursor)break;if(turnPage===99)throw new Error('Codex turn pagination limit reached');
        }
      }
      cursor=result.nextCursor;if(!cursor)break;if(page===49)throw new Error('Codex thread pagination limit reached');
    }
    return {threads,messages};
  }
  close(){this.child?.kill('SIGTERM');this.child=null;for(const entry of this.pending.values()){clearTimeout(entry.timer);entry.reject(new Error('History connection stopped'));}this.pending.clear();}
}
export function storeNativeMessage(engine,branch,message){
  const {source,sessionId,turnId,itemId,role,text,harness}=message;
  if(!['codex-history','zed-acp'].includes(source)||!['user','assistant'].includes(role)||typeof text!=='string'||text.length>500000||![sessionId,itemId,harness].every(v=>typeof v==='string'&&v.length>0&&v.length<=200))throw new Error('Invalid captured message');
  engine.db.exec('CREATE TABLE IF NOT EXISTS native_message_receipts(id TEXT PRIMARY KEY)');
  const key=digest(JSON.stringify([source,sessionId,itemId,role,text]));
  return engine.transaction(()=>{
    if(engine.db.prepare('SELECT 1 FROM native_message_receipts WHERE id=?').get(key))return 0;
    engine.submit(branch,{actor:harness,harness,evidence:'codex-saved-history',sourceEventId:`codex-history:${sessionId}`,sessionId,messageId:itemId,...(turnId?{turnId}:{}),requestId:`native-${key}`,expectedHeads:engine.ref(branch).heads,operations:[{type:'message.add',messageId:`native-${key}`,role,text}]});
    engine.db.prepare('INSERT INTO native_message_receipts VALUES(?)').run(key);return 1;
  });
}
