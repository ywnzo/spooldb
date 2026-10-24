# SpoolDB Codex plugin

Install the plugin once, review its hooks, and connect a project through a normal Codex chat. The plugin includes its Linux x86-64 runtime, MCP server, companion, setup skill and continuity skill. A separate Node/Bun or SpoolDB terminal installation is not required. The shared relay remains independent and can run on Cloudflare or a self-hosted server.

## Install on this computer

If SpoolDB is already installed:

```sh
spool plugin install
```

This registers a local SpoolDB marketplace, installs `spooldb@spooldb` in Codex, and remembers the current SpoolDB state directory. It leaves the existing relay, project connections and capture data in place. It does not trust hooks on the user's behalf.

Open the SpoolDB plugin in Codex and run its setup workflow (or ask “Set up SpoolDB for this project”). The four hooks are labeled “SpoolDB: Load project context”, “SpoolDB: Retrieve relevant memory”, “SpoolDB: Save handoff” and “SpoolDB: Save interrupted checkpoint”. Codex uses their `statusMessage` values as display names. Review and trust them in Codex's hook manager (`/hooks` in the CLI). If old managed configuration is detected, setup migrates it only after the plugin hooks are trusted and the user approves. Backups are kept under the private state directory's `integration-backups`. Restart the Codex session after migration so old running MCP processes and hooks are unloaded.

## Install on a new Linux machine

Download the [plugin marketplace bundle](https://github.com/ywnzo/spooldb/releases/latest/download/spooldb-codex-linux-x64.tar.gz), extract it into a permanent folder, and add that marketplace in Codex. With the Codex CLI:

```sh
mkdir -p ~/.local/share/spooldb-plugin
curl -fL https://github.com/ywnzo/spooldb/releases/latest/download/spooldb-codex-linux-x64.tar.gz -o /tmp/spooldb-plugin.tar.gz
tar -xzf /tmp/spooldb-plugin.tar.gz -C ~/.local/share/spooldb-plugin
codex plugin marketplace add ~/.local/share/spooldb-plugin
codex plugin add spooldb@spooldb
```

These are standard Codex installation commands; there is no `spool init` or JSON configuration step afterward. Use the plugin's setup workflow to paste a project or workspace invitation, choose an existing project or create one, and approve sharing. A workspace invitation connects the machine to the workspace only; project sharing requires a separate approval. Opening an unconnected Git folder prompts for a choice before capture starts. Declining records that choice.

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

Hook-containing plugins currently require manual/private distribution rather than the public plugin directory. The bundle can be shared through a company marketplace. This is a local Codex plugin; installing it in ChatGPT cloud does not deploy command hooks. IDE integrations, including Codex in Zed, need their runtime's plugin support verified separately; the existing companion integration remains available.

Build from source:

```sh
npm run build:plugin
```

The marketplace is written to `work/plugin-marketplace` and the self-contained archive to `installers/spooldb-codex-linux-x64.tar.gz`. The bundle contains source/runtime/production dependencies and public plugin metadata, never workspace tokens, invitations, state databases or deployment receipts.

## Stable hook trust across updates

Starting with plugin 0.3.0, hook commands use a version-independent, content-addressed dispatcher under `${XDG_DATA_HOME:-$HOME/.local/share}/spool/codex-hooks/<fingerprint>/run.sh`. The first migration from older versioned-cache commands needs one review. After that, an unchanged hook definition keeps its Codex key and trust hash across plugin version, icon, documentation and UI updates.

The fingerprint covers the dispatcher, the hook-only entry point, its complete local JavaScript import graph and the bundled interpreter binary. Changes to those files produce a new command/fingerprint, which Codex marks for review. Handler settings such as timeouts and status messages remain part of Codex's own definition hashing. Changing marketplace/plugin identity also creates a different trust identity.

Before executing hook JavaScript, the dispatcher verifies these pinned files in the current plugin against its immutable checksum manifest. It refuses mismatches rather than blindly forwarding a previously approved command to arbitrary new hook code. Existing dispatcher profiles are never overwritten; a modified profile is reported and left untouched. The companion remains a separate application service with its existing project sharing approvals and installation/update lifecycle.

`spool plugin install` installs the dispatcher automatically. Direct marketplace installations initialize it when the plugin MCP server starts. No production path writes Codex trust hashes. The native regression test approves hooks only in a disposable Codex home, confirms that trust survives a real UI-only plugin upgrade, then checks that modified hook code is refused and a hook upgrade is marked for review.

## Connect and switch workspaces in Codex

After installing the desktop plugin, say **“Connect my SpoolDB workspace”** in Codex. The setup skill lists saved workspaces or asks for an invitation, previews its workspace name and access, then connects after your approval. No terminal command, browser UI or open Git folder is required for workspace-only setup. Next, choose the shared project for an actual Git folder and separately approve conversation sharing.

Say **“Switch to the Acme workspace”** to use a saved workspace. Saved names and relay addresses are shown through `spool_setup`; credentials remain in private local profile files. Switching changes the workspace used for future project enrollment. It preserves every already-connected checkout and its capture destination. Repository identity changes still invalidate discovery authorization and require new sharing approval. If a saved connection has expired or been revoked, a failed switch preserves the current workspace.

The setup tool exposes `workspace_status`, `workspace_preview`, `workspace_connect` and `workspace_switch`. Connection/switch actions require explicit user approval via `confirm:true`. Workspace status never returns invitations or access tokens. Existing single-workspace installations are remembered automatically when first inspected or replaced. For headless administration the same profiles are available through `spool workspace saved` and `spool workspace switch NAME`.

## Workspace sharing categories

Open Company workspace → Shared memory to choose whether new handoffs, decisions, findings, tasks and conversations are shared. Owners and admins can save settings; other members can see them. All switches default on for existing workspaces. Findings includes blockers. Changes apply across all projects and clients in that workspace, with revision checks to prevent overwriting another administrator’s changes.

`spool workspace sharing` offers interactive yes/no prompts; `spool workspace sharing --json` reads the current settings. In Codex, ask to change the sharing categories: `spool_setup action="workspace_sharing"` reads settings, and the same action with `sharing`, `expectedRevision` and `confirm:true` changes them.

Turning sharing off preserves existing shared history. New local capture and memory remain on that computer; private records are excluded from later uploads even if sharing is turned back on. Cloud clients have no local companion store, so disabled-category writes are rejected with `SHARING_DISABLED`, not reported as saved. A shared handoff can exist without a shared task when task sharing is disabled. These are category controls, not semantic redaction: administrators and agents must not copy private content into another category.

Automatic lifecycle records that embed raw prompt or assistant excerpts follow the conversation switch as well as their own category switch. Turning conversations off keeps those automatic excerpts local, while explicit agent-authored findings, decisions and handoffs follow their respective category settings.

## Per-project sharing

Under Settings → Workspace & team access, choose a shared project and use Project sharing. Each category offers Use workspace setting (default), Shared or Private. Workspace settings are an upper limit: a workspace-disabled category stays private even if the project requests sharing. The panel shows the effective settings. Existing shared history stays readable and private items are never backfilled automatically. Workspace administrators and that project's admins can save settings.

Use `spool project sharing Wield` for interactive prompts, or append `--json` to read the settings. In Codex, `spool_setup action="project_sharing" project="Wield"` reads them; an approved change adds `sharing`, `expectedRevision` and `confirm:true`. Set an override to null to inherit again. Settings are stored on the relay and enforced on every client, including direct remote MCP writes.
