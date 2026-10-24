// Hook-only entry point. Its complete local import graph and runtime are pinned by the stable dispatcher.
import {pluginState} from './state.js';
import {ensureCompanion} from './companion.js';
import {runDiscoveryHook} from '../discovery-hook.js';
process.umask(0o077);
const event=process.argv[2];let companion;
try{
 let text='';for await(const chunk of process.stdin){text+=chunk;if(Buffer.byteLength(text)>1000000)throw Error('Hook input too large');}
 companion=await ensureCompanion(pluginState(),{timeout:event==='Interrupt'?1500:20000});
 const result=await runDiscoveryHook({directory:pluginState(),event,input:JSON.parse(text),plugin:true});console.log(JSON.stringify(result));
}catch(error){console.log(JSON.stringify(/not a git repository|rev-parse/.test(error.message)?{}:{systemMessage:'SpoolDB hook unavailable: '+error.message}));}
finally{companion?.release();}
