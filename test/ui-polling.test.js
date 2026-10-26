import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {runInNewContext} from 'node:vm';
function fixture(){
 const elements=new Map(),listeners=new Map(),timers=new Map();let serial=0,calls=0;
 const element=id=>{if(!elements.has(id))elements.set(id,{hidden:id==='project-home'?false:true,value:'',checked:false,replaceChildren(){},addEventListener(){},removeAttribute(){}});return elements.get(id);};
 const document={hidden:false,getElementById:element,createElement:()=>({}),addEventListener:(event,fn)=>listeners.set(event,fn)};
 const data={supported:true,revision:0,settings:{provider:'local',accountId:'',enabled:true,model:'mini',threads:2,minScore:0.25,contextChars:6000},models:[{key:'mini',name:'Mini',description:'Local'}],cloudflareModels:[],cleanup:{archived:0},status:'ready',activeModel:'mini'};
 const window={spoolSettings:{current:'retrieval'},localRequest:async()=>{calls++;return structuredClone(data);}};
 runInNewContext(readFileSync(new URL('../src/review/public/retrieval-settings.js',import.meta.url),'utf8'),{window,document,setTimeout:(fn,delay)=>{const id=++serial;timers.set(id,{fn,delay});return id;},clearTimeout:id=>timers.delete(id)});
 return {document,data,timers,element,calls:()=>calls,event:async(name,detail)=>{await listeners.get(name)?.({detail});await new Promise(resolve=>setImmediate(resolve));}};
}
test('retrieval UI polls ready status only every two minutes and sleeps while hidden',async()=>{
 const f=fixture();await f.event('spool-workspace-state',{connected:true,owner:true,relay:'https://relay.example'});assert.equal(f.calls(),1);assert.equal([...f.timers.values()][0].delay,120000);
 f.document.hidden=true;await f.event('visibilitychange');assert.equal(f.timers.size,0);assert.equal(f.calls(),1);
 f.document.hidden=false;await f.event('visibilitychange');assert.equal(f.calls(),2);assert.equal(f.timers.size,1);
 f.data.status='loading';await f.event('spool-settings-section');assert.equal([...f.timers.values()][0].delay,2000);
 f.document.hidden=true;const timer=[...f.timers.values()][0];f.timers.clear();await timer.fn();assert.equal(f.calls(),3);assert.equal(f.timers.size,0);
});
