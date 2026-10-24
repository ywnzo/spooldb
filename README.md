# SpoolDB

Shared project memory for AI coding agents. Preserve conversations, decisions, findings, tasks and handoffs so agents and teammates can pick up where another session stopped.

One relay serves multiple projects and machines. Code stays in Git; memory references files and commits. Codex desktop, terminal and Codex in Zed are supported, with MCP access for other agents.

[Download installers](https://github.com/ywnzo/spooldb/releases/latest) · [Codex plugin](docs/codex-plugin.md)

## Get started

### 1. Set up a relay

On a Linux x86-64 server:

```sh
curl -fsSL https://github.com/ywnzo/spooldb/releases/latest/download/install.sh -o install-spooldb.sh && sh install-spooldb.sh --server
```

Setup configures a background relay and prints a **private, single-use owner invitation**—before any client connects. Follow its prompts for storage, a reachable address, HTTPS and firewall setup.

Alternatively, install the CLI using the client command below, then run `spool deploy cloudflare`. Guided deployment creates a Cloudflare relay and owner invitation. Resume interrupted setup with `spool deploy cloudflare --resume`.

### 2. Connect your first client

On your computer:

```sh
curl -fsSL https://github.com/ywnzo/spooldb/releases/latest/download/install.sh -o install-spooldb.sh && sh install-spooldb.sh
```

Paste the owner invitation when prompted. No Git clone, separate runtime or JSON editing is required. Git is needed for project integration.

Or use **Codex → Plugins → Add marketplace → `ywnzo/spooldb`**, then install **SpoolDB**. Review its hooks and connect using the invitation in chat. The plugin includes the client; [setup details](docs/codex-plugin.md).

### 3. Create or join a project

Use the client UI, ask Codex, or run from your Git folder:

```sh
spool init
```

Choose an existing shared project or create one, then approve sharing. Start a new Codex session to load the integration.

Create invitations for other computers through **Settings → Workspace & team access**, Codex, or `spool workspace invite`. Each computer keeps its own checkout. Workspace and per-project controls choose what is shared; disabling sharing preserves existing shared history.

The **management UI runs on clients**; the relay serves invitation, download and authorization pages. CLI management is also available. Recover a self-hosted owner invitation with `spool server workspace owner-invite` on the server.

## More

[CLI reference](docs/cli.md) · [Server setup](docs/workspaces.md) · [Cloudflare](docs/cloudflare.md) · [Codex plugin](docs/codex-plugin.md) · [MCP and memory](docs/memory.md) · [Architecture and limits](docs/architecture.md)

Early-stage software · MIT license · Linux x86-64/glibc installers. Development: `bun install --frozen-lockfile` and `bun run test`.
