import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {applyUpdate,checkUpdate,configureUpdates,scheduledUpdate,newerVersion} from '../src/update.js';
function fixture(t){const base=mkdtempSync(join(tmpdir(),'spool-updater-'));t.after(()=>rmSync(base,{recursive:true,force:true}));const paths={data:join(base,'data'),config:join(base,'config'),state:join(base,'state'),bin:join(base,'bin'),home:join(base,'home')},state=join(base,'settings');mkdirSync(state);return {base,paths,state};}
const release={tag_name:'v0.5.0',draft:false,prerelease:false,assets:['SHA256SUMS','spool-linux-x64.run'].map(name=>({name,browser_download_url:'https://github.com/ywnzo/spooldb/releases/download/v0.5.0/'+name}))};
const mockRun=(calls,version='0.4.6')=>(command,args)=>{calls.push({command,args});if(args[0]==='plugin'&&args[1]==='list')return JSON.stringify({installed:[{pluginId:'spooldb@spooldb',version}]});if(args[0]==='plugin'&&args[1]==='add')return JSON.stringify({version:'0.5.0'});return '';};
test('plugin updater uses Codex marketplace install, rejects downgrades and never grants hook trust',async t=>{
 const {paths,state}=fixture(t),calls=[],run=mockRun(calls),config={target:'plugin',paths,state,codex:'/codex'},fetcher=async()=>Response.json(release);
 assert.equal(newerVersion('0.4.10','0.4.9'),true);assert.equal(newerVersion('0.4.6','0.5.0'),false);assert.throws(()=>newerVersion('next','0.4.6'));
 assert.equal((await checkUpdate(config,{run,fetcher})).available,true);const result=await applyUpdate(config,{run,fetcher});assert.equal(result.updated,true);assert.equal(result.hookReviewRequired,true);assert.equal(result.restartRequired,true);
 assert.deepEqual(calls.filter(value=>value.args[0]==='plugin'&&value.args[1]!=='list').map(value=>value.args),[['plugin','marketplace','upgrade','spooldb'],['plugin','add','spooldb@spooldb','--json']]);
 const noUpdate=await applyUpdate(config,{run:mockRun([], '0.5.1'),fetcher});assert.equal(noUpdate.updated,false);
});
test('opt-in schedulers survive plugin updates, remain separate per target and support macOS launch agents',t=>{
 const {paths,state}=fixture(t),app=process.cwd(),run=()=>'';
 const result=configureUpdates({state,mode:'automatic',target:'plugin',app,paths,run,codex:'/codex',activate:false,platform:'linux'});assert.equal(result.mode,'automatic');
 const service=readFileSync(join(paths.config,'systemd/user/spool-update-plugin.service'),'utf8');assert.match(service,/spool\/updater\/bun/);assert.ok(!service.includes('plugins/cache'));assert.match(service,/updates-plugin.json/);
 configureUpdates({state,mode:'check',target:'plugin',app,paths,run,codex:'/codex',activate:false,platform:'darwin'});
 const agent=join(paths.home,'Library/LaunchAgents/dev.spooldb.update.plugin.plist');assert.match(readFileSync(agent,'utf8'),/<integer>3600<\/integer>/);
 configureUpdates({state,mode:'off',target:'plugin',app,paths,activate:false,platform:'darwin'});assert.equal(existsSync(agent),false);
 assert.equal(existsSync(join(paths.config,'systemd/user/spool-update-plugin.service')),true);
});
test('scheduled updates defer live sessions, check daily, record errors and release the lock',async t=>{
 const {paths,state}=fixture(t),path=join(state,'updates-plugin.json'),config={target:'plugin',mode:'automatic',paths,state,codex:'/codex'};writeFileSync(path,JSON.stringify(config));mkdirSync(join(state,'plugin-leases'));writeFileSync(join(state,'plugin-leases/current.json'),JSON.stringify({pid:process.pid}));let calls=[];
 assert.match((await scheduledUpdate(path,{run:mockRun(calls),fetcher:async()=>Response.json(release)})).skipped,/session/);assert.equal(calls.length,0);rmSync(join(state,'plugin-leases/current.json'));
 const result=await scheduledUpdate(path,{run:mockRun(calls),fetcher:async()=>Response.json(release)});assert.equal(result.updated,true);assert.equal((await scheduledUpdate(path)).skipped,'checked recently');assert.equal(existsSync(path+'.lock'),false);
 writeFileSync(path,JSON.stringify(config));await assert.rejects(()=>scheduledUpdate(path,{run:mockRun([]),fetcher:async()=>new Response('oops',{status:503})}),/503/);assert.equal(existsSync(path+'.lock'),false);assert.match(JSON.parse(readFileSync(path)).error,/503/);
});
test('client installer is checksum-verified before execution and uses noninteractive update mode',{skip:process.platform!=='linux'},async t=>{
 const {paths,state}=fixture(t);mkdirSync(join(paths.data,'spool'),{recursive:true});writeFileSync(join(paths.data,'spool/installation.json'),JSON.stringify({version:'0.4.6'}));const payload=Buffer.from('installer fixture'),sha=createHash('sha256').update(payload).digest('hex'),calls=[],config={target:'client',paths,state};
 const fetcher=async url=>url.endsWith('/latest')?Response.json(release):url.endsWith('SHA256SUMS')?new Response(sha+'  spool-linux-x64.run\n'):new Response(payload);
 assert.equal((await applyUpdate(config,{fetcher,run:mockRun(calls)})).updated,true);assert.equal(calls[0].command,'sh');assert.equal(calls[0].args[1],'--update');
 await assert.rejects(()=>applyUpdate(config,{fetcher:async url=>url.endsWith('spool-linux-x64.run')?new Response('tampered'):fetcher(url),run:()=>assert.fail('must not execute')}),/checksum mismatch/);
});

test('automatic updates do not reenable a plugin disabled in Codex',async t=>{
 const {paths,state}=fixture(t),path=join(state,'updates-plugin.json');writeFileSync(path,JSON.stringify({target:'plugin',mode:'automatic',paths,state,codex:'/codex'}));
 const result=await scheduledUpdate(path,{run:()=>JSON.stringify({installed:[{pluginId:'spooldb@spooldb',enabled:false,version:'0.4.6'}]}),fetcher:()=>assert.fail('must not check or install a disabled plugin')});assert.match(result.skipped,/disabled/);
});
