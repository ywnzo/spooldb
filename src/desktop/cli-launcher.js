import {bundledRuntime} from '../runtime.js';
import {existsSync,mkdirSync,readFileSync,writeFileSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
const marker='# Managed by SpoolDB CLI installer';
const shell=value=>"'"+value.replaceAll("'","'\\''")+"'";
export function assertCLIWritable(paths){const path=join(paths.bin??join(paths.data,'spool/bin'),'spool');if(existsSync(path)&&!readFileSync(path,'utf8').includes(marker))throw new Error('An unmanaged spool command already exists at '+path);return path;}
export function registerCLI({app,state,serverState,paths,runtime}){
 const bin=paths.bin??join(paths.data,'spool/bin'),path=assertCLIWritable(paths);
 if(existsSync(path)&&!readFileSync(path,'utf8').includes(marker))throw new Error('An unmanaged spool command already exists at '+path);
 mkdirSync(bin,{recursive:true});const node=runtime??bundledRuntime(app);
 const native=join(app,'runtime/spool-native-linux-x64');
 const commands=state&&existsSync(native)?`case "\${1:-}" in
 open|init|memory|storage|status|discovery|service|plugin|--version) exec ${shell(native)} "$@" ;;
 workspace)
   case "\${2:-}" in connect|status|projects|members|create|saved|sharing|usage|invite|revoke|disconnect|switch) exec ${shell(native)} "$@" ;; esac
   ;;
 project)
   case "\${2:-}" in list|add|select|status|capture|agents|pause|resume|invite|accept-invite|join|join-invite|connections|revoke|sharing|delete-conversations) exec ${shell(native)} "$@" ;; esac
   ;;
 update)
   legacy_update=
   for argument do
     case "$argument" in relay|--target=relay) legacy_update=1 ;; esac
   done
   if [ -z "$legacy_update" ] && [ -z "\${SPOOL_CONTAINER_CONFIG:-}" ]; then
     case "\${2:-}" in ''|status|check|enable|disable|--yes|--json|--target*) exec ${shell(native)} "$@" ;; esac
   fi
   ;;
 deploy)
   if [ "\${2:-}" = cloudflare ]; then exec ${shell(native)} "$@"; fi
   ;;
 server) case "\${2:-}" in setup|status|workspace|project) exec ${shell(native)} "$@" ;; esac ;;
 ''|help|--help) ;;
 --sharded) [ "$#" -eq 1 ] && exec ${shell(native)} storage spool.sqlite --sharded ;;
 -*) ;;
 *)
   case "\${2:-}" in
     '') exec ${shell(native)} storage "$1" --legacy ;;
     --sharded) [ "$#" -eq 2 ] && exec ${shell(native)} storage "$1" --sharded ;;
     watch|run)
       database=$1
       shift
       exec ${shell(native)} storage "$database" "$@"
       ;;
   esac
   ;;
esac\n`:'';
 const localServer=serverState&&existsSync(native)?`if [ "\${1:-}" = server ]; then
   case "\${2:-}" in status|workspace|project) exec ${shell(native)} "$@" ;; esac
 elif [ "\${1:-}" = service ]; then exec ${shell(native)} "$@"
 fi
`:'';
 const variables=[...(state?[`SPOOL_STATE=${shell(state)}; export SPOOL_STATE`]:[]),...(serverState?[`SPOOL_SERVER_STATE=${shell(serverState)}; export SPOOL_SERVER_STATE`]:[])];
 writeFileSync(path,`#!/bin/sh\n${marker}\n${variables.join('\n')}\n${localServer}${commands}exec ${shell(node)} ${shell(join(app,'src/cli.js'))} "$@"\n`,{mode:0o755});chmodSync(path,0o755);return path;
}
