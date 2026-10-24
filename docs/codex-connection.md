# Automatic shared memory

Use the Memory page’s **Connect Codex & Zed** action. [Automatic context and handoff workflow](memory.md#connect-mcp). This installs project-local settings and trusts only the connector’s exact hooks. New chats load them; existing sessions may need reopening.

# Use Codex normally

Open the local SpoolDB app and click **Connect Codex** once. Continue using the Codex app, the interactive terminal CLI, or Codex in Zed. Open **Review** whenever you want to browse the project. No wrapper command, room identity, pasted token, or new prompt is required. Connection settings persist; the project page and review refresh automatically.

The local app authenticates its browser automatically with an HTTP-only, same-site session cookie. It accepts only its exact loopback host, same-origin browser requests, and a per-session CSRF header for local endpoints. The separately hosted relay API still requires its existing credentials. The local app never exposes the writer token to JavaScript and its review endpoint cannot publish branch pointers.

## What is captured

The connector uses Codex's documented [app-server history API](https://learn.chatgpt.com/docs/app-server). It starts a local history reader, lists sessions for the connected folder, and reads completed-turn summaries. Its only allowed methods are initialization, `thread/list`, and `thread/turns/list`. It never starts/resumes a thread or starts a model turn. Session listing uses `useStateDbOnly` to avoid metadata repair scans.

Completed user prompts and final assistant replies are imported. Intermediate commentary, reasoning, images and tool input/output are omitted. Active turns are collected after completion, interruption or failure, not streamed token by token. Capture polls every ten seconds. The UI polls every four seconds and refreshes a branch when its published frontier changes. Replay receipts prevent duplicate copies across polls and service restarts. Edited messages are retained as a new imported version; old history is not silently removed.

The conversation reader does not transmit captured data to a model provider. Using Codex itself retains Codex's normal provider behavior. Imported messages are labeled **Saved Codex chat** in review. Their import time is not an assertion about when the original conversation happened. Importing an older chat does not reconstruct its old filesystem snapshots or prove a particular reply authored a file change. Saved code is observed separately, with the existing unknown-authorship evidence.

## Codex in Zed

[Zed's Codex agent](https://zed.dev/docs/ai/external-agents) owns its Codex configuration and history. When it uses the same local Codex home as the app and terminal, the same connector reads its persisted conversations. No ACP proxy, alternative Zed agent entry, hook, global configuration edit, or separate login is installed.


## Scope and limits

The folder must exactly match the session's stored working directory after canonicalization. Other projects, subagents and archived sessions are not imported. A separate worktree or a custom `CODEX_HOME` needs its own connection; automatic worktree discovery and a source-profile picker are not implemented. Ephemeral or history-disabled sessions cannot be imported. Pagination and message/response size budgets fail visibly rather than claiming a complete import.

Pause conversation capture from the project page to stop reading future Codex replies. Already captured history stays available, and code-save capture continues. Pausing or stopping SpoolDB does not stop your Codex or Zed session.

The local app can reopen after a restart without credential entry. The desktop launcher opens the local project app. It is a local launcher, not an installed or signed desktop package.
