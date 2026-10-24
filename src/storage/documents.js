import * as A from '@automerge/automerge';
import { createHash } from 'node:crypto';
import { digest } from '../adapters/contract.js';

const sorted = heads => [...heads].sort();
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
const checksum = bytes => createHash('sha256').update(bytes).digest('hex');
const reach = `WITH RECURSIVE wanted(hash) AS (
  SELECT value FROM json_each(?) UNION SELECT dep.value FROM wanted w
  CROSS JOIN shard_changes c CROSS JOIN json_each(c.deps) dep WHERE c.room=? AND c.doc=? AND c.hash=w.hash
)`;

export class Documents {
  constructor(db, { checkpointEvery = 128, checkpointKeep = 2, cacheBytes = 32 * 1024 * 1024, cacheEntries = 64 } = {}) {
    if (![checkpointEvery, checkpointKeep, cacheBytes, cacheEntries].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('Invalid storage limits');
    this.db = db; this.queries = new Map(); this.checkpointEvery = checkpointEvery; this.checkpointKeep = checkpointKeep; this.cacheBytes = cacheBytes; this.cacheEntries = cacheEntries;
    this.cache = new Map(); this.weight = 0; this.owned = new Map(); this.depth = 0; this.resetMetrics();
    db.exec(`CREATE TABLE IF NOT EXISTS shard_changes (
      seq INTEGER PRIMARY KEY,room TEXT NOT NULL,doc TEXT NOT NULL,hash TEXT NOT NULL,deps TEXT NOT NULL,body BLOB NOT NULL,
      UNIQUE(room,doc,hash));
      CREATE TABLE IF NOT EXISTS shard_doc_stats (
      room TEXT NOT NULL,doc TEXT NOT NULL,changes_count INTEGER NOT NULL,bytes INTEGER NOT NULL,checkpoint_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(room,doc));
      CREATE TABLE IF NOT EXISTS shard_checkpoints (
      seq INTEGER PRIMARY KEY,room TEXT NOT NULL,doc TEXT NOT NULL,heads TEXT NOT NULL,body BLOB NOT NULL,checksum TEXT NOT NULL,
      UNIQUE(room,doc,heads));`);
  }
  prepare(sql) { if (!this.queries.has(sql)) this.queries.set(sql, this.db.prepare(sql)); return this.queries.get(sql); }
  resetMetrics() { this.metrics = { cacheHits: 0, documentLoads: 0, checkpointLoads: 0, replayedChanges: 0, corruptCheckpoints: 0 }; }
  clear() { this.cache.clear(); this.weight = 0; }
  own(doc) { this.owned.set(A.getActorId(doc), doc); return doc; }
  clone(doc) { return this.own(A.clone(doc)); }
  release(doc) {
    const actor = A.getActorId(doc);
    if (this.owned.has(actor)) { this.owned.delete(actor); A.free(doc); }
  }
  scope(fn) {
    this.depth++;
    try { return fn(); }
    finally { if (--this.depth === 0) { for (const doc of this.owned.values()) A.free(doc); this.owned.clear(); } }
  }
  seed(room, key) {
    const doc = this.own(A.init({ actor: digest({ room, key }).slice(0, 32) }));
    return A.change(doc, { time: 0, message: 'shard-genesis' }, d => {
      Object.assign(d, { schema: 2, room, document: key, files: {}, messages: {}, comments: {}, adapterEvents: {}, events: {} });
    });
  }
  remember(room, key, doc, weight) {
    const cacheKey = `${room}/${key}`; const old = this.cache.get(cacheKey);
    if (old) { this.weight -= old.weight; this.cache.delete(cacheKey); }
    if (!this.cacheEntries) return;
    const body = A.save(doc); weight = body.byteLength;
    if (weight > this.cacheBytes) return;
    this.cache.set(cacheKey, { heads: sorted(A.getHeads(doc)), body, weight }); this.weight += weight;
    while (this.cache.size > this.cacheEntries || this.weight > this.cacheBytes) {
      const at = this.cache.keys().next().value; this.weight -= this.cache.get(at).weight; this.cache.delete(at);
    }
    // Cache owns compressed bytes, never live Wasm backends. Weight is not an RSS limit.
  }
  load(room, key, heads) {
    const cacheKey = `${room}/${key}`; const cached = this.cache.get(cacheKey);
    if (cached && same(cached.heads, heads)) {
      this.metrics.cacheHits++; this.cache.delete(cacheKey); this.cache.set(cacheKey, cached); return this.own(A.load(cached.body));
    }
    this.metrics.documentLoads++;
    let cp = this.prepare(`${reach} SELECT cp.* FROM shard_checkpoints cp WHERE cp.room=? AND cp.doc=?
      AND NOT EXISTS(SELECT 1 FROM json_each(cp.heads) h WHERE h.value NOT IN (SELECT hash FROM wanted))
      ORDER BY cp.seq DESC LIMIT 1`).get(JSON.stringify(heads), room, key, room, key);
    let doc = this.own(A.init());
    if (cp) {
      try {
        if (checksum(cp.body) !== cp.checksum) throw new Error('Invalid checkpoint checksum');
        doc = this.own(A.load(new Uint8Array(cp.body)));
        if (!same(A.getHeads(doc), JSON.parse(cp.heads))) throw new Error('Invalid checkpoint frontier');
        this.metrics.checkpointLoads++;
      } catch {
        this.metrics.corruptCheckpoints++; this.prepare('DELETE FROM shard_checkpoints WHERE seq=?').run(cp.seq); cp = null; doc = this.own(A.init());
      }
    }
    const covered = cp ? cp.heads : '[]';
    const rows = this.prepare(`${reach}, covered(hash) AS (
      SELECT value FROM json_each(?) UNION SELECT dep.value FROM covered w
      CROSS JOIN shard_changes c CROSS JOIN json_each(c.deps) dep WHERE c.room=? AND c.doc=? AND c.hash=w.hash
    ) SELECT c.body FROM shard_changes c JOIN wanted w ON w.hash=c.hash
      WHERE c.room=? AND c.doc=? AND c.hash NOT IN (SELECT hash FROM covered) ORDER BY c.seq`)
      .all(JSON.stringify(heads), room, key, covered, room, key, room, key);
    [doc] = A.applyChanges(doc, rows.map(r => new Uint8Array(r.body))); this.metrics.replayedChanges += rows.length;
    if (A.getMissingDeps(doc).length || !same(A.getHeads(doc), heads) || doc.room !== room || doc.document !== key) throw new Error('Incomplete or invalid shard history');
    const stats = this.prepare('SELECT bytes FROM shard_doc_stats WHERE room=? AND doc=?').get(room, key);
    this.remember(room, key, doc, (stats?.bytes ?? 0) + Buffer.byteLength(JSON.stringify(doc)));
    return A.view(doc, A.getHeads(doc));
  }
  persist(room, key, doc, previous) {
    const changes = previous ? A.getChanges(previous, doc) : A.getAllChanges(doc);
    this.insert(room, key, changes);
    const stats = this.prepare('SELECT * FROM shard_doc_stats WHERE room=? AND doc=?').get(room, key);
    if (this.checkpointEvery && stats.changes_count - stats.checkpoint_count >= this.checkpointEvery) this.checkpoint(room, key, doc);
    this.remember(room, key, doc, stats.bytes + Buffer.byteLength(JSON.stringify(doc)));
    return sorted(A.getHeads(doc));
  }
  insert(room, key, changes) {
    const insert = this.prepare('INSERT OR IGNORE INTO shard_changes(room,doc,hash,deps,body) VALUES(?,?,?,?,?)');
    let count = 0; let bytes = 0;
    for (const body of changes) {
      const change = A.decodeChange(body);
      if (insert.run(room, key, change.hash, JSON.stringify(change.deps), body).changes) { count++; bytes += body.length; }
    }
    this.prepare(`INSERT INTO shard_doc_stats(room,doc,changes_count,bytes) VALUES(?,?,?,?)
      ON CONFLICT(room,doc) DO UPDATE SET changes_count=changes_count+excluded.changes_count,bytes=bytes+excluded.bytes`)
      .run(room, key, count, bytes);
  }
  checkpoint(room, key, doc) {
    const copy = A.clone(doc); let body;
    try { body = A.save(copy); } finally { A.free(copy); }
    const heads = JSON.stringify(sorted(A.getHeads(doc)));
    this.prepare('INSERT OR IGNORE INTO shard_checkpoints(room,doc,heads,body,checksum) VALUES(?,?,?,?,?)')
      .run(room, key, heads, body, checksum(body));
    this.prepare('UPDATE shard_doc_stats SET checkpoint_count=changes_count WHERE room=? AND doc=?').run(room, key);
    this.pruneCheckpoints(room, key);
    return body.length;
  }
  pruneCheckpoints(room, key) {
    if (!this.checkpointKeep) return 0;
    return this.prepare(`DELETE FROM shard_checkpoints WHERE room=? AND doc=? AND seq NOT IN
      (SELECT seq FROM shard_checkpoints WHERE room=? AND doc=? ORDER BY seq DESC LIMIT ?)`)
      .run(room, key, room, key, this.checkpointKeep).changes;
  }
}
