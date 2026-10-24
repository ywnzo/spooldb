# Repository discovery with explicit approval

Enable it once on each client with `spool discovery enable`, or accept the discovery option in the interactive installer. Connect your company workspace once. Reopen Codex or its Codex backend in Zed after changing the user configuration.

A new Codex session or prompt runs a trusted user-level lifecycle hook. It detects the current Git root and adds a **local proposal**. It does not create a shared project, start capture, or send repository contents to the relay. Merely opening an editor folder without starting Codex does not trigger a hook.

Codex receives onboarding context instructing it to ask one clarifying question in its first response and wait for your answer. It uses a native question tool when available, otherwise a normal chat question. Lifecycle hooks provide context; they cannot independently open a native Codex question before a model turn. Explicit approval in chat authorizes the agent to connect through the CLI; declining lets it ignore the checkout and continue without SpoolDB. In the local SpoolDB UI, **Detected repositories → Choose connection** offers:

- Create a new shared project, if your membership permits it.
- Join a matching project you can access, or explicitly link an existing project you administer.
- Ignore this checkout. This persists until the repository identity changes.

The final **Connect and share conversations & memory** button grants approval for that checkout and enables saved Codex conversation capture. It may import earlier saved conversations for this checkout as well as future ones. The local companion retains local code snapshots; the shared relay stores memory and Git references only.

Once approved, the global MCP bridge routes memory tools to that checkout. Session and turn hooks retrieve context and request handoffs. This needs no new `.codex/config.toml` inside the repository. Existing project-local SpoolDB connections keep working and take precedence; global hooks avoid duplicating their lifecycle work.

## CLI

```sh
spool discovery enable
spool discovery list
spool discovery propose /path/to/repo
spool discovery preview /path/to/repo
spool discovery approve /path/to/repo
spool discovery approve /path/to/repo --room EXISTING_ROOM
spool discovery ignore /path/to/repo
```

Approval prompts interactively. Noninteractive approval requires `--yes` after explicit user authorization. The global hooks never call approval themselves. No create/join tool is exposed to the model through MCP.

## Matching and access

The supported `origin` remote is normalized without its credentials: SSH and HTTPS URLs for the same host and repository path share an identity. Path case and nonstandard ports remain distinct. Worktrees and different local paths resolve to the same remote identity; each checkout still needs its own initial approval. Repositories without an origin require explicitly choosing an existing shared project. SpoolDB never fetches or pushes Git.

The relay stores a hash of the canonical remote and binds it to a shared room. Project creation and identity binding commit together. Concurrent/retried enrollment uses the binding rather than making another project. Matching a remote does not grant membership: an inaccessible match refuses enrollment until a project invitation grants access. Only project administrators may attach a previously unbound repository identity to an existing project.

Changing a checkout's remote or selected workspace invalidates its discovery approval. The existing local connection is retained for recovery, but global tools and hooks require renewed approval before using it. Discovery state survives companion restarts. All proposal and approval actions use the owner-only Unix socket or the same loopback session/CSRF checks as the UI.

## Limits

Discovery runs in Codex lifecycle hooks; it is not a scanner of every folder, editor database or historical chat. The Codex backend must support user-level MCP and lifecycle hooks. Session reopening is required after installation. Zed itself is not instrumented; Codex in Zed uses that same Codex configuration. Hook errors warn and let work continue. If the companion is stopped, start it with `spool service client start`.

Implementation follows the [official Codex hooks documentation](https://learn.chatgpt.com/docs/hooks).

## Live end-to-end acceptance

Run `bun examples/discovery-flow-check.js` from the source checkout with Codex installed and signed in. It uses the configured model, an isolated Codex home referencing the existing sign-in, a disposable Git checkout and a separate loopback relay/client. No projects are created in the company workspace. The sign-in link is removed and both services stop at the end.

The first real Codex app-server session asks about connecting. The driver records that no project or capture exists, then supplies an explicit approval reply. That session inspects the fixture and writes a finding and handoff through MCP. A second app-server process receives no recap, retrieves the exact handoff, repairs the fixture, runs its test, completes the original task and leaves its own handoff. The driver separately reruns the fixture test and checks that conversations were captured and the relay has no file shards. Reports and raw fixture-only traces are retained in the reported temporary directory.

The acceptance exercises the backend protocol used by the Codex desktop app. Desktop window interactions and a human clicking the approval question are separate manual checks. Run the integration tests to reproduce the backend checks.
