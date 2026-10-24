import {copyProductionDependencies} from '../src/production-dependencies.js';
import {fetchBunRuntime} from './fetch-bun-runtime.js';
import {cpSync,mkdirSync,rmSync,readFileSync,writeFileSync,readdirSync,statSync,chmodSync} from 'node:fs';
import {resolve,join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('../',import.meta.url)),work=join(root,'work/linux-package'),bundle=join(work,'SpoolDB');
rmSync(work,{recursive:true,force:true});mkdirSync(join(bundle,'runtime'),{recursive:true});
for(const name of ['src','schemas','package.json','bun.lock','LICENSE','wrangler.jsonc'])cpSync(join(root,name),join(bundle,name),{recursive:true});
const engine='bun';
cpSync(join(root,'plugins/spooldb'),join(bundle,'plugins/spooldb'),{recursive:true});
const runtime=process.env.SPOOL_BUILD_BUN??await fetchBunRuntime();
if(execFileSync(runtime,['-p','process.platform+"-"+process.arch'],{encoding:'utf8'}).trim()!=='linux-x64')throw new Error('Need a standalone Linux x64 Bun runtime');
cpSync(runtime,join(bundle,'runtime',engine));chmodSync(join(bundle,'runtime',engine),0o755);
cpSync(join(root,'third-party/BUN-LICENSE.txt'),join(bundle,'runtime/LICENSE'));
const runtimeVersion=execFileSync(runtime,['--version'],{encoding:'utf8'}).trim();
copyProductionDependencies(root,bundle);
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
"$tmp/SpoolDB/runtime/${engine}" "$tmp/SpoolDB/src/desktop/install.js" "$@"
exit 0
__SPOOL_PAYLOAD__
`;
mkdirSync(join(root,'installers'),{recursive:true});const output=join(root,'installers/spool-linux-x64.run');writeFileSync(output,Buffer.concat([Buffer.from(header),archive]),{mode:0o755});chmodSync(output,0o755);console.log(output+' ('+(statSync(output).size/1024/1024).toFixed(1)+' MiB)');
