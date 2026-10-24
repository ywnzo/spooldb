import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {captureCheckpoint,createReconciler,submoduleStates} from '../src/team/git-references.js';
import {gitReference} from '../src/team/reference-contract.js';
import {repositoryAt} from '../src/repository.js';
import {ShardedEngine} from '../src/index.js';
import {Bridge} from '../src/bridge.js';
const git=(root,...args)=>execFileSync('git',['-c','protocol.file.allow=always','-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const commit=root=>git(root,'-c','user.name=Test','-c','user.email=test@example.test','commit','-qam','fixture');
function fixture(t){const base=mkdtempSync(join(tmpdir(),'spool-submodules-'));t.after(()=>rmSync(base,{recursive:true,force:true}));const make=name=>{const root=join(base,name);mkdirSync(root);git(root,'init','-q');writeFileSync(join(root,'code.txt'),name);git(root,'add','.');commit(root);return root;};return {base,make};}
test('parent capture excludes submodule source while checkpoints detect changed, dirty and missing child checkouts',t=>{
 const {base,make}=fixture(t),child=make('library'),root=make('parent');git(root,'submodule','add','-q',child,'packages/library');commit(root);const sub=join(root,'packages/library');git(root,'config','submodule.packages/library.ignore','all');
 const engine=new ShardedEngine(join(base,'memory.sqlite'));t.after(()=>engine.close());engine.create('main');const bridge=new Bridge(engine);bridge.attach('main',root);const scan=bridge.scan(root);assert.ok(!scan.entries['packages/library']);assert.ok(!scan.entries['packages/library/code.txt']);assert.ok(scan.excluded.some(value=>value.reason==='git-submodule-reference'));
 assert.equal(repositoryAt(sub).superproject.path,'packages/library');
 const saved=captureCheckpoint(root,['packages/library/code.txt']);assert.equal(saved.git.submodules.length,1);assert.equal(saved.git.submodules[0].commit,git(sub,'rev-parse','HEAD'));assert.equal(saved.git.dirty,false);assert.deepEqual(gitReference(saved.git),saved.git);
 const item={kind:'handoff',git:saved.git,files:saved.files};assert.equal(createReconciler(root)(item).reconciliation.status,'matching');
 writeFileSync(join(sub,'code.txt'),'changed inside child');assert.equal(captureCheckpoint(root).git.dirty,true);assert.equal(createReconciler(root)(item).reconciliation.status,'different_revision');assert.equal(createReconciler(root)(item).reconciliation.submodules[0].state,'different');
 git(sub,'add','.');commit(sub);assert.notEqual(captureCheckpoint(root).git.submodules[0].commit,saved.git.submodules[0].commit);assert.equal(createReconciler(root)(item).reconciliation.status,'different_revision');
 git(sub,'checkout','-q','--detach',saved.git.submodules[0].commit);git(root,'submodule','deinit','-q','-f','--all');assert.equal(submoduleStates(root)[0].initialized,false);assert.equal(createReconciler(root)(item).reconciliation.status,'commit_unavailable');assert.match(createReconciler(root)(item).reconciliation.message,/submodule/);assert.doesNotThrow(()=>bridge.capture(root));
});
test('nested submodules, paths with spaces and hostile metadata stay bounded and do not escape a checkout',t=>{
 const {make}=fixture(t),leaf=make('leaf'),child=make('child'),root=make('root');git(child,'submodule','add','-q',leaf,'nested library');commit(child);git(root,'submodule','add','-q',child,'vendor lib');git(root,'submodule','update','--init','--recursive');commit(root);
 assert.deepEqual(submoduleStates(root).map(value=>value.path),['vendor lib','vendor lib/nested library']);assert.throws(()=>submoduleStates(root,{limit:1}),/safety limit/);
 const checkpoint=captureCheckpoint(root);assert.equal(gitReference(checkpoint.git).submodules.length,2);
 assert.throws(()=>gitReference({submodules:[{path:'../outside',expectedCommit:'a'.repeat(40),initialized:true}]}),/project-relative/);
 assert.throws(()=>gitReference({submodules:[{...checkpoint.git.submodules[0],code:'source text'}]}),/Invalid submodule/);
 rmSync(join(root,'vendor lib'),{recursive:true,force:true});symlinkSync(child,join(root,'vendor lib'));assert.equal(submoduleStates(root)[0].initialized,false);assert.equal(readFileSync(join(child,'code.txt'),'utf8'),'child');
});
