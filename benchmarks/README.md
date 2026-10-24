# Reproducible storage benchmarks

Run `bun run benchmark` for the comparison profile, `bun run benchmark:large` for the 10,000-file profile, or `bun run benchmark:million` for the million-edit profile. They use temporary SQLite databases and remove them afterward. The saved reports contain runtime/CPU information and exact workloads. Existing reports are overwritten only by an explicit benchmark run. Run these profiles separately from tests and other benchmarks.

## Method

The comparison uses a separate Node worker for each layout: legacy, sharded without checkpoints, and sharded with a checkpoint interval of 32. All receive the same 100 files, 200 messages, 1 KiB text per initial record and 200 leading single-character edits to one file. Five file reads clear the engine's application caches; thirty reads reuse them. OS disk caches are not dropped. The benchmark also records initial creation, fork latency, disk footprint before closing SQLite, total wall time and process peak RSS.

The comparison explicitly runs GC and yields to the event loop between samples for both layouts. GC is excluded from individual call times but included in total wall time. This gives the legacy engine's finalizers a chance to release temporary CRDT backends; it does not represent sustained production throughput. Medians/p95 come from one local run, without confidence intervals.

The larger profile uses 10,000 files, 1,000 messages, 256-byte initial records and 2,000 edits to one file, with checkpoints every 128 shard changes. It disables explicit GC and event-loop yields between calls to exercise the new engine's explicit resource ownership. It is a local synthetic test, not a substitute for a real repository, distributed relay or million-operation run. Repetitive text is compressible and does not cover all source/binary entropy patterns.

The reports include the full database, WAL and SHM size before connection close; this can exceed the final post-checkpoint file size. New writes avoid private intermediate manifest roots, compress stored JSON and keep two derived checkpoints per document. Lossless maintenance removes unreachable nodes, upgrades old TEXT rows and optionally vacuums SQLite. Raw changes and all committed historical manifests remain retained. Table-level allocation uses SQLite `dbstat` when available; payload byte counts are also recorded.

The million-edit profile uses 1,000 files of 256 bytes, populated with deterministic SHA-256 hex text, and ten round-robin visits to each file. Each visit submits 100 first-character replacements in one atomic batch. There are **1,000,000 logical edits, 1,000,000 corresponding Automerge changes, and 10,000 edit transactions**, plus file-creation setup. Text stays bounded while tombstones and history grow. This is not a million independent commits or a single million-change hot file. It uses no explicit GC, yields after each batch and retains the default 64-document byte cache. Checkpoints are created after a batch crosses the 128-change threshold; only two snapshots per file are kept.

It verifies every final file, every file after compaction/reopening, sampled historical versions and stable anchors, the exact raw-change count, and SQLite integrity. It records batch latency, total write time, progress/RSS and both live and vacuumed disk sizes. `bun benchmarks/million.js --operations=10000 --files=100 --batch-size=100 --output=benchmarks/million-pilot-results.json` is the smaller diagnostic profile. Failures are saved with their phase and completed edit count.

## Findings retained during development

The first comparison, without event-loop yields/forced GC, exhausted the legacy engine's Automerge WebAssembly allocator. [Initial failure](initial-baseline-failure.json) records the workload and the absence of a captured peak-RSS/sample count. The final comparison grants both layouts the same GC opportunity. This failure is not hidden by a smaller workload.

The first larger-profile run completed but exposed an approximately 823 ms cold file read. Its SQLite plan scanned all changes of a file inside each recursive parent step. Parent-first indexed traversal fixed that query shape. [Initial larger result](initial-large-results.json) and [initial comparison](initial-comparison-results.json) are preserved separately from the final results. The initial comparison overlapped briefly with regression tests, so it is not the final controlled comparison.

Checkpointing guarantees fewer deltas decoded after a suitable checkpoint; it does not guarantee lower latency for short histories. The small initial run decoded 10 changes with checkpoints versus 202 without them, yet its checkpoint read was slower. Use the final JSON and profile sizes rather than assuming that every cache or checkpoint setting wins on every workload.

## Results before disk optimization

Measured on AMD Ryzen 5 5500, Node v26.11.1; single local runs. See [comparison JSON](results.json) and [large-workload JSON](large-results.json) for all samples and counters.

| 100-file comparison | Write p50 / p95 (ms) | Cold file read p50 (ms) | Hot file read p50 (ms) | Peak RSS (MiB) | DB + WAL + SHM (MiB) |
| --- | ---: | ---: | ---: | ---: | ---: |
| legacy | 387.24 / 408.14 | 407.99 | 409.88 | 453.65 | 4.89 |
| sharded (checkpoint interval 0) | 2.59 / 3.92 | 6.19 | 1.77 | 147.93 | 7.55 |
| sharded (checkpoint interval 32) | 2.57 / 2.98 | 4.67 | 1.80 | 146.32 | 7.58 |

The separate 10,000-file / 1,000-message / 2,000-edit run completed and verified the final text and original anchor. With checkpoint interval 128 and no explicit GC/yields, it measured:

- File creation: 25.35 s; message creation: 2.20 s; total wall time: 42.22 s.
- Writes: 6.67 ms median, 13.36 ms p95.
- Single-file reads: 38.98 ms cold median, 10.38 ms hot median.
- Fork: 0.33 ms; peak RSS: 265.49 MiB; DB + WAL + SHM: 250.16 MiB.
- One cold read replayed 82 changes from a checkpoint. No temporary CRDT handles remained after operations.

The indexed traversal reduced the earlier large-run cold median from 822.78 ms to 38.98 ms. The storage footprint is still high for this small, compressible content payload: immutable nodes and changes are retained without packing or garbage collection. These runs establish local behavior only; they do not establish multi-host scalability or million-operation capacity.

## Disk-overhead improvement

The same 10,000-file / 1,000-message / 2,000-edit profile was run before and after the storage changes, separately from tests and the million-edit run. [Baseline](disk-baseline-results.json) and [optimized report](disk-optimized-results.json) include table allocation and payload counts.

| Measurement | Before | After |
| --- | ---: | ---: |
| Live database + WAL + SHM | 250.15 MiB | 72.08 MiB |
| Manifest nodes | 115,000 | 33,715 |
| Encoded manifest payload | 76.86 MiB | 11.30 MiB |
| Raw CRDT changes retained | 24,000 | 24,000 |
| Derived checkpoints retained | 15 | 2 |
| Write median / p95 | 6.39 / 12.98 ms | 6.56 / 13.14 ms |
| Cold file read median | 38.86 ms | 37.87 ms |
| Peak process RSS | 269.77 MiB | 285.51 MiB |

Live disk use fell **71.19%** with the same raw-change count. The optimized database occupied 44.37 MiB after maintenance/vacuum and WAL truncation; that smaller number is reported separately rather than compared against a baseline that still includes its WAL. This is lossless cleanup of private roots and derived data, plus metadata compression. It is not history pruning.

Staging initially increased bulk-creation peak RSS to 370.27 MiB. Periodic removal of private staged roots lowered it to 285.51 MiB in the final run, still above the baseline. The optimized worker's peak covers its added maintenance check too. [Initial optimized report](disk-initial-optimized-results.json) is retained to make this tradeoff visible. The final worker verified text and the original anchor again after maintenance.

## Million-edit result

[Saved report](million-results.json): **completed and verified** on AMD Ryzen 5 5500, Node v26.11.1.

| Measurement | Result |
| --- | ---: |
| Logical edits / retained edit changes | 1,000,000 / 1,000,000 |
| Edit transactions / files | 10,000 / 1,000 |
| Write wall time | 313.67 s |
| Full run including verification/maintenance/reopening | 342.33 s |
| Batch latency, median / p95 | 31.50 / 41.41 ms |
| Cold file read, median / p95 (20 samples) | 9.64 / 10.70 ms |
| Peak process RSS, including verification | 263.61 MiB |
| Live database + WAL + SHM | 562.06 MiB |
| After lossless compaction, vacuum and WAL truncation | 543.09 MiB |

All 1,000 final files matched; all 1,000 matched again after reopening. Sixteen midpoint historical files and sixteen stable anchors matched. The database retained 1,002,000 changes including 2,000 setup changes, and SQLite integrity returned `ok`. No temporary CRDT handles remained. The checkpoint count was 2,000 (two per file), and compaction removed zero manifest nodes: normal writes had already avoided unreachable nodes. Compaction/vacuum took 4.30 s.

RSS during the write-progress samples ended at 194.86 MiB; peak RSS above includes later read/verification work. Throughput averaged 3,188.03 edits/s **within 100-edit atomic batches**, not that many independent durable commits/s. A growing batch-latency trend is visible in the progress timings as each file accumulates retained history; the aggregate median is not a constant-latency guarantee.

After vacuum, raw change rows occupied 357.32 MiB and their unique index 115.23 MiB. These now dominate disk usage. Further reductions need packed change storage and more compact indexing; this release retains every raw edit rather than discarding history to improve the benchmark.

## Multi-client relay result

Run `bun run benchmark:relay` separately from other tests and benchmarks. [Saved report](relay-results.json): **completed and verified** on AMD Ryzen 5 5500, Node v26.11.1.

The workload uses ten independent SQLite clients, 100 initial files, and five rounds of offline concurrent edits. Each client makes ten edits to the shared file, one edit to its own file, and one message per round: 600 logical offline operations total. All clients sync concurrently, then perform a catch-up pass; every round verifies full-state equality and stable anchors. The relay restarts midway with the same database and origin. A final no-op reconnect verifies zero data pages.

| Measurement | Result |
| --- | ---: |
| Converged clients / completed rounds | 10 / 5 |
| Whole workload, including setup and verification | 67.12 s |
| Round sync + catch-up + verification range | 10.19–11.78 s |
| HTTP attempts during initial/round sync | 293 |
| Push / pull data pages | 53 / 80 |
| Attempted JSON upload / complete response payloads | 1.16 / 9.86 MiB |
| Combined process peak RSS | 555.26 MiB |
| Relay DB + WAL + SHM | 5.71 MiB |
| Relay documents / raw changes / global batches | 150 / 850 / 71 |
| Final no-op resume data pages | 0 push / 0 pull |

The final no-op check still used two HTTP requests and 2260 JSON payload bytes. Payload counters exclude headers/framing and are not packet-capture measurements. This run had zero retries/resets; separate integration tests exercise lost acknowledgments and missing-history resets.

The relay and all ten client engines shared one Node process and used real **loopback HTTP**. Its RSS covers all eleven engines, and synchronous engine work shares one event loop. The round times include full-state verification, so they are not individual network latency or commit-throughput measurements. The separate three-CLI-client test verifies independent OS processes and relay restart. WAN/TLS performance, multi-host failover and million-operation network sync remain unverified. See [hosting and protocol details](../docs/relay.md).

## Scope

The ten-replica convergence check is part of the functional suite and uses small independent local databases. It is not a ten-client network throughput benchmark. Large global merges, transcript paging indexes, deliberate history pruning, blob packs, streaming sync, migration and multi-host concurrency remain unmeasured or unimplemented. The HTTP relay now supplies complete-batch paging and room grants; file-level selection and fragments within an oversized batch remain absent. Million-edit results apply only to the documented local batched profile.
