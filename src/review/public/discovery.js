(()=>{
 const list=document.getElementById('discovery-list'),error=document.getElementById('discovery-error'),panel=document.getElementById('workspace-panel');if(!list)return;let busy=false,signature='';
 const api=input=>panel.dataset.api==='setup'?window.api('discovery',input):window.localRequest('discovery',input);
 const node=(tag,text)=>{const el=document.createElement(tag);el.textContent=text;return el;};
 async function action(fn){busy=true;error.textContent='';try{if(await fn()!==false){signature='';await refresh();}}catch(e){error.textContent=e.message;}finally{busy=false;}}
 async function refresh(){const result=await api({command:'list'}),pending=result.entries.filter(e=>e.status==='pending'),key=JSON.stringify(pending);document.getElementById('discovery-panel').hidden=pending.length===0;if(key===signature)return;signature=key;list.replaceChildren();if(!pending.length){list.append(node('p','No repositories waiting for approval.'));return;}
 for(const entry of pending){const card=node('section','');card.className='memory-detail';card.append(node('h3',entry.name),node('p',entry.root),node('p',entry.remote??'No supported origin remote. Choose an existing shared project.'));const check=node('button','Choose connection'),skip=node('button','Ignore this checkout');check.className='primary';skip.className='quiet';card.append(check,skip);list.append(card);
 skip.onclick=()=>action(()=>api({command:'ignore',cwd:entry.root}));check.onclick=()=>action(async()=>{const info=await api({command:'preview',cwd:entry.root});if(!info.connected)throw new Error('Connect your company workspace below first.');check.hidden=true;const form=document.createElement('form'),select=document.createElement('select'),name=document.createElement('input');select.setAttribute('aria-label','Shared project');name.setAttribute('aria-label','New shared project name');name.value=entry.name;
 if(info.match){const option=node('option','Join '+info.match.name);option.value=info.match.room;select.append(option);}else{
 const placeholder=node('option','Choose a shared project…');placeholder.value='';select.append(placeholder);
 if(info.canCreate&&entry.repositoryKey){const option=node('option','Create a new shared project');option.value='create';select.append(option);}
 for(const project of info.projects){if(entry.repositoryKey&&project.role!=='admin')continue;const option=node('option','Join '+project.name);option.value=project.room;select.append(option);}}
 const submit=node('button','Connect and share conversations & memory');submit.type='submit';submit.className='primary';form.append(select,name,node('p','Approval enables saved Codex conversation capture for this checkout. Code stays in Git.'),submit);card.append(form);
 select.onchange=()=>{name.hidden=select.value!=='create';};select.onchange();
 form.onsubmit=e=>{e.preventDefault();action(async()=>{if(!select.value)throw new Error('Choose whether to create or join a shared project.');submit.disabled=true;try{const result=await api({command:'approve',cwd:entry.root,confirm:true,...(select.value==='create'?{name:name.value}:{room:select.value})});if(panel.dataset.api==='setup'){location.href=result.origin+'/';return;}await window.loadProjects?.();}finally{submit.disabled=false;}});};
 return false;});}
 }
 document.addEventListener('spool-ready',()=>{refresh().catch(e=>error.textContent=e.message);setInterval(()=>{if(!busy)refresh().catch(e=>error.textContent=e.message);},5000);});
})();
