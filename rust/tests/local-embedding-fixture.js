import assert from 'node:assert/strict';
import {localEmbeddings} from '../../src/memory/local-embeddings.js';

const [binary, model = 'multilingual'] = process.argv.slice(2);
const cacheDir = process.env.SPOOL_MODEL_CACHE;
assert.ok(binary, 'Pass the compiled spool-native binary');
assert.ok(cacheDir, 'Set SPOOL_MODEL_CACHE to a cache containing the pinned model');
assert.ok(process.env.ORT_DYLIB_PATH, 'Set ORT_DYLIB_PATH to the ONNX shared library');

const texts = [
  'An English finding about authentication.',
  'Přihlášení uživatele a tvorba faktur.',
  ('Repeated evidence for the token length boundary. ').repeat(90),
];
const previous = localEmbeddings({model, cacheDir, threads: 2});
try {
  const rust = Bun.spawnSync([binary, 'local-embed', model], {
    stdin: Buffer.from(JSON.stringify(texts)),
  });
  assert.equal(rust.exitCode, 0, rust.stderr.toString());
  const output = JSON.parse(rust.stdout);
  assert.equal(output.model, previous.id);
  const expected = await previous.embed(texts);
  assert.equal(output.vectors.length, expected.length);
  for (const [index, values] of output.vectors.entries()) {
    assert.equal(values.length, 384);
    const reference = expected[index];
    const maxError = Math.max(...values.map((value, axis) => Math.abs(value - reference[axis])));
    assert.ok(maxError < 0.00001, `Embedding ${index} differs from the previous model output by ${maxError}`);
  }
} finally {
  await previous.dispose();
}

const {Database} = await import('bun:sqlite');
const {mkdtempSync,rmSync,writeFileSync} = await import('node:fs');
const {tmpdir} = await import('node:os');
const {join} = await import('node:path');
const {RelayServer,createCredential} = await import('../../src/relay/server.js');
const directory = mkdtempSync(join(tmpdir(),'spool-local-embedding-'));
const database = join(directory,'relay.sqlite');
const config = join(directory,'host.json');
const room = 'local-vectors';
const {token,credential} = createCredential('reader',{[room]:'read'});
const legacy = new RelayServer(database);
legacy.engine.create('relay-'+room,{room});
const finding = legacy.memory.run(room,{command:'remember',kind:'finding',title:'České ověření',
  text:'Ověření uživatelských oprávnění.',requestId:'fixture-finding'},{id:'writer'});
const unindexed = legacy.memory.run(room,{command:'remember',kind:'finding',title:'Klientská správa',
  text:'Konfigurace platebních metod.',requestId:'fixture-backlog'},{id:'writer'});
legacy.memory.run(room,{command:'search',query:'ověření'},{id:'writer'});
await legacy.close();
writeFileSync(config,JSON.stringify({credentials:[credential],projects:[{room,name:"Model fixture"}]}));
const db = new Database(database);
const referenceModel = localEmbeddings({model,cacheDir,threads:2});
try {
  const query = 'Authentication permissions';
  const [embedding] = await referenceModel.embed([query]);
  db.exec(`CREATE TABLE retrieval_settings(id INTEGER PRIMARY KEY,revision INTEGER,data TEXT);
    CREATE TABLE IF NOT EXISTS memory_vectors(room TEXT,id TEXT,model TEXT,fingerprint TEXT,chunk INTEGER,vector BLOB,
      PRIMARY KEY(room,id,model,chunk));`);
  db.prepare('INSERT INTO retrieval_settings VALUES(1,1,?)')
    .run(JSON.stringify({enabled:true,provider:'local',model,threads:2}));
  db.prepare('INSERT INTO memory_vectors SELECT room,id,?,fingerprint,0,? FROM memory_docs WHERE room=? AND id=?')
    .run(referenceModel.id,new Float32Array(embedding),room,finding.id);
  db.close();
  const child = Bun.spawn([binary,'relay',database,config,'127.0.0.1:0'],{stdout:'pipe',stderr:'inherit'});
  try {
    const {value} = await child.stdout.getReader().read();
    const address = Buffer.from(value).toString().trim();
    const observer = new Database(database,{readonly:true});
    try {
      const indexed = observer.prepare('SELECT length(vector) AS bytes FROM memory_vectors WHERE room=? AND id=? AND model=?');
      const deadline = Date.now()+12000;
      while (!indexed.get(room,unindexed.id,referenceModel.id) && Date.now()<deadline) {
        await Bun.sleep(50);
      }
      assert.equal(indexed.get(room,unindexed.id,referenceModel.id)?.bytes,1536);
    } finally {
      observer.close();
    }
    const request = await fetch(`http://${address}/v1/rooms/${room}/memory`,{
      method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},
      body:JSON.stringify({command:'search',query}),
    });
    const result = await request.json();
    assert.equal(request.status,200,JSON.stringify(result));
    assert.equal(result.retrieval.model,referenceModel.id);
    assert.equal(result.results[0].id,finding.id);
    assert.ok(result.results[0].match.semantic > 0.99999);
  } finally {
    child.kill();
    await child.exited;
  }
} finally {
  await referenceModel.dispose();
  rmSync(directory,{recursive:true,force:true});
}
