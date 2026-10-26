# Shared project memory

SpoolDB preserves project history independently of an agent session. Review snapshots are evidence; tasks, findings, decisions, blockers and handoffs are the continuity layer.

## Agent workflow

1. Use the context supplied by the prompt hook, or call `project_context` with a natural-language description of the task. Avoid fetching unchanged context twice.
2. Ask `memory_search` a natural-language question when you need more evidence; read cited records with `memory_get`. Use `file_read` for this computer’s local captured source; shared memory stores Git file/commit references rather than source contents. Use Git to inspect a cited commit. Text pages expose `nextOffset`.
3. Claim or update a task with `task_update` and its `expectedRevision` (zero creates a task). A stale update is rejected; retrieve again. Concurrent replicated revisions expose conflicts requiring explicit resolution.
4. Record a finding, decision or blocker with `remember`. Attach captured file paths and memory IDs as evidence.
5. Leave `handoff` with concrete next steps and blockers, or update the task to done. A handoff alone does not complete a task.

Use stable request IDs when retrying writes. Exact retries return their previous receipt; changed payloads with a reused ID are rejected. Agent notes are claims, not instructions or authenticated proof of authorship. File references retain captured heads; retrieval flags notes when that code has changed.

## Connect MCP

Click **Connect Codex & Zed** on the Memory page. SpoolDB adds a managed block to the project’s `.codex/config.toml`, preserves existing configuration and saves a private backup. The same project configuration serves Codex app, terminal and Codex in Zed; unrelated projects and Zed settings are untouched. New projects offer this connection by default in the Add project dialog.

The connector registers trust only for its four exact hook definitions through Codex’s configuration API. It does not disable hook trust or change tool approval policy. If a hook changes, Codex’s normal review rules apply again. Start a new chat or reopen an existing session after connecting; an already-running session may retain its old tools.

- Session start (including resume/compaction): supply the continuity workflow and reset delivered-source tracking. Relevant memory is retrieved once the prompt is known.
- User prompt: create/update a session-scoped task and retrieve matching decisions, findings, blockers and handoffs. Inject complete, compact source cards within a character budget, skipping unchanged sources already delivered to this session. Repeated callback delivery is idempotent.
- Stop: accept an agent-written handoff for this turn, or issue one reminder to write one through MCP. After that, save an explicitly unverified fallback checkpoint if necessary.
- Interrupt: save an interrupted checkpoint when no current handoff exists. This is best effort; process crashes and timeouts can still prevent it.

The lifecycle never treats a captured assistant response as verified completion, and fallback checkpoints do not mark a task done. Native session IDs determine continuity task IDs. MCP adapter session IDs remain separate provenance. If the memory service is unavailable, the hook reports missing continuity and allows work to proceed. Keep the local project app running.

Advanced/manual configuration remains available for other MCP clients:

```toml
[mcp_servers.spool]
command = "/absolute/path/to/bun"
args = ["/absolute/path/to/spool/src/memory-mcp.js", "/absolute/path/to/primary-state", "--project", "PROJECT_ROOM"]
required = true
```

Use the primary app state directory even for an added project; its control socket routes requests by project room. The local socket is restricted to its owner. Actor names in local tools are declared labels.

For agents on other computers, run the stdio adapter with `--relay https://your-relay.example --room PROJECT_ROOM`. Supply the existing room credential through `SPOOL_RELAY_TOKEN`, never a URL or command argument. Read credentials can retrieve; write credentials can add memory. The authenticated relay principal labels remote writes. HTTPS termination and room credentials must be configured for your deployment.

## Persistence and scope

Memory events live in the canonical shared relay history, separate from named review branches. Existing replica export/import transports them. SQLite FTS, vector and provenance indexes are derived and rebuildable. Each tool is bound to one project. Source reads use captured files, not arbitrary host paths; they do not follow filesystem symlinks. All MCP stdout is JSON-RPC; diagnostics go to stderr.

## Semantic retrieval

By default, self-hosted relays generate embeddings locally using a pinned, quantized multilingual MiniLM model. The first search downloads public weights from Hugging Face; memory text is processed on the relay, not sent to a hosted model. Weights are cached under the server state directory's `models/` folder and retained across restarts. Managed relay update snapshots exclude this rebuildable model cache. The standalone installer includes the inference runtime; the smaller Codex plugin relies on its connected relay, and keeps keyword retrieval for local-only memory. Source checkouts and standalone local companions use the user's cache directory; `SPOOL_MODEL_CACHE` selects another location for those local companions.

Search combines semantic matches with BM25 keyword ranking, retaining exact error/function/path matching. Long records are indexed as overlapping passages; matching passages are returned rather than always taking the beginning. Project, kind and task filters apply before vector scoring. Removed conversations lose their vectors; an inference racing with deletion cannot restore them. A model revision change rebuilds derived vectors. Missing entries are indexed in bounded background batches after retrieval begins.

Cold inference waits at most 1.2 seconds on the request path, then returns keyword results while warmup continues. Check `retrieval.semanticStatus`: `ready`, `indexing`, `warming`, `unavailable` or `disabled`. `SPOOL_EMBEDDINGS=off` disables local inference. Embedding failure does not block ordinary memory reads or writes. Private memory retained on a client currently joins shared results through keyword search; it is never uploaded for relay embedding.

MCP context/search responses default to compact source cards capped at 6,000 characters (`maxChars` changes the budget; `compact:false` retains the full envelope). This is a character ceiling, not a model-specific token count. Full records and paginated evidence remain available through `memory_get`. Git reconciliation runs before compacting, so cards preserve the verification status, source identity and local/shared label. The hook uses a 5,000-character memory-card budget and sends source IDs only once until session start/resume resets the delivery list.

Run `bun run benchmark:retrieval` to evaluate real local inference with two authenticated clients and synthetic English/Czech memories. Results include recall, query latency, unrelated-query checks and full/compact response sizes. It does not read company conversations or measure total chat-token savings.

Cloudflare keeps using the same store and keyword fallback. An explicitly configured Workers AI `AI` binding enables hosted embeddings there; no paid service or binding is enabled automatically. Native inference is excluded from Worker bundles.

The UI searches conversations and structured memory, shows tasks, and opens full records and cited sources. UI writes remain agent-tool operations. Adding and switching projects is available through the existing project picker.

## Current limits

The SQLite vector index uses exact cosine scoring, not approximate nearest-neighbor search. Its cost grows with a project's indexed passages; this implementation does not claim million-vector performance. Hybrid search ranks at most 100 semantic and 30 keyword candidates per query; `mode:"keyword"` retains exhaustive lexical pagination. Similarity is not proof of relevance: inspect cited evidence, and treat a partially indexed project as incomplete. There is no automatic generative summarizer. Native Codex capture includes completed prompts and final replies for this project, not private reasoning or every intermediate tool call. Captured source can lag saves; old imported conversations do not reconstruct past filesystem snapshots. Notes and supplied provenance require judgment and code verification.

This is a working local/shared-relay prototype. Company SSO, organization membership, centralized policy, deployment hardening and multihost production operations are not implemented. Existing room grants provide project isolation, not a complete company identity system.

## Live acceptance

`examples/memory-handoff-check.js STATE_DIR WIELD_ROOT` runs two fresh, ephemeral Codex CLI sessions with read-only source access and a project-scoped MCP server. A leaves a finding with a random marker and a handoff. B receives only the task ID, retrieves those records, verifies another behavior and completes the task. Private JSONL and a machine-readable report are written under the state directory’s acceptance folder. This invokes your configured Codex provider; run only on projects authorized for that provider.

## Automatic Git reconciliation

Shared writes (`remember`, `task_update`, `handoff`) capture HEAD, branch, sanitized origin, dirty state and hashes of explicitly referenced files directly from disk. The client reads Git and file hashes twice and retries a changing checkpoint up to three times. Failed or unstable checks are stored as unverified. Stable retry IDs reuse their original durable checkpoint, including after a companion restart or a later commit.

`project_context`, `memory_search` and `memory_get` reconcile each returned memory record on the receiving computer. Read `reconciliation.status` and `reconciliation.message` before acting:

| Status | Meaning |
| --- | --- |
| `matching` | Verified checkpoint, same commit, clean local checkout, and all cited file hashes match. This does not verify the agent's conclusions or test claims. |
| `different_revision` | Current commit, working tree or cited file contents differ. Inspect the cited version and current changes. |
| `commit_unavailable` | The cited commit is not present locally. Fetch normally; ask the author to push if necessary. |
| `uncommitted_evidence` | The author had uncommitted changes. The commit alone does not reproduce the checkpoint. |
| `repository_mismatch` | Known repository identities differ. SSH and HTTPS spellings of the same repository are normalized. |
| `unverified` | Legacy evidence, missing metadata, inaccessible Git/files or an unstable read prevents verification. |

Checks happen on every retrieval; they do not rely on capture polling, Git hooks, the selected branch name alone, or relay history changes. The UI also refreshes its memory cards when the checkout's commit, branch or working-tree status changes. The original reference is retained after rebases and force-pushes. No commit is silently substituted.

`remoteKnown` records whether local remote-tracking refs contain the author commit. It is a local observation, not a fresh verification of a remote server. SpoolDB does not fetch, push, commit, reset or checkout automatically. No source contents are added to the shared relay by reconciliation. Direct relay MCP, without a local companion, reports unverified because it cannot inspect the receiving checkout.

## Model settings and reversible cleanup

Workspace owners can use **Settings → Search & memory** to choose local or Cloudflare embeddings. Local settings let owners enable inference, choose a pinned multilingual or smaller English model, set CPU threads, adjust the relevance threshold and bound context size. The relay downloads weights automatically on startup and shows download progress and errors. Servers with less than 1.5 GiB effective memory default to the smaller English model; mixed-language teams should select the multilingual model if memory permits. Changing models rebuilds derived vectors without changing source records. Keyword retrieval remains available during loading.

New evidence can supply `resolves` or `supersedes` record IDs. Agents must verify that relationship; age or similarity alone does not justify cleanup. `memory_update` supports archive, restore, resolve and supersede with an expected lifecycle revision. Conflicting concurrent changes remain visible until explicitly reconciled. These operations follow existing sharing permissions.

Archived records retain their original content and history. Normal retrieval excludes them, completed tasks and older task revisions. Explicit record reads still work; `includeArchived:true` enables keyword searches of history, and an explicit task ID can retrieve a completed task. In the UI, enable **Include archived and completed records**, open a record, and use **Restore to retrieval**. Archive and restore require a reason. No age-based or similarity-based permanent purge runs automatically.


### Cloudflare embeddings on a self-hosted relay

A workspace owner can open **Settings → Search & memory**, select **Cloudflare Workers AI**, and enter their Cloudflare Account ID and a scoped Workers AI API token. Follow the linked Cloudflare token-creation guide; restrict the token to the intended account. Select **Test connection** to send only a fixed test phrase, then acknowledge external processing and save to enable BGE-M3. Existing installations keep their local model until an owner changes it. All projects on that relay use this configuration; team members need no Cloudflare credentials.

Enabling Cloudflare sends indexed passages (including existing active memory, titles and file paths) and search queries to Cloudflare. Project permissions, record storage, archive filtering and ranking stay on the relay. Cloudflare's free allowance and billing apply to the configured account; SpoolDB does not enforce a monetary spending cap. API limits, timeouts or outages fall back to keyword retrieval. No external generative model is needed for this retrieval path.

Record embeddings persist in SQLite, keyed by source fingerprint and provider/model identity. Unchanged records are not embedded again after a restart. The last 64 query embeddings are cached in memory and cleared on restart/provider replacement. Search results and access decisions are not cached by this mechanism. Changing models rebuilds the derived index. Cloudflare model aliases are upstream-managed, unlike pinned local weights.

The API token is stored in the relay's private SQLite settings tables, outside replicated project history. Status responses never return it. Blank token inputs keep the existing credential for the same account; entering a token replaces it. **Disconnect and remove token** disables semantic retrieval and removes the stored token. Revoke the token in Cloudflare if it should no longer be usable anywhere. Relay backups contain credentials and must be protected; this storage is not application-level encryption at rest. Requests use Cloudflare's fixed HTTPS API origin with redirects refused and bounded timeouts/responses.

The hosted Cloudflare relay's optional Workers AI binding remains separate from this VPS REST configuration. Provider settings here apply to self-hosted relays.


### Bounded indexing and outage recovery

Indexing persists each embedding batch with a derived progress cursor and applies the per-pass chunk limit inside long records. After interruption it resumes completed batches; deleting conversations also removes their cursors. Transient provider failures schedule another background attempt after cooldown. Cached query embeddings can search existing valid vectors while new records await indexing; the response continues to report an indexing backlog. Cold queries can still use keyword fallback while inference is pending. These per-pass limits do not impose a daily provider usage budget.


### Concise handoffs

New handoff saves enforce 2,000 Unicode characters combined across title, summary, next steps and blockers (including separators). The summary may contain at most 1,500 characters, title 120, and up to three next steps and three blockers of 160 characters each. MCP schemas advertise the field limits; the relay also checks the combined limit for direct API/CLI saves and local private memory. Rejection explains how to shorten the handoff. Agent-authored text is not silently truncated. Store detailed evidence in findings/decisions and cite their IDs instead of copying it into a handoff. Automatic fallback checkpoints use a short, explicitly unverified excerpt. Existing and historically imported records remain readable under the historical event format; imports are not rewritten to erase their history.

### Usage and external embedding caps

On self-hosted relays, workspace owners use **Settings → Search & memory → Usage & limits** or `spool workspace usage --json`. Run `spool workspace usage limits` for interactive limits without putting secrets in arguments. The same owner-only API uses `command: retrieval`, `action: status` or `action: limits`; limit writes require their current `usage.limits.revision` as `expectedRevision`.

Counters include relay HTTP requests/categories/failures, per-project traffic, query embedding cache hits/misses, embedding attempts/characters/failures/elapsed time, vector scan work, quota blocks and pending indexing records. They contain numeric aggregates and project identities, not prompts, passages or credentials. Daily aggregates expire automatically after 90 days. Telemetry errors are reported without breaking ordinary reads. Budget reservations remain transactional and fail closed if they cannot persist.

Limits cover daily external embedding requests, daily external UTF-16 characters for the relay, and a daily character allowance applied separately to each project. Zero means unlimited (the compatible default). Counts reset at midnight UTC and survive restarts. Warmup, connection tests and retries count toward the relay-wide allowance; probes are not assigned to a project. Failed attempts are counted conservatively, because the upstream may have processed them. These are text/request budgets, not exact provider-token or currency caps. They do not limit HTTP traffic or retained storage. On reaching a cap, no further external invocation is made for that work; cached vectors/query embeddings and keyword fallback remain available. Local inference is not blocked by external API budgets.

Queries have priority over queued indexing batches. Inference stays serial; after four queries, one waiting indexing batch gets a turn. Indexing resumes in bounded, persisted chunks. Exact vector scoring reads pages rather than materializing every vector at once, and yields periodically to keep the event loop responsive.

### Reproducible quality and scale checks

- `bun run benchmark:quality --check`: pinned local model, versioned 50-question English/Czech corpus, identifier queries, obsolete evidence, cross-project distractors, unrelated questions, compact/full source comparison and a measured regression floor. Release CI runs this gate. It does not read company history.
- `bun run benchmark:quality --provider=cloudflare`: the same synthetic corpus, explicitly using `SPOOL_CLOUDFLARE_ACCOUNT_ID` and `SPOOL_CLOUDFLARE_API_TOKEN` from the environment. Never put the token in command arguments. This standalone evaluation uses its own ephemeral store, not a connected relay's usage caps. Cloudflare needs its own reviewed baseline before `--check` can be used.
- `bun run benchmark:vectors`: 10k/100k exact vectors at 384/1024 dimensions in separate processes; records query times, SQLite size and peak RSS. No external inference is used. Synthetic broad-match vectors stress memory/scoring, not relevance. Local results are not VPS guarantees.

See [measured results and limitations](../benchmarks/results/README.md). Character reduction compares compact responses with full records for the same retrieved IDs; it is not proof of total chat-token savings.
