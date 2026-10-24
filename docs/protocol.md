# Local JSONL protocol, revision 1

This guide describes the legacy-compatible API. A separate, opt-in storage layout uses `--sharded` and the `spool/2` replication bundle; see [sharded storage](storage.md). The normalized adapter envelope remains `spool-adapter/1` in both layouts.

Run `node src/cli.js path/to/project.sqlite`. Input and output are newline-delimited JSON. Standard output contains responses only; Node may print runtime warnings to stderr. The CLI creates a SQLite database if absent. It has no network listener and is intended for trusted local processes.

Responses are `{ "id": <request id or null>, "ok": true, "result": ... }` or `{ "id": ..., "ok": false, "error": "..." }`. Error wording is not a stable machine error code yet. `id` correlates a response; `input.requestId` deduplicates writes. One process handles requests sequentially. Maximum JSON request size is 16 MB, checked after reading a line; this is not a network memory limit.

## Initialize and read

```json
{"id":1,"command":"init","branch":"main"}
{"id":2,"command":"read","branch":"main"}
{"id":3,"command":"refs"}
```

Read returns `room`, `heads`, `files`, `messages`, `comments`, `conflicts`. Heads are opaque causal change hashes; arrays have set semantics. Preserve file IDs across renames. Messages/comments are ID-keyed maps; map iteration order is not transcript order. Consult causal history for ordering. Timestamp order alone cannot order concurrent offline work.

It also returns `adapterEvents`, keyed by normalized event identity. Sort events from a single stream by `sequence`, then `part`; this is stream order, not a global causal ordering across replicas. `run.closed` records process supervision separately from native turn completion. See the [adapter contract](adapters.md).

## Submit a batch

Replace `HEAD_FROM_READ` with the actual head(s) from the preceding read. The value below is a placeholder, not a valid head.

```json
{"id":4,"command":"submit","branch":"main","input":{"actor":"developer","harness":"custom-agent","requestId":"turn1-write1","expectedHeads":["HEAD_FROM_READ"],"sessionId":"session-1","turnId":"turn-1","messageId":"m1","toolCallId":"tool-1","operations":[{"type":"file.create","fileId":"file-1","path":"src/hello.js","text":"hello world"},{"type":"message.add","messageId":"m1","role":"assistant","text":"Created greeting"}]}}
```

The result includes new heads and an event ID. Writes require `actor`, `requestId`, `expectedHeads`, and 1–10,000 operations within the request size limit. On a stale-head error, re-read and reconsider the operation. To merge genuinely concurrent work, use a separate replica/branch. Do not blindly reuse stale offsets. Retry exactly the same serialized input with the same request ID to receive the original receipt; use a new request ID for a changed request. Receipts are local to this database and branch, and are not replicated. Change imports themselves are idempotent.

## Operation shapes

```json
{"type":"file.create","fileId":"f1","path":"src/a.js","text":"hello world"}
{"type":"file.splice","fileId":"f1","index":6,"deleteCount":5,"insert":"team"}
{"type":"file.write","fileId":"f1","kind":"text","text":"hello team","mode":420}
{"type":"file.create","fileId":"bin1","path":"image.bin","kind":"binary","data":"AP8=","mode":420}
{"type":"file.create","fileId":"link1","path":"link","kind":"symlink","target":"src/a.js","mode":420}
{"type":"file.rename","fileId":"f1","path":"src/b.js"}
{"type":"file.delete","fileId":"f1"}
{"type":"file.restore","fileId":"f1"}
{"type":"message.add","messageId":"m1","role":"user","text":"Please review this"}
{"type":"comment.add","commentId":"c1","fileId":"f1","start":0,"end":5,"text":"Why this greeting?"}
```

IDs use letters, digits, dots, underscores and hyphens, with an alphanumeric first character. Text is limited to 1,000,000 UTF-16 code units per field/file. Paths must be relative, contain no empty/dot/parent segments, backslashes, colon or `.git` segment. This validation does not implement a secure filesystem materializer. Offsets are UTF-16 code units and must not split a surrogate pair.

File `kind` defaults to `text`; mode is decimal `420` (0644) or `493` (0755). Binary `data` is canonical base64, with a maximum decoded size of 1,000,000 bytes. Symlinks store a target string without reading its contents. `file.write` accepts the same content fields as `file.create` and computes a text diff with Automerge's pinned `updateText` implementation. It requires the same expected-head check as a splice. Concurrent binary changes or metadata writes can produce explicit conflicts. Pre-bridge files without kind/mode are read as text/0644. These are additions to the unpublished, provisional v1 format, not a promise of old-client write compatibility.

`input.evidence` and `input.gitCommit` are optional provenance strings. Filesystem capture uses actor `unknown`, harness `filesystem`, evidence `observed-disk-snapshot` and the observed Git HEAD when available. Snapshot provenance does not identify which process authored the edits.

`file.restore` can reveal a path collision; `read.conflicts` must be inspected after merges/restores. Concurrent metadata assignments expose their CRDT alternatives. A deliberate rename of the current winning value can resolve a rename conflict. Text convergence does not imply valid source code. Deleted files remain queryable for history/anchors.

## History, trace and anchors

```json
{"command":"history","branch":"main","options":{"after":0,"limit":100}}
{"command":"trace","branch":"main","fileId":"file-1"}
{"command":"anchor","branch":"main","fileId":"file-1","start":0,"end":5}
```

History includes local pagination cursor, change ID, parents and submitted provenance. `trace` returns changes that named the file and messages linked to those changes. It is file-level provenance, not character-level blame. Imported provenance is a claim by a trusted source, not cryptographic authorship.

Pass the returned anchor object to `{ "command": "resolve", "branch": "main", "anchor": ... }`. Supply `heads` to `read` or `resolve` for an old version. Anchors follow text positions and file identity, including renames. At EOF, the cursor follows EOF; a range ending there will expand as text is appended. If anchored text is deleted, a cursor resolves to a neighboring location; the selected text is not guaranteed to remain semantically equivalent.

## Fork and merge

```json
{"command":"fork","source":"main","target":"experiment"}
{"command":"merge","target":"main","source":"experiment"}
```

`fork` also accepts historical `heads`. Forked refs share stored changes. Both files and conversation branch together. Merge joins causal histories of the same room; unrelated rooms are rejected. The source branch remains unchanged. `read.conflicts` reports metadata/path conflicts after merging.

## Replicate

```json
{"command":"export","branch":"main"}
```

The bundle is `{protocol:"spool/1", schema:1, room, heads, changes:[base64...]}`. Pass it to `{ "command": "import", "branch": "main", "bundle": ... }` on the other replica. An absent branch is created; an existing related branch is merged. An existing unrelated branch fails. Full export includes conversation and deleted historical content, not only current file text.

Export accepts `since` heads already known by the destination to reduce transferred changes. The destination must have their causal dependencies; otherwise import fails without changing the ref. This local JSONL API does not authenticate peers or verify signed authorship. The separate [HTTP relay](relay.md) adds room-scoped authentication, complete-batch paging, durable acknowledgments and one bounded causal-base reset. Use that transport for authorized remote collaborators rather than exposing the local import command directly.

## JavaScript adapter example

```js
import { Engine } from './src/index.js';
const engine = new Engine('project.sqlite');
try {
  const state = engine.read('main');
  const result = engine.submit('main', {
    actor: 'agent-1', harness: 'your-harness', requestId: crypto.randomUUID(),
    expectedHeads: state.heads, sessionId: 'session-1', turnId: 'turn-1',
    operations: [{ type: 'message.add', messageId: crypto.randomUUID(),
      role: 'assistant', text: 'A normalized event from the harness' }],
  });
  console.log(result);
} finally { engine.close(); }
```

Initialize `main` once before this example. Adapters should obtain supported event APIs from their harness, normalize only information actually observed, and preserve source IDs for deduplication. Bundled Codex/Claude adapters use the explicit native runner or ingestion commands below; this generic message example alone does not capture an external session.

## Git and snapshot commands

```json
{"command":"git.attach","branch":"main","root":"/absolute/path/to/repo"}
{"command":"git.capture","root":"/absolute/path/to/repo"}
{"command":"git.sources"}
{"command":"snapshot.create","branch":"main","target":"/absolute/path/to/new-folder"}
{"command":"snapshot.list"}
{"command":"snapshot.recover","snapshotId":"ID_FROM_LIST"}
```

`git.attach` creates a branch if absent, or requires an existing branch with no files. It creates a `disk-*` observation branch and records eligible saved files. `git.capture` observes that same root, updates its disk branch, and merges into the chosen branch. The root must be the top-level Git checkout. Attach/capture do not modify the source files, index or Git branches.

`snapshot.create` accepts optional historical `heads`. Its target must not exist, its parent must exist, and it must be separate from attached source roots. It returns a snapshot ID and completion status. A snapshot is a file tree, not a Git clone. It does not update an existing output folder. `snapshot.recover` resumes a journaled output after interruption; changed files or an invalid ownership marker stop recovery. Read the [bridge guide](bridge.md) before relying on recovery semantics.

Watch mode is a separate CLI entry point: `node src/cli.js database.sqlite watch /git/root 1000`. It prints a `watching` event, then capture events only on observed changes. A capture error stops the process with a failing exit status. SIGINT/SIGTERM stop it cleanly. It is polling, not an editor keystroke recorder.

## Adapter commands

```json
{"command":"adapter.open","options":{"branch":"main","harness":"codex","streamId":"capture-1","prompt":"Review this repository"}}
{"command":"adapter.ingest","streamId":"capture-1","sequence":0,"nativeEvent":{"type":"thread.started","thread_id":"NATIVE_SESSION_ID"}}
{"command":"adapter.close","streamId":"capture-1","result":{"exitCode":0,"signal":null}}
{"command":"adapter.streams"}
```

Open an existing branch, then ingest the native stream at its original zero-based sequence positions. Replays of an identical position are idempotent; changed input at that position or sequence gaps fail. JSON object key order does not affect replay identity. These native-ingress commands support the two bundled normalizers. Third-party adapters may submit a validated normalized event with `adapter.record` in an ordinary engine batch. Its event field must satisfy [adapter-event.schema.json](../schemas/adapter-event.schema.json).

`adapter.close` is a trusted local supervisor report, not proof that the harness completed a turn. Exit zero without a native completion yields `incomplete`; a nonzero exit, signal, reported failure or runner error yields `failed`. Closing an already closed stream is idempotent. The runner CLI invokes these operations automatically and captures saved files at tool/turn boundaries. Manual native ingestion does not invoke Git capture or execute the harness.
