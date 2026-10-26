import {test} from 'node:test';import assert from 'node:assert/strict';import Ajv from 'ajv';
import {ShardedEngine} from '../src/index.js';import {MemoryStore} from '../src/memory/store.js';import {assertHandoff,handoffLength} from '../src/memory/handoff-limits.js';import {memoryTools} from '../src/memory/tools.js';import * as validators from '../src/memory/tool-validators.js';import {validMemoryEvent} from '../src/memory/event-validation.js';
const base={taskId:'work',title:'Continue delivery fix',text:'Fixed duplicate delivery charge; focused tests pass. Deploy still pending.',nextSteps:['Review the patch and run the full gate.'],blockers:[]};
test('handoff field and combined limits reject padding instead of silently truncating evidence',()=>{
 assertHandoff(base);for(const changes of [{text:'x'.repeat(1501)},{title:'x'.repeat(121)},{nextSteps:['a','b','c','d']},{blockers:['x'.repeat(161)]},{text:'x'.repeat(1500),nextSteps:Array(3).fill('x'.repeat(160)),blockers:['x'.repeat(160)]}])assert.throws(()=>assertHandoff({...base,...changes}),error=>error.code==='HANDOFF_TOO_LONG'&&/separate findings/.test(error.message));
 const unicode={...base,text:'🙂'.repeat(1400)};assertHandoff(unicode);assert.ok(handoffLength(unicode)<2000);
});
test('relay memory enforces the limit atomically for tool and direct API handoffs; legacy history stays readable',t=>{
 const engine=new ShardedEngine(':memory:'),ref=engine.create('new');engine.db.prepare('UPDATE shard_refs SET name=? WHERE name=?').run('relay-'+ref.room,'new');const store=new MemoryStore(engine);t.after(()=>engine.close());const run=input=>store.run(ref.room,{requestId:crypto.randomUUID(),...input});
 run({command:'task_update',taskId:'work',title:'Delivery',text:'Fix delivery',status:'in_progress',expectedRevision:0});const before=engine.ref('relay-'+ref.room).heads;
 assert.throws(()=>run({command:'handoff',...base,text:'x'.repeat(1501)}),error=>error.code==='HANDOFF_TOO_LONG');assert.deepEqual(engine.ref('relay-'+ref.room).heads,before);
 assert.throws(()=>run({command:'remember',kind:'handoff',...base,text:'x'.repeat(1501)}),error=>error.code==='HANDOFF_TOO_LONG');
 const saved=run({command:'handoff',...base});assert.equal(run({command:'get',id:saved.id}).kind,'handoff');
 const legacy={protocol:'spool-memory/1',kind:'handoff',title:'Historical long handoff',text:'x'.repeat(9000),nextSteps:[],blockers:[]};assert.equal(validMemoryEvent(legacy),true);engine.submit('relay-'+ref.room,{actor:'legacy',requestId:'legacy',expectedHeads:engine.ref('relay-'+ref.room).heads,operations:[{type:'message.add',messageId:'legacy',role:'system',text:JSON.stringify(legacy)}]});assert.equal(run({command:'get',id:'legacy',limit:12000}).text.length,9000);
});
test('desktop and standalone cloud validators expose the same concise handoff schema',()=>{
 const schema=memoryTools.find(tool=>tool.name==='handoff').inputSchema,validate=new Ajv().compile(schema);assert.equal(validate(base),true);assert.equal(validators.handoff(base),true);for(const value of [{...base,text:'x'.repeat(1501)},{...base,nextSteps:Array(4).fill('step')}]){assert.equal(validate(value),false);assert.equal(validators.handoff(value),false);}
});
