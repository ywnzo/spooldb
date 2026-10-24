# Sharded storage, checkpoints and measured limits

The new storage engine is opt-in. It separates file state and conversation records, publishes mixed operations atomically and can reconstruct a selected file without loading the rest of the room. It is a local SQLite implementation, not a distributed server.

## Open a new-format database

```sh
printf '%s\n' '{"command":"init","branch":"main"}' \
  '{"command":"storage.stats"}' \
  | node src/cli.js ./sharded.sqlite --sharded
```

`--sharded` may also be used with `run` and `watch`. Keep that flag on subsequent openings of the same database. Opening it through the legacy engine fails with an explicit layout error. Existing legacy databases stay readable through the original engine; opening one with the sharded engine also fails rather than migrating it. No data is deleted or rewritten by a conversion. There is currently no automatic migration of legacy histories, anchors or bundles.

Library clients may use the named, typed API:

```js
import { ShardedEngine } from 'spooldb';
const engine = new ShardedEngine('sharded.sqlite', {
  checkpointEvery: 128,
  cacheEntries: 64,
  cacheBytes: 32 * 1024 * 1024,
});
```

The existing `new Engine(filename, { layout: 'sharded' })` factory works too. Omitting the option preserves legacy behavior. No new model provider, storage service or account is required.

## Document boundaries

Every file has its own Automerge document, keyed by stable file identity. Each message, code comment and normalized adapter event has an independent record document. Rename, deletion, text and executable/binary metadata stay with the file. Comments store cursors into the file document; they do not depend on a transcript text copy.

Record-per-document is intentionally simple. It isolates reads but adds overhead for many tiny messages. Conversation chunks, immutable content-addressed binary blobs and packed archival changes are not implemented. The format does not claim compatibility with DeltaDB.

A content-addressed manifest maps document IDs to causal frontiers. Its radix tree shares unchanged nodes between versions, with four hexadecimal levels and bucket leaves. File path entries are derived metadata, so path checks and file listings need not load file contents. A single-file edit copies a bounded tree path rather than serializing a complete worktree map. Within a transaction, new nodes are staged: only nodes reachable from a committed batch, branch or cached historical frontier are written. Private intermediate roots are discarded. Every logical edit still produces its own Automerge change; batching does not collapse retained CRDT history.

## Atomic mixed operations

A global batch records parent batch IDs, the manifest root, provenance and updated shard frontiers. The global batch hash is the room version address; file CRDT hashes remain internal document versions. Branches point to a global frontier and root. A fork at an existing single version adds a ref and shares stored nodes/deltas. A merge combines causal global heads and merges changed document frontiers.

`submit` writes shard changes, optional checkpoints, manifest nodes, a global batch, the ref and the retry receipt inside one SQLite transaction. Other connections see the old complete ref until commit. A failed later operation or failed persistence rolls everything back. In-memory caches are cleared on rollback so an aborted import cannot make missing data appear present.

Import verifies content hashes and reconstructs each batch's manifest from its parents and declared shard updates before publishing it. Missing document changes, missing global parents, wrong manifests or invalid records abort the whole import. Concurrent renames, duplicate paths, binary alternatives and reused entity IDs remain visible conflicts. Converged text is not proof of valid code.

## Selective reads

```json
{"command":"file.read","branch":"main","fileId":"FILE_ID"}
{"command":"files.list","branch":"main","options":{"limit":100}}
{"command":"records.read","branch":"main","options":{"kind":"messages","limit":100}}
{"command":"storage.stats"}
```

`file.read` loads only that file document plus manifest metadata; optional `heads` selects a global historical version. `files.list` returns IDs/paths/deletion flags without loading text. `records.read` accepts `messages`, `comments` or `adapterEvents` and loads only the selected page's documents. Pages use ID order with an `after` cursor, not chronological order. Use native stream sequence/part or causal history for conversation ordering.

Record pages default to an 8 MiB serialized-record budget, configurable with `byteLimit` up to 16 MiB. A page returns its byte count and can stop before the record-count limit. It may decode one extra candidate to determine whether it fits. An individually oversized record fails explicitly instead of returning a cursor that cannot advance. Public historical heads must include at least the room genesis; `since: []` remains the supported base for a full export.

Metadata page discovery currently traverses the manifest and filters/sorts matching keys. It bounds document materialization, not the cost of finding every candidate key. `read` remains an explicit full-room snapshot for compatibility, and the filesystem bridge still performs whole-checkout scans. Global history/trace queries and multi-head merges can walk causal history. These paths need additional indexing before a million-operation claim.

## Checkpoints and memory ownership

The default creates a checkpoint after 128 newly stored changes in a document, including its genesis, and retains the two most recently inserted checkpoints per document. `checkpointEvery: 0` disables automatic creation; `checkpointKeep: 0` retains all checkpoints. Checkpoints are derived compressed Automerge snapshots plus SHA-256 checksums. Evicting one preserves raw changes and anchors, but an old version or a less active branch may need a full replay. On a cold load, the engine selects a checkpoint whose entire frontier is ancestral to the requested document version, then applies only the missing tail. A checkpoint from a different branch cannot inject that branch's edits. Corrupt checkpoint bytes are discarded and rebuilt from retained deltas on demand.

```json
{"command":"storage.checkpoint","branch":"main","options":{"fileId":"FILE_ID"}}
{"command":"storage.clearCache"}
{"command":"storage.stats","options":{"resetMetrics":true}}
```

Omit `fileId` to checkpoint every document referenced by the branch. This does not prune history, alter version IDs or rewrite cursor anchors. Cold loading still walks the selected file's causal graph in SQL; checkpointing reduces decoded/replayed deltas, not all history work. Recursive queries force parent-first indexed lookups to avoid rescanning every document change for each ancestor. The join ordering follows SQLite's documented [CROSS JOIN behavior](https://sqlite.org/optoverview.html#manual_control_of_query_plans_using_cross_join).

The cache owns compressed byte snapshots, not live WebAssembly documents. It has both entry and byte limits, with defaults of 64 entries/32 MiB. Temporary CRDT backends are explicitly freed after each public operation; full-room and import loops release completed document work as they go. Prepared SQL statements are reused. This avoids relying on JavaScript finalizers to run during a long synchronous write loop.

`storage.stats` reports cache hits, SQL document loads, checkpoint loads, replayed change counts, corrupt-checkpoint fallbacks, active temporary handles, cache bytes/limits and database object counts. Cache bytes are compressed payload bytes only. They do not cap RSS: the Wasm linear heap, SQLite, JavaScript state, manifests and returned results consume additional memory. Checkpoints retain file history and a file with many edits can still become expensive to load.

## Replication and compatibility

Manifest nodes, global batch bodies and retry inputs now use versioned DEFLATE BLOBs when smaller than JSON TEXT. Current readers accept both encodings; older application versions cannot read the new BLOB rows. Use the current engine when reopening a database written by this version. Content hashes and the v2 wire format are unchanged. Raw Automerge change bodies and exact retry semantics remain retained.

Sharded exports use `spool/2`, schema 2, containing global batches, immutable manifest nodes and per-document changes. Legacy exports remain `spool/1`. Neither engine silently converts the other's bundles. Full and `since`-based incremental export/import are supported for trusted replicas of the same room. A branch can use room data already present elsewhere in the local database; a truly empty database must receive the required base dependencies.

Full bundles remain limited to 16 MB, and an oversized full export fails explicitly. `exportPage` and the [authenticated HTTP relay](relay.md) now paginate complete global batches with byte/count limits; one oversized atomic batch still cannot be split. Export/page discovery walks reachable history and manifest nodes. Whole-room replication is implemented; file-level network selection and streaming fragments within one batch remain future work. Local adapter receipts, stream supervisor state, source attachments and snapshot jobs retain their existing local-only semantics.

## Reclaim existing disk space

```json
{"command":"storage.compact","options":{"vacuum":true}}
```

The library equivalent is `engine.compact({ vacuum: true })`. Compaction marks manifest nodes reachable from **every** stored batch, cached version and branch across all rooms, removes only unreachable nodes, compresses old TEXT rows, and applies the configured checkpoint retention. It preserves historical roots, raw changes, receipts and anchor identities. Run it with the current engine and a backup for valuable data; it is a maintenance operation that acquires the SQLite writer lock.

Logical compaction is one transaction and cannot run inside an existing transaction. Optional `VACUUM` follows that commit to repack free pages, then a WAL truncate is requested. Other active readers can prevent WAL truncation; `walBusy` reports that condition. A vacuum error can occur after logical compaction has committed. Vacuum can require additional temporary disk space. SQLite documents [VACUUM behavior](https://www.sqlite.org/lang_vacuum.html); physical allocation is measured with [dbstat](https://www.sqlite.org/dbstat.html) where supported.

Default new writes avoid temporary-node overhead without requiring compaction. Retained historical manifests, raw deltas, indexes and per-record document overhead still grow. This is lossless cleanup, not history pruning or packed archival storage.

## Verification and benchmarks

The original engine behaviors are tested against both layouts. Additional tests cover selective reads, bounded tail replay, historical checkpoint selection, corrupt-checkpoint fallback, cache budgets, shared forks, rollback after shard persistence, publication across two SQLite connections, invalid/partial imports, comments created after an edit in the same batch, bridge/adapter compatibility and ten offline replicas editing shared and separate file shards.

```sh
npm test
npm run typecheck
npm run benchmark
npm run benchmark:large
npm run benchmark:million
```

See [benchmark method and results](../benchmarks/README.md), [disk comparison JSON](../benchmarks/disk-optimized-results.json) and [million-edit JSON](../benchmarks/million-results.json). The million-edit run verified every file before and after compaction/reopening, 16 historical files and anchors, the exact 1,002,000-change count including setup, and SQLite integrity. It used 10,000 edit transactions across 1,000 files. Reported results are synthetic local measurements, not a service SLA, multi-host load test or evidence of a million independent commits.
