import {readFileSync,writeFileSync,existsSync,mkdirSync,renameSync,rmSync,lstatSync} from 'node:fs';
import {join,dirname,relative,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {desktopPaths} from '../desktop/paths.js';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
// Never redirect an already trusted command to arbitrary new hook code. The manifest below pins
// the hook entry's local dependency graph and interpreter before any plugin hook JS is executed.
const dispatcherTemplate=`#!/bin/sh
set -eu
profile=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root="\${PLUGIN_ROOT:-\${CLAUDE_PLUGIN_ROOT:-}}"
if [ -z "$root" ]; then echo 'SpoolDB hook: plugin location was not provided by Codex.' >&2; exit 1; fi
root=$(CDPATH= cd -- "$root" && pwd -P)
cd -- "$root"
while read -r checksum file; do
  # Resolve each parent physically and reject a symlink at the leaf.
  parent=$(CDPATH= cd -- "$(dirname -- "$file")" && pwd -P)
  if [ -L "$file" ] || [ "$parent/$(basename -- "$file")" != "$root/$file" ]; then
    echo 'SpoolDB hook dependencies must not be redirected through symlinks.' >&2
    exit 1
  fi
  if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$file"); else actual=$(shasum -a 256 "$file"); fi
  if [ "\${actual%% *}" != "$checksum" ]; then
    echo 'SpoolDB hook code changed or is incomplete. Reinstall/update the plugin and review its changed hook definition.' >&2
    exit 1
  fi
done < "$profile/files.sha256"
runtime="$root/__SPOOL_HOOK_RUNTIME__"
if [ "$(uname -sm)" = 'Darwin arm64' ] && [ -x "$root/app/runtime/bun-darwin-arm64" ]; then runtime="$root/app/runtime/bun-darwin-arm64"; fi
exec "$runtime" "$root/app/src/plugin/hook-entry.js" "$@"
`;
const imports=/(?:\b(?:import|export)\s+(?:(?:[^'";]+?)\s+from\s*)?|\bimport\s*\(\s*)['"]([^'"]+)['"]/g;
export function hookProfile(plugin){
 plugin=resolve(plugin);const source=join(plugin,'app/src'),queue=[join(source,'plugin/hook-entry.js')],seen=new Map();
 while(queue.length){const path=queue.pop();if(seen.has(path))continue;const name=relative(plugin,path);if(!name.startsWith('app/src/')||name.includes('..'))throw Error('Hook dependencies must stay inside app/src');const code=readFileSync(path,'utf8');seen.set(path,{name,hash:sha(code)});
  for(const match of code.matchAll(imports)){const specifier=match[1];if(specifier.startsWith('node:'))continue;if(!specifier.startsWith('.'))throw Error('Hook runtime must use local modules or Node builtins: '+specifier);const dependency=resolve(dirname(path),specifier);if(!dependency.endsWith('.js'))throw Error('Hook module must be JavaScript');queue.push(dependency);}
 }
 const runtime=existsSync(join(plugin,'app/runtime/bun'))?'app/runtime/bun':'app/runtime/node',files=[...seen.values(),...(existsSync(join(plugin,'app/runtime/bun-darwin-arm64'))?[{name:'app/runtime/bun-darwin-arm64',hash:sha(readFileSync(join(plugin,'app/runtime/bun-darwin-arm64')))}]:[]),{name:runtime,hash:sha(readFileSync(join(plugin,runtime)))}].sort((a,b)=>a.name.localeCompare(b.name)),manifest=files.map(f=>f.hash+'  '+f.name+'\n').join('');
 const dispatcher=dispatcherTemplate.replaceAll('__SPOOL_HOOK_RUNTIME__',runtime);const fingerprint=sha(JSON.stringify({protocol:'spool-hooks/1',dispatcher,runtime,manifest}));return {fingerprint,runtime,manifest,dispatcher,files};
}
export function prepareStableHooks(plugin){
 const profile=hookProfile(plugin),path=join(plugin,'hooks/hooks.json'),hooks=JSON.parse(readFileSync(path));
 for(const [event,groups]of Object.entries(hooks.hooks))for(const group of groups)for(const handler of group.hooks){handler.command='sh "${XDG_DATA_HOME:-$HOME/.local/share}/spool/codex-hooks/'+profile.fingerprint+'/run.sh" '+event;}
 writeFileSync(path,JSON.stringify(hooks,null,2)+'\n');writeFileSync(join(plugin,'hooks/runtime-profile.json'),JSON.stringify({protocol:'spool-hooks/1',fingerprint:profile.fingerprint,runtime:profile.runtime},null,2)+'\n');return profile;
}
export function installStableHooks(plugin,{data=desktopPaths().data}={}){
 const profile=hookProfile(plugin),declared=JSON.parse(readFileSync(join(plugin,'hooks/runtime-profile.json')));
 if(declared.protocol!=='spool-hooks/1'||declared.fingerprint!==profile.fingerprint||declared.runtime!==profile.runtime)throw Error('SpoolDB hook runtime does not match the packaged hook definition');
 const parent=join(data,'spool/codex-hooks'),target=join(parent,profile.fingerprint),files={'run.sh':profile.dispatcher,'files.sha256':profile.manifest,runtime:profile.runtime+'\n'};mkdirSync(parent,{recursive:true,mode:0o700});
 if(existsSync(target)){if(lstatSync(target).isSymbolicLink())throw Error('SpoolDB hook profile must not be a symlink');for(const [name,expected]of Object.entries(files)){const path=join(target,name);if(lstatSync(path).isSymbolicLink()||readFileSync(path,'utf8')!==expected)throw Error('The installed SpoolDB hook dispatcher was modified; it was left unchanged');}return {path:target,fingerprint:profile.fingerprint};}
 const stage=target+'.new-'+randomUUID();mkdirSync(stage,{mode:0o700});try{for(const [name,content]of Object.entries(files))writeFileSync(join(stage,name),content,{mode:name==='run.sh'?0o700:0o600});try{renameSync(stage,target);}catch(error){if(!['EEXIST','ENOTEMPTY'].includes(error.code))throw error;return installStableHooks(plugin,{data});}}finally{rmSync(stage,{recursive:true,force:true});}
 return {path:target,fingerprint:profile.fingerprint};
}
