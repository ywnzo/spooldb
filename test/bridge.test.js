import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync, symlinkSync,
  readlinkSync, chmodSync, lstatSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { Engine } from '../src/index.js';
import { Bridge } from '../src/bridge.js';

function git(root, ...args) { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
function fixture(t, persistent = false) {
  const dir = mkdtempSync(join(tmpdir(), 'spool-bridge-')); const root = join(dir, 'repo'); mkdirSync(root);
  git(root, 'init', '-q');
  const filename = persistent ? join(dir, 'state.sqlite') : ':memory:';
  const e = new Engine(filename); const b = new Bridge(e);
  t.after(() => { e.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, root, e, b, filename };
}
const file = (e, name) => e.read('main').files.find(f => f.path === name && !f.deleted);
function submit(e, operations) {
  return e.submit('main', { actor: 'agent', requestId: crypto.randomUUID(), expectedHeads: e.read('main').heads, operations });
}

test('Git import includes dirty and untracked work; excludes ignores, secret patterns and Git internals', t => {
  const { root, e, b } = fixture(t);
  writeFileSync(join(root, '.gitignore'), 'ignored.txt\ntracked.txt\n');
  writeFileSync(join(root, 'tracked.txt'), 'original'); git(root, 'add', '-f', 'tracked.txt');
  writeFileSync(join(root, 'tracked.txt'), 'dirty');
  writeFileSync(join(root, 'untracked.txt'), 'untracked');
  writeFileSync(join(root, 'ignored.txt'), 'ignored');
  writeFileSync(join(root, '.env'), 'DO_NOT_IMPORT=secret'); git(root, 'add', '-f', '.env');
  writeFileSync(join(root, '.env.example'), 'TOKEN=placeholder');
  const before = git(root, 'status', '--porcelain=v1');
  const result = b.attach('main', root);
  assert.equal(file(e, 'tracked.txt').text, 'dirty'); assert.equal(file(e, 'untracked.txt').text, 'untracked');
  assert.equal(file(e, 'ignored.txt'), undefined); assert.equal(file(e, '.env'), undefined);
  assert.equal(file(e, '.env.example').text, 'TOKEN=placeholder');
  assert.deepEqual(result.excluded.map(x => x.path), ['.env']);
  assert.equal(git(root, 'status', '--porcelain=v1'), before);
  assert.equal(e.export('main').changes.some(x => Buffer.from(x, 'base64').includes('DO_NOT_IMPORT')), false);
  const heads = e.read('main').heads;
  assert.equal(b.capture(root).operations, 0); assert.deepEqual(e.read('main').heads, heads);
});

test('captures changes, deletion and an unambiguous exact rename with stable file identity', t => {
  const { root, e, b } = fixture(t);
  writeFileSync(join(root, 'a.txt'), 'hello world'); writeFileSync(join(root, 'gone.txt'), 'remove'); b.attach('main', root);
  const original = file(e, 'a.txt'); const anchor = e.anchor('main', original.fileId, 6, 11);
  renameSync(join(root, 'a.txt'), join(root, 'renamed.txt')); rmSync(join(root, 'gone.txt'));
  b.capture(root); assert.equal(file(e, 'renamed.txt').fileId, original.fileId);
  assert.equal(e.resolve('main', anchor).path, 'renamed.txt');
  writeFileSync(join(root, 'renamed.txt'), 'prefix hello world'); b.capture(root);
  assert.equal(e.resolve('main', anchor).text, 'world');
  assert.equal(e.resolve('main', anchor).start, 13);
  assert.ok(e.read('main').files.find(f => f.path === 'gone.txt').deleted);
  assert.equal(e.trace('main', original.fileId).at(-1).provenance.actor, 'unknown');
});

test('disk capture merges with engine edits instead of replacing a newer engine state', t => {
  const { root, e, b } = fixture(t);
  writeFileSync(join(root, 'a.txt'), 'hello world'); b.attach('main', root); const f = file(e, 'a.txt');
  submit(e, [{ type: 'file.splice', fileId: f.fileId, index: 11, deleteCount: 0, insert: ' agent' }]);
  assert.equal(b.capture(root).operations, 0);
  assert.equal(file(e, 'a.txt').text, 'hello world agent');
  writeFileSync(join(root, 'a.txt'), 'disk hello world'); b.capture(root);
  assert.equal(file(e, 'a.txt').text, 'disk hello world agent');
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'disk hello world');
});

test('preserves binary bytes, executable modes, BOM, CRLF and relative symlinks in an isolated snapshot', t => {
  const { dir, root, e, b } = fixture(t);
  const binary = Buffer.from([0, 255, 254, 13, 10]); writeFileSync(join(root, 'image.bin'), binary);
  writeFileSync(join(root, 'run.sh'), '#!/bin/sh\r\necho hi\r\n'); chmodSync(join(root, 'run.sh'), 0o755);
  writeFileSync(join(root, 'bom.txt'), '\uFEFFžluťoučký\r\n'); symlinkSync('run.sh', join(root, 'shortcut'));
  b.attach('main', root); assert.equal(file(e, 'image.bin').kind, 'binary');
  const result = b.materialize('main', join(dir, 'view'));
  assert.ok(result.complete); assert.deepEqual(readFileSync(join(dir, 'view/image.bin')), binary);
  assert.deepEqual(readFileSync(join(dir, 'view/run.sh')), readFileSync(join(root, 'run.sh')));
  assert.deepEqual(readFileSync(join(dir, 'view/bom.txt')), readFileSync(join(root, 'bom.txt')));
  assert.equal(lstatSync(join(dir, 'view/run.sh')).mode & 0o777, 0o755);
  assert.equal(readlinkSync(join(dir, 'view/shortcut')), 'run.sh');
  assert.throws(() => b.materialize('main', join(dir, 'view')), /EEXIST/);
});

test('refuses existing destinations, nested source destinations, case aliases and prefix collisions', t => {
  const { dir, root, e, b } = fixture(t); writeFileSync(join(root, 'a.txt'), 'safe'); b.attach('main', root);
  const target = join(dir, 'existing'); mkdirSync(target); writeFileSync(join(target, 'a.txt'), 'local');
  assert.throws(() => b.materialize('main', target), /EEXIST/);
  assert.equal(readFileSync(join(target, 'a.txt'), 'utf8'), 'local');
  assert.throws(() => b.materialize('main', join(root, 'nested')), /separate/);
  submit(e, [{ type: 'file.create', fileId: 'case', path: 'A.txt', text: 'different' }]);
  assert.throws(() => b.materialize('main', join(dir, 'case')), /collision/); assert.equal(existsSync(join(dir, 'case')), false);
  e.create('prefix'); e.submit('prefix', { actor: 'user', requestId: 'prefix', expectedHeads: e.read('prefix').heads,
    operations: [{ type: 'file.create', fileId: 'one', path: 'dir', text: 'one' }, { type: 'file.create', fileId: 'two', path: 'dir/file', text: 'two' }] });
  assert.throws(() => b.materialize('prefix', join(dir, 'prefix')), /collision/);
});

test('records symlinks without following them and refuses unsafe materialization', t => {
  const { dir, root, e, b } = fixture(t); writeFileSync(join(dir, 'outside'), 'private'); symlinkSync('../outside', join(root, 'link'));
  b.attach('main', root); const f = file(e, 'link'); assert.equal(f.kind, 'symlink'); assert.equal(f.target, '../outside');
  assert.equal(f.text, ''); assert.throws(() => b.materialize('main', join(dir, 'view')), /Unsafe symlink/);
  assert.equal(existsSync(join(dir, 'view')), false);
});

test('refuses symlink parents during source scanning without recording outside content', t => {
  const { dir, root, e, b } = fixture(t); mkdirSync(join(root, 'sub')); writeFileSync(join(root, 'sub/file'), 'tracked'); git(root, 'add', '.');
  b.attach('main', root); const heads = e.read('main').heads;
  rmSync(join(root, 'sub'), { recursive: true }); mkdirSync(join(dir, 'external')); writeFileSync(join(dir, 'external/file'), 'outside');
  symlinkSync('../external', join(root, 'sub'));
  assert.throws(() => b.capture(root), /Unsafe parent/); assert.deepEqual(e.read('main').heads, heads);
});

test('snapshot journal survives process restart and resumes already published files', t => {
  const { dir, root, e, b, filename } = fixture(t, true);
  writeFileSync(join(root, 'a'), 'one'); mkdirSync(join(root, 'nested')); writeFileSync(join(root, 'nested/b'), 'two'); b.attach('main', root);
  assert.throws(() => b.materialize('main', join(dir, 'view'), undefined, { afterWrite: () => { throw new Error('simulated interruption'); } }), /interruption/);
  const job = b.snapshots()[0]; assert.equal(job.complete, 0);
  const second = new Engine(filename); t.after(() => second.close()); const reopened = new Bridge(second);
  assert.ok(reopened.recover(job.id).complete);
  assert.equal(readFileSync(join(dir, 'view/nested/b'), 'utf8'), 'two');
  assert.equal(reopened.snapshots()[0].complete, 1);
});

test('recovery detects user edits without overwriting', t => {
  const { dir, root, e, b } = fixture(t);
  writeFileSync(join(root, 'a'), 'one'); writeFileSync(join(root, 'b'), 'two'); b.attach('main', root);
  assert.throws(() => b.materialize('main', join(dir, 'view'), undefined, { afterWrite: () => { throw new Error('stop'); } }), /stop/);
  const job = b.snapshots()[0]; writeFileSync(join(dir, 'view/a'), 'local changes');
  assert.throws(() => b.recover(job.id), /local edits/); assert.equal(readFileSync(join(dir, 'view/a'), 'utf8'), 'local changes');
  assert.equal(b.snapshots()[0].complete, 0);
});

test('journal recovers after SIGKILL during an active output transaction', t => {
  const { dir, root, e, b, filename } = fixture(t, true);
  writeFileSync(join(root, 'a'), 'one'); writeFileSync(join(root, 'b'), 'two'); b.attach('main', root);
  const script = `import {Engine} from './src/index.js'; import {Bridge} from './src/bridge.js';
    const e=new Engine(process.argv[1]); const b=new Bridge(e);
    b.materialize('main', process.argv[2], undefined, {afterWrite:()=>process.kill(process.pid,'SIGKILL')});`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script, filename, join(dir, 'killed-view')],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.ifError(run.error); assert.equal(run.signal, 'SIGKILL', run.stderr);
  const job = b.snapshots()[0]; assert.equal(job.complete, 0);
  assert.ok(b.recover(job.id).complete); assert.equal(readFileSync(join(dir, 'killed-view/b'), 'utf8'), 'two');
});

test('recovery rejects replacing a planned directory with a symlink', t => {
  const { dir, root, b } = fixture(t); mkdirSync(join(root, 'sub')); writeFileSync(join(root, 'sub/a'), 'one'); writeFileSync(join(root, 'sub/b'), 'two');
  b.attach('main', root);
  assert.throws(() => b.materialize('main', join(dir, 'view'), undefined, { afterWrite: () => { throw new Error('stop'); } }));
  rmSync(join(dir, 'view/sub'), { recursive: true }); mkdirSync(join(dir, 'outside')); symlinkSync('../outside', join(dir, 'view/sub'));
  assert.throws(() => b.recover(b.snapshots()[0].id), /Unsafe parent/);
  assert.equal(existsSync(join(dir, 'outside/b')), false);
});

test('ambiguous renames are recorded as delete/create rather than invented identities', t => {
  const { root, e, b } = fixture(t); writeFileSync(join(root, 'a'), 'same'); writeFileSync(join(root, 'b'), 'same'); b.attach('main', root);
  const ids = e.read('main').files.map(f => f.fileId);
  renameSync(join(root, 'a'), join(root, 'c')); renameSync(join(root, 'b'), join(root, 'd')); b.capture(root);
  assert.ok(e.read('main').files.filter(f => !f.deleted).every(f => !ids.includes(f.fileId)));
});

test('imports more than 100 files in one atomic observed snapshot', t => {
  const { root, e, b } = fixture(t);
  for (let n = 0; n < 120; n++) writeFileSync(join(root, `file-${n}`), `contents-${n}`);
  const result = b.attach('main', root); assert.equal(result.files, 120); assert.equal(result.operations, 120);
  assert.equal(e.read('main').files.length, 120);
});

test('polling watcher records an actual disk edit and shuts down on SIGTERM', { timeout: 10000 }, async t => {
  const { dir, root, e, b, filename } = fixture(t, true); writeFileSync(join(root, 'a'), 'before'); b.attach('main', root);
  const child = spawn(process.execPath, ['src/cli.js', filename, 'watch', root, '200'], { cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let output = ''; let errors = ''; let wrote = false;
  child.stderr.on('data', value => { errors += value; });
  child.stdout.on('data', value => {
    output += value;
    if (!wrote && output.includes('"watching"')) { wrote = true; writeFileSync(join(root, 'a'), 'after'); }
    if (output.includes('"capture"')) child.kill('SIGTERM');
  });
  const [code, signal] = await once(child, 'exit'); assert.equal(code, 0, errors); assert.equal(signal, null);
  assert.ok(output.includes('"capture"'), output); assert.equal(file(e, 'a').text, 'after');
});

test('interrupted output refuses changed ownership marker', t => {
  const { dir, root, b } = fixture(t); writeFileSync(join(root, 'a'), 'one'); b.attach('main', root);
  assert.throws(() => b.materialize('main', join(dir, 'view'), undefined, { afterWrite: () => { throw new Error('stop'); } }));
  writeFileSync(join(dir, 'view/.spool-snapshot.json'), '{"id":"other"}');
  assert.throws(() => b.recover(b.snapshots()[0].id), /ownership/);
});

test('recovery compares bytes even when an explicitly binary record is valid UTF-8', t => {
  const { dir, e, b } = fixture(t); e.create();
  submit(e, [{ type: 'file.create', fileId: 'binary', path: 'a', kind: 'binary', data: Buffer.from('hello').toString('base64') },
    { type: 'file.create', fileId: 'text', path: 'b', text: 'contains\0nul' }]);
  assert.throws(() => b.materialize('main', join(dir, 'view'), undefined, { afterWrite: () => { throw new Error('stop'); } }));
  assert.ok(b.recover(b.snapshots()[0].id).complete);
  assert.ok(b.recover(b.snapshots()[0].id).complete);
  assert.equal(readFileSync(join(dir, 'view/b'), 'utf8'), 'contains\0nul');
});

test('binary merge alternatives are explicit and a chosen current value resolves them', t => {
  const { e } = fixture(t); e.create();
  submit(e, [{ type: 'file.create', fileId: 'binary', path: 'a.bin', kind: 'binary', data: 'AA==' }]);
  e.fork('main', 'other');
  submit(e, [{ type: 'file.write', fileId: 'binary', kind: 'binary', data: 'AQ==' }]);
  e.submit('other', { actor: 'other', requestId: 'binary-change', expectedHeads: e.read('other').heads,
    operations: [{ type: 'file.write', fileId: 'binary', kind: 'binary', data: 'Ag==' }] });
  e.merge('main', 'other'); assert.equal(e.read('main').conflicts[0].field, 'data');
  submit(e, [{ type: 'file.write', fileId: 'binary', kind: 'binary', data: file(e, 'a.bin').data }]);
  assert.equal(e.read('main').conflicts.length, 0);
});

test('oversized files and non-root repositories fail without creating branches', t => {
  const { root, e, b } = fixture(t); mkdirSync(join(root, 'sub'));
  assert.throws(() => b.attach('main', join(root, 'sub')), /top-level/);
  writeFileSync(join(root, 'large'), Buffer.alloc(1_000_001)); assert.throws(() => b.attach('main', root), /1 MB/);
  assert.equal(e.refs().length, 0); assert.equal(b.sources().length, 0);
});

test('records commit identity and excludes its own SQLite files', t => {
  const { root, dir } = fixture(t); writeFileSync(join(root, 'a'), 'one'); git(root, 'add', '.');
  git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base');
  const e = new Engine(join(root, 'state.sqlite')); t.after(() => e.close()); const b = new Bridge(e);
  const result = b.attach('main', root); assert.equal(result.gitCommit, git(root, 'rev-parse', 'HEAD').trim());
  assert.ok(result.excluded.some(x => x.path === 'state.sqlite')); assert.equal(file(e, 'state.sqlite'), undefined);
  assert.throws(() => b.materialize('main', dir), /separate/);
});

test('CLI imports a real Git checkout and materializes it through JSONL', t => {
  const { dir, root } = fixture(t); writeFileSync(join(root, 'hello'), 'hello CLI');
  const run = spawnSync(process.execPath, ['src/cli.js', join(dir, 'cli.sqlite')], { cwd: new URL('..', import.meta.url), encoding: 'utf8',
    input: [ { command: 'git.attach', root, branch: 'main' }, { command: 'snapshot.create', branch: 'main', target: join(dir, 'cli-view') } ].map(JSON.stringify).join('\n') + '\n' });
  assert.ifError(run.error); assert.equal(run.status, 0, run.stderr);
  const rows = run.stdout.trim().split('\n').map(JSON.parse); assert.ok(rows.every(r => r.ok), run.stdout);
  assert.equal(readFileSync(join(dir, 'cli-view/hello'), 'utf8'), 'hello CLI');
});

test('unchanged captures avoid reconstructing file documents and invalidate the cache when the disk branch changes',t=>{
  const {root,e,b}=fixture(t);writeFileSync(join(root,'code.txt'),'disk');const attached=b.attach('main',root);
  const original=e.read.bind(e);let reads=0;e.read=(...args)=>{reads++;return original(...args);};
  assert.equal(b.capture(root).operations,0);assert.equal(reads,0);
  const f=original(attached.diskBranch).files[0];e.submit(attached.diskBranch,{actor:'external',requestId:crypto.randomUUID(),expectedHeads:e.ref(attached.diskBranch).heads,operations:[{type:'file.write',fileId:f.fileId,text:'different'}]});
  assert.equal(b.capture(root).operations,1);assert.ok(reads>0);assert.equal(file(e,'code.txt').text,'disk');
});
