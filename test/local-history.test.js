import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {localHistoryReader} from '../src/local-history.js';
test('local history snapshot keeps pagination stable when capture appends and rejects other records and writes',t=>{
 const dir=mkdtempSync(join(tmpdir(),'spool-history-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));let ids=['b','a'];
 const memory={run(_room,args){if(args.command==='search')return {results:ids.map(id=>({id})),nextOffset:null};return {id:args.id,kind:'conversation',text:args.id};}};
 const read=localHistoryReader(memory,'room',dir);assert.throws(()=>read({command:'remember',snapshot:'approved'}),/read-only/);
 assert.equal(read({command:'search',snapshot:'approved',limit:1}).results[0].id,'b');ids=['c','b','a'];
 const restarted=localHistoryReader(memory,'room',dir),page=restarted({command:'search',snapshot:'approved',offset:1,limit:1});assert.equal(page.results[0].id,'a');assert.equal(page.nextOffset,null);
 assert.throws(()=>read({command:'get',snapshot:'approved',id:'c'}),/not in this approved project/);
 assert.equal(read({command:'search',snapshot:'new-approval'}).total,3);
 assert.throws(()=>read({command:'search',snapshot:'new-approval',limit:21}),/Invalid history page/);
});
