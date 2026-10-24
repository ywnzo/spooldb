import {existsSync,mkdirSync,readFileSync,writeFileSync,cpSync,lstatSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {verifyBundle} from './desktop/install.js';
import {normalizeDomain,inspectDomain,openWebFirewall,waitForHTTPS,rootRun} from './server-caddy.js';
const marker='# Managed by SpoolDB VPS setup',label='dev.spooldb.managed';
export const vpsPaths={app:'/opt/spooldb',unit:'/etc/systemd/system/spool-shared.service',cli:'/usr/local/bin/spool'};
const shell=value=>"'"+value.replaceAll("'","'\\''")+"'";
export function selectEngine(run=rootRun){for(const engine of ['/usr/bin/podman','/usr/bin/docker'])try{run(engine,['info']);return engine;}catch{}throw Error('Install and start Docker or Podman on this VPS, then run the installer again.');}
export function containerRequest(path,input,{run=rootRun}={}){const config=JSON.parse(readFileSync(path,'utf8'));return JSON.parse(run(config.engine,['exec','-i','spool-relay','bun','src/team-host.js','request','/data'],{input:JSON.stringify(input)}));}
export function containerUnit({app,engine}){return `${marker}\n[Unit]\nDescription=SpoolDB relay and HTTPS containers\nWants=network-online.target\nAfter=network-online.target${engine.endsWith('/docker')?' docker.service':''}\n${engine.endsWith('/docker')?'Requires=docker.service\n':''}\n[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=${engine} start spool-relay spool-caddy\nExecStop=${engine} stop -t 30 spool-caddy spool-relay\nTimeoutStartSec=120\nTimeoutStopSec=90\n\n[Install]\nWantedBy=multi-user.target\n`;}
export function containerCommands({app,domain,probe,image}){return [
 ['create','--name','spool-relay','--label',label+'=true','--restart=unless-stopped','--network','spool-network','--network-alias','relay','--mount','type=volume,source=spool-relay-data,target=/data',image,'bun','src/team-host.js','start','/data','--host=0.0.0.0','--port=8878','--origin=https://'+domain],
 ['create','--name','spool-caddy','--label',label+'=true','--restart=unless-stopped','--network','spool-network','-p','80:80','-p','443:443','--mount','type=volume,source=spool-caddy-data,target=/data','--mount','type=volume,source=spool-caddy-config,target=/config','docker.io/library/caddy:2.11.7']
 ];}
export async function configureVPS({domain,bundle,paths=vpsPaths,run=rootRun,checkDNS=inspectDomain,firewall=openWebFirewall,checkHTTPS=waitForHTTPS,requireRoot=true,progress=()=>{}}={}){
 domain=normalizeDomain(domain);if(requireRoot&&process.getuid?.()!==0)throw Error('Automatic VPS setup requires root/sudo for public ports 80/443.');
 bundle=resolve(bundle);const manifest=verifyBundle(bundle);if(!existsSync(join(bundle,'runtime/bun')))throw Error('Use the self-contained Linux installer.');
 for(const path of [paths.app,paths.unit,paths.cli])if(existsSync(path)&&lstatSync(path).isSymbolicLink())throw Error('Refusing to replace a symlink: '+path);
 const configPath=join(paths.app,'containers.json');let previous;
 if(existsSync(paths.app)){if(!existsSync(configPath))throw Error('Existing application is not a managed container installation. Choose advanced setup.');previous=JSON.parse(readFileSync(configPath));if(previous.managedBy!=='SpoolDB')throw Error('Unmanaged installation.');}
 for(const path of [paths.unit,paths.cli])if(existsSync(path)&&!readFileSync(path,'utf8').includes(marker))throw Error('Unmanaged service or command: '+path);
 await checkDNS(domain);const engine=previous?.engine??selectEngine(run);run(engine,['info']);
 // Inspect every name before changing anything. Never adopt another application's resources.
 for(const [kind,names] of [['container',['spool-relay','spool-caddy']],['volume',['spool-relay-data','spool-caddy-data','spool-caddy-config']],['network',['spool-network']]])for(const name of names){let result;try{result=JSON.parse(run(engine,[kind,'inspect',name]));}catch{continue;}const item=result[0]??result;if((item.Config?.Labels??item.Labels??item.labels)?.[label]!=='true')throw Error('Unmanaged container resource exists: '+name);}
 mkdirSync(paths.app,{recursive:true,mode:0o700});const app=join(paths.app,'releases',manifest.version+'-'+randomUUID());cpSync(bundle,app,{recursive:true});
 const image='localhost/spooldb-relay:'+manifest.version+'-'+randomUUID(),probe=randomUUID();
 writeFileSync(join(app,'Containerfile'),`FROM docker.io/oven/bun:1.4.3\nWORKDIR /app\nCOPY src ./src\nCOPY schemas ./schemas\nCOPY package.json ./\nCOPY node_modules ./node_modules\nRUN chmod -R a+rX /app && mkdir /data && chown bun:bun /data\nUSER bun\nVOLUME /data\nEXPOSE 8878\n`);
 progress('Building the relay container and downloading Caddy…');run(engine,['build','-f',join(app,'Containerfile'),'-t',image,app],{stdio:'inherit',timeout:600000});run(engine,['pull','docker.io/library/caddy:2.11.7'],{stdio:'inherit',timeout:300000});
 const config={managedBy:'SpoolDB',engine,image,domain,app,probe};writeFileSync(configPath,JSON.stringify(config,null,2)+'\n',{mode:0o600});
 // Named volumes survive failed setup, container recreation and installer reruns.
 for(const name of ['spool-relay-data','spool-caddy-data','spool-caddy-config'])run(engine,['volume','create','--label',label+'=true',name]);
 try{run(engine,['network','inspect','spool-network']);}catch{run(engine,['network','create','--label',label+'=true','spool-network']);}
 const savedUnit=existsSync(paths.unit)?readFileSync(paths.unit):null,savedCLI=existsSync(paths.cli)?readFileSync(paths.cli):null,backups=[],created=[];
 let enrollment;
 try{
  for(const name of ['spool-caddy','spool-relay']){let found=false;try{run(engine,['container','inspect',name]);found=true;}catch{}if(found){const backup=name+'-previous-'+randomUUID();run(engine,['stop','-t','30',name]);run(engine,['rename',name,backup]);backups.push({name,backup});}}
  const commands=containerCommands({...config});
  // Copy configuration through the engine; no host bind mount or SELinux relabeling.
  for(const args of commands){run(engine,args);created.push(args[args.indexOf('--name')+1]);}
  const caddyfile=join(app,'Caddyfile');writeFileSync(caddyfile,`${domain} {\n @health path /healthz\n header @health X-SpoolDB-Setup ${probe}\n reverse_proxy relay:8878\n}\n`);run(engine,['cp',caddyfile,'spool-caddy:/etc/caddy/Caddyfile']);
  mkdirSync(dirname(paths.unit),{recursive:true});writeFileSync(paths.unit,containerUnit({...paths,engine}),{mode:0o644});run('systemctl',['daemon-reload']);run('systemctl',['enable','--now','spool-shared.service']);run(engine,['start','spool-relay','spool-caddy']);
  for(let i=0;i<30;i++){try{enrollment=containerRequest(configPath,{command:'workspace-init',name:domain},{run});break;}catch(error){if(i===29)throw error;await delay(500);}}
  mkdirSync(dirname(paths.cli),{recursive:true});writeFileSync(paths.cli,`#!/bin/sh\n${marker}\nexport SPOOL_CONTAINER_CONFIG=${shell(configPath)}\nexport SPOOL_SYSTEM_SERVICE=1\nexec ${shell(join(app,'runtime/bun'))} ${shell(join(app,'src/cli.js'))} "$@"\n`,{mode:0o755});
  firewall({run});await checkHTTPS(domain,probe,{progress});for(const {backup} of backups)try{run(engine,['rm',backup]);}catch{}return {origin:'https://'+domain,engine,ownerLink:enrollment.link??null};
 }catch(error){if(previous){try{for(const name of created)run(engine,['rm','-f',name]);for(const {name,backup} of backups){run(engine,['rename',backup,name]);run(engine,['start',name]);}writeFileSync(configPath,JSON.stringify(previous,null,2)+'\n',{mode:0o600});if(savedUnit)writeFileSync(paths.unit,savedUnit);if(savedCLI)writeFileSync(paths.cli,savedCLI,{mode:0o755});run('systemctl',['daemon-reload']);error.message+=' Previous containers were restored.';}catch{error.message+=' Automatic rollback could not finish; previous containers remain under spool-*-previous-* names.';}}error.message+=' Container volumes and installation files were preserved. Fix the error and rerun setup. Inspect sudo '+engine+' logs spool-caddy and spool-relay.';throw error;}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){process.umask(0o077);const args=process.argv.slice(2),option=name=>args[args.indexOf(name)+1];configureVPS({domain:option('--domain'),bundle:option('--bundle'),progress:console.log}).then(result=>{console.log('\nSpoolDB ready: '+result.origin+'\nContainers start automatically on reboot. Manage with sudo spool server status.');if(result.ownerLink)console.log('Private owner invitation (single use):\n'+result.ownerLink);else console.log('Existing workspace preserved. Use sudo spool server workspace owner-invite for an invitation.');}).catch(error=>{console.error(error.message);process.exitCode=1;});}
