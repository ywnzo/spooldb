import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ShardedEngine } from '../src/index.js';
import { RelayServer,SyncClient,createCredential } from '../src/relay/index.js';
import { lineDiff } from '../src/review/diff.js';
const submit=(e,branch,operations)=>e.submit(branch,{actor:'reviewer',harness:'generic',requestId:crypto.randomUUID(),expectedHeads:e.ref(branch).heads,operations});
async function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'spool-review-'));const e=new ShardedEngine(join(dir,'local.sqlite'));e.create();
  submit(e,'main',[{type:'file.create',fileId:'f',path:'src/app.js',text:'function limit() {\n  return 10;\n}\n'},{type:'message.add',messageId:'prompt',role:'user',text:'Please make the limit configurable.'}]);e.fork('main','feature');
  const room=e.ref('main').room,auth=createCredential('writer',{[room]:'write'}),reader=createCredential('reader',{[room]:'read'});
  const relay=new RelayServer(join(dir,'relay.sqlite'),{credentials:[auth.credential,reader.credential]});const url=await relay.listen();
  const client=branch=>new SyncClient(e,{url,room,branch,token:auth.token});await client('main').publishBranch('main');
  submit(e,'feature',[{type:'file.write',fileId:'f',text:'function limit(value = 25) {\n  return value;\n}\n'},{type:'file.rename',fileId:'f',path:'src/limit.js'},
    {type:'message.add',messageId:'reply',role:'assistant',text:'<img src=x onerror=alert(1)> Limit is configurable.'},
    {type:'comment.add',commentId:'comment',fileId:'f',start:0,end:8,text:'The stable function anchor.'}]);await client('feature').publishBranch('feature/configurable');
  const api=async(input,token=reader.token)=>{const r=await fetch(`${url}/v1/rooms/${room}/review`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(input)});return {status:r.status,...await r.json()};};
  t.after(async()=>{await relay.close();e.close();rmSync(dir,{recursive:true,force:true});});return {e,room,auth,reader,relay,url,client,api};
}
test('bounded line diffs preserve edits, line numbers, empty files and fallback limits',()=>{
  const d=lineDiff('a\nb\nc','a\nx\nc');assert.equal(d.added,1);assert.equal(d.removed,1);assert.deepEqual(d.rows.filter(r=>r.type==='add')[0],{type:'add',text:'x',oldLine:null,newLine:2});
  assert.equal(lineDiff('','a').removed,0);assert.equal(lineDiff('a','').added,0);assert.deepEqual(lineDiff('','').rows,[]);
  assert.equal(lineDiff('a'.repeat(400001),'b').truncated,true);const large=lineDiff(Array.from({length:1100},(_,i)=>`a${i}`).join('\n'),Array.from({length:1100},(_,i)=>`b${i}`).join('\n'));assert.equal(large.approximate,true);assert.ok(large.rows.length<=2000);assert.equal(large.truncated,true);
});
test('named branch snapshots retain independent histories and optimistic publishing rejects stale updates',async t=>{
  const f=await fixture(t);const list=await f.api({command:'branches'});assert.equal(list.status,200);assert.deepEqual(list.branches.map(b=>b.name),['@live','feature/configurable','main']);
  assert.notDeepEqual(f.e.ref('main').heads,f.e.ref('feature').heads);assert.equal(f.e.readFile('main','f').file.path,'src/app.js');
  await assert.rejects(f.client('feature').publishBranch('feature/configurable'),e=>e.code==='BRANCH_CONFLICT');
  const updated=await f.client('feature').publishBranch('feature/configurable',{expectedRevision:1});assert.equal(updated.branch.revision,2);
  const denied=await f.api({command:'publish',name:'bad',heads:f.e.ref('main').heads,expectedRevision:0});assert.equal(denied.status,403);
});
test('publishing an independent feature never pulls the relay aggregate into the local branch',async t=>{
  const f=await fixture(t);f.e.fork('main','experiment');submit(f.e,'experiment',[{type:'file.splice',fileId:'f',index:0,deleteCount:0,insert:'// experiment\n'}]);
  await f.client('experiment').publishBranch('experiment/isolated');
  assert.equal(f.e.readFile('experiment','f').file.path,'src/app.js');assert.ok(f.e.readFile('experiment','f').file.text.includes('return 10'));assert.equal(f.e.read('experiment').messages.reply,undefined);
  const view=await f.api({command:'file',branch:'experiment/isolated',fileId:'f'});assert.equal(view.file.path,'src/app.js');assert.ok(view.file.text.startsWith('// experiment'));
  const timeline=await f.api({command:'timeline',branch:'experiment/isolated'});assert.ok(!timeline.entries.some(e=>e.messages.some(m=>m.id==='reply')));
});
test('a lost publication acknowledgment retries without advancing the branch twice',async t=>{
  const f=await fixture(t);const send=f.relay.send.bind(f.relay);let dropped=false;
  f.relay.send=(res,status,value)=>{if(value.name==='retry-safe'&&!dropped){dropped=true;res.destroy();return;}send(res,status,value);};
  const result=await f.client('feature').publishBranch('retry-safe',{requestId:'stable-publication'});assert.ok(dropped);assert.equal(result.branch.revision,1);
  const replay=await f.client('feature').publishBranch('retry-safe',{requestId:'stable-publication'});assert.deepEqual(replay.branch,result.branch);
  await assert.rejects(f.client('feature').publishBranch('another-name',{requestId:'stable-publication'}),e=>e.code==='REQUEST_CONFLICT');
});
test('review compares renamed files by stable identity and shows branch-specific code, conversations and resolved comments',async t=>{
  const f=await fixture(t);const input={branch:'feature/configurable',compare:'main'};
  const files=await f.api({command:'files',...input});assert.equal(files.files[0].status,'renamed');assert.equal(files.files[0].previousPath,'src/app.js');
  const diff=await f.api({command:'diff',...input,fileId:'f'});assert.ok(diff.rows.some(r=>r.type==='add'&&r.text.includes('return value')));assert.equal(diff.comments[0].resolved.text,'function');
  const base=await f.api({command:'file',branch:'main',fileId:'f'});assert.ok(base.file.text.includes('return 10'));assert.equal(base.comments.length,0);
  const timeline=await f.api({command:'timeline',branch:'feature/configurable'});assert.ok(timeline.entries.some(e=>e.messages.some(m=>m.text.includes('<img'))));
  const main=await f.api({command:'timeline',branch:'main'});assert.ok(!main.entries.some(e=>e.messages.some(m=>m.id==='reply')));
  const change=timeline.entries.find(e=>e.metadata?.fileIds.includes('f')&&e.messages.some(m=>m.id==='reply'));
  const revision=await f.api({command:'diff',branch:'feature/configurable',heads:[change.changeId],baseHeads:change.parents,fileId:'f'});assert.ok(revision.added>0);
  const wrong=await f.api({command:'file',branch:'main',heads:[change.changeId],fileId:'f'});assert.equal(wrong.status,404);assert.equal(f.relay.engine.storageStats().activeDocumentHandles,0);
});
test('review assets expose no workspace data and carry a strict same-origin policy; endpoints enforce grants',async t=>{
  const f=await fixture(t);const html=await fetch(`${f.url}/review`);assert.equal(html.status,200);assert.match(html.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.ok(!(await html.text()).includes(f.reader.token));
  const redirect=await fetch(`${f.url}/review?preview=1`,{redirect:'manual'});assert.equal(redirect.status,308);assert.equal(redirect.headers.get('location'),'/review/?preview=1');
  const page=await fetch(`${f.url}/review/?preview=1`);const markup=await page.text();
  const stylesheets=[...markup.matchAll(/rel="stylesheet" href="([^"]+)"/g)].map(match=>new URL(match[1],page.url));
  assert.deepEqual(stylesheets.map(url=>url.pathname.split('/').at(-1)),['kiln.css','style.css']);
  for(const stylesheet of stylesheets){const css=await fetch(`${stylesheet}?v=1`);assert.equal(css.status,200);assert.match(css.headers.get('content-type'),/^text\/css/);const source=await css.text();assert.match(source,stylesheet.pathname.endsWith('kiln.css')?/color-scheme: dark/:/\.topbar\{/);assert.equal(new URL(stylesheet.pathname.split('/').at(-1),'file:///preview/index.html').pathname,'/preview/'+stylesheet.pathname.split('/').at(-1));}
  const script=await fetch(`${f.url}/review/app.js`);const source=await script.text();assert.ok(!source.includes('innerHTML'));assert.ok(!source.includes('localStorage'));assert.ok(!source.includes('sessionStorage'));
  assert.equal((await f.api({command:'branches'},'x'.repeat(43))).status,401);
  const foreign=new ShardedEngine(':memory:');foreign.create();const foreignHeads=foreign.ref('main').heads;foreign.close();
  assert.notEqual((await f.api({command:'publish',name:'foreign',heads:foreignHeads,expectedRevision:0},f.auth.token)).status,200);
  f.relay.setCredentials([]);assert.equal((await f.api({command:'timeline',branch:'main'})).status,401);
});
test('review history and file pages resume without mixing branch versions; non-text content is metadata only',async t=>{
  const f=await fixture(t);for(let i=0;i<8;i++)submit(f.e,'feature',[{type:'file.create',fileId:`extra-${i}`,path:`${i}.txt`,text:'hello'}]);
  submit(f.e,'feature',[{type:'file.create',fileId:'binary',path:'asset.bin',kind:'binary',data:'AP8='},{type:'file.create',fileId:'link',path:'shortcut',kind:'symlink',target:'src/limit.js'}]);await f.client('feature').publishBranch('feature/configurable',{expectedRevision:1});
  const first=await f.api({command:'files',branch:'feature/configurable',limit:2});const next=await f.api({command:'files',branch:'feature/configurable',limit:2,after:first.nextCursor});assert.ok(first.files.every(a=>!next.files.some(b=>b.fileId===a.fileId)));
  const recent=await f.api({command:'timeline',branch:'feature/configurable',limit:2});const older=await f.api({command:'timeline',branch:'feature/configurable',limit:2,before:recent.nextCursor});assert.ok(older.entries.every(a=>a.cursor<recent.entries.at(-1).cursor));
  const bin=await f.api({command:'diff',branch:'feature/configurable',compare:'main',fileId:'binary'});assert.equal(bin.nonText,true);assert.equal(bin.after.bytes,2);assert.equal(bin.after.data,undefined);
  const baseOnly=await f.api({command:'file',branch:'main',compare:'feature/configurable',fileId:'binary'});assert.equal(baseOnly.previewFrom,'base');assert.equal(baseOnly.file.kind,'binary');
  const link=await f.api({command:'file',branch:'feature/configurable',fileId:'link'});assert.equal(link.file.target,'src/limit.js');
});
test('deleted files and long-message previews remain browsable only in the matching branch history',async t=>{
  const f=await fixture(t);const text='Detailed reasoning.\n'.repeat(800);
  submit(f.e,'feature',[{type:'file.delete',fileId:'f'},{type:'file.create',fileId:'ghost',path:'temporary.txt',text:'temporary'},{type:'file.delete',fileId:'ghost'},{type:'message.add',messageId:'long-explanation',role:'assistant',text}]);await f.client('feature').publishBranch('feature/configurable',{expectedRevision:1});
  const files=await f.api({command:'files',branch:'feature/configurable',compare:'main'});assert.equal(files.files[0].status,'deleted');
  assert.equal(files.files.find(f=>f.fileId==='ghost').status,'unchanged');const changed=await f.api({command:'files',branch:'main',compare:'feature/configurable',changedOnly:true});assert.ok(!changed.files.some(f=>f.fileId==='ghost'));
  const diff=await f.api({command:'diff',branch:'feature/configurable',compare:'main',fileId:'f'});assert.equal(diff.after.deleted,true);assert.ok(diff.removed>0);
  const timeline=await f.api({command:'timeline',branch:'feature/configurable'});const preview=timeline.entries.flatMap(e=>e.messages).find(m=>m.id==='long-explanation');assert.equal(preview.text.length,12000);assert.equal(preview.truncated,true);
  const full=await f.api({command:'message',branch:'feature/configurable',messageId:'long-explanation'});assert.equal(full.message.text,text);
  assert.equal((await f.api({command:'message',branch:'main',messageId:'long-explanation'})).status,404);
});
