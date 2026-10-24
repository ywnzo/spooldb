import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync,chmodSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline/promises';
import {WorkspaceClient} from '../team/workspace-client.js';
import {parseWorkspaceLink,workspaceLink} from '../team/workspace.js';
const root=fileURLToPath(new URL('../../',import.meta.url));
export const WRANGLER_VERSION='4.152.0';
const save=(path,data)=>{mkdirSync(dirname(path),{recursive:true,mode:0o700});writeFileSync(path+'.tmp',JSON.stringify(data,null,2)+'\n',{mode:0o600});renameSync(path+'.tmp',path);chmodSync(path,0o600);};
export function cloudflareConfig({name,accountId,bootstrapHash,downloadsDirectory,oauthNamespaceId}){
 if(!/^[a-z][a-z0-9-]{1,61}[a-z0-9]$/.test(name))throw new Error('Worker name must be 3–63 lowercase letters, numbers or hyphens');
 if(accountId&&!/^[a-f0-9]{32}$/.test(accountId))throw new Error('Invalid Cloudflare account ID');
 return {name,...(downloadsDirectory?{assets:{directory:downloadsDirectory,binding:'DOWNLOADS',run_worker_first:true}}:{}),main:join(root,'src/cloudflare/worker.js'),compatibility_date:'2026-10-19',compatibility_flags:['nodejs_compat','global_fetch_strictly_public'],...(oauthNamespaceId?{kv_namespaces:[{binding:'OAUTH_KV',id:oauthNamespaceId}]}:{}),workers_dev:true,...(accountId?{account_id:accountId}:{}),alias:{'node:sqlite':join(root,'src/cloudflare/no-node-sqlite.js')},durable_objects:{bindings:[{name:'WORKSPACE',class_name:'SpoolWorkspace'},{name:'PROJECTS',class_name:'SpoolProject'}]},migrations:[{tag:'v1',new_sqlite_classes:['SpoolWorkspace','SpoolProject']}],vars:{BOOTSTRAP_TOKEN_HASH:bootstrapHash},limits:{cpu_ms:30000},observability:{enabled:true}};
}
function wrangler(){const cli=join(root,'node_modules/wrangler/bin/wrangler.js');if(existsSync(cli))return {command:process.execPath,prefix:[cli]};return process.versions.bun?{command:process.execPath,prefix:['x','--bun','wrangler@'+WRANGLER_VERSION]}:{command:'npx',prefix:['--yes','wrangler@'+WRANGLER_VERSION]};}
export function runWrangler(args,{output=process.stdout,interactive=false,quiet=false,logPath}={}){
 const {command,prefix}=wrangler();return new Promise((resolvePromise,reject)=>{const child=spawn(command,[...prefix,...args],{cwd:root,env:{...process.env,WRANGLER_SEND_METRICS:'false',...(logPath?{WRANGLER_LOG_PATH:logPath}:{})},stdio:interactive?'inherit':['ignore','pipe','pipe']});let text='',bytes=0;if(!interactive)for(const pipe of [child.stdout,child.stderr])pipe.on('data',chunk=>{if(pipe===child.stdout)text+=chunk;bytes+=chunk.length;if(bytes>2_000_000){child.kill();reject(new Error('Wrangler output exceeds limit'));}if(!quiet)output.write(chunk);});child.on('error',reject);child.on('close',status=>status===0?resolvePromise(text):reject(new Error('Wrangler failed (exit '+status+'). Check the output above; your deployment files are retained.')));});
}
export async function deployCloudflare({state,options={},input=process.stdin,output=process.stdout,run=runWrangler,fetcher=fetch,connect}={}){
 if(!options['dry-run']&&!options.resume&&!input.isTTY&&(!options.yes||!options.name||!options['account-id']))throw new Error('Use an interactive terminal, or --yes with --name and --account-id for deployment');
 const rl=input.isTTY?createInterface({input,output}):null;const ask=async(label,value='')=>rl?(await rl.question(label+(value?' ['+value+']':'')+': ')).trim()||value:value;
 try{
 if(!options.resume)output.write('\nSpoolDB · Cloudflare deployment\nA shared workspace and a separate Durable Object for each project.\nThe current self-hosted relay and its data stay in place. Cloudflare usage is billed to the selected account.\n');
 const savedPath=options['deploy-dir']?join(resolve(options['deploy-dir']),'deployment.json'):null;
 const savedName=options.resume&&savedPath&&existsSync(savedPath)?JSON.parse(readFileSync(savedPath)).name:null;
 const name=options.name??(options.resume?savedName??'spooldb':await ask('Worker name','spooldb'));cloudflareConfig({name});
 const folder=resolve(options['deploy-dir']??join(state,'deployments/cloudflare',name)),receiptPath=join(folder,'deployment.json');let receipt=existsSync(receiptPath)?JSON.parse(readFileSync(receiptPath)):{};
 if(receipt.name&&receipt.name!==name)throw new Error('Deployment directory belongs to another Worker');
 if(options.resume){if(options.url){const url=new URL(options.url);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new Error('Supply the deployed HTTPS origin with --url');receipt={...receipt,origin:url.origin};if(receipt.ownerLink)receipt.ownerLink=workspaceLink({...parseWorkspaceLink(receipt.ownerLink),url:url.origin});}if(!receipt.origin||!receipt.bootstrapToken||!receipt.workspaceName)throw new Error('No published deployment receipt found for this Worker. Use --name or --deploy-dir to select it.');output.write('Resuming setup for '+receipt.origin+' (no upload or publish).\n');return await finishCloudflareDeployment({receipt,receiptPath,state,options,output,ask,rl,fetcher,connect});}
 mkdirSync(folder,{recursive:true,mode:0o700});
 let accountId=options['account-id']??receipt.accountId;
 if(!options['dry-run']){
  let identity;try{identity=JSON.parse(await run(['whoami','--json'],{quiet:true,output,logPath:join(folder,'wrangler.log')}));}catch(error){
   if(!rl||!/^y(es)?$/i.test(await ask('Sign in to Cloudflare in your browser? (Y/n)','Y')))throw new Error('Cloudflare sign-in required. Run wrangler login and retry.');
   await run(['login'],{interactive:true,output});identity=JSON.parse(await run(['whoami','--json'],{quiet:true,output}));
  }
  const accounts=identity.accounts??identity.account?.accounts??[];
  if(!accountId){if(accounts.length===1)accountId=accounts[0].id;else if(accounts.length){output.write(accounts.map((a,i)=>`${i+1}. ${a.name} (${a.id})`).join('\n')+'\n');const selected=Number(await ask('Account number','1'));accountId=accounts[selected-1]?.id;}else accountId=await ask('Cloudflare account ID');}
  if(accounts.length&&!accounts.some(a=>a.id===accountId))throw new Error('Selected account is not available to this Cloudflare login');
 }
 const workspaceName=options['workspace-name']??receipt.workspaceName??await ask('Workspace name','Company workspace');if(!workspaceName.trim()||workspaceName.length>160)throw new Error('Enter a workspace name (1–160 characters)');
 if(receipt.accountId&&accountId&&receipt.accountId!==accountId)throw new Error('This deployment belongs to another account; use a new deployment directory');
 const bootstrap=receipt.bootstrapToken??randomBytes(32).toString('base64url'),config=cloudflareConfig({name,accountId,oauthNamespaceId:receipt.oauthNamespaceId,bootstrapHash:createHash('sha256').update(bootstrap).digest('hex'),downloadsDirectory:existsSync(join(root,'work/download-assets/manifest.json'))?join(root,'work/download-assets'):undefined});
 if(!options['dry-run']&&!accountId)throw new Error('Cloudflare account ID required');
 const configPath=join(folder,'wrangler.json');save(configPath,config);receipt={...receipt,name,accountId,workspaceName,bootstrapToken:bootstrap,configPath};save(receiptPath,receipt);
 output.write(`\nWorker: ${name}\nAccount: ${accountId??'not selected (build only)'}\nWorkspace: ${workspaceName}\nDeployment files: ${folder}\n`);
 // Always prepare a reviewable build before the final publish confirmation.
 await run(['deploy','--config',configPath,'--dry-run','--outdir',join(folder,'bundle')],{output,logPath:join(folder,'wrangler.log')});
 if(options['dry-run']){output.write('\nBuild verified. Nothing published. Run spool deploy cloudflare again to sign in and deploy.\n');return {prepared:true,deployed:false,configPath};}
 if(!options.yes&&!/^y(es)?$/i.test(await ask('Publish this Worker and its Durable Object namespaces? (y/N)','N'))){output.write('Cancelled. Prepared deployment retained.\n');return {prepared:true,deployed:false,configPath};}
 // Provision OAuth storage only after publication was approved. Recover by stable name after interrupted setup.
 if(!receipt.oauthNamespaceId){
  const title=name+'-oauth',list=async()=>JSON.parse(await run(['kv','namespace','list','--config',configPath],{quiet:true,output,logPath:join(folder,'wrangler.log')}));
  let namespaces=await list(),namespace=namespaces.find(n=>n.title===title);
  if(!namespace){await run(['kv','namespace','create',title,'--config',configPath,'--update-config=false'],{output,logPath:join(folder,'wrangler.log')});namespaces=await list();namespace=namespaces.find(n=>n.title===title);}
  if(!namespace||!/^[a-f0-9]{32}$/.test(namespace.id))throw new Error('OAuth KV namespace not found; deployment retained. Retry deployment to recover.');
  receipt.oauthNamespaceId=namespace.id;save(receiptPath,receipt);
 }
 config.kv_namespaces=[{binding:'OAUTH_KV',id:receipt.oauthNamespaceId}];save(configPath,config);
 const result=await run(['deploy','--config',configPath],{output,logPath:join(folder,'wrangler.log')});
 let origin=options.url??receipt.origin??result.match(/https:\/\/[a-z0-9.-]+\.workers\.dev\b/i)?.[0];if(!origin)origin=await ask('Deployed HTTPS relay URL');const url=new URL(origin);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new Error('Supply the deployed HTTPS origin with --url');origin=url.origin;
 receipt={...receipt,origin,deployedAt:new Date().toISOString()};save(receiptPath,receipt);
 return finishCloudflareDeployment({receipt,receiptPath,state,options,output,ask,rl,fetcher,connect});
 }finally{rl?.close();}
}


export async function cloudflareJson(response,step){
 const text=await response.text();try{return JSON.parse(text);}catch{
  const type=response.headers.get('content-type')??'unknown content type',ray=response.headers.get('cf-ray'),code=/error code:\s*(\d+)/i.exec(text)?.[1];
  throw new Error(`${step} returned HTTP ${response.status} (${type}) instead of JSON${code?'; Cloudflare error '+code:''}${ray?'; Ray '+ray:''}. The deployment is saved. Check Cloudflare routing/request filtering, then run spool deploy cloudflare --resume. No republish is needed.`);
 }
}
export function cloudflareNetworkError(error,origin){
 const code=error.cause?.code??error.code;
 if(code==='ENOTFOUND')return new Error('The relay hostname '+new URL(origin).hostname+' has no DNS record (ENOTFOUND). Check the Worker’s workers.dev URL and whether it is enabled in Cloudflare. Your saved deployment and workspace are retained; do not redeploy to fix a URL.',{cause:error});
 return new Error('Cannot reach '+origin+': '+(code??error.message)+'. Your deployment and workspace are retained.',{cause:error});
}
async function finishCloudflareDeployment({receipt,receiptPath,state,options,output,ask,rl,fetcher,connect}){
 const {origin,bootstrapToken:bootstrap,workspaceName,configPath}=receipt,folder=dirname(receiptPath);
 let health,status;for(let attempt=0;attempt<4;attempt++){health=undefined;try{health=await fetcher(origin+'/healthz',{redirect:'error',signal:AbortSignal.timeout(30000)});status=await cloudflareJson(health,'Health check');break;}catch(error){if(!health&&['ENOTFOUND','ERR_TLS_CERT_ALTNAME_INVALID','CERT_HAS_EXPIRED'].includes(error.cause?.code??error.code))throw cloudflareNetworkError(error,origin);if(attempt===3||health&&![404,429,500,502,503,504,520,521,522,523,524,525,526,527].includes(health.status))throw health?error:cloudflareNetworkError(error,origin);output.write('Relay check failed; retrying connection…\n');await new Promise(resolve=>setTimeout(resolve,500*2**attempt));}}if(!health.ok||status.protocol!=='spool-relay/1'||status.backend!=='cloudflare')throw new Error('Worker health check failed; deployment receipt retained. Retry after checking Wrangler logs.');
 let setup;if(receipt.workspace&&receipt.ownerLink){setup={workspace:receipt.workspace,link:receipt.ownerLink};}else{const response=await fetcher(origin+'/v1/setup',{method:'POST',headers:{authorization:'Bootstrap '+bootstrap,'content-type':'application/json'},body:JSON.stringify({name:workspaceName}),redirect:'error',signal:AbortSignal.timeout(30000)});setup=await cloudflareJson(response,'Workspace setup');if(!response.ok)throw new Error(setup.error?.message??'Workspace setup failed');}
 if(setup.link)receipt.ownerLink=setup.link;receipt.workspace=setup.workspace;save(receiptPath,receipt);
 output.write('\nRelay ready: '+origin+'\n');if(setup.alreadyConfigured&&!setup.link)output.write('Workspace is already initialized. Existing memberships and data were preserved.\n');if(setup.link)output.write('Private owner invitation (single use; keep private):\n'+receipt.ownerLink+'\n');
 const old=existsSync(join(state,'workspace.json'))?JSON.parse(readFileSync(join(state,'workspace.json'))):null;
 if(old?.url===origin)output.write('This client is already connected to the Cloudflare workspace.\n');
 if(setup.link&&old?.url!==origin&&!options['no-connect']&&(options.connect||rl&&/^y(es)?$/i.test(await ask(old&&old.url!==origin?'Switch this client’s workspace connection to Cloudflare? Existing project connections remain in place. (y/N)':'Connect this client to the new workspace? (y/N)','N')))){
  if(old&&old.url!==origin){const backup=join(folder,'previous-workspace-'+Date.now()+'.json');save(backup,old);output.write('Previous workspace connection backed up at '+backup+'\n');}
  const action=connect??(link=>new WorkspaceClient(state).run({command:'connect',link}));await action(receipt.ownerLink);output.write('Client connected. Add or join projects from the UI or spool project commands.\n');
 }
 return {deployed:true,origin,workspace:setup.workspace,configPath,receiptPath};
}
