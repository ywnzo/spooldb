(()=>{
 const $=id=>document.getElementById('relay-'+id);if(!$('controls'))return;
 let context={},epoch=0,poll,busy=false,dirty=false,loadedRevision,status,watched,handled,confirmation,connectionError=false;
 const active=()=>!document.hidden&&window.spoolSettings?.current==='relay'&&!document.getElementById('project-home').hidden;
 const message=(text,error=false)=>{$('message').textContent=text;$('message').classList.toggle('error',error);};
 const api=input=>window.localRequest('workspace',{command:'relay-admin',...input});
 const errors=plan=>[...(plan?.errors??[]),...(plan?.artifacts?.errors??[])];
 const counts=plan=>({backups:plan?.removed?.length??0,images:plan?.artifacts?.removedImages?.length??0,releases:plan?.artifacts?.removedReleases?.length??0});
 function render(){
  if(!status?.supported)return;
  $('controls').hidden=false;$('status').textContent='SpoolDB '+status.version+' · '+new URL(context.relay).host;$('health').textContent=status.needsRecovery?'Recovery needed':status.relayRunning===false?'Stopped':status.relayRunning===true?'Online':'Unknown';
  $('health').classList.toggle('connected',!status.needsRecovery&&status.relayRunning===true);
  $('disk').textContent=status.disk?`${(status.disk.availableBytes/1073741824).toFixed(1)} GB available of ${(status.disk.totalBytes/1073741824).toFixed(1)} GB`:'';
  if(!dirty){$('automatic').checked=status.automatic;for(const [prefix,policy]of [['backup',status.backupRetention],['artifact',status.artifactRetention]]){$(prefix+'-keep').value=policy.keep;$(prefix+'-days').value=policy.maxAgeDays;}loadedRevision=status.revision;}
  $('next').textContent=status.automatic?'Daily automatic updates are enabled. Next server check: '+(status.timerNext??'scheduled'):'Automatic updates are off. Manual updates still include protected storage cleanup.';
  const check=status.jobs?.find(j=>j.action==='check'&&j.status==='succeeded');$('update-status').textContent=check?.result?(check.result.available?'Version '+check.result.latest+' is available.':'Up to date as of the last check ('+check.result.latest+').'):'Check for the latest stable release.';
  const cleanup=status.artifactCleanup??status.backupCleanup;$('cleanup-status').textContent=cleanup?.checkedAt?'Last cleanup: '+new Date(cleanup.checkedAt).toLocaleString()+(errors({errors:status.backupCleanup?.errors,artifacts:status.artifactCleanup}).length?' · review cleanup warnings':' · completed without errors'):'';
  const running=status.jobs?.find(j=>['queued','running'].includes(j.status));
  for(const button of ['check','update','preview','save','recover'])$(button).disabled=busy||status.busy;
  for(const input of $('settings-form').querySelectorAll('input'))input.disabled=busy||status.busy;
  $('recover').hidden=!status.needsRecovery;$('recover').disabled=busy||Boolean(running)||status.canRecover===false;
  if(running)message(({'check':'Checking for updates','update':'Updating relay; reconnecting after health checks','configure':'Saving relay settings','preview':'Preparing cleanup preview','cleanup':'Cleaning eligible storage','recover':'Recovering the relay'}[running.action]??'Working')+'…');
  else if(status.needsRecovery)message('An interrupted update needs recovery. Rollback resources are protected.',true);
  const job=status.jobs?.find(j=>j.id===watched);
  if(job&&['succeeded','failed'].includes(job.status)&&handled!==job.id){handled=job.id;if(job.status==='failed')message(job.error??'Maintenance failed.',true);else{
   if(job.action==='configure'){dirty=false;loadedRevision=status.revision;message('Relay settings saved.');}
   else if(job.action==='preview'){const c=counts(job.result);if(errors(job.result).length){message('Cleanup was not applied: '+errors(job.result).map(e=>e.error).join(' '),true);}else if(active()){message(c.backups+c.images+c.releases?'Cleanup preview ready. No changes made.':'Nothing is eligible for cleanup. Rollback resources remain protected.');confirmation={action:'cleanup',previewId:job.id};$('confirm-title').textContent='Clean up relay storage';$('confirm-text').textContent=`Remove ${c.backups} backups, ${c.images} images and ${c.releases} application releases? Active and rollback resources stay protected.`;$('confirm-apply').disabled=!(c.backups+c.images+c.releases);$('confirm-apply').textContent='Run cleanup';$('confirm-error').textContent='';$('confirm-dialog').showModal();}}
   else message(({check:'Update check completed.',update:job.result?.updated?'Relay update completed.':'Relay is already up to date.',cleanup:'Storage cleanup completed.',recover:'Relay recovery completed.'})[job.action]??'Done.');
  }}
 }
 async function refresh(){
  clearTimeout(poll);if(!context.connected||!context.owner||!active())return;
  const current=epoch;try{const next=await api({action:'status'});if(current!==epoch)return;const initial=!status?.supported;status=next;if(status.supported&&(initial||connectionError)){message('');connectionError=false;}if(!status.supported){$('controls').hidden=true;message(status.message??'Host maintenance is unavailable on this backend.');return;}render();}
  catch(error){if(current!==epoch)return;connectionError=true;message((status?.busy?'Maintenance is running. Waiting for the relay to reconnect… ': '')+error.message,true);}
  finally{if(current===epoch&&active())poll=setTimeout(refresh,status?.busy?2000:120000);}
 }
 async function start(action,extra={}){
  if(busy)return;busy=true;const current=epoch;message('Starting maintenance…');render();try{const result=await api({action,requestId:crypto.randomUUID(),...extra});if(current!==epoch)return;if(!result.accepted)throw Error(result.message??'Maintenance unavailable');watched=result.job.id;handled=null;}
  catch(error){if(current===epoch)message(error.message,true);}finally{busy=false;if(current===epoch)await refresh();}
 }
 $('settings-form').addEventListener('input',()=>dirty=true);
 $('settings-form').onsubmit=e=>{e.preventDefault();if(!$('settings-form').reportValidity())return;start('configure',{settings:{automatic:$('automatic').checked,expectedRevision:loadedRevision,backupRetention:{keep:Number($('backup-keep').value),maxAgeDays:Number($('backup-days').value)},artifactRetention:{keep:Number($('artifact-keep').value),maxAgeDays:Number($('artifact-days').value)}}});};
 $('refresh').onclick=refresh;$('check').onclick=()=>start('check');$('preview').onclick=()=>start('preview');
 for(const action of ['update','recover'])$(action).onclick=()=>{confirmation={action};$('confirm-title').textContent=action==='update'?'Update relay':'Recover relay';$('confirm-text').textContent=action==='update'?'Install the latest stable release? The relay will pause briefly while memory is backed up and health is checked.':'Restore or finish the interrupted update using its recorded recovery transaction?';$('confirm-apply').disabled=false;$('confirm-apply').textContent=action==='update'?'Update relay':'Recover relay';$('confirm-error').textContent='';$('confirm-dialog').showModal();};
 $('confirm-cancel').onclick=()=>{$('confirm-dialog').close();confirmation=null;};
 $('confirm-apply').onclick=()=>{const selected=confirmation;if(!selected)return;$('confirm-dialog').close();confirmation=null;start(selected.action,selected.previewId?{previewId:selected.previewId}:{});};
 document.addEventListener('spool-workspace-state',event=>{const next=event.detail;if(next.relay!==context.relay||next.owner!==context.owner||next.connected!==context.connected){epoch++;status=null;dirty=false;watched=null;handled=null;clearTimeout(poll);$('controls').hidden=true;if($('confirm-dialog').open)$('confirm-dialog').close();}context=next;if(!next.connected)message('Connect a workspace to manage its relay.');else if(!next.owner)message('Workspace owner access is required to manage the relay.');else if(active())refresh();});
 document.addEventListener('spool-settings-section',()=>{clearTimeout(poll);if(active())refresh();});
 document.addEventListener('visibilitychange',()=>{clearTimeout(poll);if(active())refresh();});
})();
