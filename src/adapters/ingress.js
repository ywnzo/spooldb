import { randomUUID } from 'node:crypto';
import { normalize, validateEvent, PROTOCOL, ensure, string, digest } from './contract.js';

export class AdapterIngress {
  constructor(engine) {
    this.engine = engine; this.db = engine.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS adapter_streams (
      id TEXT PRIMARY KEY, branch TEXT NOT NULL, harness TEXT NOT NULL, next_sequence INTEGER NOT NULL,
      state TEXT NOT NULL, prompt_id TEXT);
      CREATE TABLE IF NOT EXISTS adapter_receipts (
      stream_id TEXT NOT NULL, sequence INTEGER NOT NULL, digest TEXT NOT NULL, result TEXT NOT NULL,
      PRIMARY KEY(stream_id,sequence));`);
  }
  open({ branch, harness, streamId = randomUUID(), prompt }) {
    string(streamId, 'streamId', 80); ensure(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(streamId), 'Invalid stream ID');
    ensure(['codex', 'claude'].includes(harness), 'Unsupported harness');
    return this.engine.transaction(() => {
      const ref = this.engine.ref(branch);
      ensure(!this.db.prepare('SELECT 1 FROM adapter_streams WHERE id=?').get(streamId), 'Adapter stream already exists');
      const promptId = prompt === undefined ? null : `prompt-${digest(streamId)}`;
      if (promptId) {
        ensure(typeof prompt === 'string' && prompt.length <= 1_000_000, 'Invalid prompt');
        this.engine.submit(branch, { actor: 'user', harness, sessionId: streamId, evidence: 'adapter-input',
          requestId: `open-${streamId}`, expectedHeads: ref.heads,
          operations: [{ type: 'message.add', messageId: promptId, role: 'user', text: prompt }] });
      }
      this.db.prepare('INSERT INTO adapter_streams VALUES(?,?,?,?,?,?)').run(streamId, branch, harness, 0,
        JSON.stringify({ streamId, status: 'opened', turnCounter: 0 }), promptId);
      return this.get(streamId);
    });
  }
  get(streamId) {
    const row = this.db.prepare('SELECT * FROM adapter_streams WHERE id=?').get(streamId);
    ensure(row, 'Unknown adapter stream');
    return { ...JSON.parse(row.state), streamId: row.id, branch: row.branch, harness: row.harness,
      nextSequence: row.next_sequence, promptId: row.prompt_id };
  }
  list() { return this.db.prepare('SELECT id FROM adapter_streams ORDER BY rowid').all().map(r => this.get(r.id)); }
  ingest(streamId, sequence, raw) {
    ensure(Number.isSafeInteger(sequence) && sequence >= 0, 'Invalid sequence');
    ensure(raw && JSON.stringify(raw).length <= 1_000_000, 'Native event exceeds 1 MB');
    const hash = digest(raw);
    return this.engine.transaction(() => {
      const previous = this.db.prepare('SELECT * FROM adapter_receipts WHERE stream_id=? AND sequence=?').get(streamId, sequence);
      if (previous) { ensure(hash === previous.digest, 'Sequence replay has different native payload'); return JSON.parse(previous.result); }
      const stream = this.get(streamId); ensure(sequence === stream.nextSequence, 'Native event sequence gap');
      ensure(!stream.closed, 'Adapter stream is closed');
      const normalized = normalize(stream.harness, raw, stream);
      const events = normalized.events.map((event, part) => validateEvent({ protocol: PROTOCOL, harness: stream.harness,
        eventId: digest({ streamId, sequence, part }), streamId, sequence, part,
        sessionId: normalized.state.sessionId ?? streamId,
        sessionIdSource: normalized.state.sessionId ? 'native' : 'adapter',
        ...(normalized.state.turnId ? { turnId: normalized.state.turnId } : {}),
        sourceType: raw.type, evidence: 'native-event', ...event }));
      const operations = [];
      for (const event of events) {
        operations.push({ type: 'adapter.record', event });
        if (event.kind === 'message') operations.push({ type: 'message.add',
          messageId: `native-${event.eventId}`, role: event.payload.role, text: event.payload.text });
      }
      // Even unsupported input is represented by an explicit notice, never silently acknowledged.
      const result = this.engine.submit(stream.branch, { actor: stream.harness, harness: stream.harness,
        sessionId: normalized.state.sessionId ?? streamId, ...(normalized.state.turnId ? { turnId: normalized.state.turnId } : {}),
        evidence: 'native-event', sourceEventId: events[0].eventId,
        ...(stream.promptId ? { messageId: stream.promptId } : {}),
        requestId: `adapter-${digest({ streamId, sequence })}`, expectedHeads: this.engine.ref(stream.branch).heads, operations });
      const response = { ...result, events };
      this.db.prepare('UPDATE adapter_streams SET state=?,next_sequence=? WHERE id=?').run(JSON.stringify(normalized.state), sequence + 1, streamId);
      this.db.prepare('INSERT INTO adapter_receipts VALUES(?,?,?,?)').run(streamId, sequence, hash, JSON.stringify(response));
      return response;
    });
  }
  close(streamId, { exitCode = null, signal = null, reason } = {}) {
    return this.engine.transaction(() => {
      const stream = this.get(streamId); if (stream.closed) return stream;
      const status = reason || signal || exitCode !== 0 || stream.status === 'failed' ? 'failed' : stream.status === 'completed' ? 'completed' : 'incomplete';
      const next = { ...stream, closed: true, status, exitCode, signal, ...(reason ? { reason } : {}) };
      const event = validateEvent({ protocol: PROTOCOL, harness: stream.harness, eventId: digest({ streamId, closed: true }),
        streamId, sequence: stream.nextSequence, part: 0, sessionId: stream.sessionId ?? streamId,
        sessionIdSource: stream.sessionId ? 'native' : 'adapter', ...(stream.turnId ? { turnId: stream.turnId } : {}),
        kind: 'run.closed', sourceType: 'adapter.process.exit', evidence: 'adapter-process',
        payload: { status, exitCode, signal, ...(reason ? { reason } : {}) } });
      this.engine.submit(stream.branch, { actor: 'adapter', harness: stream.harness, evidence: 'adapter-process',
        requestId: `close-${streamId}`, expectedHeads: this.engine.ref(stream.branch).heads,
        operations: [{ type: 'adapter.record', event }] });
      this.db.prepare('UPDATE adapter_streams SET state=? WHERE id=?').run(JSON.stringify(next), streamId);
      return this.get(streamId);
    });
  }
}
