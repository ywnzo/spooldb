import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/index.js';
import { Bridge } from '../src/bridge.js';
import { AdapterIngress } from '../src/adapters/index.js';
import { execFileSync, spawnSync } from 'node:child_process';
import { unpack } from '../src/storage/codec.js';

function setup(t, options = {}) {
  const e = new Engine(':memory:', { layout: 'sharded', ...options }); t.after(() => e.close()); e.create(); return e;
}
const create = (fileId, path = `${fileId}.txt`, text = 'hello world') => ({ type: 'file.create', fileId, path, text });
const splice = (fileId = 'f', index = 0, insert = 'x') => ({ type: 'file.splice', fileId, index, deleteCount: 0, insert });
const submit = (e, operations, branch = 'main') => e.submit(branch, { actor: 'test', requestId: crypto.randomUUID(), expectedHeads: e.ref(branch).heads, operations });

test('atomic batches retain only manifest nodes reachable from committed versions', t => {
  const e = setup(t); submit(e,Array.from({length:100},(_,i)=>create(`f-${i}`)));
  submit(e,Array.from({length:50},()=>splice('f-0')));
  const live=new Set();for(const row of e.db.prepare('SELECT root FROM shard_batches UNION SELECT root FROM shard_versions').all()) e.manifest.hashes(row.root,live);
  assert.equal(e.storageStats().manifestNodes,live.size);
  assert.equal(e.readFile('main','f-0').file.text,'x'.repeat(50)+'hello world');
  assert.equal(e.storageStats().changes,250); // 100 seeds, 100 creates, 50 edits
});

test('large staged trees discard private roots while retaining explicitly pinned historical roots', t => {
  const e=setup(t);const m=e.manifest;m.begin();let root=null;let old;
  for(let i=0;i<2500;i++) {root=m.set(root,`key-${i}`,{value:i});if(i===999) {old=root;m.retain(old);} }
  const before=m.layers.at(-1).nodes.size;m.discardIntermediate(root);
  assert.ok(m.layers.at(-1).nodes.size<before);m.retain(root);m.flush();m.commit();m.cache.clear();
  assert.equal([...m.entries(root)].length,2500);assert.equal([...m.entries(old)].length,1000);
  assert.deepEqual(m.get(root,'key-2499'),{value:2499});
});

test('checkpoint retention discards derived snapshots without losing historical versions or anchors', t => {
  const e=setup(t,{checkpointEvery:2,checkpointKeep:2,cacheEntries:0});submit(e,[create('f')]);
  const old=e.ref('main').heads; const anchor=e.anchor('main','f',6,11);
  for(let i=0;i<20;i++) submit(e,[splice()]);
  assert.equal(e.storageStats().checkpoints,2);assert.equal(e.storageStats().changes,22);
  assert.equal(e.readFile('main','f',old).file.text,'hello world');assert.equal(e.resolve('main',anchor).text,'world');
});

test('compaction upgrades old TEXT rows and removes only unreachable nodes, preserving receipts and all rooms', t => {
  const e=setup(t,{checkpointEvery:2,checkpointKeep:0});
  const request={actor:'test',requestId:'retry',expectedHeads:e.ref('main').heads,operations:[create('f', 'f.txt', 'hello world'.repeat(100))]};
  const receipt=e.submit('main',request);e.fork('main','old');const anchor=e.anchor('main','f',6,11);
  for(let i=0;i<10;i++) submit(e,[splice()]);e.create('room2');submit(e,[create('r')],'room2');
  const bundle=e.export('main');const before=e.read('main');const second=e.read('room2');
  for(const [table,key,column] of [['shard_nodes','hash','body'],['shard_batches','seq','body'],['shard_receipts','rowid','input']]) {
    for(const row of e.db.prepare(`SELECT ${key} AS k,${column} AS v FROM ${table}`).all()) e.db.prepare(`UPDATE ${table} SET ${column}=? WHERE ${key}=?`).run(JSON.stringify(unpack(row.v)),row.k);
  }
  e.manifest.put({entries:[['orphan',{heads:[]}]]});e.documents.checkpointKeep=2;
  const result=e.compact({vacuum:true});assert.equal(result.removedNodes,1);assert.ok(result.encodedRows>0);assert.ok(result.removedCheckpoints>0);assert.equal(result.walBusy,false);
  assert.deepEqual(e.read('main'),before);assert.deepEqual(e.read('room2'),second);assert.deepEqual(e.export('main'),bundle);
  assert.deepEqual(e.submit('main',request),receipt);assert.equal(e.resolve('main',anchor).text,'world');assert.equal(e.readFile('old','f').file.text,'hello world'.repeat(100));
  assert.equal(e.compact().removedNodes,0);
});

test('nested savepoint rollback never publishes staged nodes or loses an outer staged root', t => {
  const e=setup(t);e.transaction(()=>{
    submit(e,[create('a')]);
    assert.throws(()=>e.transaction(()=>{submit(e,[create('b')]);throw new Error('nested failure');}),/nested failure/);
    submit(e,[create('c')]);
  });
  assert.deepEqual(e.read('main').files.map(f=>f.fileId),['a','c']);
  assert.equal(e.manifest.layers.length,0);assert.equal(e.compact().removedNodes,0);
  const before=e.read('main');const flush=e.manifest.flush.bind(e.manifest);
  e.manifest.flush=()=>{flush();throw new Error('flush failure');};assert.throws(()=>submit(e,[splice('a')]),/flush failure/);e.manifest.flush=flush;
  assert.deepEqual(e.read('main'),before);assert.equal(e.manifest.layers.length,0);
});

test('selective reads do not load unrelated files or conversation documents', t => {
  const e = setup(t);
  submit(e, Array.from({ length: 100 }, (_, i) => create(`f-${i}`)));
  submit(e, Array.from({ length: 20 }, (_, i) => ({ type: 'message.add', messageId: `m-${i}`, role: 'assistant', text: 'context' })));
  e.clearCache(); e.storageStats({ resetMetrics: true });
  assert.equal(e.readFile('main', 'f-3').file.text, 'hello world');
  assert.equal(e.storageStats().documentLoads, 1);
  e.clearCache(); e.storageStats({ resetMetrics: true });
  const page = e.readRecords('main', { limit: 5 }); assert.equal(page.records.length, 5);
  assert.equal(e.storageStats().documentLoads, 5);
  e.clearCache(); e.storageStats({ resetMetrics: true });
  assert.equal(e.listFiles('main', { limit: 10 }).files.length, 10);
  assert.equal(e.storageStats().documentLoads, 0);
  assert.equal(e.storageStats().activeDocumentHandles, 0);
});

test('checkpoints preserve history and anchors while bounding the replayed tail', t => {
  const e = setup(t, { checkpointEvery: 8, cacheEntries: 0 }); submit(e, [create('f')]);
  const original = e.ref('main').heads; const anchor = e.anchor('main', 'f', 6, 11);
  for (let i = 0; i < 25; i++) submit(e, [splice()]);
  e.clearCache(); e.storageStats({ resetMetrics: true });
  assert.equal(e.readFile('main', 'f').file.text, 'x'.repeat(25) + 'hello world');
  const metrics = e.storageStats(); assert.equal(metrics.checkpointLoads, 1); assert.ok(metrics.replayedChanges < 8);
  assert.equal(e.resolve('main', anchor).text, 'world');
  assert.equal(e.readFile('main', 'f', original).file.text, 'hello world');
  assert.equal(e.resolve('main', anchor, original).start, 6);
});

test('record pages enforce a byte budget and resume without dropping records', t => {
  const e = setup(t); submit(e, ['a', 'b', 'c'].map(messageId => ({ type: 'message.add', messageId, role: 'assistant', text: 'x'.repeat(100) })));
  const a = e.readRecords('main', { byteLimit: 250 }); assert.equal(a.records.length, 1); assert.ok(a.bytes <= 250);
  const b = e.readRecords('main', { byteLimit: 250, after: a.nextCursor }); assert.equal(b.records[0].id, 'b');
  assert.throws(() => e.readRecords('main', { byteLimit: 1 }), /exceeds/);
  assert.equal(e.storageStats().activeDocumentHandles, 0);
});

test('editable versions cannot omit the global room genesis', t => {
  const e = setup(t); assert.throws(() => e.fork('main', 'empty', []), /genesis/);
  assert.throws(() => e.read('main', []), /genesis/);
  assert.throws(() => e.import('empty', { protocol: 'spool/2', schema: 2, room: e.ref('main').room, heads: [], batches: [], nodes: [], documents: [] }), /Invalid bundle/);
});

test('a checkpoint on another branch is never used to inject that branch into a historical read', t => {
  const e = setup(t, { checkpointEvery: 3, cacheEntries: 0 }); submit(e, [create('f')]); e.fork('main', 'other');
  for (let i = 0; i < 5; i++) submit(e, [splice('f', 0, 'A')]);
  const before = e.ref('main').heads;
  for (let i = 0; i < 7; i++) submit(e, [splice('f', 0, 'B')], 'other');
  assert.equal(e.readFile('main', 'f', before).file.text, 'AAAAAhello world');
  assert.equal(e.readFile('other', 'f').file.text, 'BBBBBBBhello world');
});

test('corrupt derived checkpoints fall back to the retained immutable changes', t => {
  const e = setup(t, { checkpointEvery: 3, cacheEntries: 0 }); submit(e, [create('f')]);
  for (let i = 0; i < 5; i++) submit(e, [splice()]);
  e.db.prepare("UPDATE shard_checkpoints SET body=x'00'").run();
  e.clearCache(); e.storageStats({ resetMetrics: true });
  assert.equal(e.readFile('main', 'f').file.text, 'xxxxxhello world');
  assert.equal(e.storageStats().corruptCheckpoints, 1);
});

test('cache entry and accounting budgets are enforced without claiming an RSS limit', t => {
  const e = setup(t, { cacheEntries: 2, cacheBytes: 20000 }); submit(e, [create('a'), create('b'), create('c')]);
  for (const key of ['a', 'b', 'c', 'a']) e.readFile('main', key);
  const stats = e.storageStats(); assert.ok(stats.cacheEntries <= 2); assert.ok(stats.cacheWeightBytes <= 20000);
  assert.equal(stats.activeDocumentHandles, 0);
  e.clearCache(); assert.equal(e.storageStats().cacheEntries, 0);
});

test('historical forks share manifest nodes and changes without copying shards', t => {
  const e = setup(t); submit(e, [create('a'), create('b')]); const before = e.storageStats();
  e.fork('main', 'fork'); const after = e.storageStats();
  assert.equal(after.changes, before.changes); assert.equal(after.manifestNodes, before.manifestNodes);
  submit(e, [splice('a')], 'fork'); assert.equal(e.readFile('main', 'a').file.text, 'hello world');
  assert.equal(e.readFile('fork', 'a').file.text, 'xhello world');
});

test('a failure after shard persistence rolls back all shard changes, checkpoints and the branch ref', t => {
  const e = setup(t, { checkpointEvery: 1 }); submit(e, [create('a'), create('b')]); const before = e.read('main'); const counts = e.storageStats();
  const persist = e.documents.persist.bind(e.documents);
  e.documents.persist = (...args) => { persist(...args); throw new Error('injected storage failure'); };
  assert.throws(() => submit(e, [splice('a'), splice('b')]), /storage failure/);
  e.documents.persist = persist;
  assert.deepEqual(e.read('main'), before);
  const after = e.storageStats(); assert.equal(after.changes, counts.changes); assert.equal(after.checkpoints, counts.checkpoints);
  assert.equal(after.batches, counts.batches);
});

test('two SQLite connections see the old complete batch until all shards publish together', t => {
  const dir = mkdtempSync(join(tmpdir(), 'spool-shards-')); const filename = join(dir, 'db.sqlite');
  const a = new Engine(filename, { layout: 'sharded' }); const b = new Engine(filename, { layout: 'sharded' });
  t.after(() => { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }); }); a.create(); submit(a, [create('a'), create('b')]);
  const persist = a.documents.persist.bind(a.documents); let observations = 0;
  a.documents.persist = (...args) => {
    const result = persist(...args); observations++;
    assert.equal(b.readFile('main', 'a').file.text, 'hello world'); assert.equal(b.readFile('main', 'b').file.text, 'hello world'); return result;
  };
  submit(a, [splice('a'), splice('b'), { type: 'message.add', messageId: 'm', role: 'assistant', text: 'Both changed' }]);
  assert.equal(observations, 3); assert.equal(b.readFile('main', 'a').file.text, 'xhello world');
  assert.equal(b.read('main').messages.m.text, 'Both changed');
});

test('partial or malformed bundles never publish a partial global version; valid retry works', t => {
  const source = setup(t); submit(source, [create('a'), { type: 'message.add', messageId: 'm', role: 'user', text: 'context' }]);
  const destination = new Engine(':memory:', { layout: 'sharded' }); t.after(() => destination.close());
  const bundle = source.export('main'); const partial = structuredClone(bundle); partial.documents.pop();
  assert.throws(() => destination.import('main', partial), /Incomplete/); assert.equal(destination.refs().length, 0);
  assert.equal(destination.storageStats().documents, 0);
  destination.import('main', bundle); assert.deepEqual(destination.read('main'), source.read('main'));
  const exported = source.export('main');
  exported.nodes[0].node.changedByCaller = true;
  assert.deepEqual(destination.read('main'), source.read('main'));
  const corrupt = structuredClone(bundle); corrupt.nodes[0].hash = 'bad';
  assert.throws(() => destination.import('other', corrupt), /hash/); assert.equal(destination.refs().length, 1);
});

test('ten offline replicas converge after concurrent edits to shared and distinct file shards', t => {
  const seed = setup(t); submit(seed, [create('shared'), ...Array.from({ length: 10 }, (_, i) => create(`f-${i}`))]);
  const base = seed.export('main'); const peers = Array.from({ length: 10 }, () => new Engine(':memory:', { layout: 'sharded' }));
  t.after(() => peers.forEach(p => p.close()));
  const updates = peers.map((peer, i) => {
    peer.import('main', base); submit(peer, [splice('shared', 0, `[${i}]`), splice(`f-${i}`, 0, `${i}`)]); return peer.export('main', base.heads);
  });
  for (const [i, peer] of peers.entries()) {
    for (const update of i % 2 ? [...updates].reverse() : updates) peer.import('main', update);
  }
  const expected = peers[0].read('main'); for (const peer of peers) assert.deepEqual(peer.read('main'), expected);
  assert.equal(expected.heads.length, 10); assert.ok(expected.files.find(f => f.fileId === 'shared').text.includes('[9]'));
});

test('comments refer to file shards even when a text edit precedes the comment in the same atomic batch', t => {
  const e = setup(t); submit(e, [create('f')]);
  submit(e, [splice('f', 0, 'prefix '), { type: 'comment.add', commentId: 'c', fileId: 'f', start: 13, end: 18, text: 'This word' }]);
  const comment = e.readRecords('main', { kind: 'comments' }).records[0].value;
  assert.equal(e.resolve('main', comment).text, 'world');
  submit(e, [splice()]); assert.equal(e.resolve('main', comment).text, 'world');
});

test('legacy data is left intact and storage layouts cannot be opened interchangeably', t => {
  const dir = mkdtempSync(join(tmpdir(), 'spool-format-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const legacy = new Engine(join(dir, 'legacy.sqlite')); legacy.create(); legacy.close();
  assert.throws(() => new Engine(join(dir, 'legacy.sqlite'), { layout: 'sharded' }), /not migrated/);
  const still = new Engine(join(dir, 'legacy.sqlite')); assert.equal(still.refs().length, 1); still.close();
  const v2 = new Engine(join(dir, 'v2.sqlite'), { layout: 'sharded' }); v2.create(); v2.close();
  assert.throws(() => new Engine(join(dir, 'v2.sqlite')), /layout/);
});

test('the Git bridge and native ingress run against the sharded storage API', t => {
  const dir = mkdtempSync(join(tmpdir(), 'spool-shard-bridge-')); const root = join(dir, 'repo'); mkdirSync(root);
  t.after(() => rmSync(dir, { recursive: true, force: true })); execFileSync('git', ['-C', root, 'init', '-q']); writeFileSync(join(root, 'a'), 'bytes');
  const e = new Engine(':memory:', { layout: 'sharded' }); t.after(() => e.close()); const bridge = new Bridge(e); bridge.attach('main', root);
  const ingress = new AdapterIngress(e); const s = ingress.open({ branch: 'main', harness: 'codex', prompt: 'context' });
  ingress.ingest(s.streamId, 0, { type: 'thread.started', thread_id: 'native' });
  assert.equal(e.readRecords('main', { kind: 'adapterEvents' }).records.length, 1);
  assert.ok(bridge.materialize('main', join(dir, 'output')).complete);
});

test('the opt-in sharded CLI exposes selective reads and checkpoint metrics', () => {
  const run = spawnSync(process.execPath, ['src/cli.js', ':memory:', '--sharded'], { cwd: new URL('..', import.meta.url), encoding: 'utf8',
    input: [{ command: 'init', branch: 'main' }, { command: 'storage.stats' }, { command: 'files.list', branch: 'main' }, { command: 'storage.compact', options: { vacuum: true } }].map(JSON.stringify).join('\n') + '\n' });
  assert.ifError(run.error); assert.equal(run.status, 0, run.stderr);
  const rows = run.stdout.trim().split('\n').map(JSON.parse); assert.ok(rows.every(r => r.ok), run.stdout); assert.equal(rows[1].result.layout, 'sharded');
  assert.equal(rows[3].result.vacuum,true); assert.equal(rows[3].result.removedNodes,0);
});
