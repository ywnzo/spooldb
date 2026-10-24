import * as A from '@automerge/automerge';
import { DatabaseSync } from '#spool-sqlite';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { validateEvent } from './adapters/contract.js';

const MAX_TEXT = 1_000_000;
const MAX_BUNDLE = 16_000_000;
const own = (object, key) => Object.hasOwn(object, key);
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
function check(ok, message) { if (!ok) throw new Error(message); }
function text(value, label, max = MAX_TEXT) {
  check(typeof value === 'string' && value.length <= max, `Invalid ${label}`);
  return value;
}
function id(value, label = 'id') {
  text(value, label, 200);
  check(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value), `Invalid ${label}`);
  return value;
}
function path(value) {
  text(value, 'path', 4096);
  check(value.length > 0 && !value.startsWith('/') && !value.includes('\\') &&
    !/[\x00-\x1f:]/.test(value) && value.split('/').every(p => p && p !== '.' && p !== '..' && p.toLowerCase() !== '.git'), 'Unsafe file path');
  return value;
}
function file(doc, fileId) {
  id(fileId, 'fileId');
  check(own(doc.files, fileId), 'Unknown file');
  return doc.files[fileId];
}
function position(value, length) {
  check(Number.isSafeInteger(value) && value >= 0 && value <= length, 'Invalid text offset');
}
function noSplitSurrogate(value, offset) {
  check(!(offset > 0 && offset < value.length && /[\uD800-\uDBFF]/.test(value[offset - 1]) &&
    /[\uDC00-\uDFFF]/.test(value[offset])), 'Offset splits a Unicode surrogate pair');
}
export { path as validatePath };
export function content(op) {
  const kind = op.kind ?? 'text';
  check(['text', 'binary', 'symlink'].includes(kind), 'Invalid file kind');
  const mode = op.mode ?? 420;
  check(mode === 420 || mode === 493, 'Invalid file mode');
  const value = { kind, mode, text: kind === 'text' ? text(op.text, 'text') : '', data: '', target: '' };
  if (kind === 'binary') {
    text(op.data, 'binary data', 1_400_000);
    check(Buffer.from(op.data, 'base64').toString('base64') === op.data && Buffer.from(op.data, 'base64').length <= MAX_TEXT, 'Invalid binary data');
    value.data = op.data;
  }
  if (kind === 'symlink') {
    value.target = text(op.target, 'symlink target', 4096);
    check(value.target.length > 0 && !value.target.includes('\0'), 'Invalid symlink target');
  }
  return value;
}

// Local, trusted-process API. No network listener or execution of harness commands.
export class LegacyEngine {
  constructor(filename = ':memory:', options = {}) {
    this.layout = 'legacy';
    this.filename = filename === ':memory:' ? null : resolve(filename);
    this.db = options.database ?? new DatabaseSync(filename);
    if (!options._sharded && this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='shard_refs'").get()) {
      this.db.close(); throw new Error('This database uses sharded storage; open with layout: sharded');
    }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS changes (
        seq INTEGER PRIMARY KEY, room TEXT NOT NULL, hash TEXT NOT NULL,
        deps TEXT NOT NULL, body BLOB NOT NULL, UNIQUE(room, hash));
      CREATE TABLE IF NOT EXISTS refs (
        name TEXT PRIMARY KEY, room TEXT NOT NULL, heads TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts (
        branch TEXT NOT NULL, request_id TEXT NOT NULL, input TEXT NOT NULL,
        result TEXT NOT NULL, PRIMARY KEY(branch, request_id));`);
  }
  close() { this.db.close(); }
  transaction(fn) {
    if (this.db.transaction) return this.db.transaction(fn);
    if (this.transactionDepth) {
      const savepoint = `nested_${this.transactionDepth++}`;
      this.db.exec(`SAVEPOINT ${savepoint}`);
      try { const result = fn(); this.db.exec(`RELEASE ${savepoint}`); return result; }
      catch (error) { this.db.exec(`ROLLBACK TO ${savepoint}`); this.db.exec(`RELEASE ${savepoint}`); throw error; }
      finally { this.transactionDepth--; }
    }
    this.db.exec('BEGIN IMMEDIATE');
    this.transactionDepth = 1;
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.transactionDepth = 0; }
  }
  ref(branch) {
    id(branch, 'branch');
    const row = this.db.prepare('SELECT * FROM refs WHERE name=?').get(branch);
    check(row, 'Unknown branch');
    return { ...row, heads: JSON.parse(row.heads) };
  }
  load(branch) {
    const ref = this.ref(branch);
    const rows = this.db.prepare(`WITH RECURSIVE reachable(hash) AS (
      SELECT value FROM json_each(?) UNION
      SELECT dep.value FROM changes c JOIN reachable r ON c.hash=r.hash
      JOIN json_each(c.deps) dep WHERE c.room=?
    ) SELECT c.body FROM changes c JOIN reachable r ON c.hash=r.hash
      WHERE c.room=? ORDER BY c.seq`).all(JSON.stringify(ref.heads), ref.room, ref.room);
    const [doc] = A.applyChanges(A.init(), rows.map(row => new Uint8Array(row.body)));
    check(A.getMissingDeps(doc).length === 0 && same(A.getHeads(doc), ref.heads), 'Incomplete stored history');
    return doc;
  }
  persist(branch, doc, previous = null) {
    const changes = previous ? A.getChanges(previous, doc) : A.getAllChanges(doc);
    const insert = this.db.prepare('INSERT OR IGNORE INTO changes(room,hash,deps,body) VALUES(?,?,?,?)');
    for (const bytes of changes) {
      const change = A.decodeChange(bytes);
      insert.run(doc.room, change.hash, JSON.stringify(change.deps), bytes);
    }
    const heads = A.getHeads(doc);
    this.db.prepare('INSERT INTO refs(name,room,heads) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET heads=excluded.heads')
      .run(branch, doc.room, JSON.stringify(heads));
    return { branch, room: doc.room, heads };
  }
  create(branch = 'main') {
    id(branch, 'branch');
    return this.transaction(() => {
      check(!this.db.prepare('SELECT 1 FROM refs WHERE name=?').get(branch), 'Branch already exists');
      const doc = A.from({ schema: 1, room: randomUUID(), files: {}, messages: {}, events: {}, comments: {} });
      return this.persist(branch, doc);
    });
  }
  refs() {
    return this.db.prepare('SELECT * FROM refs ORDER BY name').all().map(r => ({ branch: r.name, room: r.room, heads: JSON.parse(r.heads) }));
  }
  read(branch, heads) {
    let doc = this.load(branch);
    if (heads) doc = A.view(doc, heads);
    const files = Object.entries(doc.files).map(([fileId, value]) => ({ fileId, ...value }));
    const conflicts = [];
    const paths = new Map();
    for (const f of files) {
      if (!f.deleted) {
        if (paths.has(f.path)) conflicts.push({ type: 'path-collision', path: f.path, fileIds: [paths.get(f.path), f.fileId] });
        paths.set(f.path, f.fileId);
      }
      for (const field of ['path', 'deleted', 'kind', 'mode', 'data', 'target']) {
        const values = A.getConflicts(doc.files[f.fileId], field);
        if (values && Object.keys(values).length > 1) conflicts.push({ type: 'concurrent-metadata', fileId: f.fileId, field, values });
      }
    }
    return { room: doc.room, heads: A.getHeads(doc), files,
      messages: JSON.parse(JSON.stringify(doc.messages)), comments: JSON.parse(JSON.stringify(doc.comments)),
      adapterEvents: JSON.parse(JSON.stringify(doc.adapterEvents ?? {})), conflicts };
  }
  readFile(branch, fileId, heads) {
    const state = this.read(branch, heads); const value = state.files.find(f => f.fileId === fileId);
    check(value, 'Unknown file');
    return { room: state.room, heads: state.heads, file: value, conflicts: state.conflicts.filter(c => c.fileId === fileId || c.fileIds?.includes(fileId)) };
  }
  submit(branch, input) {
    check(input && typeof input === 'object', 'Invalid submission');
    id(input.actor, 'actor');
    id(input.requestId, 'requestId');
    check(Array.isArray(input.operations) && input.operations.length > 0 && input.operations.length <= 10000, 'Expected 1–10000 operations');
    check(Array.isArray(input.expectedHeads), 'expectedHeads is required; read before writing');
    const encoded = JSON.stringify(input);
    check(encoded.length <= MAX_BUNDLE, 'Submission too large');
    return this.transaction(() => {
      const prior = this.db.prepare('SELECT * FROM receipts WHERE branch=? AND request_id=?').get(branch, input.requestId);
      if (prior) {
        check(prior.input === encoded, 'Request ID reused with different input');
        return JSON.parse(prior.result);
      }
      const before = this.load(branch);
      check(same(A.getHeads(before), input.expectedHeads), 'Stale heads; read again or edit an offline branch and merge');
      const eventId = randomUUID();
      const metadata = { eventId, actor: input.actor, harness: text(input.harness ?? 'generic', 'harness', 200),
        observedAt: new Date().toISOString(), operationTypes: input.operations.map(op => op.type),
        fileIds: [...new Set(input.operations.flatMap(op => op.fileId ? [op.fileId] : []))],
        messageIds: input.operations.flatMap(op => op.type === 'message.add' ? [op.messageId] : []) };
      for (const key of ['sessionId', 'turnId', 'messageId', 'toolCallId']) {
        if (input[key] !== undefined) metadata[key] = text(input[key], key, 200);
      }
      for (const key of ['evidence', 'gitCommit', 'sourceEventId', 'observedAfter']) {
        if (input[key] !== undefined) metadata[key] = text(input[key], key, 200);
      }
      const after = A.change(before, { message: JSON.stringify(metadata) }, doc => {
        for (const op of input.operations) this.apply(doc, op, eventId);
        doc.events[eventId] = metadata;
      });
      const result = { ...this.persist(branch, after, before), eventId };
      this.db.prepare('INSERT INTO receipts VALUES(?,?,?,?)').run(branch, input.requestId, encoded, JSON.stringify(result));
      return result;
    });
  }
  apply(doc, op, eventId) {
    check(op && typeof op === 'object', 'Invalid operation');
    switch (op.type) {
      case 'adapter.record': {
        const event = validateEvent(op.event);
        if (!doc.adapterEvents) doc.adapterEvents = {};
        check(!own(doc.adapterEvents, event.eventId), 'Adapter event ID already exists');
        doc.adapterEvents[event.eventId] = JSON.parse(JSON.stringify(event));
        break;
      }
      case 'file.create': {
        id(op.fileId, 'fileId'); path(op.path);
        check(!own(doc.files, op.fileId), 'File ID already exists');
        check(!Object.values(doc.files).some(f => !f.deleted && f.path === op.path), 'Path already exists');
        doc.files[op.fileId] = { path: op.path, ...content(op), deleted: false, createdBy: eventId };
        break;
      }
      case 'file.splice': {
        const f = file(doc, op.fileId);
        check(!f.deleted, 'File is deleted');
        check((f.kind ?? 'text') === 'text', 'File is not text');
        text(op.insert, 'insert'); position(op.index, f.text.length);
        check(Number.isSafeInteger(op.deleteCount) && op.deleteCount >= 0, 'Invalid deleteCount');
        position(op.index + op.deleteCount, f.text.length);
        noSplitSurrogate(f.text, op.index); noSplitSurrogate(f.text, op.index + op.deleteCount);
        check(f.text.length - op.deleteCount + op.insert.length <= MAX_TEXT, 'File too large');
        A.splice(doc, ['files', op.fileId, 'text'], op.index, op.deleteCount, op.insert);
        break;
      }
      case 'file.write': {
        const f = file(doc, op.fileId); check(!f.deleted, 'File is deleted');
        const value = content(op);
        A.updateText(doc, ['files', op.fileId, 'text'], value.text);
        for (const key of ['kind', 'mode', 'data', 'target']) {
          const conflicts = A.getConflicts(f, key);
          if (f[key] !== value[key] || (conflicts && Object.keys(conflicts).length > 1)) f[key] = value[key];
        }
        break;
      }
      case 'file.rename': {
        const f = file(doc, op.fileId); check(!f.deleted, 'File is deleted'); path(op.path);
        check(!Object.entries(doc.files).some(([key, value]) => key !== op.fileId && !value.deleted && value.path === op.path), 'Path already exists');
        f.path = op.path;
        break;
      }
      case 'file.delete': file(doc, op.fileId).deleted = true; break;
      case 'file.restore': file(doc, op.fileId).deleted = false; break;
      case 'message.add': {
        id(op.messageId, 'messageId');
        check(!own(doc.messages, op.messageId), 'Message ID already exists');
        check(['user', 'assistant', 'tool', 'system'].includes(op.role), 'Invalid message role');
        doc.messages[op.messageId] = { role: op.role, text: text(op.text, 'message'), eventId };
        break;
      }
      case 'comment.add': {
        id(op.commentId, 'commentId'); check(!own(doc.comments, op.commentId), 'Comment ID already exists');
        const f = file(doc, op.fileId); check(!f.deleted, 'File is deleted');
        position(op.start, f.text.length); position(op.end, f.text.length);
        check(op.start <= op.end, 'Invalid comment range');
        noSplitSurrogate(f.text, op.start); noSplitSurrogate(f.text, op.end);
        doc.comments[op.commentId] = { fileId: op.fileId, text: text(op.text, 'comment'), eventId,
          start: A.getCursor(doc, ['files', op.fileId, 'text'], op.start),
          end: A.getCursor(doc, ['files', op.fileId, 'text'], op.end) };
        break;
      }
      default: throw new Error('Unknown operation type');
    }
  }
  fork(source, target, heads) {
    id(target, 'branch');
    return this.transaction(() => {
      check(!this.db.prepare('SELECT 1 FROM refs WHERE name=?').get(target), 'Branch already exists');
      const doc = this.load(source);
      const selected = heads ? A.view(doc, heads) : doc;
      const result = { branch: target, room: doc.room, heads: A.getHeads(selected) };
      this.db.prepare('INSERT INTO refs VALUES(?,?,?)').run(target, doc.room, JSON.stringify(result.heads));
      return result;
    });
  }
  merge(target, source) {
    return this.transaction(() => {
      const before = this.load(target); const remote = this.load(source);
      check(before.room === remote.room, 'Cannot merge unrelated rooms');
      return this.persist(target, A.merge(before, remote), before);
    });
  }
  history(branch, { after = 0, limit = 100 } = {}) {
    check(Number.isSafeInteger(after) && after >= 0 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 1000, 'Invalid pagination');
    const doc = this.load(branch);
    // Local sequence is a pagination cursor only; it is never causal time.
    const hashes = A.getAllChanges(doc).map(bytes => A.decodeChange(bytes).hash);
    const rows = this.db.prepare(`SELECT seq,hash,body FROM changes WHERE room=? AND seq>? AND hash IN (SELECT value FROM json_each(?)) ORDER BY seq LIMIT ?`)
      .all(doc.room, after, JSON.stringify(hashes), limit);
    return rows.map(row => {
      const change = A.decodeChange(new Uint8Array(row.body));
      return { cursor: row.seq, changeId: row.hash, parents: change.deps,
        provenance: change.message ? JSON.parse(change.message) : null };
    });
  }
  anchor(branch, fileId, start, end) {
    const doc = this.load(branch); const f = file(doc, fileId);
    position(start, f.text.length); position(end, f.text.length); check(start <= end, 'Invalid range');
    noSplitSurrogate(f.text, start); noSplitSurrogate(f.text, end);
    return { room: doc.room, fileId, heads: A.getHeads(doc),
      start: A.getCursor(doc, ['files', fileId, 'text'], start),
      end: A.getCursor(doc, ['files', fileId, 'text'], end) };
  }
  trace(branch, fileId) {
    const doc = this.load(branch); file(doc, fileId);
    return A.getAllChanges(doc).flatMap(bytes => {
      const change = A.decodeChange(bytes);
      const provenance = change.message ? JSON.parse(change.message) : null;
      if (!provenance?.fileIds?.includes(fileId)) return [];
      const messageIds = new Set([...provenance.messageIds, ...(provenance.messageId ? [provenance.messageId] : [])]);
      return [{ changeId: change.hash, parents: change.deps, provenance,
        messages: [...messageIds].filter(key => own(doc.messages, key)).map(key => ({ messageId: key, ...doc.messages[key] })) }];
    });
  }
  resolve(branch, anchor, heads) {
    let doc = this.load(branch); if (heads) doc = A.view(doc, heads);
    check(doc.room === anchor.room || anchor.room === undefined, 'Anchor belongs to another room');
    const f = file(doc, anchor.fileId); const p = ['files', anchor.fileId, 'text'];
    const start = A.getCursorPosition(doc, p, anchor.start);
    const end = A.getCursorPosition(doc, p, anchor.end);
    return { fileId: anchor.fileId, path: f.path, deleted: f.deleted, start, end, text: f.text.slice(start, end) };
  }
  export(branch, since = []) {
    const doc = this.load(branch);
    const bytes = A.getChanges(A.view(doc, since), doc);
    return { protocol: 'spool/1', schema: 1, room: doc.room, heads: A.getHeads(doc),
      changes: bytes.map(change => Buffer.from(change).toString('base64')) };
  }
  import(branch, bundle) {
    id(branch, 'branch');
    check(bundle && JSON.stringify(bundle).length <= MAX_BUNDLE, 'Bundle too large');
    check(bundle.protocol === 'spool/1' && bundle.schema === 1, 'Unsupported protocol');
    id(bundle.room, 'room');
    check(Array.isArray(bundle.changes) && bundle.changes.length <= 10000 && Array.isArray(bundle.heads), 'Invalid bundle');
    return this.transaction(() => {
      const ref = this.db.prepare('SELECT 1 FROM refs WHERE name=?').get(branch);
      const before = ref ? this.load(branch) : A.init();
      if (ref) check(before.room === bundle.room, 'Cannot import unrelated room');
      const bytes = bundle.changes.map(value => {
        text(value, 'encoded change', MAX_BUNDLE);
        check(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value), 'Invalid base64');
        return new Uint8Array(Buffer.from(value, 'base64'));
      });
      const [doc] = A.applyChanges(before, bytes);
      check(A.getMissingDeps(doc).length === 0, 'Missing causal dependencies');
      check(A.hasHeads(doc, bundle.heads), 'Missing advertised heads');
      check(doc.schema === 1 && doc.room === bundle.room && doc.files && doc.messages && doc.events && doc.comments, 'Invalid document');
      for (const [fileId, f] of Object.entries(doc.files)) { id(fileId); path(f.path); content(f); }
      for (const [eventId, event] of Object.entries(doc.adapterEvents ?? {})) {
        validateEvent(event); check(eventId === event.eventId, 'Adapter event key does not match identity');
      }
      return this.persist(branch, doc, ref ? before : null);
    });
  }
}
export { check, text, id, position, noSplitSurrogate, same };
