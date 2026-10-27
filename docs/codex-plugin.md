# SpoolDB Codex plugin

Install the plugin once, review its hooks, and connect a project through a normal Codex chat. The plugin includes its native Bun runtime, MCP server, companion, setup skill and continuity skill. A separate Node/Bun or SpoolDB terminal installation is not required. The shared relay remains independent and can run on Cloudflare or a self-hosted server.

## Install in Codex

1. Open **Plugins → Add marketplace** in Codex.
2. Enter **`ywnzo/spooldb`** and add it.
3. Select **SpoolDB → Install**.

The plugin prepares its bundled runtime automatically on first use. No download/extraction steps, separate SpoolDB installation, Node/Bun installation, or JSON editing are needed. Linux x86-64 with glibc and Apple Silicon Macs with macOS 13 or newer are supported; Git, curl and tar must be available.

On a fresh installation, the first MCP connection can fail while the bundled runtime is prepared. Retry the connection or restart Codex once the download has finished. Native Apple Silicon MCP and lifecycle-hook startup are tested in CI; this does not replace checking the final install in your desktop app.

Review the four named hooks in Codex, then start a new chat and say **“Connect SpoolDB”**. Paste your workspace invitation there. Project sharing still requires your approval. Installation itself does not connect a workspace or upload conversations.

### Terminal alternative

```sh
codex plugin marketplace add ywnzo/spooldb && codex plugin add spooldb@spooldb
```

If SpoolDB is already installed, `spool plugin install` remains available. If legacy configuration exists, setup migrates only SpoolDB-managed entries after approval, preserves backups, and never trusts hooks for you.

### How the download works

The Git marketplace contains a small plugin launcher. Its release URL, archive checksum, hook definitions and hook fingerprint are pinned in the marketplace commit. On first launch, it downloads the matching release, checks the checksum and hook definitions, then installs the runtime into the plugin cache. Subsequent launches reuse it. Updates never switch to an unpinned latest payload or silently change reviewed hook definitions.

Manual [bundle downloads](https://github.com/ywnzo/spooldb/releases/latest/download/spooldb-codex.tar.gz) remain available for offline distribution.

## What runs automatically

- `SessionStart` loads shared project context for approved folders.
- `UserPromptSubmit` retrieves relevant context and creates/updates the session's task.
- Conversation capture reads saved Codex user/assistant messages, preserves session/turn/message provenance and deduplicates them. The current turn may appear only after Codex saves it. Hidden reasoning is not captured.
- `Stop` requests an agent-authored handoff once. If unavailable, a subsequent stop saves a clearly marked, unverified fallback checkpoint. `Interrupt` attempts a bounded fallback checkpoint.
- Findings remain evidence-based agent writes; the plugin does not invent findings from arbitrary conversation text.

The setup MCP tool supports status, invitation/project previews, approved connection, ignore, pause/resume and migration. Memory tools remain bound to the selected checkout and project. Code stays in Git, and cited commits/files are reconciled locally.

A fresh installation starts a private companion when the plugin runs. Concurrent plugin sessions share it. The plugin-owned companion shuts down after its final live connection closes and an idle grace period passes. State is kept outside the plugin cache, so reinstalling does not delete memory. An existing independently managed SpoolDB companion keeps its original service lifecycle; pause it through setup when you want capture to stop. No hook trust settings are written by plugin code.

## Distribution and support

The package uses `.codex-plugin/plugin.json`, root `mcp.json`, two skills, and `hooks/hooks.json`. This compatibility manifest is tested with Codex 0.163.0. The portable manifest's hooks/MCP extension fields were not honored by that installed build, so the distributed package uses the format that actually loads all components. Its MCP launcher also handles the installed build passing plugin-root placeholders literally: it locates the versioned Codex plugin cache while preserving the project working directory. The MCP server is named `spooldb` to avoid colliding with an older `spool` server during migration.

The Git marketplace is separate from OpenAI’s universal public plugin directory; adding `ywnzo/spooldb` makes SpoolDB available in your own plugin browser. This is a local Codex plugin; installing it in ChatGPT cloud does not deploy command hooks. IDE integrations, including Codex in Zed, need their runtime's plugin support verified separately; the existing companion integration remains available.

Build from source:

```sh
bun run build:plugin
```

The marketplace is written to `work/plugin-marketplace` and the self-contained archive to `installers/spooldb-codex.tar.gz`. The bundle contains source/runtime/production dependencies and public plugin metadata, never workspace tokens, invitations, state databases or deployment receipts.

## Stable hook trust across updates

Starting with plugin 0.3.0, hook commands use a version-independent, content-addressed dispatcher under `${XDG_DATA_HOME:-$HOME/.local/share}/spool/codex-hooks/<fingerprint>/run.sh`. The first migration from older versioned-cache commands needs one review. After that, an unchanged hook definition keeps its Codex key and trust hash across plugin version, icon, documentation and UI updates.

The fingerprint covers the dispatcher, the hook-only entry point, its complete local JavaScript import graph and the bundled interpreter binary. Changes to those files produce a new command/fingerprint, which Codex marks for review. Handler settings such as timeouts and status messages remain part of Codex's own definition hashing. Changing marketplace/plugin identity also creates a different trust identity.

Before executing hook JavaScript, the dispatcher verifies these pinned files in the current plugin against its immutable checksum manifest. It refuses mismatches rather than blindly forwarding a previously approved command to arbitrary new hook code. Existing dispatcher profiles are never overwritten; a modified profile is reported and left untouched. The companion remains a separate application service with its existing project sharing approvals and installation/update lifecycle.

`spool plugin install` installs the dispatcher automatically. Direct marketplace installations initialize it when the plugin MCP server starts. No production path writes Codex trust hashes. The native regression test approves hooks only in a disposable Codex home, confirms that trust survives a real UI-only plugin upgrade, then checks that modified hook code is refused and a hook upgrade is marked for review.

## Repository connections in Codex

There is no global active workspace. Ask Codex to connect the repository being worked on. The setup skill lists saved connections or previews an invitation, then asks for the connection and whether to create or join a matching shared project. Sharing still requires explicit approval. Saving a connection never moves another repository's memory.

When the agent encounters an unconnected repository mid-chat, memory tools return `PROJECT_CONNECTION_REQUIRED` with a structured setup question. The agent asks which saved connection to use, previews that repository on it, then asks to join an existing match or create a shared project. Choosing a connection does not authorize sharing the repository. **Continue without SpoolDB** records a local decline and suppresses future automatic questions for that repository; the user can explicitly reopen setup later. Failed writes remain unsaved and are never redirected to the starting project. Offline or denied access offers retry/skip, not duplicate creation.

Every local plugin memory call requires `root`, an absolute directory inside the repository currently being worked on. Git resolves its actual top level, including submodules. A chat can retrieve and save memory on several relays without restarting its MCP server. Missing bindings, permission failures and unavailable relays never fall back to the chat's original project. Results include the resolved repository and relay. Agents must retrieve each repository's own context when crossing repositories; the plugin cannot observe arbitrary `cd` commands in other tools.

`spool_setup workspace_status` lists saved connections; `workspace_preview` previews an invitation and `workspace_connect` saves it. Pass `root` and `workspace` to `preview`/`connect` for repository enrollment. The old `workspace_switch` action returns a migration explanation rather than selecting a global workspace. Legacy `workspace.json` credentials are preserved in saved profiles and a private migration backup; existing project grants and databases are untouched.

## Workspace sharing categories

Open Company workspace → Shared memory to choose whether new handoffs, decisions, findings, tasks and conversations are shared. Owners and admins can save settings; other members can see them. All switches default on for existing workspaces. Findings includes blockers. Changes apply across all projects and clients in that workspace, with revision checks to prevent overwriting another administrator’s changes.

`spool workspace sharing` offers interactive yes/no prompts; `spool workspace sharing --json` reads the current settings. In Codex, ask to change the sharing categories: `spool_setup action="workspace_sharing"` reads settings, and the same action with `sharing`, `expectedRevision` and `confirm:true` changes them.

Turning sharing off preserves existing shared history. New local capture and memory remain on that computer; private records are excluded from later uploads even if sharing is turned back on. Cloud clients have no local companion store, so disabled-category writes are rejected with `SHARING_DISABLED`, not reported as saved. A shared handoff can exist without a shared task when task sharing is disabled. These are category controls, not semantic redaction: administrators and agents must not copy private content into another category.

Automatic session tasks contain generic metadata rather than raw prompts, so task sharing works independently of conversation sharing. Older automatic records that embed raw prompt or assistant excerpts follow the conversation switch as well as their own category switch. Turning conversations off keeps those automatic excerpts local, while explicit agent-authored findings, decisions and handoffs follow their respective category settings.

## Per-project sharing

Under Settings → Workspace & team access, choose a shared project and use Project sharing. Each category offers Use workspace setting (default), Shared or Private. Workspace settings are an upper limit: a workspace-disabled category stays private even if the project requests sharing. The panel shows the effective settings. Existing shared history stays readable and private items are never backfilled automatically. Workspace administrators and that project's admins can save settings.

Use `spool project sharing Wield` for interactive prompts, or append `--json` to read the settings. In Codex, `spool_setup action="project_sharing" project="Wield"` reads them; an approved change adds `sharing`, `expectedRevision` and `confirm:true`. Set an override to null to inherit again. Settings are stored on the relay and enforced on every client, including direct remote MCP writes.

## Updates

Ask **“Enable automatic SpoolDB updates”** to opt in through the setup tool. Updates wait for active sessions to finish; changed hooks still require review. See [updates](updates.md).

### Companion upgrades

The plugin checks the companion protocol, version and capabilities before reusing a running service. An older plugin-owned companion is restarted automatically. Recognized Linux user services are upgraded to a staged runtime with the same state directory and a service-configuration backup; failed startup restores the previous configuration. Workspace credentials, project bindings and sharing approvals remain in place. Newer compatible companions are reused, so an older chat cannot downgrade them. Unrecognized services are left untouched with an actionable error. Project setup status includes the running companion version.

### Delete shared conversations

Ask Codex to “Delete shared conversations from PROJECT” or to delete one identified captured conversation. The plugin previews the scope and count, then submits the authorized deletion with a stale-preview check. Project admin access is required. Findings, decisions, tasks, handoffs and local Codex chats remain. Deleted messages/sessions are blocked from capture re-upload. Older relays must be upgraded once to v0.4.12 or newer.

In the web UI use **Project settings → Company workspace → Project sharing → Delete shared conversations…**. A shared conversation’s source details also offer deletion of its captured session. CLI administrators can use `spool project delete-conversations PROJECT`, with `--dry-run` for preview. Independent backups and already-downloaded copies are outside the deletion scope.

### Existing chats

Project connection offers **Analyze existing chats** or **Skip**. If accepted, Codex reviews the checkout's locally saved conversation history and saves useful decisions, findings, tasks and handoffs, with source references and verification limits. It deduplicates existing memory and accounts for later fixes and corrections. This choice is saved per checkout and resumes if interrupted.

Raw conversation sharing remains a separate setting. Private local chat retrieval is available only after the analysis choice is approved; the relay receives structured memory according to the workspace/project category settings. Unseen cloud or colleague chats are outside this machine's coverage. The analysis runs in a Codex session with reviewed plugin hooks; it is not an unattended relay summarizer. Connections made through the UI or `spool init` queue accepted analysis for the next Codex session.

Configuration and hook trust do not prove that an existing chat loaded the plugin. Setup status reports observed prompt-hook delivery separately from background capture. If no delivery is observed, open a new chat with the plugin enabled and hooks reviewed. Findings, decisions and handoffs are agent-authored useful evidence, not a record automatically created for every reply or every category.

### Older relays

SpoolDB checks repository-enrollment capabilities before creating a shared project.
If the relay is too old, Codex offers to update that selected relay instead of
creating a project and failing afterward. Existing matching projects remain
joinable. `spool_setup action="relay_update"` checks maintenance support;
`updateNow=true confirm=true` requests a supported host update after approval.
Cloudflare requires redeploying the existing Worker with its deployment credentials;
the plugin explains this rather than claiming to have updated it. After updating,
preview again and join any existing repository match instead of creating a duplicate.
