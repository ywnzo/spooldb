import {existsSync,lstatSync,mkdirSync,chmodSync,chownSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {rootRun} from './server-caddy.js';
const marker='# Managed by SpoolDB relay control';
export function prepareRelayControl(configPath,{requireRoot=true}={}){
 if(requireRoot&&process.getuid?.()!==0)throw Error('Relay maintenance requires root');
 const root=dirname(configPath),directory=join(root,'control');
 if(existsSync(directory)&&!lstatSync(directory).isDirectory())throw Error('Control directory must not be a symlink or file');
 mkdirSync(directory,{recursive:true,mode:0o750});chmodSync(directory,0o750);if(requireRoot)chownSync(directory,0,1000);
 return directory;
}
export function installRelayControl(configPath,{run=rootRun,units='/etc/systemd/system',requireRoot=true}={}){
 prepareRelayControl(configPath,{requireRoot});const config=JSON.parse(readFileSync(configPath,'utf8'));const quote=value=>JSON.stringify(value.replaceAll('%','%%').replaceAll('$','$$'));const file=join(units,'spool-relay-control.service');
 if(existsSync(file)&&(!lstatSync(file).isFile()||!readFileSync(file,'utf8').includes(marker)))throw Error('Unmanaged relay control service');
 writeFileSync(file,`${marker}\n[Unit]\nDescription=SpoolDB owner maintenance control\nAfter=network-online.target spool-shared.service\nWants=network-online.target\n[Service]\nType=simple\nExecStart=${quote(join(config.app,'runtime/bun'))} ${quote(join(config.app,'src/relay-control-service.js'))} ${quote(configPath)}\nRestart=on-failure\nRestartSec=3\nKillMode=process\nUMask=0077\n[Install]\nWantedBy=multi-user.target\n`,{mode:0o644});
 writeFileSync(join(dirname(configPath),'relay-control-runtime.json'),JSON.stringify({previous:config})+'\n',{mode:0o600});
 run('systemctl',['daemon-reload']);run('systemctl',['enable','spool-relay-control.service']);run('systemctl',['--no-block','restart','spool-relay-control.service']);
}
