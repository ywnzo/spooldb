import { execFileSync } from 'node:child_process';
import { constants, lstatSync, realpathSync, readlinkSync, openSync, closeSync, fstatSync,
  readFileSync, writeFileSync, mkdirSync, fsyncSync, fchmodSync, linkSync, unlinkSync, symlinkSync } from 'node:fs';
import { resolve, join, dirname, basename, relative, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { validatePath, content } from './index.js';

const MAX_BYTES = 1_000_000;
const MARKER = '.spool-snapshot.json';
const check = (ok, message) => { if (!ok) throw new Error(message); };
function stat(filename) { try { return lstatSync(filename); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
function git(root, args) {
  return execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', root, ...args], { maxBuffer: 16_000_000, timeout: 10000,
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } });
}
function safePath(value) {
  validatePath(value);
  check(!value.split('/').some(part => part.toLowerCase().startsWith('.spool')), 'Reserved bridge path');
  return value;
}
function parents(root, name, create = false) {
  safePath(name);
  const rootStat = lstatSync(root); check(rootStat.isDirectory() && !rootStat.isSymbolicLink(), 'Checkout root must be a real directory');
  let current = root;
  for (const part of name.split('/').slice(0, -1)) {
    current = join(current, part); let s = stat(current);
    if (!s && create) { mkdirSync(current, { mode: 0o700 }); syncDir(dirname(current)); s = lstatSync(current); }
    if (!s) return false;
    check(s.isDirectory() && !s.isSymbolicLink(), `Unsafe parent: ${name}`);
  }
  return true;
}
function bytes(entry) { return entry.kind === 'binary' ? Buffer.from(entry.data, 'base64') : Buffer.from(entry.text, 'utf8'); }
function fingerprint(entry) {
  return createHash('sha256').update(JSON.stringify({ kind: entry.kind, mode: entry.mode, text: entry.text, data: entry.data, target: entry.target })).digest('hex');
}
function sameDisk(actual, expected) {
  if (actual.kind === 'symlink' || expected.kind === 'symlink') return actual.kind === expected.kind && actual.target === expected.target;
  return actual.mode === expected.mode && bytes(actual).equals(bytes(expected));
}
function readEntry(root, name) {
  if (!parents(root, name)) return null;
  const filename = join(root, name); const s = stat(filename); if (!s) return null;
  if (s.isSymbolicLink()) return content({ kind: 'symlink', target: readlinkSync(filename), mode: 420 });
  check(s.isFile(), `Unsupported filesystem entry: ${name}`);
  check(s.size <= MAX_BYTES, `File exceeds 1 MB: ${name}`);
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  let data;
  try {
    const before = fstatSync(fd); check(before.isFile() && before.ino === s.ino && before.dev === s.dev, `File changed during scan: ${name}`);
    data = readFileSync(fd);
    const after = fstatSync(fd);
    check(data.length <= MAX_BYTES && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs, `File changed during scan: ${name}`);
  } finally { closeSync(fd); }
  const mode = s.mode & 0o111 ? 493 : 420;
  try {
    check(!data.includes(0), 'binary');
    return content({ text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data), mode });
  } catch { return content({ kind: 'binary', data: data.toString('base64'), mode }); }
}
function secretPath(name) {
  const part = basename(name).toLowerCase();
  return (/^\.env(?:\.|$)/.test(part) && !/\.(example|sample|template)$/.test(part)) ||
    /\.(pem|key|p12|pfx)$/.test(part) || /^(id_rsa|id_ed25519)$/.test(part);
}
function syncDir(root) { const fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } }
function readMarker(root) {
  const fd = openSync(join(root, MARKER), constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return JSON.parse(readFileSync(fd, 'utf8')); } finally { closeSync(fd); }
}

export class Bridge {
  constructor(engine) {
    this.engine = engine; this.db = engine.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS sources (
      root TEXT PRIMARY KEY, branch TEXT NOT NULL, disk_branch TEXT NOT NULL, git_commit TEXT);
      CREATE TABLE IF NOT EXISTS snapshots (
      id TEXT PRIMARY KEY, root TEXT UNIQUE NOT NULL, plan TEXT NOT NULL, complete INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS source_exclusions(root TEXT PRIMARY KEY, paths TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_scans(root TEXT PRIMARY KEY, signature TEXT NOT NULL, disk_heads TEXT NOT NULL);`);
  }
  setExclusions(root, paths) {
    root=realpathSync(root);
    check(!this.db.prepare('SELECT 1 FROM sources WHERE root=?').get(root),'Exclusions must be configured before attaching');
    check(Array.isArray(paths)&&paths.length<=1000,'Invalid exclusion list');
    const normalized=[...new Set(paths.map(path=>safePath(path.replace(/\/$/,''))))].sort();
    this.db.prepare('INSERT INTO source_exclusions VALUES(?,?) ON CONFLICT(root) DO UPDATE SET paths=excluded.paths').run(root,JSON.stringify(normalized));
  }
  scan(root) {
    root = realpathSync(root);
    const exclusions=JSON.parse(this.db.prepare('SELECT paths FROM source_exclusions WHERE root=?').get(root)?.paths??'[]');
    check(realpathSync(git(root, ['rev-parse', '--show-toplevel']).toString().trim()) === root, 'Choose the top-level Git checkout');
    const stage = git(root, ['ls-files', '--stage', '-z']).toString('utf8').split('\0').filter(Boolean);
    const submodules=stage.filter(line=>line.startsWith('160000 ')).map(line=>line.slice(line.indexOf('\t')+1));
    check(!stage.some(line => !/^\d+ [a-f0-9]+ 0\t/.test(line)), 'Resolve Git index conflicts before capturing');
    const names = new TextDecoder('utf-8', { fatal: true }).decode(git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']))
      .split('\0').filter(Boolean);
    check(names.length <= 10000, 'Checkout exceeds 10000 listed paths');
    const excluded = []; const entries = Object.create(null);
    for (const name of [...new Set(names)].sort()) {
      if(submodules.some(path=>name===path||name.startsWith(path+'/'))){excluded.push({path:name,reason:'git-submodule-reference'});continue;}
      if(exclusions.some(path=>name===path||name.startsWith(path+'/'))) {excluded.push({path:name,reason:'configured-exclusion'});continue;}
      if (secretPath(name) || name.split('/').some(p => p.toLowerCase().startsWith('.spool')) ||
          [this.engine.filename, `${this.engine.filename}-wal`, `${this.engine.filename}-shm`].includes(join(root, name))) {
        excluded.push({ path: name, reason: 'local-state-or-secret-pattern' }); continue;
      }
      safePath(name); const entry = readEntry(root, name); if (entry) entries[name] = entry;
    }
    check(JSON.stringify(entries).length <= 12_000_000, 'Checkout snapshot exceeds 12 MB');
    let gitCommit = null;
    try { gitCommit = git(root, ['rev-parse', '--verify', 'HEAD']).toString().trim(); } catch { /* unborn repository */ }
    return { root, entries, excluded, gitCommit };
  }
  attach(branch, root) {
    const scan = this.scan(root);
    return this.engine.transaction(() => {
      check(!this.db.prepare('SELECT 1 FROM sources WHERE root=?').get(scan.root), 'Checkout already attached');
      const ref = this.engine.refs().find(r => r.branch === branch);
      if (!ref) this.engine.create(branch);
      check(this.engine.read(branch).files.length === 0, 'Initial Git import requires an empty branch');
      const diskBranch = `disk-${randomUUID()}`;
      this.engine.fork(branch, diskBranch);
      this.db.prepare('INSERT INTO sources VALUES(?,?,?,?)').run(scan.root, branch, diskBranch, scan.gitCommit);
      return this.captureScan(scan);
    });
  }
  capture(root, context = {}) { return this.captureScan(this.scan(root), context); }
  captureScan(scan, context = {}) {
    return this.engine.transaction(() => {
      const source = this.db.prepare('SELECT * FROM sources WHERE root=?').get(scan.root);
      check(source, 'Checkout is not attached');
      const signature=createHash('sha256').update(JSON.stringify(scan.entries)).digest('hex');
      const diskHeads=JSON.stringify(this.engine.ref(source.disk_branch).heads);
      const previous=this.db.prepare('SELECT signature,disk_heads FROM source_scans WHERE root=?').get(scan.root);
      if(previous?.signature===signature&&previous.disk_heads===diskHeads) {
        this.db.prepare('UPDATE sources SET git_commit=? WHERE root=?').run(scan.gitCommit,scan.root);
        return {branch:source.branch,heads:this.engine.ref(source.branch).heads,diskBranch:source.disk_branch,operations:0,files:Object.keys(scan.entries).length,gitCommit:scan.gitCommit,excluded:scan.excluded};
      }
      const current = this.engine.read(source.disk_branch);
      const live = new Map(current.files.filter(f => !f.deleted).map(f => [f.path, f]));
      const operations = [];
      const removed = [...live].filter(([name]) => !Object.hasOwn(scan.entries, name));
      const added = Object.entries(scan.entries).filter(([name]) => !live.has(name));
      const renames = new Map(); const renamedIds = new Set();
      const removedByHash = new Map(); const addedCounts = new Map();
      for (const [, f] of removed) {
        const hash = fingerprint(content(f)); const group = removedByHash.get(hash) ?? [];
        group.push(f); removedByHash.set(hash, group);
      }
      for (const [, entry] of added) { const hash = fingerprint(entry); addedCounts.set(hash, (addedCounts.get(hash) ?? 0) + 1); }
      for (const [name, entry] of added) {
        const hash = fingerprint(entry);
        const matches = removedByHash.get(hash) ?? [];
        if (matches.length === 1 && addedCounts.get(hash) === 1) {
          renames.set(name, matches[0]); renamedIds.add(matches[0].fileId);
        }
      }
      // Delete first so newly observed paths can replace old entries safely.
      for (const [, f] of removed) if (!renamedIds.has(f.fileId)) operations.push({ type: 'file.delete', fileId: f.fileId });
      for (const [name, entry] of Object.entries(scan.entries)) {
        const existing = live.get(name);
        if (renames.has(name)) operations.push({ type: 'file.rename', fileId: renames.get(name).fileId, path: name });
        else if (!existing) operations.push({ type: 'file.create', fileId: randomUUID(), path: name, ...entry });
        else if (fingerprint(content(existing)) !== fingerprint(entry)) operations.push({ type: 'file.write', fileId: existing.fileId, ...entry });
      }
      let result = { ...this.engine.ref(source.branch), branch: source.branch };
      if (operations.length) {
        this.engine.submit(source.disk_branch, { actor: 'unknown', harness: 'filesystem', evidence: 'observed-disk-snapshot',
          ...Object.fromEntries(['sessionId', 'turnId', 'toolCallId', 'messageId', 'observedAfter'].filter(k => context[k] !== undefined).map(k => [k, context[k]])),
          ...(scan.gitCommit ? { gitCommit: scan.gitCommit } : {}), requestId: randomUUID(), expectedHeads: current.heads, operations });
        result = this.engine.merge(source.branch, source.disk_branch);
      }
      this.db.prepare('UPDATE sources SET git_commit=? WHERE root=?').run(scan.gitCommit, scan.root);
      this.db.prepare('INSERT INTO source_scans VALUES(?,?,?) ON CONFLICT(root) DO UPDATE SET signature=excluded.signature,disk_heads=excluded.disk_heads')
        .run(scan.root,signature,JSON.stringify(this.engine.ref(source.disk_branch).heads));
      return { branch: source.branch, heads: result.heads, diskBranch: source.disk_branch, operations: operations.length,
        files: Object.keys(scan.entries).length, gitCommit: scan.gitCommit, excluded: scan.excluded };
    });
  }
  sources() { return this.db.prepare('SELECT root,branch,disk_branch AS diskBranch,git_commit AS gitCommit FROM sources ORDER BY root').all(); }
  materialize(branch, target, heads, options = {}) {
    const state = this.engine.read(branch, heads);
    check(state.conflicts.length === 0, 'Resolve recorded conflicts before materialization');
    const root = join(realpathSync(dirname(resolve(target))), basename(resolve(target)));
    const plan = { branch, room: state.room, heads: state.heads, files: state.files.filter(f => !f.deleted).map(f => ({ path: f.path, ...content(f) })) };
    this.validatePlan(plan);
    // Do not create snapshots inside a source checkout or its ancestor.
    for (const source of this.sources()) {
      const a = relative(source.root, root); const b = relative(root, source.root);
      check(a.startsWith('..' + '/') && b.startsWith('..' + '/'), 'Snapshot must be separate from attached source checkouts');
    }
    const jobId = randomUUID();
    mkdirSync(root, { mode: 0o700 }); // Exclusive claim. Existing destinations are never adopted.
    const fd = openSync(join(root, MARKER), 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify({ id: jobId, room: state.room, heads: state.heads })); fsyncSync(fd); } finally { closeSync(fd); }
    syncDir(root); syncDir(dirname(root));
    this.db.prepare('INSERT INTO snapshots(id,root,plan) VALUES(?,?,?)').run(jobId, root, JSON.stringify(plan));
    return this.recover(jobId, options);
  }
  validatePlan(plan) {
    const names = new Set(); const casing = new Map();
    for (const f of plan.files) {
      safePath(f.path); content(f);
      const portable = f.path.normalize('NFC').toLowerCase();
      check(!names.has(portable), 'Case or Unicode path collision'); names.add(portable);
      const parts = f.path.split('/');
      for (let n = 1; n <= parts.length; n++) {
        const prefix = parts.slice(0, n).join('/'); const folded = prefix.normalize('NFC').toLowerCase();
        check(!casing.has(folded) || casing.get(folded) === prefix, 'Case or Unicode directory collision'); casing.set(folded, prefix);
      }
      if (f.kind === 'symlink') {
        const target = resolve('/', dirname(f.path), f.target);
        check(!isAbsolute(f.target) && !f.target.includes('\\') && !f.target.split('/').includes('..') &&
          !relative('/', target).split('/').some(p => p.toLowerCase() === '.git'), `Unsafe symlink target: ${f.path}`);
        // Lexical traversal is checked relative to a synthetic root, not clamped at '/'.
        const rel = relative('/spool-root', resolve('/spool-root', dirname(f.path), f.target));
        check(rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel), `Symlink escapes snapshot: ${f.path}`);
      }
    }
    for (const name of names) {
      const parts = name.split('/'); parts.pop();
      while (parts.length) { check(!names.has(parts.join('/')), 'File/directory path collision'); parts.pop(); }
    }
  }
  snapshots() { return this.db.prepare('SELECT id,root,complete FROM snapshots ORDER BY rowid').all(); }
  recover(jobId, { afterWrite } = {}) {
    return this.engine.transaction(() => this.recoverJob(jobId, { afterWrite }));
  }
  recoverJob(jobId, { afterWrite } = {}) {
    const job = this.db.prepare('SELECT * FROM snapshots WHERE id=?').get(jobId); check(job, 'Unknown snapshot');
    const plan = JSON.parse(job.plan); this.validatePlan(plan);
    const root = job.root; const s = lstatSync(root); check(s.isDirectory() && !s.isSymbolicLink() && realpathSync(root) === root, 'Snapshot root changed');
    check(readMarker(root).id === jobId, 'Snapshot ownership marker changed');
    let written = 0;
    for (const f of plan.files) {
      parents(root, f.path, true);
      const actual = readEntry(root, f.path);
      if (actual) { check(sameDisk(actual, content(f)), `Snapshot has local edits: ${f.path}`); continue; }
      check(!job.complete, `Completed snapshot has missing file: ${f.path}`);
      const filename = join(root, f.path);
      if (f.kind === 'symlink') symlinkSync(f.target, filename);
      else {
        const temp = join(dirname(filename), `.spool-temp-${jobId}`);
        // Temp names are private to this job; recreate a partial temp after a crash.
        if (stat(temp)) { check(lstatSync(temp).isFile() && !lstatSync(temp).isSymbolicLink(), 'Unsafe staging file'); unlinkSync(temp); }
        const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { writeFileSync(fd, bytes(f)); fchmodSync(fd, f.mode); fsyncSync(fd); } finally { closeSync(fd); }
        parents(root, f.path);
        linkSync(temp, filename); // Exclusive publish: cannot replace a concurrently created path.
        unlinkSync(temp);
      }
      syncDir(dirname(filename)); written++;
      if (afterWrite) afterWrite({ written, path: f.path });
    }
    this.db.prepare('UPDATE snapshots SET complete=1 WHERE id=?').run(jobId);
    return { id: jobId, root, branch: plan.branch, heads: plan.heads, files: plan.files.length, complete: true };
  }
}
