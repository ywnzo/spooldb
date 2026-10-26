(()=>{
 const $=id=>document.getElementById('retrieval-'+id);if(!$('panel'))return;
 let context={},epoch=0,timer,data,dirty=false,busy=false,limitsDirty=false;
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
  renderUsage();
  $('cleanup').textContent=`${data.cleanup.archived} ${data.cleanup.archived===1?'record':'records'} archived. Resolved and superseded records are excluded from normal retrieval; their history remains available in the project archive.`;
 }
 function renderUsage(){
  const usage=data.usage;if(!usage)return;$('usage-panel').hidden=false;const totals=usage.totals,backlog=usage.backlog.reduce((sum,p)=>sum+(p.records??0),0),hits=totals.query_cache_hits??0,misses=totals.query_cache_misses??0;
  $('usage-summary').textContent=`Today (UTC): ${totals.http_requests??0} relay requests · ${totals.external_requests??0} external embedding requests · ${totals.external_characters??0} external characters · ${hits} cache hits / ${hits+misses} queries · ${totals.embedding_failures??0} embedding failures · ${usage.backlog.some(p=>p.records===null)?'unknown':backlog} records awaiting indexing.`;
  $('usage-detail').textContent=`HTTP failures: ${totals.http_failures??0}. Budget blocks: ${totals.budget_denied??0}. Embedding time: ${totals.embedding_latency_ms??0} ms total. Current categories: ${Object.entries(totals).filter(([key])=>key.startsWith('http_')&&!['http_requests','http_failures'].includes(key)).map(([key,value])=>key.slice(5)+': '+value).join(' · ')}.`+(usage.recordingError?' '+usage.recordingError:'')+(usage.lastFailure?` Last retrieval issue: ${usage.lastFailure.code} at ${usage.lastFailure.at}.`:'');
  $('usage-projects').replaceChildren(...usage.backlog.map(project=>{const row=document.createElement('p'),values=usage.projects?.[project.room]??{};row.textContent=`${project.name??project.room}: ${values.http_requests??0} requests · ${values.external_characters??0} external characters · ${project.records??'unknown'} pending records`;return row;}));
  if(!limitsDirty){$('daily-characters').value=usage.limits.dailyCharacters;$('daily-requests').value=usage.limits.dailyRequests;$('project-characters').value=usage.limits.projectDailyCharacters;}
  for(const input of $('limits-form').querySelectorAll('input,button'))input.disabled=busy||!context.owner;
 }
 async function refresh(){clearTimeout(timer);if(!context.connected||!context.owner||!active())return;const current=epoch;try{const next=await api({action:'status'});if(current!==epoch)return;data=next;if(!data.supported){$('panel').hidden=true;$('access').hidden=false;$('access').textContent=data.message??'Retrieval settings are unavailable on this backend.';return;}render();}catch(error){if(current===epoch)$('error').textContent=error.message;}finally{if(current===epoch&&active())timer=setTimeout(refresh,data?.status==='loading'?2000:120000);}}
 async function change(input){if(busy)return;busy=true;$('error').textContent='';const current=epoch;render();try{const result=await api(input);if(current!==epoch)return;if(input.action==='test'){$('test-result').textContent=result.message;}else{data=result;if(input.action==='limits'){limitsDirty=false;$('limits-result').textContent='Usage limits saved.';}else{dirty=false;$('token').value='';$('consent').checked=false;}render();}}catch(error){if(current===epoch)$('error').textContent=error.message;}finally{busy=false;if(current===epoch)await refresh();}}
 function settings(){return {enabled:$('enabled').checked,provider:$('provider').value,accountId:$('account').value.trim(),model:$('model').value,threads:Number($('threads').value),minScore:Number($('min-score').value),contextChars:Number($('context-chars').value)};}
 $('form').addEventListener('input',()=>{dirty=true;$('test-result').textContent='';});$('model').onchange=()=>{dirty=true;render();};
 $('provider').onchange=()=>{dirty=true;selectModels();$('consent').checked=false;render();};
 $('form').onsubmit=event=>{event.preventDefault();if(!$('form').reportValidity())return;const value=settings();if(value.enabled&&value.provider==='cloudflare'&&!$('consent').checked){$('error').textContent='Confirm external processing before enabling Cloudflare.';return;}change({action:'configure',expectedRevision:data.revision,settings:value,externalProcessingApproved:$('consent').checked,...($('token').value?{token:$('token').value}:{})});};
 $('test').onclick=()=>change({action:'test',accountId:$('account').value.trim(),model:$('model').value,...($('token').value?{token:$('token').value}:{})});
 $('disconnect').onclick=()=>change({action:'configure',expectedRevision:data.revision,settings:{...data.settings,enabled:false},clearToken:true});
 $('limits-form').addEventListener('input',()=>{limitsDirty=true;$('limits-result').textContent='';});
 $('limits-form').onsubmit=event=>{event.preventDefault();if(!$('limits-form').reportValidity())return;change({action:'limits',expectedRevision:data.usage.limits.revision,limits:{dailyCharacters:Number($('daily-characters').value),dailyRequests:Number($('daily-requests').value),projectDailyCharacters:Number($('project-characters').value)}});};
 $('retry').onclick=()=>change({action:'retry'});
 document.addEventListener('spool-workspace-state',event=>{const next=event.detail;if(next.relay!==context.relay||next.owner!==context.owner||next.connected!==context.connected){epoch++;data=null;dirty=false;limitsDirty=false;clearTimeout(timer);$('token').value='';$('account').value='';$('consent').checked=false;$('test-result').textContent='';$('panel').hidden=true;$('usage-panel').hidden=true;$('limits-result').textContent='';$('access').hidden=false;$('access').textContent='Workspace owner access is required to configure retrieval.';$('error').textContent='';}context=next;if(active())refresh();});
 document.addEventListener('spool-settings-section',()=>{clearTimeout(timer);if(active())refresh();});
 document.addEventListener('visibilitychange',()=>{clearTimeout(timer);if(active())refresh();});
})();
