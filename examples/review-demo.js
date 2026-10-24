import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShardedEngine } from '../src/index.js';
import { RelayServer,SyncClient,createCredential,hashToken } from '../src/relay/index.js';

// Disposable, synthetic review workspace. This public read token is only for
// this loopback demo; real relays should generate separate random credentials.
const token='spool-demo-readonly-token-2026';
const dir=mkdtempSync(join(tmpdir(),'spool-review-demo-'));const engine=new ShardedEngine(join(dir,'client.sqlite'));engine.create();
const room=engine.ref('main').room;const writer=createCredential('demo-publisher',{[room]:'write'});
const relay=new RelayServer(join(dir,'relay.sqlite'),{credentials:[writer.credential,{id:'demo-reader',tokenHash:hashToken(token),rooms:{[room]:'read'}}]});
let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;await relay.close();engine.close();rmSync(dir,{recursive:true,force:true});};process.once('SIGINT',stop);process.once('SIGTERM',stop);
try {
const submit=(branch,actor,harness,operations)=>engine.submit(branch,{actor,harness,requestId:crypto.randomUUID(),expectedHeads:engine.ref(branch).heads,operations});
const historyBefore=`import { Database } from '../storage/database';
import type { Change, Frontier } from './types';

export interface HistoryOptions {
  room: string;
  heads: Frontier;
}

/** Read the history visible at a room frontier. */
export function history(db: Database, options: HistoryOptions) {
  const changes = db.reachable(options.room, options.heads);

  return {
    room: options.room,
    heads: options.heads,
    changes: changes.map(toHistoryEntry),
  };
}

function toHistoryEntry(change: Change) {
  return {
    id: change.hash,
    parents: change.parents,
    actor: change.provenance.actor,
    message: change.provenance.message,
  };
}
`;
const historyAfter=historyBefore.replace('  heads: Frontier;','  heads: Frontier;\n  after?: number;\n  limit?: number;').replace('  const changes = db.reachable(options.room, options.heads);',`  const limit = Math.min(options.limit ?? 50, 200);
  const changes = db.reachablePage({
    room: options.room,
    heads: options.heads,
    after: options.after ?? 0,
    limit: limit + 1,
  });
  const page = changes.slice(0, limit);`).replace('    changes: changes.map(toHistoryEntry),','    changes: page.map(toHistoryEntry),\n    nextCursor: changes.length > limit ? page.at(-1).sequence : null,');
const checkpointBefore=`export function createCheckpoint(document, storage) {
  const snapshot = document.save();
  storage.insert(snapshot);
  return snapshot.heads;
}
`;
submit('main','Alex','generic',[
  {type:'file.create',fileId:'api-history',path:'src/api/history.ts',text:historyBefore},
  {type:'file.create',fileId:'checkpoints',path:'src/storage/checkpoints.ts',text:checkpointBefore},
  {type:'file.create',fileId:'readme',path:'README.md',text:'# SpoolDB\n\nCode and conversation, kept together.\n'},
  {type:'file.create',fileId:'types',path:'src/api/types.ts',text:'export type Frontier = string[];\nexport interface Change { hash: string; parents: string[]; provenance: Record<string, string> }\n'},
  {type:'message.add',messageId:'initial-context',role:'user',text:'Let’s make room history practical to review. Keep code, conversations and stable anchors on the same causal frontier.'},
]);engine.fork('main','feature');
const url=await relay.listen({port:Number(process.env.SPOOL_REVIEW_PORT??0)});
const client=branch=>new SyncClient(engine,{url,room,branch,token:writer.token});await client('main').publishBranch('main');
submit('feature','Alex','generic',[{type:'message.add',messageId:'request',role:'user',text:'Add cursor pagination to history. A reconnect should pick up where it left off, and reviewing an old branch must stay consistent.'}]);
submit('feature','coding-agent','codex',[
  {type:'file.write',fileId:'api-history',text:historyAfter},
  {type:'file.create',fileId:'history-test',path:'test/history.test.ts',text:`test('a cursor resumes without repeating changes', () => {
  const first = history(db, { room, heads, limit: 2 });
  const next = history(db, { room, heads, after: first.nextCursor, limit: 2 });

  expect(next.changes).not.toContainEqual(first.changes.at(-1));
  expect(next.heads).toEqual(first.heads);
});
`},
  {type:'message.add',messageId:'implementation',role:'assistant',text:'The history reader now requests one extra row to detect the next page. Both the query and response keep the selected frontier, so new writes won’t shift an in-progress review.'},
]);
submit('feature','review-agent','claude',[
  {type:'comment.add',commentId:'cursor-review',fileId:'api-history',start:historyAfter.indexOf('const limit'),end:historyAfter.indexOf('const limit')+11,text:'Keep this cap at the API boundary. It bounds the response even when a client requests a large page.'},
  {type:'message.add',messageId:'review-note',role:'assistant',text:'The cursor should be the last visible row, not the look-ahead row. The added regression test covers that boundary. Existing text anchors remain independent of pagination.'},
]);
submit('feature','coding-agent','codex',[
  {type:'file.write',fileId:'checkpoints',text:checkpointBefore.replace('  storage.insert(snapshot);','  storage.insert(snapshot);\n  storage.keepLatest(document.id, 2);')},
  {type:'file.write',fileId:'readme',text:'# SpoolDB\n\nCode and conversation, kept together.\n\nHistory uses stable cursors and explicit causal frontiers.\n'},
  {type:'message.add',messageId:'finish',role:'assistant',text:'Pagination and its regression coverage are ready for review. I also bounded derived checkpoint retention; the raw history remains available for older branch views.'},
]);await client('feature').publishBranch('feature/cursor-pagination');
console.log(JSON.stringify({event:'review.demo',url:`${url}/review#room=${room}&branch=feature%2Fcursor-pagination&compare=main`,room,token,note:'Synthetic sample workspace; read-only token; no real project data.'}));
} catch(error) {await stop();throw error;}
