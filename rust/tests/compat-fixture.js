import { decodeChange, getHeads } from '@automerge/automerge';
import { deflateRawSync } from 'node:zlib';
// Generate the fixture through the production JavaScript engine, not SQL mocks.
import { ShardedEngine } from '../../src/index.js';
import { MemoryStore } from '../../src/memory/store.js';
import { updateMemoryInput } from '../../src/memory/lifecycle.js';

const engine = new ShardedEngine(process.argv[2], {checkpointEvery: 1});
try {
  if (process.argv[3] === 'verify-native') {
    const native = engine.ref('rust-created');
    const expected = engine.create('bun-created', {room: 'interop-room'});
    if (JSON.stringify(native.heads) !== JSON.stringify(expected.heads)) {
      throw new Error('Rust and Bun disagree on the room genesis');
    }
    const bundle = engine.export('rust-created');
    console.log(JSON.stringify({native, bundle}));
  } else if (process.argv[3] === 'init-empty') {
    // Opening the engine initializes the current production schema.
  } else if (process.argv[3] === 'export-existing') {
    console.log(JSON.stringify(engine.export('relay-'+process.argv[4])));
  } else if (process.argv[3] === 'verify-existing-bundle') {
    const bundle = JSON.parse(await Bun.stdin.text());
    const peer = new ShardedEngine();
    try {
      peer.import('relay-'+bundle.room, bundle);
      const memory = new MemoryStore(peer, {referencesOnly: true});
      console.log(JSON.stringify(memory.run(bundle.room, {command: 'get', id: process.argv[4]})));
    } finally {
      peer.close();
    }
  } else if (process.argv[3] === 'verify-message') {
    const bundle = JSON.parse(await Bun.stdin.text());
    const native = engine.export('rust-created');
    if (JSON.stringify(native.heads) !== JSON.stringify(bundle.heads)) {
      throw new Error('Rust and Bun disagree on the exported frontier');
    }
    const peer = new ShardedEngine();
    try {
      const since = bundle.batches[0].parents;
      if (since.length) peer.import('from-rust', engine.export('rust-created', [], {heads: since}));
      peer.import('from-rust', bundle);
      const state = peer.read('from-rust');
      const genesis = peer.documents.scope(() => {
        const seed = peer.documents.seed(bundle.room, 'm:native-message');
        return getHeads(seed)[0];
      });
      const changes = bundle.documents.find(doc => doc.key === 'm:native-message').changes;
      if (decodeChange(Buffer.from(changes[0], 'base64')).hash !== genesis) {
        throw new Error('Rust and Bun disagree on the document genesis');
      }
      console.log(JSON.stringify(state.messages['native-message']));
    } finally {
      peer.close();
    }
  } else {
    const memory = new MemoryStore(engine, {referencesOnly: true});
    const {room} = engine.create('initial');
    engine.db.prepare('UPDATE shard_refs SET name=? WHERE name=?').run('relay-'+room, 'initial');
    const saved = memory.run(room, {
      command: 'remember', kind: 'finding', title: 'Migration fixture',
      text: 'Keep the original evidence. '.repeat(80), requestId: 'fixture',
    });
    memory.run(room, updateMemoryInput({
      action: 'archive', id: saved.id, expectedRevision: 0,
      reason: 'Historical fixture', requestId: 'archive-fixture',
    }));
    memory.run(room, {
      command: 'remember', kind: 'finding', title: 'Current migration evidence',
      text: 'Migration now preserves citations.', requestId: 'current-fixture',
    });
    const ref = engine.db.prepare('SELECT root FROM shard_refs WHERE room=?').get(room);
    // Exercise the BLOB encoding on the queried route, even when this tiny fixture
    // is too small for the production encoder to choose compression.
    const node = engine.manifest.node(ref.root);
    const compressed = deflateRawSync(Buffer.from(JSON.stringify(node)));
    engine.db.prepare('UPDATE shard_nodes SET body=? WHERE hash=?')
      .run(Buffer.concat([Buffer.from([1]), compressed]), ref.root);
    const descriptor = engine.manifest.get(ref.root, 'm:'+saved.id);
    const shard = engine.documents.scope(() =>
      JSON.parse(JSON.stringify(engine.documents.load(room, 'm:'+saved.id, descriptor.heads))));
    console.log(JSON.stringify({room, descriptor, shard, record: memory.run(room, {command:'get', id:saved.id})}));
  }
} finally {
  engine.close();
}
