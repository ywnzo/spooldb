# Command-line management

The Linux installer installs `spool` under `~/.local/bin` (or the configured CLI bin directory). It uses the bundled runtime, so no separate Node installation is needed. The installer prints the complete command path; use that path if your shell does not include the directory in PATH.

For source development, replace `spool` below with `bun src/cli.js`. Run `spool --help` for the command list. Existing database/JSONL commands remain available with an explicit database filename.

## Start from a project folder

```sh
cd /path/to/repository
spool init
```

The interactive wizard detects the Git root, reuses the connected workspace, and lets you create a shared project, join an existing project, or paste an invitation. A matching Git remote is offered first. If this computer is not connected to a workspace, paste a workspace or project invitation when prompted. No internal project IDs are needed.

Before creating or joining a project, the wizard shows the folder, relay and sharing scope and asks for approval. It then enables saved Codex conversation capture, approves this repository for discovery, selects the local project, and installs/trusts SpoolDB’s shared Codex MCP and lifecycle hooks. This also works for Codex in Zed. Other repositories still ask before connecting. Start a new Codex session after setup.

Rerunning `spool init` offers to keep the current connection and refreshes Codex setup. Remote identity mapping and stable creation retry keys prevent duplicate projects when retrying. Git repositories without a remote can also create or explicitly join a project. No code is committed, pushed or uploaded to the relay.

## Workspaces without a browser

```sh
spool workspace connect
spool workspace status
spool workspace projects
spool workspace create 'New project'
spool workspace invite --label 'Alice laptop'
spool workspace invite --label 'Restricted laptop' --no-create
spool workspace members
spool workspace revoke MEMBER_ID
```

`connect` prompts for an enrollment link. Automation can use `--invite-file FILE` or `--invite-stdin` instead, avoiding secrets in shell history/process arguments. Invites are printed privately on request; `--json` returns compact structured output. Workspace credentials remain in the same private state directory used by the UI. Workspace commands call the server directly and do not require a browser or a running local companion. Permissions are identical to UI permissions.

Use `--request-id KEY` when retrying project creation in automation. Reuse the key only for the same name. Project names work directly; internal project IDs are not needed. Project invitations:

```sh
spool project invite Wield --label 'Bob laptop'
spool project invite  # Uses the currently selected project
spool project accept-invite --invite-file project-invite.txt
spool project join Wield /path/to/local/checkout
```

Joining starts an installed companion if needed and attaches the checkout through the same local API as the UI. By default it enables conversation capture and Codex integration; `--no-capture --no-agents` opts out. A direct project-only invitation can be used with `project join-invite FOLDER` without workspace enrollment.

## Local projects and capture

```sh
spool project list
spool project add /path/to/local/checkout
spool project select LOCAL_PROJECT_ID
spool status
spool project capture
spool project pause
spool project resume
spool project agents
```

Status checks are read-only and do not restart a stopped companion. CLI selection persists independently of the browser's selected project. `--project LOCAL_PROJECT_ID` overrides it for one command. `pause`/`resume` control Codex conversation capture; `agents` installs/reconnects the project integration. Stop the client service to stop all background capture.

## Memory and handoffs

```sh
spool memory context
spool memory search 'queue validation'
spool memory get MEMORY_ID
spool memory task queue-audit --revision 0 --status in_progress \
  --title 'Queue audit' --text-file summary.txt
spool memory remember --kind decision --title 'Validation policy' \
  --text-file decision.txt --task queue-audit --file server/actions.ts
spool memory handoff --task queue-audit --title 'Continue the audit' \
  --text-file handoff.txt --next-step 'Check resolve-time validation' \
  --file server/actions.ts --ref MEMORY_ID
```

Text can also be read through `--text-stdin`. `--file`, `--ref`, `--next-step` and `--blocker` are repeatable. Task conflict resolution accepts repeated `--resolve-id ID`. Reads support `--offset N` and `--limit N` for pagination. Existing tasks require their current revision. Writes use the owner-only companion socket, preserving the same project routing, Git checkpoints and shared-memory authorization as agent MCP. Reads return automatic Git reconciliation. Source contents remain local.

## Server administration and services

```sh
spool server setup
spool server status
spool server workspace init 'Company workspace'
spool server workspace owner-invite
spool server project create 'Wield'
spool server project invite ROOM_ID --label 'Alice laptop'
spool server project revoke ROOM_ID MEMBER_ID
spool service server status
spool service server restart
spool service server logs
spool service client status
spool service client stop
spool service client start
```

`server` administration commands use the relay's owner-only local Unix socket. Remote administration uses the authenticated `workspace` commands. Services are managed through the user systemd manager. Server setup is also available from the downloaded installer with `--server`.

Use `--state DIR` for a custom client state directory and `--server-state DIR` for a custom server directory. Installed command wrappers set these defaults for the installation. `SPOOL_STATE` and `SPOOL_SERVER_STATE` also supply defaults.

## Which web UI?

The workspace management UI runs in the **local companion**, normally at `http://127.0.0.1:8787`. It talks to the shared server's authenticated workspace API. The server currently has **no hosted workspace administration dashboard**; its static review shell is not an administration interface. CLI management supports headless operation.

Repository discovery is available with `spool discovery enable`, `list`, and `propose|preview|approve|ignore FOLDER`. `approve` asks before connecting and sharing captured conversations. Use `--room ROOM` to choose an existing project or `--name NAME` when creating one. `--yes` is for already-authorized noninteractive approval. See [discovery](discovery.md).

Connect a cloud MCP client once to all workspace projects: run `spool workspace invite` and answer the guided questions. Only omitted options are prompted for. For scripts, `--label "ChatGPT" --role writer --no-create` skips the questions; `--allow-create` explicitly permits project creation. JSON and non-terminal usage keep their existing noninteractive defaults. Choose `reader` for read only, or `member` for individually granted projects. Reader/writer access includes future projects without granting workspace administration.

## Updates

Use `spool update` for an interactive update, `spool update check` to check without installing, or `spool update enable` to opt in to daily updates. `spool update disable` turns them off. Choose `--target plugin` or `--target client` when both are installed. See [updates](updates.md).

Repository memory commands resolve the Git repository in the current directory. Use `--root /absolute/repo` when working elsewhere. They never use the last project selected in the web UI. Saved connection management accepts `--workspace NAME`; `spool init` asks which saved connection to use when more than one is available. There is no global workspace switch.
