(()=>{
 const root=document.querySelector('.settings-layout');if(!root)return;
 const sections=[...root.querySelectorAll('[data-settings-section]')],links=[...root.querySelectorAll('[data-settings-link]')];
 function show(section,{record=true,focus=false}={}){
  if(!sections.some(node=>node.dataset.settingsSection===section))section='project';
  for(const node of sections)node.hidden=node.dataset.settingsSection!==section;
  for(const link of links){const active=link.dataset.settingsLink===section;link.classList.toggle('selected',active);if(active)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');}
  if(record){const url=new URL(location.href);url.searchParams.set('view','settings');url.searchParams.set('section',section);if(url.href!==location.href)history.pushState(null,'',url);}
  if(focus){const title=root.querySelector('[data-settings-section="'+section+'"] h2');title.tabIndex=-1;title.focus({preventScroll:true});}
 }
 for(const link of links)link.addEventListener('click',event=>{if(event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();show(link.dataset.settingsLink,{focus:true});});
 window.spoolSettings={show};
 const restore=()=>show(new URLSearchParams(location.search).get('section')??'project',{record:false});
 window.addEventListener('popstate',restore);restore();
 document.addEventListener('spool-workspace-invite',()=>show('workspace'));
})();
