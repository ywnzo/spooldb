(()=>{
 const $=id=>document.getElementById('retrieval-'+id);if(!$('panel'))return;
 let context={},epoch=0,timer,data,dirty=false,busy=false;
 const active=()=>window.spoolSettings?.current==='relay'&&!document.getElementById('project-home').hidden;
 const api=input=>window.localRequest('workspace',{command:'retrieval',...input});
 function render(){
  if(!data?.supported)return;$('panel').hidden=false;
  if(!dirty){$('model').replaceChildren(...data.models.map(model=>{const option=document.createElement('option');option.value=model.key;option.textContent=model.name;return option;}));$('enabled').checked=data.settings.enabled;$('model').value=data.settings.model;$('threads').value=data.settings.threads;$('min-score').value=data.settings.minScore;$('context-chars').value=data.settings.contextChars;}
  $('model-description').textContent=data.models.find(model=>model.key===$('model').value)?.description??'';
  $('status').textContent=({loading:'Downloading or loading the selected model. Keyword search remains available.',ready:'Local model ready: '+(data.models.find(model=>model.key===data.activeModel)?.name??data.activeModel),disabled:'Semantic search is off. Keyword search remains available.',error:data.error})[data.status]??'Preparing local retrieval…';
  $('progress').hidden=data.status!=='loading';if(Number.isFinite(data.download?.progress))$('progress').value=data.download.progress;else $('progress').removeAttribute('value');
  $('retry').hidden=data.status!=='error';$('save').disabled=busy;$('retry').disabled=busy;
  $('cleanup').textContent=`${data.cleanup.archived} records archived. Resolved and superseded records are excluded from normal retrieval; their history remains available in the project archive.`;
 }
 async function refresh(){clearTimeout(timer);if(!context.connected||!context.owner||!active())return;const current=epoch;try{const next=await api({action:'status'});if(current!==epoch)return;data=next;if(!data.supported){$('panel').hidden=true;return;}render();}catch(error){if(current===epoch)$('error').textContent=error.message;}finally{if(current===epoch&&active())timer=setTimeout(refresh,data?.status==='loading'?2000:10000);}}
 async function change(input){if(busy)return;busy=true;$('error').textContent='';const current=epoch;render();try{const result=await api(input);if(current!==epoch)return;data=result;dirty=false;render();}catch(error){if(current===epoch)$('error').textContent=error.message;}finally{busy=false;if(current===epoch)await refresh();}}
 $('form').addEventListener('input',()=>dirty=true);$('model').onchange=()=>{dirty=true;render();};
 $('form').onsubmit=event=>{event.preventDefault();if(!$('form').reportValidity())return;change({action:'configure',expectedRevision:data.revision,settings:{enabled:$('enabled').checked,model:$('model').value,threads:Number($('threads').value),minScore:Number($('min-score').value),contextChars:Number($('context-chars').value)}});};
 $('retry').onclick=()=>change({action:'retry'});
 document.addEventListener('spool-workspace-state',event=>{const next=event.detail;if(next.relay!==context.relay||next.owner!==context.owner||next.connected!==context.connected){epoch++;data=null;dirty=false;clearTimeout(timer);$('panel').hidden=true;$('error').textContent='';}context=next;if(active())refresh();});
 document.addEventListener('spool-settings-section',()=>{clearTimeout(timer);if(active())refresh();});
 document.addEventListener('visibilitychange',()=>{if(!document.hidden&&active())refresh();});
})();
