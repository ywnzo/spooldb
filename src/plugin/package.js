import {copyProductionDependencies} from '../production-dependencies.js';
import {prepareStableHooks,installStableHooks} from './stable-hooks.js';
import {existsSync,readFileSync,mkdirSync,cpSync,writeFileSync,chmodSync,renameSync,rmSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {desktopPaths} from '../desktop/paths.js';
import {bundledRuntime} from '../runtime.js';
import {pluginSettingsPath} from './state.js';
export function packagePlugin({app,destination,runtime=bundledRuntime(app),engine=process.versions.bun?'bun':'node'}){
 app=resolve(app);destination=resolve(destination);if(app===destination||app.startsWith(destination+'/'))throw Error('Plugin destination must not contain the application');
 if(process.platform!=='linux'||process.arch!=='x64')throw Error('The bundled plugin currently supports Linux x86-64');
 const receipt=join(destination,'spool-marketplace.json');if(existsSync(destination)&&!existsSync(receipt))throw Error('Refusing to replace an unmanaged plugin marketplace');
 const stage=destination+'.new-'+randomUUID(),plugin=join(stage,'plugins/spooldb'),bundled=join(plugin,'app');mkdirSync(dirname(stage),{recursive:true,mode:0o700});
 try{
  cpSync(join(app,'plugins/spooldb'),plugin,{recursive:true});mkdirSync(bundled,{recursive:true});
  for(const name of ['src','schemas','package.json','bun.lock','LICENSE'])cpSync(join(app,name),join(bundled,name),{recursive:true});
  cpSync(join(app,'plugins/spooldb'),join(bundled,'plugins/spooldb'),{recursive:true});
  copyProductionDependencies(app,bundled);
  mkdirSync(join(bundled,'runtime'));engine=runtime.endsWith('/bun')?'bun':engine;cpSync(runtime,join(bundled,'runtime',engine));chmodSync(join(bundled,'runtime',engine),0o755);chmodSync(join(plugin,'scripts/spool.sh'),0o755);
  const runtimeLicense=existsSync(join(app,'runtime/LICENSE'))?join(app,'runtime/LICENSE'):engine==='bun'?'/usr/share/licenses/bun/LICENSE.md':'/usr/share/licenses/nodejs/LICENSE';if(existsSync(runtimeLicense))cpSync(runtimeLicense,join(bundled,'runtime/LICENSE'));
  prepareStableHooks(plugin);
  mkdirSync(join(stage,'.agents/plugins'),{recursive:true});writeFileSync(join(stage,'.agents/plugins/marketplace.json'),JSON.stringify({name:'spooldb',interface:{displayName:'SpoolDB'},plugins:[{name:'spooldb',source:{source:'local',path:'./plugins/spooldb'},policy:{installation:'AVAILABLE',authentication:'ON_USE'},category:'Productivity'}]},null,2)+'\n');
  writeFileSync(join(stage,'spool-marketplace.json'),JSON.stringify({managedBy:'SpoolDB',version:JSON.parse(readFileSync(join(plugin,'.codex-plugin/plugin.json'))).version})+'\n',{mode:0o600});
  if(existsSync(destination))renameSync(destination,destination+'.previous-'+Date.now());renameSync(stage,destination);
  return {marketplace:destination,plugin:join(destination,'plugins/spooldb')};
 }finally{rmSync(stage,{recursive:true,force:true});}
}
export function installPlugin({state,app=fileURLToPath(new URL('../../',import.meta.url)),paths=desktopPaths(),run=(args)=>execFileSync('codex',args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:60000})}={}){
 const result=packagePlugin({app,destination:join(paths.data,'spool/plugin-marketplace')});
 installStableHooks(result.plugin,{data:paths.data});
 const settings=join(paths.config,'spool/plugin.json');mkdirSync(dirname(settings),{recursive:true,mode:0o700});writeFileSync(settings,JSON.stringify({state:resolve(state)})+'\n',{mode:0o600});
 run(['plugin','marketplace','add',result.marketplace,'--json']);run(['plugin','add','spooldb@spooldb','--json']);
 return {...result,installed:true,hookReviewRequired:true,restartRequired:true,setupSkill:'spooldb:setup',message:'Review and trust the SpoolDB hooks in Codex, then run the SpoolDB setup skill in a new chat. Existing integrations remain until setup migration is approved.'};
}
