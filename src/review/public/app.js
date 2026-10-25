const $=id=>document.getElementById(id);
const node=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
const action=(label,fn,cls)=>{const b=node('button',cls,label);b.type='button';b.addEventListener('click',()=>Promise.resolve(fn()).catch(showError));return b;};
const short=value=>value?.slice(0,8)??'';
const state={local:false,csrf:'',project:null,token:'',room:'',branches:[],branch:'@live',compare:'',files:[],entries:[],fileId:null,revision:null,mode:'diff',snapshot:[],epoch:0,fileSeq:0,listSeq:0,activitySeq:0};
let session=new AbortController(),view=new AbortController(),fileRequest=new AbortController(),listRequest=new AbortController();
function notice(text) {$('notice').textContent=text;$('notice').hidden=!text;}
function showError(error) {if(error?.name==='AbortError')return;if(!state.token&&!state.local){$('connect-error').textContent=error.message;return;}notice(error.message);$('announcer').textContent=error.message;}
function disconnect(message='') {
  session.abort();view.abort();fileRequest.abort();listRequest.abort();state.token='';state.room='';state.epoch++;state.files=[];state.entries=[];state.branches=[];state.fileId=null;state.revision=null;
  for(const id of ['files','activity','code','comments'])$(id).replaceChildren();$('token').value='';$('workspace').hidden=true;$('connect-screen').hidden=false;$('disconnect').hidden=true;$('refresh').hidden=true;$('connect-error').textContent=message;notice('');
  for(const id of ['branch','compare','diff-stats'])$(id).replaceChildren();for(const id of ['file-path','previous-path','revision-label','version-label','room-short'])$(id).textContent='';state.snapshot=[];
}
async function api(input,signal,retried=false) {
  const requestEpoch=state.epoch;
  const response=await fetch(state.local?'/local/review':`/v1/rooms/${encodeURIComponent(state.room)}/review`,{method:'POST',headers:{...(state.local?{'x-spool-csrf':state.csrf,'x-spool-project':state.project.id}:{authorization:`Bearer ${state.token}`}),'content-type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.any([session.signal,signal??view.signal,AbortSignal.timeout(30000)]),redirect:'error',cache:'no-store'});
  const data=await response.json();if(requestEpoch!==state.epoch)throw new DOMException('Project changed','AbortError');
  if(!response.ok) {if(state.local&&response.status===401&&!retried){await renewLocalSession();return api(input,signal,true);}const message=data.error?.message??'Unable to load review';if(!state.local&&(response.status===401||response.status===403))disconnect(message);throw new Error(message);}
  if(data.protocol!=='spool-relay/1'||data.room!==state.room)throw new Error('Unexpected relay response');return data;
}
function context() {
  const base=state.branches.find(b=>b.name===state.compare);
  return {branch:state.branch,heads:state.revision?[state.revision.changeId]:state.snapshot,baseHeads:state.revision?state.revision.parents:base?.heads??[]};
}
function option(value,label) {const e=node('option','',label);e.value=value;return e;}
async function refreshBranches(initial=false) {
  const epoch=state.epoch;const data=await api({command:'branches'},session.signal);if(epoch!==state.epoch)return;
  state.branches=data.branches;const names=new Set(data.branches.map(b=>b.name));
  if(initial) {
    const hash=new URLSearchParams(location.hash.slice(1));state.branch=names.has(hash.get('branch'))?hash.get('branch'):data.branches.find(b=>!b.live&&b.name!=='main')?.name??data.branches.find(b=>b.name==='main')?.name??'@live';
    state.compare=names.has(hash.get('compare'))?hash.get('compare'):names.has('main')&&state.branch!=='main'?'main':'';
  }
  if(!names.has(state.branch))state.branch='@live';if(!names.has(state.compare))state.compare='';
  const label=b=>state.local?({'working':'Working changes','main':'Starting point','@live':'All synced history'}[b.name]??b.name):b.label??`${b.name} · r${b.revision}`;
  $('branch').replaceChildren(...data.branches.map(b=>option(b.name,label(b))));
  $('compare').replaceChildren(option('','Empty tree'),...data.branches.map(b=>option(b.name,label(b))));
  $('branch').value=state.branch;$('compare').value=state.compare;await loadView();
}
function updateHash() {const params=new URLSearchParams({room:state.room,branch:state.branch});if(state.compare)params.set('compare',state.compare);history.replaceState(null,'',`#${params}`);}
async function loadView() {
  view.abort();fileRequest.abort();listRequest.abort();view=new AbortController();const epoch=++state.epoch;state.revision=null;state.snapshot=state.branches.find(b=>b.name===state.branch)?.heads??[];
  state.entries=[];state.activityCursor=null;state.fileCursor=null;state.files=[];state.fileId=null;notice('');$('revision-banner').hidden=true;$('comments').hidden=true;updateHash();
  $('version-label').textContent=`${state.branch==='@live'?'Synced room':state.branch} · ${short(state.snapshot[0])}`;$('previous-path').hidden=true;$('diff-stats').replaceChildren();
  $('activity').replaceChildren(node('p','empty-small','Loading conversation…'));$('code').replaceChildren(node('p','empty-small','Loading this comparison…'));
  await Promise.all([loadFiles(true),loadActivity(true)]);if(epoch!==state.epoch)return;renderFiles();renderActivity();$('announcer').textContent='Branch review loaded';
}
async function loadFiles(reset=false) {
  listRequest.abort();listRequest=new AbortController();const seq=++state.listSeq,epoch=state.epoch;
  const data=await api({command:'files',...context(),query:$('search').value,changedOnly:$('changed-only').checked,limit:200,...(!reset&&state.fileCursor?{after:state.fileCursor}:{})},AbortSignal.any([view.signal,listRequest.signal]));
  if(seq!==state.listSeq||epoch!==state.epoch)return;
  state.files=reset?data.files:[...state.files,...data.files];if(state.local)state.files.sort((a,b)=>a.path.localeCompare(b.path));state.fileCursor=data.nextCursor;if(reset)state.fileTotal=data.total;renderFiles();
  if(!state.files.some(f=>f.fileId===state.fileId)) {state.fileId=(state.local?state.files.find(f=>['modified','added','renamed'].includes(f.status)):null)?.fileId??state.files[0]?.fileId??null;renderFiles();renderActivity();if(state.fileId)await loadFile();else {$('file-path').textContent='No files in this comparison';$('file-status').textContent='ALL CAUGHT UP';$('diff-stats').replaceChildren();$('comments').hidden=true;$('code').replaceChildren(empty('Nothing to compare','Try a different branch, search, or turn off “Changed files only”.'));}}
}
function renderFiles() {
  $('file-count').textContent=String(state.fileTotal??state.files.length);$('more-files').hidden=!state.fileCursor;
  $('files').replaceChildren(...state.files.map(f=>{
    const b=action('',async()=>{state.fileId=f.fileId;renderFiles();renderActivity();await loadFile();},`file-button${f.fileId===state.fileId?' active':''}`);b.setAttribute('aria-label',`${f.path}, ${f.status}`);b.setAttribute('aria-pressed',String(f.fileId===state.fileId));
    b.append(node('span','file-icon','▧'),node('span','file-name',f.path),node('span',`file-status-letter ${f.status}`,{added:'A',deleted:'D',renamed:'R',modified:'M',unchanged:'·',present:'·'}[f.status]));return b;
  }));
  if(!state.files.length)$('files').append(node('p','empty-small','No matching files.'));
}
function empty(title,description) {const e=node('div','empty-state');e.append(node('span','empty-symbol','⌘'),node('h3','',title),node('p','',description));return e;}
async function loadFile() {
  if(!state.fileId)return;fileRequest.abort();fileRequest=new AbortController();const seq=++state.fileSeq,epoch=state.epoch;
  const data=await api({command:state.mode,...context(),fileId:state.fileId},AbortSignal.any([view.signal,fileRequest.signal]));if(seq!==state.fileSeq||epoch!==state.epoch)return;
  const f=data.after??data.file??data.before;const meta=state.files.find(f=>f.fileId===state.fileId);$('file-path').textContent=f?.path??meta?.path??state.fileId;$('file-status').textContent=(meta?.status??'FILE').toUpperCase();$('previous-path').hidden=!(data.before&&data.after&&data.before.path!==data.after.path);$('previous-path').textContent=data.before?`Previously ${data.before.path}`:'';
  $('version-label').textContent=state.revision?short(state.revision.changeId):`${state.branch==='@live'?'Synced room':state.branch} · ${short(state.snapshot[0])}`;
  $('diff-tab').setAttribute('aria-selected',String(state.mode==='diff'));$('file-tab').setAttribute('aria-selected',String(state.mode==='file'));
  $('diff-stats').replaceChildren();if(data.added!==null&&data.added!==undefined)$('diff-stats').append(node('span','stat-add',`+${data.added}`),node('span','stat-delete',`−${data.removed}`));
  const warnings=[];if(data.previewFrom==='base')warnings.push('This file is absent from the reviewed version; showing its comparison-base contents.');if(data.truncated)warnings.push(data.reason??'This preview is limited. Use a local snapshot for the full file.');if(data.approximate)warnings.push('Large changed regions are shown as replacement blocks.');if((data.after?.conflicts??data.file?.conflicts??[]).length)warnings.push('This file has concurrent metadata or path conflicts.');notice(warnings.join(' '));
  const code=$('code');code.replaceChildren();
  if(data.nonText||state.mode==='file'&&data.file?.kind!=='text') {
    code.append(empty(f?.kind==='binary'?'Binary file':f?.kind==='symlink'?'Symbolic link':'File metadata',f?.kind==='binary'?`${f.bytes??0} bytes. Binary contents are not rendered.`:f?.target??'This comparison contains a file kind or metadata change.'));
  } else {
    const rows=state.mode==='file'?data.file.text.split('\n').map((text,i)=>({type:'context',text,newLine:i+1,oldLine:null})):data.rows;
    if(!rows?.length)code.append(empty('No inline changes',data.reason??'The text is unchanged at these versions.'));
    else {const table=node('table','diff-table');table.setAttribute('aria-label',state.mode==='file'?'File preview':'Unified code diff');const body=node('tbody');
      for(const row of rows) {const tr=node('tr',`diff-${row.type}`);
        if(row.type==='gap'){const td=node('td','',`⋯ ${row.text}`);td.colSpan=4;tr.append(td);}
        else tr.append(node('td','line-number',row.oldLine??''),node('td','line-number',row.newLine??''),node('td','diff-marker',row.type==='add'?'+':row.type==='delete'?'−':''),node('td','code-text',row.text||' '));body.append(tr);
      }table.append(body);code.append(table);}
  }
  const comments=$('comments');comments.replaceChildren();comments.hidden=!data.comments?.length&&!data.partial;
  if(data.comments?.length) {comments.append(node('h3','',`Attached comments · ${data.comments.length}`));for(const c of data.comments) {const e=node('div','comment');e.append(node('span','comment-range',c.resolved?`Characters ${c.resolved.start}–${c.resolved.end}`:'Anchor unavailable at this revision'),node('p','',c.text));if(c.resolved)e.append(node('blockquote','',c.resolved.text));comments.append(e);}}
  if(data.partial)comments.append(node('p','subtle','Comment scan limited to the first 200 records.'));
}
async function loadActivity(reset=false) {
  const epoch=state.epoch,seq=++state.activitySeq;const data=await api({command:'timeline',branch:state.branch,heads:context().heads,limit:25,...(!reset&&state.activityCursor?{before:state.activityCursor}:{})});if(epoch!==state.epoch||seq!==state.activitySeq)return;
  state.entries=reset?data.entries:[...state.entries,...data.entries];state.activityCursor=data.nextCursor;renderActivity();
}
function messageText(message){
  let text=message.text;
  if(state.local&&message.role==='user'&&text.includes('<in-app-browser-context ')){
    text=text.replace(/<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context>/g,'').replace(/^\s*## My request:\s*/,'').trim();
  }
  return text;
}
function renderActivity() {
  const container=$('activity');const filter=$('activity-filter').value;const entries=filter==='file'?state.entries.filter(e=>e.metadata?.fileIds?.includes(state.fileId)):state.entries;
  const seen=new Set();container.replaceChildren();$('more-activity').hidden=!state.activityCursor;
  for(const entry of entries) {
    const meta=entry.metadata;if(!meta)continue;if(state.local&&!entry.messages.length&&!meta.fileIds.length)continue;const linked=meta.fileIds.includes(state.fileId);const card=node('article',`activity-item${linked?' linked':''}${state.revision?.changeId===entry.changeId?' selected':''}`);
    const top=node('div','activity-top'),person=node('div','activity-person');person.append(node('strong','',meta.actor),node('small','',state.local&&entry.messages.some(m=>m.id.startsWith('native-'))?'Saved Codex chat':`${meta.harness??'generic'} · ${new Date(meta.observedAt).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}`));top.append(node('span','avatar',(meta.harness??'agent').slice(0,2).toUpperCase()),person,node('span','activity-hash',short(entry.changeId)));card.append(top);
    for(const m of entry.messages) {
      if(seen.has(m.id))continue;seen.add(m.id);const block=node('div','message');block.append(node('span','message-role',m.role),node('p','',messageText(m)));
      if(m.truncated)block.append(action('Read full message',async()=>{const full=await api({command:'message',branch:state.branch,heads:context().heads,messageId:m.id});block.querySelector('p').textContent=messageText(full.message);block.querySelector('button')?.remove();},'load-more'));card.append(block);
    }
    if(!entry.messages.length)card.append(node('div','activity-summary',summarize(meta.operationTypes)));
    if(meta.fileIds.length) {const chips=node('div','file-chips');for(const id of meta.fileIds.slice(0,5)) {const path=state.files.find(f=>f.fileId===id)?.path??meta.paths?.[id]??id;chips.append(action(path,async()=>{state.fileId=id;if(state.revision){state.revision=null;$('revision-banner').hidden=true;await Promise.all([loadFiles(true),loadActivity(true)]);}renderFiles();renderActivity();await loadFile();},'file-chip'));}card.append(chips);}
    if(entry.partial)card.append(node('p','empty-small','Message preview limited for this batch.'));
    card.append(action('Inspect this change →',()=>inspect(entry),'inspect-change'));container.append(card);
  }
  if(!container.children.length)container.append(node('p','empty-small',filter==='file'?'No directly linked activity on this page. Load earlier activity or view all branch activity.':'No conversation on this page. Earlier activity may contain messages.'));
}
function summarize(types=[]) {const labels={'file.create':'Created files','file.splice':'Edited code','file.write':'Updated files','file.rename':'Renamed files','file.delete':'Deleted files','file.restore':'Restored files','comment.add':'Added review context','adapter.record':'Captured harness activity','message.add':'Added a message'};return [...new Set(types.map(t=>labels[t]??t))].join(' · ');}
async function inspect(entry) {
  state.revision=entry;$('revision-banner').hidden=false;$('revision-label').textContent=`Change ${short(entry.changeId)} · compared with its parents`;
  if(entry.metadata?.fileIds?.length)state.fileId=entry.metadata.fileIds[0];renderActivity();await Promise.all([loadFiles(true),loadActivity(true)]);if(state.fileId)await loadFile();
}
$('connect-form').addEventListener('submit',async event=>{
  event.preventDefault();const button=event.submitter;button.disabled=true;$('connect-error').textContent='';session.abort();session=new AbortController();view=new AbortController();state.epoch++;state.room=$('room').value.trim();state.token=$('token').value.trim();$('token').value='';
  try {if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/.test(state.room))throw new Error('Enter a valid room identity.');await refreshBranches(true);$('connect-screen').hidden=true;$('workspace').hidden=false;$('disconnect').hidden=false;$('refresh').hidden=false;$('room-short').textContent=short(state.room);$('workspace-label').textContent=`WORKSPACE / ${short(state.room)}`;}
  catch(error){if(error.name!=='AbortError'){$('connect-error').textContent=error.message;state.token='';}}finally{button.disabled=false;}
});
$('disconnect').addEventListener('click',()=>disconnect());
$('refresh').addEventListener('click',async()=>{const b=$('refresh');b.disabled=true;try{await refreshBranches();}catch(error){showError(error);}finally{b.disabled=false;}});
for(const id of ['branch','compare'])$(id).addEventListener('change',()=>{state[id]=$(id).value;loadView().catch(showError);});
let searchTimer;$('search').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>loadFiles(true).catch(showError),250);});
$('changed-only').addEventListener('change',()=>loadFiles(true).catch(showError));
$('more-files').addEventListener('click',()=>loadFiles().catch(showError));$('more-activity').addEventListener('click',()=>loadActivity().catch(showError));$('activity-filter').addEventListener('change',renderActivity);
$('reset-revision').addEventListener('click',()=>{state.revision=null;$('revision-banner').hidden=true;Promise.all([loadFiles(true),loadActivity(true)]).then(()=>loadFile()).catch(showError);renderActivity();});
for(const mode of ['diff','file'])$(mode+'-tab').addEventListener('click',()=>{state.mode=mode;loadFile().catch(showError);});
$('room').value=new URLSearchParams(location.hash.slice(1)).get('room')??'';

if(location.protocol==='file:') {
  $('connect-screen').hidden=false;
  $('connect-error').textContent='This is a local preview. Run bun run demo:review from the SpoolDB project folder, then open the printed http:// URL to browse sample branches and conversations.';
  for(const control of $('connect-form').elements)control.disabled=true;
  document.querySelector('.brand').href='./index.html';
}

let localBusy=false,lastReviewRevision='',localPoll;
function renderProject(project){
  if($('team-status'))renderTeamState(project);
  state.project=project;if($('project-switch').querySelector(`option[value="${project.id}"]`))$('project-switch').value=project.id;$('project-name').textContent=project.name.charAt(0).toUpperCase()+project.name.slice(1);$('memory-project-name').textContent=project.name.toUpperCase();$('project-root').textContent=project.root;$('project-root').title=project.root;$('project-files').textContent=project.lastCapture?.files??'—';
  const codex=project.codex;$('project-threads').textContent=codex.threads||'0';$('codex-badge').textContent=codex.status==='connected'?'Connected':codex.status==='connecting'?'Connecting…':codex.enabled?'Needs attention':'Not connected';$('codex-badge').classList.toggle('connected',codex.status==='connected');
  $('codex-connect').hidden=codex.enabled;$('codex-disconnect').hidden=!codex.enabled;
  $('codex-detail').textContent=codex.error??(codex.status==='connected'?`${codex.threads} project chats found. New completed replies appear automatically.`:'Local capture only. No new agent or model request.');
  $('project-error').textContent=project.lastError??'';$('workspace-label').textContent=project.name.toUpperCase();$('room-short').hidden=true;
  $('connection-state').textContent=project.lastError?'Capture needs attention':'Capturing automatically';
}
async function renewLocalSession(){
  const response=await fetch('/local/session',{cache:'no-store',redirect:'error'});if(!response.ok)throw new Error('Unable to reconnect. Reload SpoolDB.');const data=await response.json();state.csrf=data.csrf;return data;
}
async function localRequest(path,input,retried=false){
  const response=await fetch('/local/'+path,{method:input?'POST':'GET',headers:{'x-spool-csrf':state.csrf,...(state.project?.id?{'x-spool-project':state.project.id}:{}),...(input?{'content-type':'application/json'}:{})},...(input?{body:JSON.stringify(input)}:{}),cache:'no-store',redirect:'error'});
  const data=await response.json();if(response.status===401&&!retried){await renewLocalSession();return localRequest(path,input,true);}if(!response.ok)throw new Error(data.error?.message??'Unable to reach SpoolDB');return data;
}
let applyingHistory=false,pageEpoch=0;
function setPage(page,{note=null,record=true}={}){
 pageEpoch++;window.scrollTo({top:0});
 for(const [id,value]of [['memory-home','memory'],['workspace','activity'],['project-home','settings']])$(id).hidden=page!==value;
 for(const [id,value]of [['memory-nav','memory'],['review-nav','activity'],['project-nav','settings']]){const active=page===value;$(id).classList.toggle('nav-active',active);if(active)$(id).setAttribute('aria-current','page');else $(id).removeAttribute('aria-current');}
 $('refresh').hidden=page!=='activity';document.body.dataset.page=page;
 if(record&&!applyingHistory){const url=new URL(location.href);url.searchParams.set('view',page);if(memoryKind!=='latest')url.searchParams.set('kind',memoryKind);else url.searchParams.delete('kind');if(memoryQuery)url.searchParams.set('q',memoryQuery);else url.searchParams.delete('q');if(note)url.searchParams.set('note',note);else url.searchParams.delete('note');if(url.href!==location.href)history.pushState(null,'',url);}
}
async function loadSettings(){
 document.dispatchEvent(new Event('spool-settings-open'));await loadTeam();
 try{const config=await localRequest('memory-setup');$('memory-setup').textContent=JSON.stringify(config,null,2);const agents=await localRequest('agents');$('memory-agents-status').textContent=agents.message??(agents.configured?'Connected. New Codex sessions can retrieve context and leave handoffs.':'Connect Codex once for automatic context and handoffs.');$('connect-memory-agents').textContent=agents.configured?'Check Codex connection':'Connect Codex';}catch(error){$('memory-setup').textContent=error.message;}
}
async function showProject(options={}){setPage('settings',options);await loadSettings();}
async function showReview(options={}){setPage('activity',options);await refreshBranches(true);}
async function restorePage(){if(!state.local)return;const params=new URLSearchParams(location.search),page=params.get('view');memoryKind=['handoff','decision','finding','task','conversation'].includes(params.get('kind'))?params.get('kind'):'latest';memoryQuery=(params.get('q')??'').slice(0,1000);$('memory-query').value=memoryQuery;if(page==='settings')await showProject({record:false});else if(page==='activity')await showReview({record:false});else await showMemory({record:false,note:params.get('note')});}
window.addEventListener('popstate',()=>{applyingHistory=true;restorePage().catch(showError).finally(()=>applyingHistory=false);});
$('project-nav').addEventListener('click',()=>showProject().catch(showError));$('review-nav').addEventListener('click',()=>showReview().catch(showError));$('open-review').addEventListener('click',()=>showMemory());
for(const [id,path]of [['codex-connect','codex/connect'],['codex-disconnect','codex/disconnect']])$(id).addEventListener('click',async()=>{
  if(localBusy)return;localBusy=true;const button=$(id),label=button.textContent;button.disabled=true;button.textContent=id==='codex-connect'?'Connecting to Codex…':'Pausing…';$('project-error').textContent='';
  try{renderProject(await localRequest(path,{}));}catch(error){$('project-error').textContent=error.message;}finally{button.disabled=false;button.textContent=label;localBusy=false;}
});
async function loadProjects(){
  const data=await localRequest('projects');$('project-switch').replaceChildren(...data.projects.map(p=>{const name=p.name.charAt(0).toUpperCase()+p.name.slice(1),duplicate=data.projects.filter(other=>other.name.toLowerCase()===p.name.toLowerCase()).length>1;const item=option(p.id,duplicate?`${name} · ${p.root}`:name);item.title=p.root;return item;}));$('project-switch').value=state.project.id;$('project-controls').hidden=false;
}
async function switchProject(id){
 $('team-connection').value='';$('team-invite-output').value='';$('team-invite-output').hidden=true;
  const project=await localRequest('projects/select',{id});
  session.abort();view.abort();fileRequest.abort();listRequest.abort();session=new AbortController();view=new AbortController();fileRequest=new AbortController();listRequest=new AbortController();state.epoch++;
  Object.assign(state,{room:project.room,branch:'working',compare:'main',fileId:null,revision:null,files:[],entries:[],branches:[],snapshot:[],fileCursor:null,activityCursor:null,fileTotal:0});lastReviewRevision='';history.replaceState(null,'',location.pathname);
  for(const name of ['files','activity','code','comments','branch','compare','diff-stats'])$(name).replaceChildren();$('revision-banner').hidden=true;$('search').value='';$('changed-only').checked=false;notice('');memoryEpoch++;memoryQuery='';memoryKind='latest';$('memory-query').value='';$('memory-detail').hidden=true;renderProject(project);document.dispatchEvent(new Event('spool-project-changed'));await showMemory();
}
$('project-switch').addEventListener('change',async()=>{
  if(localBusy){$('project-switch').value=state.project.id;return;}localBusy=true;$('project-switch').disabled=true;
  try{await switchProject($('project-switch').value);}catch(error){$('project-error').textContent=error.message;$('project-switch').value=state.project.id;}finally{$('project-switch').disabled=false;localBusy=false;}
});
$('add-project').addEventListener('click',()=>{if(localBusy)return;$('add-project-error').textContent='';$('add-project-form').reset();$('add-project-dialog').showModal();});
for(const id of ['close-add-project','cancel-add-project'])$(id).addEventListener('click',()=>{if(!localBusy)$('add-project-dialog').close();});
$('add-project-dialog').addEventListener('cancel',event=>{if(localBusy)event.preventDefault();});
$('browse-project').addEventListener('click',async()=>{
  const button=$('browse-project');button.disabled=true;try{const result=await localRequest('projects/browse',{});if(result.root)$('new-project-root').value=result.root;if(result.message)$('add-project-error').textContent=result.message;}catch(error){$('add-project-error').textContent=error.message;}finally{button.disabled=false;}
});
$('add-project-form').addEventListener('submit',async event=>{
  event.preventDefault();if(localBusy)return;localBusy=true;$('add-project-error').textContent='';$('add-project-progress').hidden=false;
  for(const element of $('add-project-form').elements)element.disabled=true;
  try{
    const result=await localRequest('projects/add',{root:$('new-project-root').value,connectCodex:$('new-project-codex').checked,exclude:$('new-project-exclude').value.split('\n').map(p=>p.trim()).filter(Boolean)});
    await loadProjects();await switchProject(result.project.id);$('project-switch').value=result.project.id;$('add-project-dialog').close();if($('new-project-memory').checked)await connectMemoryAgents();
  }catch(error){$('add-project-error').textContent=error.message;}finally{for(const element of $('add-project-form').elements)element.disabled=false;$('add-project-progress').hidden=true;localBusy=false;}
});
async function bootLocal(){
  if(location.protocol==='file:')return;
  try{
    const response=await fetch('/local/session',{cache:'no-store',redirect:'error'});if(!response.ok){$('connect-screen').hidden=false;return;}
    const data=await response.json();state.local=true;state.csrf=data.csrf;state.room=data.project.room;state.mode='file';$('changed-only').checked=false;
    $('connect-screen').hidden=true;$('project-nav').hidden=false;$('review-nav').hidden=false;$('memory-nav').hidden=false;renderProject(data.project);await loadProjects();await restorePage();$('team-local-root').value=data.project.root;await loadPendingInvite();document.dispatchEvent(new Event('spool-ready'));
    document.querySelector('.brand').addEventListener('click',event=>{event.preventDefault();showMemory();});
    const poll=async()=>{try{if(!localBusy&&!document.hidden){await loadPendingInvite();const epoch=state.epoch,project=await localRequest('status');if(epoch!==state.epoch)return;renderProject(project);if(!$('memory-home').hidden&&!memoryQuery&&$('memory-detail').hidden){const latest=await localRequest('memory',{command:'context'});if(epoch===state.epoch&&memoryFingerprint(latest)!==memoryLastHeads)await loadMemory();}if(!$('workspace').hidden&&!state.revision){const branches=await api({command:'branches'}),revision=JSON.stringify(branches.branches.map(b=>[b.name,b.heads]));if(revision!==lastReviewRevision){lastReviewRevision=revision;await refreshBranches();}}}}catch(error){if(error.name!=='AbortError'){$('project-error').textContent=error.message;$('connection-state').textContent='Reconnecting…';}}finally{localPoll=setTimeout(poll,4000);}};localPoll=setTimeout(poll,4000);
  }catch(error){$('connect-screen').hidden=false;$('connect-error').textContent='Unable to reach the local app. Reload the page to reconnect.';}
}
bootLocal();

function memoryFingerprint(context){return JSON.stringify([context.heads,context.gitState?.commit,context.gitState?.branch,context.gitState?.worktreeHash,context.gitState?.verified]);}
let memoryLastHeads=null;
let memoryPage=null,memoryQuery='',memoryEpoch=0,detailId=null,detailOffset=null;
function memoryCard(item){
 const card=node('article','memory-card memory-row');card.dataset.noteId=item.id;
 const labels={handoff:'Handoff',decision:'Decision',finding:'Finding',blocker:'Blocker',task:'Task',conversation:'Conversation'};
 const meta=node('div','memory-meta');const badge=node('span','memory-kind',labels[item.kind]??'Note');badge.dataset.kind=item.kind;meta.append(badge);
 if(item.status)meta.append(node('span','task-state',item.status.replaceAll('_',' ')));
 if(item.sharing?.mode==='local')meta.append(node('span','memory-author','Local only'));
 const actor=item.actorLabel??item.actor;if(actor){const label=node('span','memory-author',/^(machine-|workspace-)/.test(actor)?'Agent':actor);label.title=actor;meta.append(label);}
 if(item.createdAt&&!Number.isNaN(Date.parse(item.createdAt))){const date=node('time','memory-date',new Date(item.createdAt).toLocaleDateString(undefined,{month:'short',day:'numeric'}));date.dateTime=item.createdAt;meta.append(date);}
 card.append(meta);const button=node('button','memory-title',item.title);button.onclick=()=>readMemory(item.id);card.append(button);
 const copy=node('p','memory-excerpt',item.text.slice(0,280)+(item.text.length>280?'…':''));card.append(copy);
 if(item.nextSteps?.length)card.append(node('p','memory-next','Next: '+item.nextSteps[0]));
 if(item.conflicts?.length)card.append(node('p','error','Conflicting task updates. Open this task before continuing.'));
 return card;
}
let memoryKind='latest';
function updateMemoryFilters(){for(const button of $('memory-filters').querySelectorAll('button'))button.setAttribute('aria-pressed',String(button.dataset.kind===memoryKind));}
function showMemoryBrowse(){ $('memory-home').querySelector('.home-foot').hidden=false;$('memory-browse').hidden=false;$('memory-detail').hidden=true;$('memory-search-form').hidden=false;$('memory-home').querySelector('.page-heading').hidden=false; }
async function showMemory({record=true,note=null}={}){
 setPage('memory',{record});showMemoryBrowse();updateMemoryFilters();await loadMemory();if(note&&document.body.dataset.page==='memory')await readMemory(note,false,false);
}
async function loadMemory(more=false){
 const epoch=++memoryEpoch,projectId=state.project?.id;$('memory-error').textContent='';$('memory-status').textContent='Loading memory…';$('memory-results').setAttribute('aria-busy','true');$('memory-reset').hidden=!memoryQuery;
 try{
  const context=await localRequest('memory',{command:'context'});if(epoch!==memoryEpoch||projectId!==state.project?.id)return;memoryLastHeads=memoryFingerprint(context);
  let items=[...context.tasks.filter(task=>task.status!=='done'),...context.notes];memoryPage=null;
  if(memoryQuery||memoryKind!=='latest'){const result=await localRequest('memory',{command:'search',query:memoryQuery,...(memoryKind!=='latest'?{kinds:[memoryKind]}:{}),limit:20,offset:more?memoryPageOffset:0});if(epoch!==memoryEpoch||projectId!==state.project?.id)return;items=result.results;memoryPage=result.nextOffset;}
  if(more)$('memory-results').append(...items.map(memoryCard));else $('memory-results').replaceChildren(...items.map(memoryCard));
  if(!items.length&&!more)$('memory-results').append(node('p','memory-empty',memoryQuery?'No matches. Try a different search.':'Nothing here yet. Your agents add memory as they work.'));
  $('memory-more').hidden=memoryPage===null;const titles={latest:'Recent notes & open tasks',handoff:'Handoffs',decision:'Decisions',finding:'Findings',task:'Tasks',conversation:'Conversations'};$('memory-results-title').textContent=memoryQuery?'Search results':titles[memoryKind];$('memory-status').textContent='';
 }catch(error){$('memory-error').textContent=error.message;$('memory-status').textContent='';}
 finally{if(epoch===memoryEpoch)$('memory-results').removeAttribute('aria-busy');}
}
let memoryPageOffset=0;
async function readMemory(id,more=false,record=true){
 const projectId=state.project?.id,navigation=pageEpoch;
 try{const item=await localRequest('memory',{command:'get',id,offset:more?detailOffset:0,limit:12000});if(projectId!==state.project?.id||navigation!==pageEpoch)return;
 detailId=id;detailOffset=item.nextOffset;setPage('memory',{note:id,record});$('memory-home').querySelector('.home-foot').hidden=true;$('memory-browse').hidden=true;$('memory-search-form').hidden=true;$('memory-home').querySelector('.page-heading').hidden=true;$('memory-detail').hidden=false;$('memory-detail-title').textContent=item.title;
 if(more)$('memory-detail-text').textContent+=item.text;else $('memory-detail-text').textContent=item.text;
 $('memory-detail-more').hidden=detailOffset===null;
 $('memory-detail-meta').textContent=[item.kind,item.sharing?.mode==='local'?'Local only':null,item.status?.replaceAll('_',' '),item.actorLabel??item.actor].filter(Boolean).join(' · ');
 for(const [id,values]of [['memory-detail-next',item.nextSteps],['memory-detail-blockers',item.blockers]]){const section=$(id);section.hidden=!values?.length;section.querySelector('ul').replaceChildren(...(values??[]).map(text=>node('li','',text)));}

 const source=$('memory-detail-source');source.replaceChildren(document.createTextNode([item.citation,item.actor,item.freshness,item.git?.commit?'Git '+item.git.commit:null,item.git?.dirty?'Uncommitted changes at capture':null,...(item.commits??[])].filter(Boolean).join(' · ')));
 if(item.kind==='conversation'&&item.source?.sessionId&&item.sharing?.mode==='shared'){source.append(action('Delete shared conversation…',()=>document.dispatchEvent(new CustomEvent('spool-delete-conversation',{detail:{room:item.sharing.room,relay:item.sharing.url,sessionId:item.source.sessionId}})),'quiet'));}
 if(item.reconciliation){const check=document.createElement('p');check.className='memory-git-status';check.dataset.state=item.reconciliation.status;check.textContent=({matching:'Matches current code',different_revision:'Different revision',commit_unavailable:'Commit unavailable',uncommitted_evidence:'Based on uncommitted work',repository_mismatch:'Different repository',unverified:'Git not verified'}[item.reconciliation.status]??'Git status')+'. '+item.reconciliation.message;source.append(check);}
 for(const file of item.files??[]){const button=document.createElement('button');button.className='quiet';button.textContent=file.path+(file.commit?' @ '+file.commit.slice(0,12):'')+(file.dirty?' · uncommitted changes':'');button.title=[file.repository,file.commit,file.legacySnapshotReference?'Legacy reference; verify in Git':null].filter(Boolean).join(' · ');button.onclick=async()=>{try{const current=await localRequest('memory',{command:'file_read',path:file.path});if(projectId!==state.project?.id)return;$('memory-detail-title').textContent=current.path;$('memory-detail-meta').textContent='Local file · Source stays on this computer';$('memory-detail-next').hidden=true;$('memory-detail-blockers').hidden=true;$('memory-detail-text').textContent=current.text??'Binary source';$('memory-detail-more').hidden=true;source.textContent=current.citation+' · local source (not uploaded)'+(current.nextOffset!==null?' · first page only':'');}catch(error){$('memory-error').textContent=error.message;}};source.append(button);}
 for(const ref of item.refs??[]){const button=document.createElement('button');button.className='quiet';button.textContent='Read cited memory';button.onclick=()=>readMemory(ref);source.append(button);}
 if(!more){$('memory-detail').querySelector('.source-details').open=false;$('memory-detail-title').focus({preventScroll:true});$('memory-detail').scrollIntoView({block:'start'});}
 }catch(error){$('memory-error').textContent=error.message;}
}
$('memory-nav').onclick=()=>showMemory();
$('memory-back').onclick=()=>showMemory();
$('memory-filters').addEventListener('click',event=>{const button=event.target.closest('button[data-kind]');if(!button)return;memoryKind=button.dataset.kind;setPage('memory');updateMemoryFilters();loadMemory();});
$('memory-search-form').onsubmit=event=>{event.preventDefault();memoryQuery=$('memory-query').value.trim();setPage('memory');showMemoryBrowse();loadMemory();};
$('memory-reset').onclick=()=>{memoryQuery='';$('memory-query').value='';setPage('memory');showMemoryBrowse();loadMemory();};
$('memory-more').onclick=()=>{memoryPageOffset=memoryPage;loadMemory(true);};
$('memory-detail-more').onclick=()=>readMemory(detailId,true);

async function connectMemoryAgents(){
 const button=$('connect-memory-agents');button.disabled=true;$('memory-agents-status').textContent='Connecting Codex and Zed…';
 try{const result=await localRequest('agents/connect',{});$('memory-agents-status').textContent=result.message??(result.trusted?'Connected. Automatic context and handoffs are enabled for new Codex sessions, including Codex in Zed. Reopen existing sessions to load the connection.':'Configuration saved. Hook trust still needs review.');button.textContent='Check Codex connection';}
 catch(error){$('memory-agents-status').textContent=error.message;}finally{button.disabled=false;}
}
$('connect-memory-agents').onclick=connectMemoryAgents;

function renderTeamState(project){const team=project.team;$('team-status').textContent=team?.configured?`${team.connected?'Shared':'Reconnecting'} · ${team.url} · ${project.name}${team.error?' · '+team.error:''}`:'Local only. Connect a shared project to exchange memory across computers.';}
async function loadTeam(){
 try{const project=await localRequest('status');renderTeamState(project);$('team-connect-details').open=!project.team?.configured;
 }catch(error){$('team-status').textContent=error.message;}
 try{const host=await localRequest('team/host',{command:'list'});$('team-host-project').replaceChildren(...host.projects.map(p=>option(p.room,p.name)));$('team-host-error').textContent='';}catch(error){$('team-host-error').textContent='Shared host administration is unavailable on this computer. You can still join with an invite link above.';}
}
$('team-connect-form').onsubmit=async event=>{event.preventDefault();if(localBusy)return;localBusy=true;$('team-error').textContent='Joining and sharing project history…';try{const result=await localRequest('invites/join',{link:$('team-connection').value.trim(),root:$('team-local-root').value,device:$('team-device').value,connectAgents:$('team-agents').checked,captureConversations:true});$('team-connection').value='';await loadProjects();await switchProject(result.project.id);$('project-switch').value=result.project.id;$('team-error').textContent=[result.agentError,result.captureError].filter(Boolean).join(' · ');}catch(error){$('team-error').textContent=error.message;}finally{localBusy=false;}};
let lastPendingInvite=null;
async function loadPendingInvite(){const {pending}=await localRequest('invites/pending');if(!pending||pending.link===lastPendingInvite)return;lastPendingInvite=pending.link;if((pending.link.replace(/^threadweave:/,'spool:').startsWith('spool://workspace/')||pending.link.includes('/join#workspace.'))){await showProject();document.dispatchEvent(new CustomEvent('spool-workspace-invite',{detail:pending.link}));return;}$('team-connection').value=pending.link;$('team-local-root').value=state.project.root;$('team-connect-details').closest('.team-panel').open=true;$('team-connect-details').open=true;await showProject();$('team-connect-details').closest('.team-panel').open=true;$('team-connect-details').open=true;window.spoolSettings?.show('advanced');$('team-connect-details').scrollIntoView({block:'center'});$('team-device').focus();}
$('team-create').onclick=async()=>{try{const result=await localRequest('team/host',{command:'create',name:$('team-project-name').value});await loadTeam();$('team-host-project').value=result.project.room;$('team-project-name').value='';}catch(error){$('team-host-error').textContent=error.message;}};
$('team-invite').onclick=async()=>{try{const result=await localRequest('team/host',{command:'create-invite',room:$('team-host-project').value,label:$('team-member-label').value||'Teammate',role:'write'});$('team-invite-output').hidden=false;$('team-invite-output').value=result.browserLink??result.link;$('team-host-error').textContent='Invite created. Send it privately to your teammate; it expires in 24 hours.';}catch(error){$('team-host-error').textContent=error.message;}};

$('team-join').onclick=async()=>{try{$('team-host-error').textContent='Connecting this folder…';const invite=await localRequest('team/host',{command:'invite',room:$('team-host-project').value,label:state.project.name+' on this computer',role:'write'});await localRequest('team/connect',invite.connection);$('team-host-error').textContent='Folder connected to the selected shared project.';await loadTeam();await loadMemory();}catch(error){$('team-host-error').textContent=error.message;}};

document.addEventListener('spool-conversations-deleted',()=>{if(state.local){$('memory-detail').hidden=true;loadMemory().catch(error=>notice(error.message));}});
