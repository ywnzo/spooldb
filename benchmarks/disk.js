import { statSync } from 'node:fs';
export function diskProfile(engine) {
  const files = Object.fromEntries(['', '-wal', '-shm'].map(suffix => {
    try { return [suffix || 'database', statSync(engine.filename + suffix).size]; } catch { return [suffix || 'database', 0]; }
  }));
  let tables;
  try { tables = engine.db.prepare('SELECT name,sum(pgsize) AS allocatedBytes,sum(payload) AS payloadBytes FROM dbstat GROUP BY name ORDER BY allocatedBytes DESC').all(); }
  catch { tables = null; }
  const payloads = {};
  for (const [table, column] of [['shard_nodes','body'], ['shard_changes','body'], ['shard_checkpoints','body'], ['shard_batches','body'], ['shard_receipts','input']]) {
    payloads[table] = engine.db.prepare(`SELECT count(*) AS rows,coalesce(sum(length(CAST(${column} AS BLOB))),0) AS bytes FROM ${table}`).get();
  }
  return { files, totalBytes: Object.values(files).reduce((a,b)=>a+b,0), tables, payloads,
    pageCount: engine.db.prepare('PRAGMA page_count').get().page_count, freePages: engine.db.prepare('PRAGMA freelist_count').get().freelist_count };
}
