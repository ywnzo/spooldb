# Native harness adapters and shared contract

Implementation date: October 23, 2026. The bundled integrations use public non-interactive event streams, not private transcript databases. The shared envelope is independent of the two bundled launchers. For normal Codex app, terminal and Codex-in-Zed use, the [local history connection](codex-connection.md) captures completed saved conversations without wrappers. The stream launchers below remain available for explicit supervised runs. Interactive hooks, ACP/MCP servers and remote runners are not installed.

## Setup and execution

Install and authenticate the desired CLI through its own supported setup. SpoolDB does not install harnesses, copy credentials, change global settings or perform login. Run `codex --version` or `claude --version` locally to confirm the chosen program is available. Start with a fresh SpoolDB database or the same already-attached root/branch:

```sh
printf '%s\n' 'Explain the repository structure.' \
  | node src/cli.js history.sqlite run codex /absolute/path/to/repo
printf '%s\n' 'Explain the repository structure.' \
  | node src/cli.js history.sqlite run claude /absolute/path/to/repo
```

Use an optional branch after the root, followed by `--write` if desired. The prompt is sent on stdin rather than in process arguments. The selected root must be a Git checkout that fits the bridge's limits. The runner attaches it if necessary and records the prompt with evidence `adapter-input` before starting the CLI.

Codex is launched with JSONL output and its read-only sandbox by default. `--write` selects workspace-write. Claude uses stream-json/verbose output, with built-in read tools and MCP tools denied by default; `--write` restores its normal configured tool set. A tool allowlist is not an OS sandbox. Both native CLIs retain their own configuration and permission behavior. No approval-bypass flag or arbitrary shell command from an event is executed by SpoolDB. Native runs intentionally operate in the root you chose and may contact their configured model provider.

The supervisor prints `adapter.recorded`, `filesystem.observed` and `adapter.finished` JSONL records. It ingests whole completed messages rather than token deltas. Captures occur at reported tool/turn boundaries and after process exit. These are filesystem observations, not guaranteed atomic tool effects. No merged engine state is written back into the original checkout by the bridge.

Default timeout is two minutes; the library accepts 100 ms to one hour. SIGINT/SIGTERM cancel a CLI-run invocation. On Linux the supervisor terminates its spawned process group, escalating to SIGKILL after two seconds if necessary. Detached descendants that deliberately escape the group are outside this mechanism. Process startup errors, input errors, malformed/oversized streams, capture errors, timeout and cancellation are retained as explicit failed supervisor outcomes. Native stderr is drained but not retained; only its byte count is returned. Inspect native diagnostics separately when authentication or configuration fails.

## The envelope

The authoritative format is [adapter-event.schema.json](../schemas/adapter-event.schema.json), compiled once by Ajv for runtime validation. The [TypeScript declarations](../src/adapters/index.d.ts) describe the public adapter API, and the engine has corresponding declarations. Run `npm run typecheck` to verify the included consumer example.

| Field | Meaning |
| --- | --- |
| `protocol` | `spool-adapter/1`, provisional and unpublished |
| `harness` | Open lowercase namespace such as `codex`, `claude`, or `your-agent`; launcher support is separate |
| `eventId` | Stable hash of stream identity, native stream position and normalized part |
| `streamId` | One explicitly opened native capture stream |
| `sequence`, `part` | Original stream position and subevent within it; not distributed causal time |
| `sessionId`, `sessionIdSource` | Native ID when available; explicitly adapter-derived otherwise |
| `turnId` | Adapter-local turn identity, not asserted to be a native turn UUID |
| `kind` | Session/turn boundaries, message, tool start/end, notice or process close |
| `sourceType` | Public native event type, or `adapter.process.exit` |
| `evidence` | `native-event` versus `adapter-process`; filesystem evidence is separate |
| `payload` | Selected typed fields such as message text or tool identity/input/output |

The event ID is an address, not a signature. Actor/harness provenance remains a local claim and does not authenticate a person. Unknown record/item/content types become explicit notices. Recognized reasoning/thinking blocks, partial token streams, transcript paths and unrelated initialization fields are omitted. Text in messages and tool inputs/outputs is retained as supplied and is not generally secret-redacted.

`AdapterIngress.open` binds a stream to a branch and normalizer. Each ingest commits normalized events and any corresponding messages in one engine/SQLite transaction, then advances the local replay receipt. Exactly replaying a native position returns its original receipt, even after a process restart. The same position with different JSON content fails; object key order is normalized. A gap fails before advancing the stream. Unknown-session and malformed-item conditions fail rather than guessing IDs.

Normalized events replicate in the room's causal history. Local stream cursors, supervisor state and receipts are not replicated. Imported event history can be inspected without a harness installed. Restarting replay into a different database is not guaranteed idempotent through the local receipt API; preserve its database and stream ID. Reusing a native session under a new stream ID creates a distinct capture. Completion does not mean the model's task was correct: it means the observed turn and process ended in the reported state.

## Correlating code and conversation

The native message and tool-event records retain their source identities. On a tool/turn completion, the runner observes disk and passes an `observedAfter` link plus session/turn/tool context into the bridge. Observed file changes link to the recorded user prompt for file-level trace queries. The file mutation's actor stays `unknown` and its evidence remains `observed-disk-snapshot`.

A concurrent editor or formatter may have caused some observed bytes. Correlation with a native event is not proof of exclusive authorship. File-change event paths are recorded as claims; SpoolDB does not blindly apply those events to disk. Exact patch/keystroke capture and full line-to-message blame remain future work. The prompt and native events are retained separately so later adapters can provide stronger evidence without rewriting earlier claims.

## Third-party adapters

External adapters do not need a new engine release to name their harness in the normalized format. They can use `Engine.submit` with an `adapter.record` operation and, when present, a `message.add` in the same batch:

```js
engine.submit('main', {
  actor: 'your-agent', harness: 'your-agent', requestId: uniqueRequestId,
  expectedHeads: engine.read('main').heads, evidence: 'native-event',
  operations: [
    { type: 'adapter.record', event: normalizedEvent },
    { type: 'message.add', messageId: uniqueMessageId, role: 'assistant', text: reply },
  ],
});
```

Use a stable source identity and explicit evidence. Preserve the usual expected-head and retry requirements. The bundled `AdapterIngress` raw-stream normalizers and `runHarness` launcher currently accept only `codex` and `claude`; the shared normalized schema accepts other names. Add another parser/launcher only after checking its supported event interface and testing actual sessions. A new payload/operation shape requires a declared schema change rather than arbitrary vendor fields.

## Supported native mappings and sources

Codex maps public `thread.started`, `turn.*` and `item.*` records to normalized lifecycle/messages/tools. Reasoning items are intentionally omitted. Its JSONL interface is documented in [OpenAI's non-interactive guide](https://learn.chatgpt.com/docs/non-interactive-mode). The installed CLI help was also checked; no private rollout files were read.

Claude maps public `system/init`, `assistant` text/tool-use blocks, `user` tool-result blocks, and `result` outcomes. The final result's repeated response text is used only if no assistant text appeared. Subagent records with a non-null parent tool ID are represented by notices rather than flattened into the main conversation. Streaming and flags come from the [programmatic guide](https://code.claude.com/docs/en/headless) and [CLI reference](https://code.claude.com/docs/en/cli-reference). The hook reference was reviewed, but this milestone does not install hooks or read transcripts.

## Verification status

Automated tests cover both documented-shape synthetic streams, message/tool normalization, reasoning omission, unknown events, schema rejection, replay, process restart, sequence gaps, conflicting payloads, failed/incomplete exits, missing executables, malformed/oversized streams, timeout/cancellation, file correlation, public JSONL ingestion and the public `run` CLI. The native-process doubles are explicitly synthetic; they do not establish live provider compatibility.

Codex CLI **0.163.0** passed two authenticated live checks in disposable repositories: an exact-token reply under read-only permissions and a workspace-write file creation. The file's disk/engine bytes matched, the native tool boundary was retained, and trace linked the file observation to the prompt. These checks establish those flows on this environment, not every Codex event type or future CLI release.

Claude Code and Claude credentials are absent here. Its parser, supervisor path and CLI contract are implemented and covered by fixtures/process tests. An authenticated Claude session remains an explicit acceptance gap. To finish it in a configured environment, run the documented Claude command against a disposable Git repository, verify a completed turn and native tool/result records, then test a permitted file edit and its trace. No global settings, login state or hook files were changed as part of this work.
