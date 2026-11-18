import {copyProductionDependencies} from '../src/production-dependencies.js';
import {rustWorkerBuilt} from '../src/deploy/rust-worker.js';
import {fetchBunRuntime} from './fetch-bun-runtime.js';
import {cpSync,linkSync,mkdirSync,rmSync,readFileSync,writeFileSync,readdirSync,statSync,chmodSync} from 'node:fs';
import {resolve,join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('../',import.meta.url)),work=join(root,'work/linux-package'),bundle=join(work,'SpoolDB');
rmSync(work,{recursive:true,force:true});mkdirSync(join(bundle,'runtime'),{recursive:true});
for(const name of ['src','schemas','package.json','bun.lock','LICENSE','wrangler.jsonc'])cpSync(join(root,name),join(bundle,name),{recursive:true});
const rustFiles=['Cargo.toml','Cargo.lock','src','shared','cloudflare/src/remote-tools.json'];
for(const name of rustFiles){
 const destination=join(bundle,'rust',name);
 mkdirSync(join(destination,'..'),{recursive:true});
 cpSync(join(root,'rust',name),destination,{recursive:true});
}
if(rustWorkerBuilt(root))for(const name of ['entry.js','build/index.js','build/index_bg.wasm','build/spool-release.json']){
 const destination=join(bundle,'rust/cloudflare',name);
 mkdirSync(join(destination,'..'),{recursive:true});
 cpSync(join(root,'rust/cloudflare',name),destination);
}
const engine='bun';
cpSync(join(root,'plugins/spooldb'),join(bundle,'plugins/spooldb'),{recursive:true});
const runtime=process.env.SPOOL_BUILD_BUN??await fetchBunRuntime();
if(execFileSync(runtime,['-p','process.platform+"-"+process.arch'],{encoding:'utf8'}).trim()!=='linux-x64')throw new Error('Need a standalone Linux x64 Bun runtime');
cpSync(runtime,join(bundle,'runtime',engine));chmodSync(join(bundle,'runtime',engine),0o755);
cpSync(join(root,'third-party/BUN-LICENSE.txt'),join(bundle,'runtime/LICENSE'));
if(process.env.SPOOL_CLIENT_LINUX_X64){
 const native=join(bundle,'runtime','spool-native-linux-x64');
 cpSync(process.env.SPOOL_CLIENT_LINUX_X64,native);
 chmodSync(native,0o755);
}
if(process.env.SPOOL_RELAY_LINUX_X64){
 const imageBinary=join(bundle,'runtime','spool-relay-linux-x64');
 if(process.env.SPOOL_RELAY_LINUX_X64===process.env.SPOOL_CLIENT_LINUX_X64)
  linkSync(join(bundle,'runtime','spool-native-linux-x64'),imageBinary);
 else cpSync(process.env.SPOOL_RELAY_LINUX_X64,imageBinary);
 chmodSync(imageBinary,0o755);
}
if(process.env.SPOOL_NATIVE_PLUGIN_SOURCE){
 if(!process.env.SPOOL_CLIENT_LINUX_X64)throw Error('Native plugin packaging requires the Linux client binary');
 const prepared=resolve(process.env.SPOOL_NATIVE_PLUGIN_SOURCE),source=join(prepared,'plugins/spooldb'),marketplace=join(bundle,'local-marketplace'),plugin=join(marketplace,'plugins/spooldb');
 cpSync(source,plugin,{recursive:true,filter:path=>path!==join(source,'app')});
 if(!statSync(join(plugin,'hooks/native-dispatch/files.sha256')).isFile())throw Error('Expected a verified native hook profile');
 mkdirSync(join(plugin,'app/runtime'),{recursive:true});
 for(const target of ['linux-x64','darwin-arm64']){
  const name='spool-hook-'+target;
  cpSync(join(source,'app/runtime',name),join(plugin,'app/runtime',name));
 }
 linkSync(join(bundle,'runtime/spool-native-linux-x64'),join(plugin,'app/runtime/spool-native-linux-x64'));
 mkdirSync(join(marketplace,'.agents/plugins'),{recursive:true});
 cpSync(join(prepared,'.agents/plugins/marketplace.json'),join(marketplace,'.agents/plugins/marketplace.json'));
}
const runtimeVersion=execFileSync(runtime,['--version'],{encoding:'utf8'}).trim();
const native=Boolean(process.env.SPOOL_CLIENT_LINUX_X64||process.env.SPOOL_RELAY_LINUX_X64);
copyProductionDependencies(root,bundle,{exclude:native?['@huggingface/transformers']:[]});
if(native){
 // Rust uses the CPU shared libraries directly. Keep the container’s original
 // input paths without shipping other platforms or the JavaScript model runtime.
 const ort='node_modules/onnxruntime-node/bin/napi-v3/linux/x64';
 mkdirSync(join(bundle,ort),{recursive:true});
 for(const [source,name] of [['libonnxruntime.so.1.21.0','libonnxruntime.so'],
  ['libonnxruntime_providers_shared.so','libonnxruntime_providers_shared.so']]){
  cpSync(join(root,ort,source),join(bundle,ort,source));
  linkSync(join(bundle,ort,source),join(bundle,'runtime',name));
 }
}
const files={};function walk(dir){for(const entry of readdirSync(dir)){const path=join(dir,entry);if(statSync(path).isDirectory())walk(path);else files[relative(bundle,path)]=createHash('sha256').update(readFileSync(path)).digest('hex');}}walk(bundle);
writeFileSync(join(bundle,'manifest.json'),JSON.stringify({version:JSON.parse(readFileSync(join(root,'package.json'))).version,platform:'linux-x64',runtime:{engine,version:runtimeVersion},files},null,2)+'\n');
const archive=execFileSync('tar',['-czf','-','-C',work,'SpoolDB'],{maxBuffer:200*1024*1024});
const header=`#!/bin/sh
set -eu
umask 077
case "$(uname -sm)" in 'Linux x86_64') ;; *) echo 'This installer needs Linux x86-64.' >&2; exit 1;; esac
tmp=$(mktemp -d "\${TMPDIR:-/tmp}/spool-install.XXXXXXXX")
trap 'rm -rf "$tmp"' EXIT
trap 'exit 130' INT TERM
line=$(awk '/^__SPOOL_PAYLOAD__$/{print NR+1;exit}' "$0")
tail -n +"$line" "$0" | tar -xz -C "$tmp"
if [ "\${1:-}" = "--relay-update" ] && [ -x "$tmp/SpoolDB/runtime/spool-native-linux-x64" ] && [ -x "$tmp/SpoolDB/runtime/spool-relay-linux-x64" ]; then
 "$tmp/SpoolDB/runtime/spool-native-linux-x64" relay-apply "$2" "$tmp/SpoolDB"
 exit 0
fi
if [ "\${1:-}" = "--server" ] && [ -x "$tmp/SpoolDB/runtime/spool-relay-linux-x64" ]; then
 "$tmp/SpoolDB/runtime/spool-native-linux-x64" server-setup "$tmp/SpoolDB"
 exit 0
fi
if [ -x "$tmp/SpoolDB/runtime/spool-native-linux-x64" ] && [ "\${1:-}" != "--server" ]; then
 "$tmp/SpoolDB/runtime/spool-native-linux-x64" desktop-install "$tmp/SpoolDB" "$@"
 exit 0
fi
"$tmp/SpoolDB/runtime/${engine}" "$tmp/SpoolDB/src/desktop/install.js" "$@"
exit 0
__SPOOL_PAYLOAD__
`;
if(archive.length+Buffer.byteLength(header)>200000000)throw Error('Installer exceeds the existing updater download limit');
mkdirSync(join(root,'installers'),{recursive:true});const output=join(root,'installers/spool-linux-x64.run');writeFileSync(output,Buffer.concat([Buffer.from(header),archive]),{mode:0o755});chmodSync(output,0o755);console.log(output+' ('+(statSync(output).size/1024/1024).toFixed(1)+' MiB)');
