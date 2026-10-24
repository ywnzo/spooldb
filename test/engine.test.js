import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Engine as BaseEngine } from '../src/index.js';

for (const layout of ['legacy', 'sharded']) {
const test = (name, fn) => nodeTest(`${layout}: ${name}`, fn);
const Engine = class { constructor(filename) { return new BaseEngine(filename, { layout }); } };

function submit(e, branch, operations, extra = {}) {
  return e.submit(branch, { actor: 'alice', requestId: crypto.randomUUID(), harness: 'test',
    expectedHeads: e.read(branch).heads, operations, ...extra });
}
const create = (fileId = 'f1', path = 'src/a.js', text = 'hello world') => ({ type: 'file.create', fileId, path, text });
const splice = (index, insert, deleteCount = 0) => ({ type: 'file.splice', fileId: 'f1', index, insert, deleteCount });
function setup(t) { const e = new Engine(); t.after(() => e.close()); e.create(); submit(e, 'main', [create()]); return e; }

test('text, message and provenance are atomic and causally addressable', t => {
  const e = setup(t);
  const before = e.read('main').heads;
  const result = submit(e, 'main', [splice(0, 'new '), { type: 'message.add', messageId: 'm1', role: 'assistant', text: 'Updated greeting' }], { messageId: 'm1', toolCallId: 'tool-1' });
  assert.equal(e.read('main').messages.m1.eventId, result.eventId);
  assert.equal(e.read('main', before).files[0].text, 'hello world');
  const event = e.history('main').at(-1);
  assert.equal(event.provenance.toolCallId, 'tool-1');
  assert.equal(event.provenance.eventId, result.eventId);
  assert.deepEqual(event.parents, before);
  assert.equal(e.trace('main', 'f1').at(-1).messages[0].text, 'Updated greeting');
});

test('offline edits merge in either order; duplicates are idempotent', t => {
  const a = setup(t); const b = new Engine(); const c = new Engine();
  t.after(() => { b.close(); c.close(); });
  const base = a.export('main'); b.import('main', base); c.import('main', base);
  submit(a, 'main', [splice(0, 'A ')]);
  submit(b, 'main', [splice(11, ' B')], { actor: 'bob', harness: 'another-harness' });
  const left = a.export('main'); const right = b.export('main');
  a.import('main', right); b.import('main', left);
  c.import('main', right); c.import('main', left); c.import('main', right);
  assert.equal(a.read('main').files[0].text, 'A hello world B');
  assert.deepEqual(a.read('main'), b.read('main'));
  assert.deepEqual(a.read('main'), c.read('main'));
});

test('simultaneous insertion at same position converges without dropping text', t => {
  const a = setup(t); const b = new Engine(); t.after(() => b.close()); b.import('main', a.export('main'));
  submit(a, 'main', [splice(0, 'AAA')]); submit(b, 'main', [splice(0, 'BBB')]);
  const x = a.export('main'); a.import('main', b.export('main')); b.import('main', x);
  assert.deepEqual(a.read('main'), b.read('main'));
  assert.match(a.read('main').files[0].text, /^(AAABBB|BBBAAA)hello world$/);
});

test('anchors survive insertion, rename and reopening; resolve historical version', t => {
  const dir = mkdtempSync(join(tmpdir(), 'spool-')); const db = join(dir, 'test.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let e = new Engine(db); e.create(); submit(e, 'main', [create()]);
  const anchor = e.anchor('main', 'f1', 6, 11);
  submit(e, 'main', [splice(0, 'prefix '), { type: 'file.rename', fileId: 'f1', path: 'src/b.js' }]);
  e.close(); e = new Engine(db); t.after(() => e.close());
  assert.deepEqual(e.resolve('main', anchor), { fileId: 'f1', path: 'src/b.js', deleted: false, start: 13, end: 18, text: 'world' });
  assert.equal(e.resolve('main', anchor, anchor.heads).path, 'src/a.js');
});

test('fork at intermediate point isolates changes and supports merging', t => {
  const e = setup(t); const heads = e.read('main').heads;
  submit(e, 'main', [splice(11, '!')]); e.fork('main', 'experiment', heads);
  assert.equal(e.read('experiment').files[0].text, 'hello world');
  submit(e, 'experiment', [splice(0, 'branch ')]);
  assert.equal(e.read('main').files[0].text, 'hello world!');
  e.merge('main', 'experiment');
  assert.equal(e.read('main').files[0].text, 'branch hello world!');
  assert.equal(e.read('experiment').files[0].text, 'branch hello world');
});

test('stale offsets and failed batches leave no partial history', t => {
  const e = setup(t); const heads = e.read('main').heads;
  submit(e, 'main', [splice(0, 'first ')]);
  assert.throws(() => submit(e, 'main', [splice(0, 'bad')], { expectedHeads: heads }), /Stale heads/);
  const before = e.read('main'); const history = e.history('main');
  assert.throws(() => submit(e, 'main', [splice(0, 'bad'), create('f2', '../outside')]), /Unsafe/);
  assert.deepEqual(e.read('main'), before); assert.deepEqual(e.history('main'), history);
});

test('retry returns original receipt and rejects a changed payload', t => {
  const e = setup(t); const input = { actor: 'alice', requestId: 'retry-1', expectedHeads: e.read('main').heads, operations: [splice(0, 'once ')] };
  const first = e.submit('main', input); submit(e, 'main', [splice(0, 'later ')]);
  assert.deepEqual(e.submit('main', input), first);
  assert.equal(e.read('main').files[0].text, 'later once hello world');
  assert.throws(() => e.submit('main', { ...input, actor: 'bob' }), /reused/);
});

test('delta-only export syncs; missing dependencies and unrelated histories are rejected', t => {
  const a = setup(t); const b = new Engine(); t.after(() => b.close());
  b.import('main', a.export('main')); const base = b.read('main').heads;
  submit(a, 'main', [splice(0, 'delta ')]);
  const update = a.export('main', base); assert.equal(update.schema === 1 ? update.changes.length : update.documents[0].changes.length, 1);
  const empty = new Engine(); t.after(() => empty.close());
  assert.throws(() => empty.import('missing', update), /[Mm]issing/);
  b.import('main', update); assert.deepEqual(a.read('main'), b.read('main'));
  b.create('other'); assert.throws(() => b.import('other', a.export('main')), /unrelated/);
});

test('concurrent renames and path collisions are surfaced', t => {
  const e = setup(t); e.fork('main', 'other');
  submit(e, 'main', [{ type: 'file.rename', fileId: 'f1', path: 'a.js' }]);
  submit(e, 'other', [{ type: 'file.rename', fileId: 'f1', path: 'b.js' }]);
  e.merge('main', 'other');
  assert.equal(e.read('main').conflicts[0].type, 'concurrent-metadata');
  const f = e.read('main').files[0];
  submit(e, 'main', [{ type: 'file.rename', fileId: 'f1', path: f.path }]);
  assert.equal(e.read('main').conflicts.length, 0);
  e.fork('main', 'collision'); submit(e, 'main', [create('f2', 'shared.js', 'a')]);
  submit(e, 'collision', [create('f3', 'shared.js', 'b')]); e.merge('main', 'collision');
  assert.equal(e.read('main').conflicts[0].type, 'path-collision');
});

test('comments remain attached; tombstones preserve file and anchor history', t => {
  const e = setup(t);
  submit(e, 'main', [{ type: 'comment.add', commentId: 'c1', fileId: 'f1', start: 0, end: 5, text: 'Review this greeting' }]);
  const comment = e.read('main').comments.c1;
  submit(e, 'main', [splice(5, ' there')]);
  assert.equal(e.resolve('main', comment).start, 0);
  submit(e, 'main', [{ type: 'file.delete', fileId: 'f1' }]);
  assert.equal(e.resolve('main', comment).deleted, true);
  assert.throws(() => submit(e, 'main', [splice(0, 'bad')]), /deleted/);
  submit(e, 'main', [{ type: 'file.restore', fileId: 'f1' }]);
  assert.equal(e.read('main').files[0].text, 'hello there world');
});

test('Unicode offsets use UTF-16 code units and reject splitting emoji', t => {
  const e = new Engine(); t.after(() => e.close()); e.create(); submit(e, 'main', [create('f1', 'emoji.txt', 'a😀b')]);
  assert.throws(() => submit(e, 'main', [splice(2, 'bad')]), /surrogate/);
  submit(e, 'main', [splice(3, 'ž')]); assert.equal(e.read('main').files[0].text, 'a😀žb');
});

test('two connections reject stale writes and reopen all committed changes', t => {
  const dir = mkdtempSync(join(tmpdir(), 'spool-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const a = new Engine(join(dir, 'db.sqlite')); const b = new Engine(join(dir, 'db.sqlite'));
  t.after(() => { a.close(); b.close(); }); a.create(); submit(a, 'main', [create()]);
  const base = b.read('main').heads; submit(a, 'main', [splice(0, 'a ')]);
  assert.throws(() => submit(b, 'main', [splice(0, 'b ')], { expectedHeads: base }), /Stale/);
  submit(b, 'main', [splice(0, 'b ')]); assert.equal(a.read('main').files[0].text, 'b a hello world');
});

test('CLI frames success/errors and continues after a malformed request', () => {
  const run = spawnSync(process.execPath, ['src/cli.js', ':memory:', ...(layout === 'sharded' ? ['--sharded'] : [])], { cwd: new URL('..', import.meta.url),
    input: '{"id":1,"command":"init"}\ninvalid\n{"id":3,"command":"read","branch":"main"}\n', encoding: 'utf8' });
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stderr);
  const rows = run.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].ok, true); assert.equal(rows[1].ok, false); assert.equal(rows[2].id, 3); assert.equal(rows[2].ok, true);
});

}
