import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { Engine } from '../src/index.js';
import { AdapterIngress, runHarness, commandFor, validateEvent } from '../src/adapters/index.js';

const fixtures = h => readFileSync(new URL(`./fixtures/adapters/${h}.jsonl`, import.meta.url), 'utf8').trim().split('\n').map(JSON.parse);
const command = (h, mode) => ({ executable: process.execPath, args: [fileURLToPath(new URL('./fixtures/adapters/fake-native.js', import.meta.url)), h, mode] });
function setup(t) { const e = new Engine(); const ingress = new AdapterIngress(e); e.create(); t.after(() => e.close()); return { e, ingress }; }
function repo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'spool-adapter-')); const root = join(dir, 'repo'); mkdirSync(root);
  execFileSync('git', ['-C', root, 'init', '-q']); writeFileSync(join(root, 'a.txt'), 'hello');
  const e = new Engine(join(dir, 'db.sqlite')); t.after(() => { e.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, root, e };
}
for (const harness of ['codex', 'claude']) {
  test(`${harness}: native lifecycle, messages, tools and evidence survive export/import`, t => {
    const { e, ingress } = setup(t); const stream = ingress.open({ branch: 'main', harness, prompt: 'Synthetic prompt.' });
    fixtures(harness).forEach((raw, i) => ingress.ingest(stream.streamId, i, raw));
    const final = ingress.close(stream.streamId, { exitCode: 0 }); assert.equal(final.status, 'completed');
    const state = e.read('main'); const events = Object.values(state.adapterEvents);
    events.forEach(validateEvent); assert.ok(events.some(ev => ev.kind === 'tool.started'));
    assert.ok(events.some(ev => ev.kind === 'tool.completed')); assert.ok(events.some(ev => ev.kind === 'turn.completed'));
    assert.equal(Object.values(state.messages).filter(m => m.text === 'Synthetic response.').length, 1);
    assert.ok(!JSON.stringify(state).includes('MUST_NOT_RETAIN'));
    assert.equal(events.find(ev => ev.kind === 'session.started').sessionIdSource, 'native');
    assert.equal(events.find(ev => ev.kind === 'run.closed').evidence, 'adapter-process');
    const replica = new Engine(); t.after(() => replica.close()); replica.import('main', e.export('main'));
    assert.deepEqual(replica.read('main'), state);
  });
  test(`${harness}: runner captures real saved changes with explicit prompt correlation`, async t => {
    const { root, e } = repo(t); const records = [];
    const result = await runHarness(e, { harness, root, prompt: 'Synthetic prompt.', command: command(harness, 'edit'), onRecord: r => records.push(r) });
    assert.equal(result.status, 'completed'); assert.equal(result.exitCode, 0);
    const f = e.read('main').files.find(f => f.path === 'a.txt'); assert.equal(f.text, 'native hello');
    const provenance = e.trace('main', f.fileId).at(-1);
    assert.equal(provenance.provenance.actor, 'unknown'); assert.equal(provenance.provenance.evidence, 'observed-disk-snapshot');
    assert.equal(provenance.messages[0].text, 'Synthetic prompt.');
    assert.ok(provenance.provenance.observedAfter); assert.ok(records.some(r => r.event === 'filesystem.observed'));
  });
}
test('replay receipts survive reopening, ignore JSON key order and reject changed payloads', t => {
  const { dir, e } = repo(t); e.create(); const ingress = new AdapterIngress(e);
  const stream = ingress.open({ branch: 'main', harness: 'codex', streamId: 'replay' });
  const raw = fixtures('codex')[0]; const first = ingress.ingest(stream.streamId, 0, raw);
  const second = new Engine(join(dir, 'db.sqlite')); t.after(() => second.close()); const reopened = new AdapterIngress(second);
  assert.deepEqual(reopened.ingest('replay', 0, Object.fromEntries(Object.entries(raw).reverse())), first);
  assert.throws(() => reopened.ingest('replay', 0, { ...raw, thread_id: 'changed' }), /different/);
  assert.equal(reopened.get('replay').nextSequence, 1);
});
test('out-of-order events and changed native session IDs fail atomically', t => {
  const { e, ingress } = setup(t); ingress.open({ branch: 'main', harness: 'codex', streamId: 'ordered' });
  assert.throws(() => ingress.ingest('ordered', 1, fixtures('codex')[0]), /gap/);
  ingress.ingest('ordered', 0, fixtures('codex')[0]); const heads = e.read('main').heads;
  assert.throws(() => ingress.ingest('ordered', 1, { type: 'thread.started', thread_id: 'other' }), /changed/);
  assert.deepEqual(e.read('main').heads, heads); assert.equal(ingress.get('ordered').nextSequence, 1);
});
test('malformed native items roll back and unknown types leave an explicit notice', t => {
  const { e, ingress } = setup(t); ingress.open({ branch: 'main', harness: 'codex', streamId: 'unknown' });
  ingress.ingest('unknown', 0, fixtures('codex')[0]);
  const heads = e.read('main').heads;
  assert.throws(() => ingress.ingest('unknown', 1, { type: 'item.completed' }), /Missing/);
  assert.deepEqual(e.read('main').heads, heads);
  const result = ingress.ingest('unknown', 1, { type: 'future.event', credential: 'DO_NOT_STORE' });
  assert.equal(result.events[0].kind, 'notice'); assert.ok(!JSON.stringify(e.read('main')).includes('DO_NOT_STORE'));
});
test('failure before session initialization is retained as a native failure with adapter session identity', t => {
  const { e, ingress } = setup(t); ingress.open({ branch: 'main', harness: 'codex', streamId: 'error' });
  const result = ingress.ingest('error', 0, { type: 'error', message: 'synthetic authentication failure' });
  assert.equal(result.events[0].sessionIdSource, 'adapter');
  assert.equal(ingress.close('error', { exitCode: 0 }).status, 'failed');
  assert.ok(Object.values(e.read('main').adapterEvents).some(ev => ev.kind === 'turn.failed'));
});
test('failed results and zero-exit streams without terminal events are distinguished', async t => {
  const { root, e } = repo(t);
  const result = await runHarness(e, { harness: 'codex', root, prompt: 'test', command: command('codex', 'incomplete') });
  assert.equal(result.status, 'incomplete'); assert.equal(result.exitCode, 0);
  const ingress = new AdapterIngress(e); ingress.open({ branch: 'main', harness: 'claude', streamId: 'failed' });
  ingress.ingest('failed', 0, fixtures('claude')[0]);
  ingress.ingest('failed', 1, { type: 'result', subtype: 'error_max_turns', is_error: true, session_id: 'synthetic-claude-session' });
  assert.equal(ingress.close('failed', { exitCode: 0 }).status, 'failed');
});
for (const mode of ['malformed', 'oversized', 'failure', 'timeout']) {
  test(`runner handles ${mode} without reporting successful completion`, { timeout: 10000 }, async t => {
    const { root, e } = repo(t);
    const result = await runHarness(e, { harness: 'codex', root, prompt: 'test', command: command('codex', mode), timeoutMs: mode === 'timeout' ? 200 : 5000 });
    assert.equal(result.status, 'failed');
    if (mode === 'failure') { assert.equal(result.exitCode, 9); assert.ok(result.stderrBytes > 0); }
    if (mode === 'timeout') assert.equal(result.reason, 'timeout');
    assert.ok(Object.values(e.read('main').adapterEvents).some(ev => ev.kind === 'run.closed' && ev.payload.status === 'failed'));
  });
}
test('missing native executable produces a durable failed run', async t => {
  const { root, e } = repo(t);
  const result = await runHarness(e, { harness: 'claude', root, prompt: 'test', command: { executable: '/missing-spool-cli', args: [] } });
  assert.equal(result.status, 'failed'); assert.equal(result.reason, 'native-process-start-failed');
});
test('cancellation terminates the native process and closes its stream', { timeout: 10000 }, async t => {
  const { root, e } = repo(t); const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 200);
  t.after(() => clearTimeout(timer));
  const result = await runHarness(e, { harness: 'codex', root, prompt: 'test', command: command('codex', 'timeout'), signal: controller.signal });
  assert.equal(result.status, 'failed'); assert.equal(result.reason, 'cancelled');
});
test('default launch commands preserve permission boundaries and pass no prompt in argv', () => {
  const codex = commandFor('codex', '/repo'); assert.ok(codex.args.includes('read-only')); assert.ok(!codex.args.includes('--full-auto'));
  assert.ok(!codex.args.some(a => a.includes('bypass'))); assert.ok(commandFor('codex', '/repo', true).args.includes('workspace-write'));
  const claude = commandFor('claude', '/repo'); assert.ok(claude.args.includes('Read,Glob,Grep')); assert.ok(claude.args.includes('mcp__*'));
  assert.ok(!commandFor('claude', '/repo', true).args.some(a => /skip-permissions|acceptEdits/.test(a)));
});

test('published JSON Schema rejects extra fields and invalid payload types at runtime', t => {
  const { ingress } = setup(t); ingress.open({ branch: 'main', harness: 'codex', streamId: 'schema' });
  const event = ingress.ingest('schema', 0, fixtures('codex')[0]).events[0];
  assert.throws(() => validateEvent({ ...event, credentials: 'never-retain' }), /schema/);
  assert.throws(() => validateEvent({ ...event, kind: 'message', payload: { role: 'assistant', nativeId: 'm', text: 123 } }), /schema/);
  assert.throws(() => validateEvent({ ...event, payload: { unknown: true } }), /schema/);
  assert.equal(validateEvent({ ...event, harness: 'third-party-agent' }).harness, 'third-party-agent');
});

test('JSONL adapter ingestion works across separate CLI processes', t => {
  const { dir } = repo(t); const db = join(dir, 'cli.sqlite');
  const call = request => {
    const result = spawnSync(process.execPath, ['src/cli.js', db], { cwd: new URL('..', import.meta.url), encoding: 'utf8', input: JSON.stringify(request) + '\n' });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
    const row = JSON.parse(result.stdout.trim()); assert.ok(row.ok, result.stdout); return row.result;
  };
  call({ command: 'init', branch: 'main' });
  call({ command: 'adapter.open', options: { branch: 'main', harness: 'codex', streamId: 'cli-stream' } });
  fixtures('codex').forEach((raw, sequence) => call({ command: 'adapter.ingest', streamId: 'cli-stream', sequence, nativeEvent: raw }));
  call({ command: 'adapter.close', streamId: 'cli-stream', result: { exitCode: 0 } });
  assert.equal(call({ command: 'adapter.streams' })[0].status, 'completed');
  assert.ok(Object.values(call({ command: 'read', branch: 'main' }).adapterEvents).some(e => e.kind === 'run.closed'));
});

test('public run CLI passes the prompt through stdin and records a completed native-protocol run', t => {
  const { dir, root } = repo(t); const bin = join(dir, 'bin'); mkdirSync(bin);
  const fake = fileURLToPath(new URL('./fixtures/adapters/fake-native.js', import.meta.url));
  const wrapper = `#!${process.execPath}\nconst {spawn}=require('node:child_process');
    const child=spawn(process.execPath,[${JSON.stringify(fake)},'codex','edit'],{stdio:'inherit'});
    child.on('exit',code=>{process.exitCode=code??1});`;
  writeFileSync(join(bin, 'codex'), wrapper); chmodSync(join(bin, 'codex'), 0o755);
  const result = spawnSync(process.execPath, ['src/cli.js', join(dir, 'cli.sqlite'), 'run', 'codex', root, 'main', '--write'],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8', input: 'Synthetic CLI prompt', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stdout + result.stderr);
  const output = result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(output.at(-1).event, 'adapter.finished'); assert.equal(output.at(-1).result.status, 'completed');
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'native hello');
});
