import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Engine } from '../src/index.js';
import { Bridge } from '../src/bridge.js';

const temporary = mkdtempSync(join(tmpdir(), 'spool-demo-'));
const root = join(temporary, 'repo'); mkdirSync(root);
const engine = new Engine(join(temporary, 'history.sqlite')); const bridge = new Bridge(engine);
try {
  execFileSync('git', ['-C', root, 'init', '-q'], { stdio: 'pipe' });
  writeFileSync(join(root, '.gitignore'), '.env\n');
  writeFileSync(join(root, '.env'), 'LOCAL_ONLY=not-uploaded');
  writeFileSync(join(root, 'hello.txt'), 'hello world\r\n');
  bridge.attach('main', root);
  const original = engine.read('main').files.find(f => f.path === 'hello.txt');
  engine.submit('main', { actor: 'agent', harness: 'generic', requestId: 'agent-change', expectedHeads: engine.read('main').heads,
    operations: [{ type: 'file.splice', fileId: original.fileId, index: 11, deleteCount: 0, insert: '!' }] });
  writeFileSync(join(root, 'hello.txt'), 'local hello world\r\n');
  const observed = bridge.capture(root);
  const snapshot = bridge.materialize('main', join(temporary, 'review'));
  console.log(JSON.stringify({
    capturedOperations: observed.operations,
    source: readFileSync(join(root, 'hello.txt'), 'utf8'),
    mergedSnapshot: readFileSync(join(snapshot.root, 'hello.txt'), 'utf8'),
    secretCaptured: engine.read('main').files.some(f => f.path === '.env'),
    snapshotComplete: snapshot.complete,
    note: 'Temporary demo repository, database and output are removed on exit.',
  }, null, 2));
} finally { engine.close(); rmSync(temporary, { recursive: true, force: true }); }
