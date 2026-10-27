import {test} from 'node:test';
import assert from 'node:assert/strict';
import {repositoryOnboarding,loadRepositoryOnboarding} from '../src/repository-onboarding.js';
const project={root:'/work/library',name:'library',remote:'example.test/team/library',repositoryKey:'key',status:'pending'};
test('onboarding separates connection selection from project sharing and uses exact repository roots',()=>{
 const connections=[{id:'one',name:'Company',relay:'https://company.test'},{id:'two',name:'Personal',relay:'https://personal.test'}],plan=repositoryOnboarding(project,{connected:false,workspaces:connections});
 assert.equal(plan.phase,'choose_connection');assert.equal(plan.enrollmentAuthorized,false);assert.ok(plan.choices.every(choice=>choice.next?.arguments.confirm!==true));assert.deepEqual(plan.choices[0].next.arguments,{action:'preview',root:'/work/library',workspace:'one'});assert.ok(!plan.choices.some(c=>c.id==='create'));assert.equal(plan.choices.find(c=>c.id==='skip').next.arguments.action,'ignore');
});
test('matching projects offer join but never duplicate creation; project names stay display data',()=>{
 const plan=repositoryOnboarding(project,{connected:true,workspaceProfile:'one',workspaceName:'Company',relay:'https://company.test',canCreate:true,matches:[{room:'library',name:'Existing library'}]});
 assert.equal(plan.phase,'join_existing');assert.ok(!plan.choices.some(c=>c.id==='create'));assert.deepEqual(plan.choices[0].next.arguments,{action:'connect',root:'/work/library',workspace:'one',project:'library',confirm:true});assert.equal(plan.enrollmentAuthorized,false);
});
test('a new repository can create only after a checked connection and respects create permissions',()=>{
 const checked={connected:true,workspaceProfile:'one',canCreate:true,projects:[]};assert.equal(repositoryOnboarding(project,checked).phase,'choose_project');assert.equal(repositoryOnboarding(project,checked).choices[0].next.arguments.workspace,'one');assert.ok(!repositoryOnboarding(project,{...checked,canCreate:false}).choices.some(c=>c.id==='create'));assert.ok(!repositoryOnboarding({...project,repositoryKey:null},checked).choices.some(c=>c.id==='create'));assert.equal(repositoryOnboarding(project,{connected:false}).phase,'needs_invitation');
});
test('ignored repositories never re-prompt; preview failures cannot become create offers',async()=>{
 let calls=0;const skipped=await loadRepositoryOnboarding('state',{...project,status:'ignored'},{discover:async()=>{calls++;throw Error('must not contact a relay');}});assert.equal(calls,0);assert.equal(skipped.phase,'skipped');assert.equal(skipped.question,null);assert.deepEqual(skipped.choices,[]);
 const failed=await loadRepositoryOnboarding('state',project,{discover:async()=>{throw Error('Project access denied');}});assert.equal(failed.phase,'unavailable');assert.equal(failed.enrollmentAuthorized,false);assert.deepEqual(failed.choices.map(c=>c.id),['retry','skip']);assert.match(failed.guidance,/Do not offer project creation/);
});

test('outdated relays offer an update before creation but existing matches remain joinable',()=>{
 const preview={connected:true,workspaceProfile:'company',canCreate:true,projects:[],relayUpdate:{required:true,next:{tool:'spool_setup',arguments:{action:'relay_update',workspace:'company'}}}};
 const plan=repositoryOnboarding(project,preview);assert.equal(plan.phase,'update_required');assert.deepEqual(plan.choices.map(c=>c.id),['update','skip']);assert.equal(plan.choices[0].next.arguments.confirm,undefined);
 const recovery=repositoryOnboarding(project,{...preview,matches:[{room:'existing',name:'library'}]});assert.equal(recovery.phase,'join_existing');assert.equal(recovery.choices[0].next.arguments.project,'existing');assert.ok(!recovery.choices.some(c=>c.id==='create'));
});
