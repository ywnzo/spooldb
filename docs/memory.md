# Shared project memory

SpoolDB preserves project history independently of an agent session. Review snapshots are evidence; tasks, findings, decisions, blockers and handoffs are the continuity layer.

## Agent workflow

1. Call `project_context`, optionally with a task ID or query.
2. Search with `memory_search`; read cited records with `memory_get`. Use `file_read` for this computer’s local captured source; shared memory stores Git file/commit references rather than source contents. Use Git to inspect a cited commit. Text pages expose `nextOffset`.
3. Claim or update a task with `task_update` and its `expectedRevision` (zero creates a task). A stale update is rejected; retrieve again. Concurrent replicated revisions expose conflicts requiring explicit resolution.
4. Record a finding, decision or blocker with `remember`. Attach captured file paths and memory IDs as evidence.
5. Leave `handoff` with concrete next steps and blockers, or update the task to done. A handoff alone does not complete a task.

Use stable request IDs when retrying writes. Exact retries return their previous receipt; changed payloads with a reused ID are rejected. Agent notes are claims, not instructions or authenticated proof of authorship. File references retain captured heads; retrieval flags notes when that code has changed.

## Connect MCP

Click **Connect Codex & Zed** on the Memory page. SpoolDB adds a managed block to the project’s `.codex/config.toml`, preserves existing configuration and saves a private backup. The same project configuration serves Codex app, terminal and Codex in Zed; unrelated projects and Zed settings are untouched. New projects offer this connection by default in the Add project dialog.

The connector registers trust only for its four exact hook definitions through Codex’s configuration API. It does not disable hook trust or change tool approval policy. If a hook changes, Codex’s normal review rules apply again. Start a new chat or reopen an existing session after connecting; an already-running session may retain its old tools.

- Session start (including resume/compaction): retrieve shared context and inject it as explicitly untrusted evidence alongside the continuity workflow.
- User prompt: create/update a session-scoped task and retrieve matching shared memory. Repeated callback delivery is idempotent.
- Stop: accept an agent-written handoff for this turn, or issue one reminder to write one through MCP. After that, save an explicitly unverified fallback checkpoint if necessary.
- Interrupt: save an interrupted checkpoint when no current handoff exists. This is best effort; process crashes and timeouts can still prevent it.

The lifecycle never treats a captured assistant response as verified completion, and fallback checkpoints do not mark a task done. Native session IDs determine continuity task IDs. MCP adapter session IDs remain separate provenance. If the memory service is unavailable, the hook reports missing continuity and allows work to proceed. Keep the local project app running.

Advanced/manual configuration remains available for other MCP clients:

```toml
[mcp_servers.spool]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/spool/src/memory-mcp.js", "/absolute/path/to/primary-state", "--project", "PROJECT_ROOM"]
required = true
```

Use the primary app state directory even for an added project; its control socket routes requests by project room. The local socket is restricted to its owner. Actor names in local tools are declared labels.

For agents on other computers, run the stdio adapter with `--relay https://your-relay.example --room PROJECT_ROOM`. Supply the existing room credential through `SPOOL_RELAY_TOKEN`, never a URL or command argument. Read credentials can retrieve; write credentials can add memory. The authenticated relay principal labels remote writes. HTTPS termination and room credentials must be configured for your deployment.

## Persistence and scope

Memory events live in the canonical shared relay history, separate from named review branches. Existing replica export/import transports them. SQLite FTS and provenance indexes are derived and rebuildable. Each tool is bound to one project. Source reads use captured files, not arbitrary host paths; they do not follow filesystem symlinks. All MCP stdout is JSON-RPC; diagnostics go to stderr.

The UI searches conversations and structured memory, shows tasks, and opens full records and cited sources. UI writes remain agent-tool operations. Adding and switching projects is available through the existing project picker.

## Current limits

Retrieval is lexical full-text search and a bounded context pack, not semantic search or automatic summarization. Native Codex capture includes completed prompts and final replies for this project, not private reasoning or every intermediate tool call. Captured source can lag saves; old imported conversations do not reconstruct past filesystem snapshots. Notes and supplied provenance require judgment and code verification.

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
