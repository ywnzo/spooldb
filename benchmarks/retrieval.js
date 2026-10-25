// Synthetic, reproducible retrieval evaluation. Never reads company conversations.
import assert from 'node:assert/strict';
import {writeFileSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {RelayServer,createCredential} from '../src/relay/index.js';
import {localEmbeddings} from '../src/memory/local-embeddings.js';
import {compactMemory} from '../src/memory/presentation.js';

const cases=[
 {title:'Delivery policy',text:'Delivery charges must not be included in the item subtotal.',query:'Why do we calculate shipping separately?'},
 {title:'Callback idempotency',text:'Billing callbacks can arrive repeatedly. Persist a unique external event ID before applying the account balance change.',query:'How do we prevent the same payment notification from charging twice?'},
 {title:'Executor recovery',text:'A worker lease expires after sixty seconds. Another executor may then resume unfinished jobs.',query:'What happens if a background process crashes midway through its work?'},
 {title:'Team privacy',text:'Company transcripts remain private. Share only distilled findings and decisions with the team.',query:'May we upload all chat messages to the shared server?'},
 {title:'Nested source control',text:'Embedded repositories must retain their own revision references alongside the parent commit.',query:'How should handoffs handle Git submodules?'},
 {title:'Authentication cookie',text:'The authorization cookie is HttpOnly and unavailable to frontend JavaScript.',query:'Why can the browser code not read the login session token?'},
 {title:'Soukromí konverzací',text:'Poznatky a předání práce sdílíme, celé rozhovory zůstávají soukromé.',query:'Which information can another agent see from my previous session?'},
 {title:'Obnova po aktualizaci',text:'Automatická aktualizace obnoví předchozí verzi, pokud kontrola zdraví selže.',query:'What is the recovery plan when an upgrade breaks the service?'}
];
const distractors=[
 ['Visual theme','Use amber accents, warm surfaces and readable typography.'],['Release naming','Public releases follow semantic versioning.'],['Database maintenance','Old backups expire according to the configured retention window.'],['Asset pipeline','Resize uploaded photographs before producing thumbnails.'],['Localization','Store displayed dates using the viewer timezone.'],['Navigation','Put the currently selected project in the header.'],['Export format','CSV reports use UTF-8 and include a header row.'],['Tests','Unit tests use isolated temporary directories.'],['User preference','The default list page shows twenty records.'],['Cache policy','Static icons can be cached for a day.'],['Commit convention','Keep commits focused on one concrete change.'],['Error identity','ERR_DUPLICATE_PAYMENT is emitted by BillingService.validateCallback.']
];
const provider=localEmbeddings(),relay=new RelayServer(':memory:',{referencesOnly:true,embeddings:provider});
const ref=relay.engine.create('new'),room=ref.room;relay.engine.db.prepare('UPDATE shard_refs SET name=? WHERE name=?').run('relay-'+room,'new');
const alice=createCredential('alice',{[room]:'write'}),bob=createCredential('bob',{[room]:'read'});relay.setCredentials([alice.credential,bob.credential]);
const origin=await relay.listen();
const call=async(token,input)=>{const response=await fetch(`${origin}/v1/rooms/${room}/memory`,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(input)});const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;};
try{
 for(const item of cases)item.id=(await call(alice.token,{command:'remember',kind:'decision',title:item.title,text:item.text,requestId:crypto.randomUUID()})).id;
 for(const [title,text]of distractors)await call(alice.token,{command:'remember',kind:'finding',title,text,requestId:crypto.randomUUID()});
 relay.memory.index(room);const start=performance.now();await relay.memory.semantic.prepare(room);const indexingMs=performance.now()-start;
 const results=[];
 for(const [index,item]of cases.entries()){
  const lexical=relay.memory.run(room,{command:'search',query:item.query}),before=performance.now(),hybrid=await call(bob.token,{command:'search',query:item.query,limit:5});
  // English and Czech privacy decisions express the same policy; either is relevant evidence.
  const acceptable=[3,6].includes(index)?[cases[3].id,cases[6].id]:[item.id];
  const rank=list=>{const i=list.findIndex(result=>acceptable.includes(result.id));return i<0?null:i+1;};
  results.push({query:item.query,expected:item.id,keywordRank:rank(lexical.results),hybridRank:rank(hybrid.results),latencyMs:Math.round(performance.now()-before),status:hybrid.retrieval.semanticStatus,top:hybrid.results.slice(0,3).map(item=>({title:item.title,channels:item.retrievedBy,similarity:item.match?.semantic}))});
 }
 const identifiers=await call(bob.token,{command:'search',query:'ERR_DUPLICATE_PAYMENT'});assert.ok(identifiers.results.some(item=>item.text.includes('BillingService.validateCallback')));
 const negatives=[];for(const query of ['How do I bake sourdough bread?','What are the moons of Jupiter?']){const result=await call(bob.token,{command:'search',query});negatives.push({query,returned:result.results.length});}
 const verbose=await call(bob.token,{command:'context'}),compact=compactMemory(verbose),contextChars={full:JSON.stringify(verbose).length,compact:JSON.stringify(compact).length};
 const recall=(key,k)=>results.filter(result=>result[key]!==null&&result[key]<=k).length/results.length;
 const report={model:provider.id,corpus:{records:cases.length+distractors.length,queries:cases.length,source:'synthetic English/Czech project memories'},indexingMs:Math.round(indexingMs),keywordRecallAt3:recall('keywordRank',3),hybridRecallAt3:recall('hybridRank',3),hybridRecallAt1:recall('hybridRank',1),contextChars,results,negatives,limitations:'Small synthetic evaluation, not a production accuracy or total chat-token savings claim. SQLite cosine search is exact, not ANN.'};
 const output=process.argv.find(arg=>arg.startsWith('--output='))?.slice(9);if(output){mkdirSync(dirname(resolve(output)),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n');}
 console.log(JSON.stringify(report,null,2));
 assert.ok(report.hybridRecallAt3>=0.875,'Semantic recall@3 regression');assert.ok(report.hybridRecallAt3>report.keywordRecallAt3,'Hybrid must improve paraphrase retrieval');assert.ok(negatives.every(result=>result.returned===0),'Unrelated queries should not inject memory');assert.ok(contextChars.compact<=6000);
}finally{await relay.close();}
