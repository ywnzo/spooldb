# Retrieval measurements — 2026-10-26

Bun 1.4.4 on the development computer. Synthetic fixtures only; no company transcripts or external model requests were used. Results are hardware/workload-specific, not production/VPS guarantees.

## Quality

`bun run benchmark:quality --check` uses pinned multilingual MiniLM and 50 questions over 42 records, with a foreign-project distractor. There are 42 positive questions and eight unrelated/no-answer questions.

- Recall@3: 37/42 (88.1%); MRR: 0.790.
- Unrelated questions returning no result: 6/8 (75%). Two still returned irrelevant matches; five positive questions missed the expected top-three source. These remain visible in the report.
- Superseded and cross-project leaks: zero in this fixture.
- Compact envelopes are 69.1% smaller in characters than full source records for the same retrieved IDs. This is not measured total conversation-token savings.
- Query latency p50/p95: 7/9 ms in the measured run, after indexing/model warmup, for this small corpus.

The pinned-model regression floor is recorded separately from the measured report. A passing floor is not a production relevance guarantee. Cloudflare can run the same corpus with explicitly provided API credentials; it has not been evaluated in this change and must have its own reviewed baseline.

## Exact vector scale

The benchmark runs the actual paged cosine-scoring path with cached query embeddings. Each scenario uses its own process. Dense, broad-match synthetic vectors stress scoring/memory; three queries per case are not enough to estimate production p95.

| Vectors | Dimensions | Query range | Peak RSS |
| --- | --- | --- | --- |
| 10,000 | 384 | 116–127 ms | 94.9 MiB |
| 100,000 | 384 | 1,080–1,438 ms | 187.3 MiB |
| 10,000 | 1024 | 146–163 ms | 120.2 MiB |
| 100,000 | 1024 | 1,294–1,555 ms | 201.4 MiB |

Before paging, the 100k/1024 case peaked at 1,700.9 MiB. Paging reduced measured peak RSS by approximately 88.2%, with no approximate search introduced. The additional room/model/id/chunk index adds storage overhead (about 7.3 MiB in the 100k/1024 case).

Decision: retain exact search for compatibility and small collections, with this measured baseline. Large collections still exceed a sub-second search target and can exceed the existing 1.2-second response wait, causing explicit keyword fallback while work completes. If sub-second retrieval at 100k vectors is required, evaluate an ANN implementation against this same quality/isolation/deletion corpus and deployment targets. Do not infer retrieval scale from the million-operation storage benchmark.

Reports:

- `retrieval-quality-v2-local.json` — all questions, ranks, no-answer results and context sizes.
- `vector-scale-before.json` — original all-vectors materialization.
- `vector-scale-paged.json` — paged scoring on the final implementation.
