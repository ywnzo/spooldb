(()=>{
 const $=id=>document.getElementById('retrieval-'+id);if(!$('panel'))return;
 let context={},epoch=0,timer,data,dirty=false,busy=false;
 const active=()=>!document.hidden&&window.spoolSettings?.current==='retrieval'&&!document.getElementById('project-home').hidden;
 const api=input=>window.localRequest('workspace',{command:'retrieval',...input});
 const models=()=>($('provider').value==='cloudflare'?data.cloudflareModels:data.models)??[];
 function selectModels(selected){$('model').replaceChildren(...models().map(model=>{const option=document.createElement('option');option.value=model.key;option.textContent=model.name;return option;}));if(models().some(model=>model.key===selected))$('model').value=selected;}
 function render(){
  if(!data?.supported)return;$('panel').hidden=false;$('access').hidden=true;
  if(!dirty){$('provider').value=data.settings.provider??'local';selectModels(data.settings.model);$('account').value=data.settings.accountId||data.cloudflare?.accountId||'';$('enabled').checked=data.settings.enabled;$('threads').value=data.settings.threads;$('min-score').value=data.settings.minScore;$('context-chars').value=data.settings.contextChars;}
  const remote=$('provider').value==='cloudflare';$('cloudflare').hidden=!remote;$('local').hidden=remote;
  $('provider-description').textContent=remote?'The relay calls Cloudflare for embeddings. Memory storage and permission checks remain on this relay. Changing providers or models rebuilds the index.':'The relay downloads the selected model automatically. Memory stays on your server. Changing models rebuilds the index.';
  $('credential-status').textContent=data.cloudflare?.configured?'A token is stored on the relay. Leave the token blank to keep it, or enter a replacement.':'No token stored.';
  $('model-description').textContent=models().find(model=>model.key===$('model').value)?.description??'';
  $('status').textContent=({loading:'Connecting or loading the selected provider. Keyword search remains available.',ready:'Embedding provider ready: '+([...data.models,...(data.cloudflareModels??[])].find(model=>model.key===data.activeModel)?.name??data.activeModel),disabled:'Semantic search is off. Keyword search remains available.',error:data.error})[data.status]??'Preparing retrieval…';
  $('progress').hidden=data.status!=='loading';if(Number.isFinite(data.download?.progress))$('progress').value=data.download.progress;else $('progress').removeAttribute('value');
  $('retry').hidden=data.status!=='error';for(const id of ['save','retry','test','disconnect'])$(id).disabled=busy;
  $('cleanup').textContent=`${data.cleanup.archived} ${data.cleanup.archived===1?'record':'records'} archived. Resolved and superseded records are excluded from normal retrieval; their history remains available in the project archive.`;
 }
 async function refresh(){clearTimeout(timer);if(!context.connected||!context.owner||!active())return;const current=epoch;try{const next=await api({action:'status'});if(current!==epoch)return;data=next;if(!data.supported){$('panel').hidden=true;$('access').hidden=false;$('access').textContent=data.message??'Retrieval settings are unavailable on this backend.';return;}render();}catch(error){if(current===epoch)$('error').textContent=error.message;}finally{if(current===epoch&&active())timer=setTimeout(refresh,data?.status==='loading'?2000:120000);}}
 async function change(input){if(busy)return;busy=true;$('error').textContent='';const current=epoch;render();try{const result=await api(input);if(current!==epoch)return;if(input.action==='test'){$('test-result').textContent=result.message;}else{data=result;dirty=false;$('token').value='';$('consent').checked=false;render();}}catch(error){if(current===epoch)$('error').textContent=error.message;}finally{busy=false;if(current===epoch)await refresh();}}
 function settings(){return {enabled:$('enabled').checked,provider:$('provider').value,accountId:$('account').value.trim(),model:$('model').value,threads:Number($('threads').value),minScore:Number($('min-score').value),contextChars:Number($('context-chars').value)};}
 $('form').addEventListener('input',()=>{dirty=true;$('test-result').textContent='';});$('model').onchange=()=>{dirty=true;render();};
 $('provider').onchange=()=>{dirty=true;selectModels();$('consent').checked=false;render();};
 $('form').onsubmit=event=>{event.preventDefault();if(!$('form').reportValidity())return;const value=settings();if(value.enabled&&value.provider==='cloudflare'&&!$('consent').checked){$('error').textContent='Confirm external processing before enabling Cloudflare.';return;}change({action:'configure',expectedRevision:data.revision,settings:value,externalProcessingApproved:$('consent').checked,...($('token').value?{token:$('token').value}:{})});};
 $('test').onclick=()=>change({action:'test',accountId:$('account').value.trim(),model:$('model').value,...($('token').value?{token:$('token').value}:{})});
 $('disconnect').onclick=()=>change({action:'configure',expectedRevision:data.revision,settings:{...data.settings,enabled:false},clearToken:true});
 $('retry').onclick=()=>change({action:'retry'});
 document.addEventListener('spool-workspace-state',event=>{const next=event.detail;if(next.relay!==context.relay||next.owner!==context.owner||next.connected!==context.connected){epoch++;data=null;dirty=false;clearTimeout(timer);$('token').value='';$('account').value='';$('consent').checked=false;$('test-result').textContent='';$('panel').hidden=true;$('access').hidden=false;$('access').textContent='Workspace owner access is required to configure retrieval.';$('error').textContent='';}context=next;if(active())refresh();});
 document.addEventListener('spool-settings-section',()=>{clearTimeout(timer);if(active())refresh();});
 document.addEventListener('visibilitychange',()=>{clearTimeout(timer);if(active())refresh();});
})();
