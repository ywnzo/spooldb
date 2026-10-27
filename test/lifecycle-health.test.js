import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {lifecycleHealth} from '../src/lifecycle-health.js';
test('lifecycle health separates configuration, session start and successful prompt delivery by checkout',t=>{
 const directory=mkdtempSync(join(tmpdir(),'spool-health-')),root='/project';t.after(()=>rmSync(directory,{recursive:true,force:true}));
 assert.equal(lifecycleHealth(directory,root).status,'not_observed');mkdirSync(join(directory,'lifecycle'));
 const save=(id,value)=>writeFileSync(join(directory,'lifecycle',id.repeat(64)+'.json'),JSON.stringify(value));
 save('a',{root,guidanceSent:true,startedAt:'2026-10-26T10:00:00Z'});assert.equal(lifecycleHealth(directory,root).status,'session_only');
 save('b',{root:'/other',guidanceSent:true,lastPromptAt:'2026-10-26T12:00:00Z'});save('c',{root,guidanceSent:true,ignored:true,lastPromptAt:'2026-10-26T12:00:00Z'});assert.equal(lifecycleHealth(directory,root).lastPromptAt,null);
 save('d',{root,guidanceSent:true,lastPromptAt:'2026-10-26T11:00:00Z'});assert.equal(lifecycleHealth(directory,root).status,'observed');assert.equal(lifecycleHealth(directory,root).lastPromptAt,'2026-10-26T11:00:00Z');
});
