import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {copyProductionDependencies} from '../src/production-dependencies.js';

test('offline packaging preserves hoisted and nested production dependencies and excludes development packages',t=>{
 const base=mkdtempSync(join(tmpdir(),'spool-production-'));t.after(()=>rmSync(base,{recursive:true,force:true}));
 const source=join(base,'source'),out=join(base,'out');
 function pkg(path,value){mkdirSync(join(source,path),{recursive:true});writeFileSync(join(source,path,'package.json'),JSON.stringify(value));}
 pkg('',{dependencies:{a:'1'},devDependencies:{dev:'1'}});
 pkg('node_modules/a',{name:'a',dependencies:{b:'1',shared:'1'},optionalDependencies:{absent:'1'}});
 pkg('node_modules/a/node_modules/b',{name:'b',version:'1',dependencies:{shared:'1'}});
 pkg('node_modules/shared',{name:'shared',version:'1'});
 pkg('node_modules/b',{name:'b',version:'2'});
 pkg('node_modules/dev',{name:'dev'});
 pkg('node_modules/a/node_modules/unused',{name:'unused'});
 assert.deepEqual(copyProductionDependencies(source,out).sort(),['node_modules/a','node_modules/a/node_modules/b','node_modules/shared']);
 assert.equal(JSON.parse(readFileSync(join(out,'node_modules/a/node_modules/b/package.json'))).version,'1');
 for(const path of ['node_modules/dev','node_modules/b','node_modules/a/node_modules/unused'])assert.equal(existsSync(join(out,path)),false);
 const client=join(base,'client');assert.deepEqual(copyProductionDependencies(source,client,{exclude:['a']}),[]);assert.equal(existsSync(join(client,'node_modules/a')),false);
 pkg('node_modules/shared',{dependencies:{missing:'1'}});
 assert.throws(()=>copyProductionDependencies(source,join(base,'broken')),/Missing production dependency: missing/);
});
