import {copyProductionDependencies} from '../src/production-dependencies.js';
import {prepareStableHooks} from '../src/plugin/stable-hooks.js';
import {cpSync,mkdirSync,rmSync,readFileSync,writeFileSync,chmodSync,existsSync} from 'node:fs';
import {join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fetchBunRuntime} from './fetch-bun-runtime.js';
const root=fileURLToPath(new URL('../',import.meta.url)),out=resolve(process.env.SPOOL_PLUGIN_BUILD_DIR??join(root,'work/plugin-marketplace'));
if(out===root||root.startsWith(out+'/'))throw Error('Build output must not contain the source tree');
rmSync(out,{recursive:true,force:true});const plugin=join(out,'plugins/spooldb'),app=join(plugin,'app');cpSync(join(root,'plugins/spooldb'),plugin,{recursive:true});mkdirSync(app,{recursive:true});
for(const name of ['src','schemas','package.json','bun.lock','LICENSE'])cpSync(join(root,name),join(app,name),{recursive:true});
cpSync(join(root,'plugins/spooldb'),join(app,'plugins/spooldb'),{recursive:true});
copyProductionDependencies(root,app);
mkdirSync(join(app,'runtime'));
for(const target of ['linux-x64','darwin-arm64']){
 const runtime=await fetchBunRuntime({target});
 const name=target==='linux-x64'?'bun':'bun-darwin-arm64';
 cpSync(runtime,join(app,'runtime',name));chmodSync(join(app,'runtime',name),0o755);
}
cpSync(join(root,'third-party/BUN-LICENSE.txt'),join(app,'runtime/LICENSE'));chmodSync(join(plugin,'scripts/spool.sh'),0o755);
prepareStableHooks(plugin);
mkdirSync(join(out,'.agents/plugins'),{recursive:true});writeFileSync(join(out,'.agents/plugins/marketplace.json'),JSON.stringify({name:'spooldb',interface:{displayName:'SpoolDB'},plugins:[{name:'spooldb',source:{source:'local',path:'./plugins/spooldb'},policy:{installation:'AVAILABLE',authentication:'ON_USE'},category:'Productivity'}]},null,2)+'\n');
mkdirSync(join(root,'installers'),{recursive:true});const archive=join(root,'installers/spooldb-codex.tar.gz');execFileSync('tar',['-czf',archive,'-C',out,'.']);const sha=createHash('sha256').update(readFileSync(archive)).digest('hex');writeFileSync(archive+'.sha256',sha+'  spooldb-codex.tar.gz\n');
console.log(JSON.stringify({marketplace:out,plugin,archive,sha256:sha}));
