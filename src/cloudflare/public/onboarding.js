export function onboardingClient(bootstrapScript){
const $=id=>document.getElementById(id);
let manifest,invite='',project='';
const status=(message,error=false)=>{$('status').textContent=message;$('status').className=error?'error':'subtle';};
async function load(){
 try{
  const response=await fetch('/downloads/manifest.json');if(!response.ok)throw Error('Downloads are not available on this relay yet. Ask your administrator to publish the installer.');manifest=await response.json();
  const name='spool-linux-x64.run',sha=manifest.current[name],artifact=manifest.releases[sha+'/'+name];if(!artifact)throw Error('The Linux installer is unavailable.');
  $('direct').href='/downloads/'+sha+'/'+name;$('size').textContent=(artifact.size/1024/1024).toFixed(1)+' MB · Bun included';$('checksum').textContent=sha;
  const fragment=location.hash.slice(1);if(fragment)$('terminal-option').open=false;
  if(fragment){
   const workspace=fragment.startsWith('workspace.'),encoded=workspace?fragment.slice(10):fragment;
   if(!/^[A-Za-z0-9_-]+$/.test(encoded))throw Error('This invitation is malformed. Ask for a new link.');
   const payload=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(encoded.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0))));
   if(payload.version!==1||payload.url!==location.origin||!/^[-A-Za-z0-9_]{43}$/.test(payload.code)||payload.ca!==undefined)throw Error('This invitation belongs to another relay or is invalid. Ask for a fresh invite from this relay.');
   const preview=await fetch(workspace?'/v1/workspace/preview':'/v1/invites/preview',{method:'POST',headers:{authorization:'Invite '+payload.code,'content-type':'application/json'},body:'{}',referrerPolicy:'no-referrer'}),data=await preview.json();if(!preview.ok)throw Error(data.error?.message??'This invitation cannot be used. Ask for a fresh link.');
   invite=`spool://${workspace?'workspace':'join'}/v1/${encoded}`;project=workspace?data.workspace.name:data.project;
   $('title').textContent='Join '+project;$('intro').textContent=workspace?'Connect your computer to this shared workspace.':'Share project conversations, decisions and handoffs. Your code stays in Git.';
   $('open').href=invite;$('installed').hidden=false;$('steps-title').textContent='Install and connect';$('folder-hint').textContent=workspace?'The installer connects your workspace. Then choose a project and local folder.':'Have your '+project+' Git checkout ready. The installer asks for its folder and your approval before sharing conversations.';
   status('Invitation ready. It will only be used when you approve joining in SpoolDB.');
  }else if(location.pathname==='/join'){throw Error('This link is missing its private invitation. Ask your teammate for the complete link.');}
  else status('Linux x86-64 · glibc · No sudo or separate runtime installation.');
  $('install').disabled=false;$('install').textContent=project?'Download setup for '+project:'Download setup';
  $('install').onclick=()=>{
   const blob=new Blob([bootstrapScript({origin:location.origin,artifact,invite})],{type:'text/x-shellscript'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='install-spooldb.sh';a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);$('next').hidden=false;$('next').scrollIntoView({behavior:'smooth',block:'nearest'});
  };
 }catch(error){status(error.message,true);$('install').disabled=true;}
}
$('terminal-command').textContent='curl -fsSL '+location.origin+'/install.sh -o install-spooldb.sh && sh install-spooldb.sh';
for(const [button,target]of [['copy','command'],['copy-terminal','terminal-command']])$(button).onclick=async()=>{try{await navigator.clipboard.writeText($(target).textContent);$(button).textContent='Copied';}catch{status('Select and copy the command below.');}};
load();

}
