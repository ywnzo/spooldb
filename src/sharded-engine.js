import * as A from '@automerge/automerge';
import { randomUUID } from 'node:crypto';
import { LegacyEngine, check, text, id, position, noSplitSurrogate, same, content, validatePath } from './legacy-engine.js';
import { digest, validateEvent } from './adapters/contract.js';
import { Manifest } from './storage/manifest.js';
import { Documents } from './storage/documents.js';
import { pack, unpack } from './storage/codec.js';
const plain = value => JSON.parse(JSON.stringify(value));
const sorted = heads => [...new Set(heads)].sort();
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const order = ([a], [b]) => a < b ? -1 : a > b ? 1 : 0;
const reachable = `WITH RECURSIVE reachable(id) AS (
  SELECT value FROM json_each(?) UNION SELECT p.value FROM reachable r
  CROSS JOIN shard_batches b CROSS JOIN json_each(b.parents) p WHERE b.room=? AND b.id=r.id
)`;

export class ShardedEngine extends LegacyEngine {
  constructor(filename = ':memory:', options = {}) {
    super(filename, { ...options, _sharded: true }); this.layout = 'sharded'; this.queries = new Map();
    if (this.prepare('SELECT 1 FROM refs LIMIT 1').get()) { this.db.close(); throw new Error('Use a separate database for sharded storage; legacy data is not migrated'); }
    this.db.exec(`CREATE TABLE IF NOT EXISTS shard_refs(name TEXT PRIMARY KEY,room TEXT NOT NULL,heads TEXT NOT NULL,root TEXT);
      CREATE TABLE IF NOT EXISTS shard_batches(seq INTEGER PRIMARY KEY,room TEXT NOT NULL,id TEXT NOT NULL,
      parents TEXT NOT NULL,root TEXT,body TEXT NOT NULL,UNIQUE(room,id));
      CREATE TABLE IF NOT EXISTS shard_versions(room TEXT NOT NULL,frontier TEXT NOT NULL,root TEXT,PRIMARY KEY(room,frontier));
      CREATE TABLE IF NOT EXISTS shard_receipts(branch TEXT NOT NULL,request_id TEXT NOT NULL,input TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(branch,request_id));
      CREATE TABLE IF NOT EXISTS shard_batch_files(room TEXT NOT NULL,file_id TEXT NOT NULL,batch TEXT NOT NULL,PRIMARY KEY(room,file_id,batch));`);
    this.manifest = new Manifest(this.db); this.documents = new Documents(this.db, options);
    // Every public operation returns plain data; its temporary Wasm handles can
    // be released synchronously instead of waiting for JS finalizers.
    for (const name of ['read', 'readFile', 'listFiles', 'readRecords', 'submit', 'fork', 'merge', 'history', 'trace', 'anchor', 'resolve', 'checkpoint', 'export', 'exportPage', 'import']) {
      const method = this[name].bind(this); this[name] = (...args) => this.documents.scope(() => method(...args));
    }
  }
  prepare(sql) { if (!this.queries.has(sql)) this.queries.set(sql, this.db.prepare(sql)); return this.queries.get(sql); }
  transaction(fn) {
    this.manifest?.begin();
    try {
      const result = super.transaction(() => { const value = fn(); this.manifest?.flush(); return value; });
      this.manifest?.commit(); return result;
    } catch (error) { this.documents?.clear(); this.manifest?.rollback(); throw error; }
  }
  close() { this.documents.clear(); this.manifest.cache.clear(); super.close(); }
  load() { throw new Error('Sharded rooms have no monolithic CRDT; use readFile or readRecords'); }
  ref(branch) {
    id(branch, 'branch'); const row = this.prepare('SELECT * FROM shard_refs WHERE name=?').get(branch);
    check(row, 'Unknown branch'); return { ...row, heads: JSON.parse(row.heads) };
  }
  refs() { return this.prepare('SELECT * FROM shard_refs ORDER BY name').all().map(r => ({ branch: r.name, room: r.room, heads: JSON.parse(r.heads) })); }
  publish(branch, room, heads, root) {
    this.manifest.retain(root);
    heads = sorted(heads);
    this.prepare(`INSERT INTO shard_refs VALUES(?,?,?,?) ON CONFLICT(name) DO UPDATE SET heads=excluded.heads,root=excluded.root`)
      .run(branch, room, JSON.stringify(heads), root);
    this.prepare('INSERT OR IGNORE INTO shard_versions VALUES(?,?,?)').run(room, JSON.stringify(heads), root);
    return { branch, room, heads };
  }
  putBatch(batch) {
    this.manifest.retain(batch.root);
    const hash = digest(batch);
    this.prepare('INSERT OR IGNORE INTO shard_batches(room,id,parents,root,body) VALUES(?,?,?,?,?)')
      .run(batch.room, hash, JSON.stringify(batch.parents), batch.root, pack(batch));
    for (const fileId of batch.metadata?.fileIds ?? []) this.prepare('INSERT OR IGNORE INTO shard_batch_files VALUES(?,?,?)').run(batch.room, fileId, hash);
    return hash;
  }
  create(branch = 'main', {room = randomUUID()} = {}) {
    id(room, 'room'); id(branch, 'branch'); return this.transaction(() => {
      check(!this.prepare('SELECT 1 FROM shard_refs WHERE name=?').get(branch), 'Branch already exists');
      const batch = { schema: 2, room, parents: [], root: null, metadata: null, updates: [] };
      return this.publish(branch, room, [this.putBatch(batch)], null);
    });
  }
  batches(room, heads) {
    for (const hash of heads) check(this.prepare('SELECT 1 FROM shard_batches WHERE room=? AND id=?').get(room, hash), 'Unknown or missing global heads');
    return this.prepare(`${reachable} SELECT b.* FROM shard_batches b JOIN reachable r ON r.id=b.id WHERE b.room=? ORDER BY b.seq`)
      .all(JSON.stringify(heads), room, room);
  }
  minimal(room, heads) {
    heads = sorted(heads);
    if (heads.length <= 1) {
      if (heads.length) check(this.prepare('SELECT 1 FROM shard_batches WHERE room=? AND id=?').get(room, heads[0]), 'Unknown or missing global heads');
      return heads;
    }
    const ancestors = new Set();
    for (const hash of heads) for (const row of this.batches(room, [hash])) if (row.id !== hash) ancestors.add(row.id);
    return heads.filter(h => !ancestors.has(h));
  }
  descriptor(key, doc) {
    const value = { heads: sorted(A.getHeads(doc)) };
    if (key.startsWith('f:')) {
      const f = doc.files[key.slice(2)]; check(f, 'File shard is missing its file');
      value.path = f.path; value.deleted = f.deleted;
    }
    return value;
  }
  pathIndex(root, path, fileId, add) {
    const key = `p:${path}`; const values = new Set(this.manifest.get(root, key)?.files ?? []);
    if (add) values.add(fileId); else values.delete(fileId);
    return this.manifest.set(root, key, values.size ? { files: [...values].sort() } : null);
  }
  setDescriptor(root, key, descriptor) {
    const previous = this.manifest.get(root, key);
    if (key.startsWith('f:') && (!previous || previous.path !== descriptor.path || previous.deleted !== descriptor.deleted)) {
      if (previous && !previous.deleted) root = this.pathIndex(root, previous.path, key.slice(2), false);
      if (!descriptor.deleted) root = this.pathIndex(root, descriptor.path, key.slice(2), true);
    }
    return this.manifest.set(root, key, descriptor);
  }
  frontier(room, requested) {
    const heads = this.minimal(room, requested); const frontier = JSON.stringify(heads);
    const cached = this.prepare('SELECT root FROM shard_versions WHERE room=? AND frontier=?').get(room, frontier);
    if (cached) return { room, heads, root: cached.root };
    if (!heads.length) return { room, heads, root: null };
    const roots = heads.map(hash => this.prepare('SELECT root FROM shard_batches WHERE room=? AND id=?').get(room, hash).root);
    let root = roots[0];
    for (const source of roots.slice(1)) for (const [key, incoming] of this.manifest.entries(source)) {
      if (key.startsWith('p:')) continue;
      const current = this.manifest.get(root, key);
      if (current && equal(current.heads, incoming.heads)) continue;
      let value = incoming;
      if (current) {
        const left = this.documents.load(room, key, current.heads); const right = this.documents.load(room, key, incoming.heads);
        const merged = A.merge(this.documents.clone(left), right); value = this.descriptor(key, merged);
        this.documents.release(left); this.documents.release(right); this.documents.release(merged);
      }
      root = this.setDescriptor(root, key, value);
    }
    this.manifest.retain(root);
    this.prepare('INSERT OR IGNORE INTO shard_versions VALUES(?,?,?)').run(room, frontier, root);
    return { room, heads, root };
  }
  version(branch, heads) {
    const ref = this.ref(branch);
    if (heads === undefined) return ref;
    check(Array.isArray(heads) && heads.length > 0, 'A global version must include the room genesis');
    return this.frontier(ref.room, heads);
  }
  doc(version, key) {
    const descriptor = this.manifest.get(version.root, key); check(descriptor, 'Unknown document');
    return this.documents.load(version.room, key, descriptor.heads);
  }
  conflicts(doc, field, key) {
    const conflicts = []; const value = doc[field][key]; const entities = A.getConflicts(doc[field], key);
    if (entities && Object.keys(entities).length > 1) conflicts.push({ type: 'concurrent-entity', key, values: plain(entities) });
    if (field === 'files') for (const name of ['path', 'deleted', 'kind', 'mode', 'data', 'target']) {
      const values = A.getConflicts(value, name);
      if (values && Object.keys(values).length > 1) conflicts.push({ type: 'concurrent-metadata', fileId: key, field: name, values: plain(values) });
    }
    return conflicts;
  }
  readFile(branch, fileId, heads) {
    id(fileId, 'fileId'); const version = this.version(branch, heads); const doc = this.doc(version, `f:${fileId}`);
    const f = { fileId, ...plain(doc.files[fileId]) }; const conflicts = this.conflicts(doc, 'files', fileId);
    const peers = this.manifest.get(version.root, `p:${f.path}`)?.files ?? [];
    if (!f.deleted && peers.length > 1) conflicts.push({ type: 'path-collision', path: f.path, fileIds: peers });
    return { room: version.room, heads: version.heads, file: f, conflicts };
  }
  read(branch, heads) {
    const version = this.version(branch, heads);
    const state = { room: version.room, heads: version.heads, files: [], messages: {}, comments: {}, adapterEvents: {}, conflicts: [] };
    for (const [key] of [...this.manifest.entries(version.root)].sort(order)) {
      if (key.startsWith('p:')) continue;
      const field = { f: 'files', m: 'messages', c: 'comments', a: 'adapterEvents' }[key[0]];
      const doc = this.doc(version, key); const entity = key.slice(2);
      if (field === 'files') state.files.push({ fileId: entity, ...plain(doc.files[entity]) });
      else state[field][entity] = plain(doc[field][entity]);
      state.conflicts.push(...this.conflicts(doc, field, entity));
      this.documents.release(doc);
    }
    for (const [key, value] of this.manifest.entries(version.root)) if (key.startsWith('p:') && value.files.length > 1) state.conflicts.push({ type: 'path-collision', path: key.slice(2), fileIds: value.files });
    return state;
  }
  listFiles(branch, { after = '', limit = 100, includeDeleted = false } = {}) {
    check(Number.isSafeInteger(limit) && limit > 0 && limit <= 1000, 'Invalid page limit'); const version = this.version(branch);
    const entries = [...this.manifest.entries(version.root)].filter(([key, value]) => key.startsWith('f:') && key.slice(2) > after && (includeDeleted || !value.deleted)).sort(order);
    const files = entries.slice(0, limit).map(([key, value]) => ({ fileId: key.slice(2), path: value.path, deleted: value.deleted }));
    return { room: version.room, heads: version.heads, files, nextCursor: entries.length > limit ? files.at(-1).fileId : null };
  }
  readRecords(branch, { kind = 'messages', after = '', limit = 100, byteLimit = 8 * 1024 * 1024 } = {}) {
    const prefix = { messages: 'm:', comments: 'c:', adapterEvents: 'a:' }[kind]; check(prefix, 'Invalid record kind');
    check(Number.isSafeInteger(limit) && limit > 0 && limit <= 1000, 'Invalid page limit'); const version = this.version(branch);
    check(Number.isSafeInteger(byteLimit) && byteLimit > 0 && byteLimit <= 16 * 1024 * 1024, 'Invalid page byte limit');
    const entries = [...this.manifest.entries(version.root)].filter(([key]) => key.startsWith(prefix) && key.slice(2) > after).sort(order);
    const records = []; let bytes = 0;
    for (const [key] of entries.slice(0, limit)) {
      const doc = this.doc(version, key); const result = { id: key.slice(2), value: plain(doc[kind][key.slice(2)]) };
      this.documents.release(doc); const size = Buffer.byteLength(JSON.stringify(result));
      if (bytes + size > byteLimit) { check(records.length > 0, 'Record exceeds page byte limit'); break; }
      records.push(result); bytes += size;
    }
    return { room: version.room, heads: version.heads, records, bytes, nextCursor: entries.length > records.length ? records.at(-1).id : null };
  }
  submit(branch, input) {
    check(input && typeof input === 'object', 'Invalid submission'); id(input.actor, 'actor'); id(input.requestId, 'requestId');
    check(Array.isArray(input.operations) && input.operations.length && input.operations.length <= 10000, 'Expected 1–10000 operations');
    check(Array.isArray(input.expectedHeads), 'expectedHeads is required; read before writing');
    const encoded = JSON.stringify(input); check(encoded.length <= 16_000_000, 'Submission too large');
    return this.transaction(() => {
      const receipt = this.prepare('SELECT * FROM shard_receipts WHERE branch=? AND request_id=?').get(branch, input.requestId);
      if (receipt) { check(JSON.stringify(unpack(receipt.input)) === encoded, 'Request ID reused with different input'); return JSON.parse(receipt.result); }
      const ref = this.ref(branch); check(same(ref.heads, input.expectedHeads), 'Stale heads; read again or edit an offline branch and merge');
      const eventId = randomUUID();
      const metadata = { eventId, actor: input.actor, harness: text(input.harness ?? 'generic', 'harness', 200), observedAt: new Date().toISOString(),
        operationTypes: input.operations.map(op => op.type), fileIds: [...new Set(input.operations.flatMap(op => op.fileId ? [op.fileId] : []))],
        messageIds: input.operations.flatMap(op => op.type === 'message.add' ? [op.messageId] : []) };
      for (const name of ['sessionId', 'turnId', 'messageId', 'toolCallId', 'evidence', 'gitCommit', 'sourceEventId', 'observedAfter']) if (input[name] !== undefined) metadata[name] = text(input[name], name, 200);
      let root = ref.root; const working = new Map(); const remaining = new Map(); const updated = new Map();
      for (const op of input.operations) {
        const key = op.type.startsWith('file.') ? `f:${op.fileId}` : op.type === 'message.add' ? `m:${op.messageId}` : op.type === 'adapter.record' ? `a:${op.event?.eventId}` : `c:${op.commentId}`;
        remaining.set(key, (remaining.get(key) ?? 0) + 1);
      }
      const edit = key => {
        if (!working.has(key)) {
          const descriptor = this.manifest.get(root, key); const previous = descriptor ? this.documents.load(ref.room, key, descriptor.heads) : null;
          const source = previous ?? this.documents.seed(ref.room, key); const doc = this.documents.clone(source);
          if (!previous) this.documents.release(source);
          working.set(key, { previous, doc });
        }
        return working.get(key);
      };
      let operationNumber = 0;
      for (const op of input.operations) {
        let key;
        if (op.type.startsWith('file.')) { id(op.fileId, 'fileId'); key = `f:${op.fileId}`; }
        else if (op.type === 'message.add') { id(op.messageId); key = `m:${op.messageId}`; }
        else if (op.type === 'adapter.record') { validateEvent(op.event); key = `a:${op.event.eventId}`; }
        else if (op.type === 'comment.add') { id(op.commentId); key = `c:${op.commentId}`; }
        else throw new Error('Unknown operation type');
        if (op.type === 'file.create' || op.type === 'file.rename') {
          validatePath(op.path); const peers = this.manifest.get(root, `p:${op.path}`)?.files ?? [];
          check(!peers.some(peer => peer !== op.fileId), 'Path already exists');
        }
        const entry = edit(key);
        if (op.type === 'comment.add') {
          id(op.fileId, 'fileId'); const fkey = `f:${op.fileId}`;
          const fileDoc = working.get(fkey)?.doc ?? this.doc({ ...ref, root }, fkey); const f = fileDoc.files[op.fileId];
          check(f && !f.deleted, 'Unknown or deleted file'); position(op.start, f.text.length); position(op.end, f.text.length);
          check(op.start <= op.end, 'Invalid comment range'); noSplitSurrogate(f.text, op.start); noSplitSurrogate(f.text, op.end);
          const comment = { fileId: op.fileId, text: text(op.text, 'comment'), eventId,
            start: A.getCursor(fileDoc, ['files', op.fileId, 'text'], op.start), end: A.getCursor(fileDoc, ['files', op.fileId, 'text'], op.end) };
          if (!working.has(fkey)) this.documents.release(fileDoc);
          entry.doc = A.change(entry.doc, { message: eventId }, d => { check(!Object.hasOwn(d.comments, op.commentId), 'Comment ID already exists'); d.comments[op.commentId] = comment; });
        } else entry.doc = A.change(entry.doc, { message: eventId }, d => this.apply(d, op, eventId));
        // Text-only intermediate frontiers are private to this atomic batch.
        // Publish their descriptor only at the last operation on the shard.
        // Path/deletion changes remain visible immediately for later checks.
        if (remaining.get(key) === 1 || ['file.create', 'file.rename', 'file.delete', 'file.restore'].includes(op.type)) {
          root = this.setDescriptor(root, key, this.descriptor(key, entry.doc));
        }
        remaining.set(key, remaining.get(key) - 1);
        if (remaining.get(key) === 0) {
          updated.set(key, this.documents.persist(ref.room, key, entry.doc, entry.previous));
          this.documents.release(entry.doc); if (entry.previous) this.documents.release(entry.previous);
          working.delete(key);
        }
        if (++operationNumber % 1000 === 0) this.manifest.discardIntermediate(root);
      }
      const updates = [...updated].sort(order);
      const batch = { schema: 2, room: ref.room, parents: ref.heads, root, metadata, updates };
      const result = { ...this.publish(branch, ref.room, [this.putBatch(batch)], root), eventId };
      this.prepare('INSERT INTO shard_receipts VALUES(?,?,?,?)').run(branch, input.requestId, pack(input), JSON.stringify(result)); return result;
    });
  }
  fork(source, target, heads) {
    id(target, 'branch'); return this.transaction(() => {
      check(!this.prepare('SELECT 1 FROM shard_refs WHERE name=?').get(target), 'Branch already exists');
      const version = this.version(source, heads); return this.publish(target, version.room, version.heads, version.root);
    });
  }
  merge(target, source) {
    return this.transaction(() => {
      const left = this.ref(target); const right = this.ref(source); check(left.room === right.room, 'Cannot merge unrelated rooms');
      const version = this.frontier(left.room, [...left.heads, ...right.heads]); return this.publish(target, left.room, version.heads, version.root);
    });
  }
  history(branch, { after = 0, limit = 100 } = {}) {
    check(Number.isSafeInteger(after) && after >= 0 && Number.isSafeInteger(limit) && limit > 0 && limit <= 1000, 'Invalid pagination'); const ref = this.ref(branch);
    return this.prepare(`${reachable} SELECT b.* FROM shard_batches b JOIN reachable r ON r.id=b.id
      WHERE b.room=? AND b.seq>? ORDER BY b.seq LIMIT ?`).all(JSON.stringify(ref.heads), ref.room, ref.room, after, limit)
      .map(row => ({ cursor: row.seq, changeId: row.id, parents: JSON.parse(row.parents), provenance: unpack(row.body).metadata }));
  }
  trace(branch, fileId) {
    id(fileId); const version = this.version(branch); check(this.manifest.get(version.root, `f:${fileId}`), 'Unknown file');
    return this.prepare(`${reachable} SELECT b.* FROM shard_batches b JOIN reachable r ON r.id=b.id
      JOIN shard_batch_files f ON f.room=b.room AND f.batch=b.id WHERE b.room=? AND f.file_id=? ORDER BY b.seq`)
      .all(JSON.stringify(version.heads), version.room, version.room, fileId).map(row => {
        const provenance = unpack(row.body).metadata;
        const messages = [...new Set([...provenance.messageIds, ...(provenance.messageId ? [provenance.messageId] : [])])]
          .filter(mid => this.manifest.get(version.root, `m:${mid}`)).map(mid => ({ messageId: mid, ...plain(this.doc(version, `m:${mid}`).messages[mid]) }));
        return { changeId: row.id, parents: JSON.parse(row.parents), provenance, messages };
      });
  }
  anchor(branch, fileId, start, end) {
    id(fileId); const version = this.version(branch); const doc = this.doc(version, `f:${fileId}`); const f = doc.files[fileId];
    position(start, f.text.length); position(end, f.text.length); check(start <= end, 'Invalid range');
    noSplitSurrogate(f.text, start); noSplitSurrogate(f.text, end);
    return { room: version.room, fileId, heads: version.heads, start: A.getCursor(doc, ['files', fileId, 'text'], start), end: A.getCursor(doc, ['files', fileId, 'text'], end) };
  }
  resolve(branch, anchor, heads) {
    const version = this.version(branch, heads); check(!anchor.room || anchor.room === version.room, 'Anchor belongs to another room');
    const doc = this.doc(version, `f:${anchor.fileId}`); const f = doc.files[anchor.fileId]; const path = ['files', anchor.fileId, 'text'];
    const start = A.getCursorPosition(doc, path, anchor.start); const end = A.getCursorPosition(doc, path, anchor.end);
    return { fileId: anchor.fileId, path: f.path, deleted: f.deleted, start, end, text: f.text.slice(start, end) };
  }
  checkpoint(branch, { fileId } = {}) {
    return this.transaction(() => {
      const version = this.version(branch); const entries = fileId ? [[`f:${id(fileId)}`, this.manifest.get(version.root, `f:${fileId}`)]]
        : [...this.manifest.entries(version.root)].filter(([key]) => !key.startsWith('p:'));
      let bytes = 0;
      for (const [key, value] of entries) {
        check(value, 'Unknown file'); const doc = this.documents.load(version.room, key, value.heads);
        bytes += this.documents.checkpoint(version.room, key, doc); this.documents.release(doc);
      }
      return { documents: entries.length, bytes, heads: version.heads };
    });
  }
  clearCache() { this.documents.clear(); this.manifest.cache.clear(); }
  compact({ vacuum = false } = {}) {
    check(!this.transactionDepth, 'Compaction requires its own transaction');
    const result = this.transaction(() => {
      // Every committed version is a root, including branches, cached merged
      // frontiers and batches that are no longer the tip of any branch.
      this.db.exec('CREATE TEMP TABLE IF NOT EXISTS live_manifest(hash TEXT PRIMARY KEY); DELETE FROM live_manifest');
      const mark = this.prepare('INSERT OR IGNORE INTO live_manifest VALUES(?)');
      const roots = this.prepare(`SELECT root FROM shard_batches WHERE root IS NOT NULL UNION
        SELECT root FROM shard_versions WHERE root IS NOT NULL UNION SELECT root FROM shard_refs WHERE root IS NOT NULL`).all();
      for (const { root } of roots) {
        const stack = [root];
        while (stack.length) {
          const hash = stack.pop(); if (!hash || !mark.run(hash).changes) continue;
          const node = this.manifest.node(hash); if (node.children) stack.push(...node.children);
        }
      }
      const removedNodes = this.prepare('DELETE FROM shard_nodes WHERE hash NOT IN (SELECT hash FROM live_manifest)').run().changes;
      let encodedRows = 0;
      for (const [table, key, column] of [['shard_nodes','hash','body'], ['shard_batches','seq','body'], ['shard_receipts','rowid','input']]) {
        const update = this.prepare(`UPDATE ${table} SET ${column}=? WHERE ${key}=?`);
        // Materialize a bounded page before updating the table being scanned.
        let cursor = null;
        while (true) {
          const rows = cursor === null
            ? this.prepare(`SELECT ${key} AS k,${column} AS v FROM ${table} ORDER BY ${key} LIMIT 256`).all()
            : this.prepare(`SELECT ${key} AS k,${column} AS v FROM ${table} WHERE ${key}>? ORDER BY ${key} LIMIT 256`).all(cursor);
          if (!rows.length) break;
          for (const row of rows) {
            if (typeof row.v === 'string') { const body = pack(unpack(row.v)); if (typeof body !== 'string') { update.run(body,row.k); encodedRows++; } }
          }
          cursor = rows.at(-1).k;
        }
      }
      let removedCheckpoints = 0;
      for (const { room,doc } of this.prepare('SELECT DISTINCT room,doc FROM shard_checkpoints').all()) removedCheckpoints += this.documents.pruneCheckpoints(room,doc);
      this.db.exec('DELETE FROM live_manifest');
      return { removedNodes, encodedRows, removedCheckpoints };
    });
    this.clearCache();
    if (vacuum) this.db.exec('VACUUM');
    const wal = this.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    return { ...result, vacuum, walBusy: Boolean(wal.busy) };
  }
  storageStats({ resetMetrics = false } = {}) {
    const result = { layout: this.layout, ...this.documents.metrics, activeDocumentHandles: this.documents.owned.size, cacheEntries: this.documents.cache.size, cacheWeightBytes: this.documents.weight,
      cacheWeightLimit: this.documents.cacheBytes, cacheEntryLimit: this.documents.cacheEntries,
      documents: this.prepare('SELECT count(*) AS n FROM shard_doc_stats').get().n,
      changes: this.prepare('SELECT count(*) AS n FROM shard_changes').get().n,
      checkpoints: this.prepare('SELECT count(*) AS n FROM shard_checkpoints').get().n,
      manifestNodes: this.prepare('SELECT count(*) AS n FROM shard_nodes').get().n,
      batches: this.prepare('SELECT count(*) AS n FROM shard_batches').get().n };
    if (resetMetrics) this.documents.resetMetrics(); return result;
  }
  export(branch, since = [], { heads } = {}) {
    const ref = this.version(branch, heads); const current = this.frontier(ref.room, ref.heads); const old = this.frontier(ref.room, since);
    const rows = this.batches(ref.room, ref.heads); const all = new Set(rows.map(r => r.id)); check(since.every(h => all.has(h)), 'since is not an ancestor of this branch');
    const previous = this.batches(ref.room, since); const known = new Set(previous.map(r => r.id));
    const batches = rows.filter(r => !known.has(r.id)).map(r => ({ id: r.id, ...unpack(r.body) }));
    const knownNodes = new Set(); for (const row of previous) this.manifest.hashes(row.root, knownNodes);
    const nodes = new Set(); for (const batch of batches) this.manifest.hashes(batch.root, nodes);
    const documents = []; const keys = new Set(batches.flatMap(b => b.updates.map(([key]) => key)));
    for (const key of [...keys].sort()) {
      const after = this.doc(current, key); const before = this.manifest.get(old.root, key);
      const changes = before ? A.getChanges(A.view(after, before.heads), after) : A.getAllChanges(after);
      if (changes.length) documents.push({ key, changes: changes.map(bytes => Buffer.from(bytes).toString('base64')) });
      this.documents.release(after);
    }
    const bundle = { protocol: 'spool/2', schema: 2, room: ref.room, heads: ref.heads, batches,
      nodes: [...nodes].filter(hash => !knownNodes.has(hash)).sort().map(hash => ({ hash, node: plain(this.manifest.node(hash)) })), documents };
    check(JSON.stringify(bundle).length <= 16_000_000, 'Bundle exceeds 16 MB; use smaller incremental intervals'); return bundle;
  }
  exportPage(branch, since = [], { heads, limit = 32, maxBytes = 4 * 1024 * 1024 } = {}) {
    check(Number.isSafeInteger(limit) && limit > 0 && limit <= 128, 'Invalid sync page limit');
    check(Number.isSafeInteger(maxBytes) && maxBytes >= 1024 && maxBytes <= 8 * 1024 * 1024, 'Invalid sync byte limit');
    check(Array.isArray(since) && since.length <= 128, 'Invalid sync frontier');
    const ref = this.version(branch, heads);const rows = this.batches(ref.room,ref.heads);const all = new Set(rows.map(r=>r.id));
    check(since.every(h=>all.has(h)), 'Sync base is not an ancestor of target');
    const known = new Set(this.batches(ref.room,since).map(r=>r.id));const missing = rows.filter(r=>!known.has(r.id));
    if (!missing.length) return { bundle:null,heads:ref.heads,more:false,bytes:0 };
    let count = Math.min(limit,missing.length);
    while (true) {
      const tip = new Set(this.minimal(ref.room,since));
      for (const row of missing.slice(0,count)) { for (const parent of JSON.parse(row.parents)) tip.delete(parent);tip.add(row.id); }
      const frontier = [...tip].sort();
      if (!frontier.length) return { bundle:null,heads:ref.heads,more:false,bytes:0 };
      let bundle;
      try { bundle = this.export(branch,since,{ heads:frontier }); }
      catch (error) { if (!/Bundle exceeds/.test(error.message)) throw error; }
      const bytes = bundle ? Buffer.byteLength(JSON.stringify(bundle)) : Infinity;
      if (bytes <= maxBytes) return { bundle,heads:ref.heads,more:count<missing.length,bytes };
      check(count > 1,'One atomic batch exceeds the sync page byte limit');count = Math.max(1,Math.floor(count/2));
    }
  }
  import(branch, bundle) {
    id(branch, 'branch'); check(bundle && JSON.stringify(bundle).length <= 16_000_000, 'Bundle too large');
    check(bundle.protocol === 'spool/2' && bundle.schema === 2, 'Sharded storage requires protocol spool/2'); id(bundle.room, 'room');
    check(Array.isArray(bundle.batches) && Array.isArray(bundle.nodes) && Array.isArray(bundle.documents) && Array.isArray(bundle.heads) && bundle.heads.length > 0, 'Invalid bundle');
    return this.transaction(() => {
      const previous = this.prepare('SELECT * FROM shard_refs WHERE name=?').get(branch); check(!previous || previous.room === bundle.room, 'Cannot import unrelated room');
      for (const entry of bundle.nodes) { check(digest(entry.node) === entry.hash, 'Invalid manifest hash'); this.manifest.put(entry.node); }
      for (const entry of bundle.documents) {
        this.validateKey(entry.key); this.documents.insert(bundle.room, entry.key, entry.changes.map(value => {
          check(typeof value === 'string' && Buffer.from(value, 'base64').toString('base64') === value, 'Invalid base64'); return new Uint8Array(Buffer.from(value, 'base64'));
        }));
      }
      for (const entry of bundle.batches) {
        const { id: hash, ...batch } = entry; check(digest(batch) === hash && batch.room === bundle.room && batch.schema === 2, 'Invalid batch hash or room');
        check(Array.isArray(batch.parents) && Array.isArray(batch.updates), 'Invalid batch');
        if (this.prepare('SELECT 1 FROM shard_batches WHERE room=? AND id=?').get(bundle.room, hash)) continue;
        let root = this.frontier(bundle.room, batch.parents).root;
        if (!batch.parents.length) check(batch.metadata === null && batch.updates.length === 0 && batch.root === null, 'Invalid genesis');
        for (const [key, heads] of batch.updates) {
          this.validateKey(key); check(Array.isArray(heads) && heads.length > 0, 'Invalid shard heads');
          const doc = this.documents.load(bundle.room, key, heads); this.validateDoc(key, doc); root = this.setDescriptor(root, key, this.descriptor(key, doc));
          this.documents.release(doc);
        }
        check(root === batch.root, 'Batch manifest does not match its atomic updates'); this.putBatch(batch);
      }
      const version = this.frontier(bundle.room, [...(previous ? JSON.parse(previous.heads) : []), ...bundle.heads]);
      return this.publish(branch, bundle.room, version.heads, version.root);
    });
  }
  validateKey(key) { check(typeof key === 'string' && /^[fmca]:/.test(key), 'Invalid document key'); id(key.slice(2)); }
  validateDoc(key, doc) {
    const entity = key.slice(2);
    if (key.startsWith('f:')) { const f = doc.files[entity]; check(f, 'Invalid file document'); validatePath(f.path); content(f); }
    if (key.startsWith('a:')) { validateEvent(doc.adapterEvents[entity]); check(doc.adapterEvents[entity].eventId === entity, 'Invalid adapter identity'); }
    if (key.startsWith('m:')) { const m = doc.messages[entity]; check(m && ['user', 'assistant', 'tool', 'system'].includes(m.role), 'Invalid message'); text(m.text, 'message'); }
    if (key.startsWith('c:')) { const c = doc.comments[entity]; check(c && typeof c.start === 'string' && typeof c.end === 'string', 'Invalid comment'); id(c.fileId); text(c.text, 'comment'); }
  }
}
