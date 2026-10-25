import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {codexMemoryState,connectCodexMemory} from '../src/codex-connection.js';
function fixture(){
 const base=mkdtempSync(join(tmpdir(),'spool-codex-connection-')),root=join(base,'repo'),directory=join(base,'state'),plugin=join(base,'plugin'),codexHome=join(base,'codex'),calls=[];for(const dir of [root,directory,codexHome,join(plugin,'.codex-plugin')])mkdirSync(dir,{recursive:true});writeFileSync(join(plugin,'.codex-plugin/plugin.json'),JSON.stringify({name:'spooldb'}));
 const hooks=['sessionStart','userPromptSubmit','stop','interrupt'].map(eventName=>({source:'plugin',sourcePath:join(plugin,'hooks/hooks.json'),eventName,trustStatus:'trusted',command:'/data/spool/codex-hooks/current'}));
 const inspect=(selected=hooks,errors=[])=>options=>codexMemoryState(options,{rpcFactory:()=>({start:async()=>{},request:async(method)=>{calls.push(method);assert.equal(method,'hooks/list');return {data:[{cwd:root,hooks:selected,errors}]};},close(){}})});
 return {root,directory,plugin,codexHome,calls,hooks,inspect,close:()=>rmSync(base,{recursive:true,force:true})};
}
test('Connect Codex uses installed trusted plugin hooks without installing project configuration or writing trust',async()=>{
 const f=fixture();try{const result=await connectCodexMemory(f,{inspect:f.inspect(),installShared:()=>{throw Error('must not install another integration');}});assert.equal(result.mode,'plugin');assert.equal(result.ready,true);assert.equal(result.trusted,true);assert.equal(existsSync(join(f.root,'.codex')),false);assert.deepEqual(f.calls,['hooks/list']);}finally{f.close();}
});
test('untrusted plugin and legacy managed config produce actionable states without modifying either',async()=>{
 const f=fixture();try{const untrusted=f.hooks.map(h=>({...h,trustStatus:'untrusted'})),first=await connectCodexMemory(f,{inspect:f.inspect(untrusted)});assert.equal(first.needsHookReview,true);assert.equal(first.ready,false);assert.equal(existsSync(join(f.root,'.codex')),false);
  mkdirSync(join(f.root,'.codex'));const config=join(f.root,'.codex/config.toml'),before='model = "keep-me"\n# BEGIN SPOOL MANAGED\n[mcp_servers.spool]\n# END SPOOL MANAGED\n';writeFileSync(config,before);const result=await connectCodexMemory(f,{inspect:f.inspect(),installShared:()=>{throw Error('must not install another integration');}});assert.equal(result.needsMigration,true);assert.equal(result.ready,false);assert.match(result.message,/migrate.*backups/);assert.equal(readFileSync(config,'utf8'),before);assert(f.calls.every(m=>m==='hooks/list'));}finally{f.close();}
});
test('without a plugin, setup installs shared discovery and requests review instead of expecting project hooks',async()=>{
 const f=fixture();try{const result=await connectCodexMemory(f,{inspect:f.inspect([])});assert.equal(result.mode,'shared');assert.equal(result.needsHookReview,true);assert.equal(result.trusted,false);assert.equal(result.ready,false);assert.equal(existsSync(join(f.root,'.codex')),false);const saved=readFileSync(join(f.codexHome,'config.toml'),'utf8');assert.match(saved,/--discover/);assert.doesNotMatch(saved,/trusted_hash/);assert.equal((saved.match(/type = "command"/g)??[]).length,4);}finally{f.close();}
});
test('configuration errors and duplicate plugin hook sets do not install or trust more hooks',async()=>{
 const f=fixture();try{const duplicate=await connectCodexMemory(f,{inspect:f.inspect([...f.hooks,...f.hooks]),installShared:()=>{throw Error('must not install');}});assert.equal(duplicate.ready,false);assert.match(duplicate.message,/incomplete or duplicate/);const broken=await connectCodexMemory(f,{inspect:f.inspect([],['invalid config']),installShared:()=>{throw Error('must not install');}});assert.equal(broken.configurationError,true);assert.equal(existsSync(join(f.codexHome,'config.toml')),false);}finally{f.close();}
});
