# Cloudflare Workers deployment

Cloudflare is an additional relay backend. The self-hosted Node/Bun relay, its CLI, Docker deployment, databases and services remain available. Deploying creates a separate workspace; it does not migrate the existing relay or change clients' project connections.

## Guided deployment

With the installed CLI:

```sh
spool deploy cloudflare
```

From a source checkout, install dependencies with `bun install --frozen-lockfile`, then run `bun src/cli.js deploy cloudflare`. The installer contains the application runtime; Wrangler is downloaded on demand if it is not installed with the application. A network connection and a Cloudflare account with permission to deploy Workers and SQLite Durable Objects are required.

The wizard:

1. Asks for a Worker name.
2. Uses Wrangler's existing credentials, or opens its browser sign-in flow.
3. Lets you select your Cloudflare account and name the workspace.
4. Writes a private deployment directory and compiles the Worker without publishing.
5. Shows the account, Worker, workspace and file location; asks before publishing.
6. Checks the deployed health endpoint and initializes a single-use owner invitation.
7. Offers to connect this client separately. Switching workspaces backs up the previous workspace credential, and leaves existing project connections intact.

The private owner link connects clients through the existing UI or `spool workspace connect`; project creation, membership, invites and automatic repository enrollment then use the same protocol as a self-hosted relay. Reopening Codex loads the local MCP integration. Capture and Git reconciliation still run on each developer's computer.

Build-only verification needs no Cloudflare sign-in:

```sh
spool deploy cloudflare --dry-run --name company-spool
```

For an explicitly authorized noninteractive deployment:

```sh
spool deploy cloudflare --yes --name company-spool \
  --account-id YOUR_ACCOUNT_ID --workspace-name 'Company'
```

Use `--deploy-dir PATH` to store deployment files elsewhere, `--url https://relay.example.com` for a separately configured public origin, and `--no-connect` to avoid offering a client switch. `--connect` explicitly enrolls this client after initial setup. Custom domain provisioning is managed through Cloudflare/Wrangler separately; passing `--url` does not create DNS routes.

Deployment receipts are stored under the selected SpoolDB state directory in `deployments/cloudflare/WORKER/`, with mode 0600. They contain a private bootstrap token and may contain the owner invitation; do not publish or commit them. Credentials for Cloudflare itself remain managed by Wrangler. Re-running the same deployment directory preserves the bootstrap capability, namespaces, workspace and data. Only the token's SHA-256 hash is sent in Worker configuration. `/v1/setup` requires the token and cannot mint another owner invitation once an active owner exists. Existing admins invite members through workspace commands.

## Storage and authorization

- `SpoolWorkspace` holds members, grants, project/repository identities and expiring invitations in its own SQLite Durable Object.
- `SpoolProject` is routed by project ID. Each project gets a separate persistent SQLite Durable Object and the existing memory/CRDT engine.
- Every external project request is authenticated against current workspace/project credentials before forwarding to the project object; client-supplied principal headers are ignored. Member revocation is checked on subsequent requests.
- The relay accepts conversations, findings, decisions, tasks, handoffs and Git references. File uploads, generic repository pushes and branch publication are rejected. Git and the local companion remain the source of code.
- Original conversation session/turn/item provenance and task revisions use the same format as the self-hosted relay. Captured provenance and agent findings are claims, not cryptographic proof of authorship.
- SQLite transactions use Durable Object `transactionSync`; schema validators are generated ahead of time to avoid runtime code generation in Workers.
- No persistent container disk, VPS, or external SQL service is required. Cloudflare manages TLS on its deployed URLs.

One deployment currently represents one company workspace with many project objects. Workspace authorization still passes through one object. Each project has Cloudflare's per-object storage/CPU limits; this is project-level partitioning, not unlimited capacity inside one project. Consult the current [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/) and [pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/). Use Cloudflare's SQLite point-in-time recovery for operational recovery; a self-hosted `.sqlite` file is not automatically uploaded or converted by this command.

## Verification

`bun run test:cloudflare` compiles the actual Worker bundle and exercises it in local workerd with persistent SQLite: owner setup, invite redemption, independent projects, shared findings/handoffs, task revision updates, conversation provenance, access denial, revocation and restart durability. `test/deploy-cloudflare.test.js` covers the wizard's non-publishing path and deployment sequence with injected cloud calls. A local emulator pass does not prove a deployment to a particular account; a live run additionally needs Wrangler authentication and the wizard's publish confirmation.

## Resume after a published deployment

If upload succeeds but a health/setup check fails, run `spool deploy cloudflare --resume`. It uses the saved private deployment receipt, performs no Wrangler login/build/publish, retries temporary HTML responses, and resumes workspace initialization or displays the saved owner invitation. Add `--name NAME` or `--deploy-dir PATH` if you used another deployment location. HTTP status, content type and Cloudflare Ray/error codes are reported for non-JSON edge responses. Client switching remains a separate confirmation.


## Hosted installers and browser invitations

The relay serves a Kiln-themed download page at `/` and guided invitations at `/join#...`. Invite creation in the UI and the normal CLI output returns HTTPS links; JSON output retains both the application `link` and HTTPS `browserLink`. Project names are accepted: `spool project invite Wield`, or omit the name to use the selected local project. Creating or previewing an invite does not enroll a computer.

The invite fragment remains in the recipient’s browser. The page validates that it belongs to the current relay, previews it with an authorized POST, and prepares a setup script locally. The setup script carries the invite in a private temporary file, downloads an immutable installer URL, verifies its pinned SHA-256, and runs the interactive installer. Existing installations can open the application link instead. Expired or used invitations are rejected with a useful message; request a fresh link for another computer.

To publish installers from a source build:

```sh
bun scripts/build-linux-installer.js
bun scripts/build-download-assets.js
spool deploy cloudflare
```

The deploy wizard includes `work/download-assets` when its manifest exists. For an existing manually managed Wrangler configuration, add `assets: { directory: ABSOLUTE_DOWNLOAD_ASSETS_PATH, binding: "DOWNLOADS", run_worker_first: true }` before deploying. No new database or workspace is created. Without a download binding the relay API still works, and the page explains that installers have not been published.

The asset builder includes only explicitly named installers and their public manifest. It retains older immutable releases so existing downloaded setup scripts remain usable. It excludes local state, invitation files, database backups and deployment secrets. Installers exceed Cloudflare’s [25 MiB individual static asset limit](https://developers.cloudflare.com/workers/platform/limits/), so each is published in 20 MiB parts and streamed as one file. Downloads support HEAD, ETag and single byte ranges, including ranges across parts. No R2 bucket or separate download host is required. The public `/install.sh` provides a generic checksum-verifying setup script; invite pages prepare their personalized version in the browser.

## Connect ChatGPT cloud over MCP

The Cloudflare relay exposes a stateless Streamable HTTP endpoint at **`https://YOUR-RELAY/mcp`**. It supports OAuth authorization-code flow with mandatory PKCE S256, protected-resource and authorization-server discovery, client ID metadata documents, dynamic client registration, one-hour access tokens and rotating refresh tokens (30-day idle lifetime). OAuth state is stored in a dedicated `OAUTH_KV` namespace, separate from project Durable Objects. `spool deploy cloudflare` provisions and reuses this namespace after publication approval. Existing deployments need one redeployment to add it; `--resume` deliberately does not publish or provision resources.

1. Run `spool workspace invite`. The terminal asks for a name (for example, ChatGPT), project access, and whether the connection may create projects. Choose **All projects — read and write memory**, then **No** for project creation. This requires workspace admin access. `writer` grants read/write memory access to all current and future projects without workspace administration; `reader` grants read-only access. `member` limits discovery to individually granted projects. In the local UI, choose **Workspace → Invite and manage teammates → Workspace access → All projects**.
2. In ChatGPT's custom MCP settings, enter your relay's `/mcp` URL and select OAuth. Workspace administrators may need to allow custom integrations.
3. Paste the workspace invitation on SpoolDB's authorization page and click **Check access**. Review the workspace, client publisher, return host and read/write permissions, then authorize once. Invitations are private, single use and expire after 24 hours. Existing project-only OAuth connections stay project-only; reconnect with a workspace invitation to broaden access explicitly.
4. In each cloud chat, ask the agent to work on a named project. The agent calls `project_list`, chooses the relevant project, and passes its ID (or an unambiguous exact name) as `project` on every memory tool call. Missing or ambiguous project selection is rejected; ask the user when unclear. There is no connection-wide mutable active project, so concurrent chats cannot redirect each other.

The connection exposes `project_list`, `project_context`, `memory_search`, `memory_get`, `task_update`, `remember` and `handoff`; local `file_read` is absent. Discovery returns only authorized project IDs, names and roles. It never returns credentials. Each memory operation rechecks workspace membership and current project access. Write tools require both read/write OAuth scopes and a native project write grant. Read-only invitations cannot authorize write scopes. Workspace reader/writer roles include future projects without reauthorization; selected-project members see newly granted projects dynamically. Task updates still require the current revision. Remote records carry the cloud connection's actor label and connection-level session identity, not a fabricated ChatGPT conversation ID. Code stays in Git; file and commit references are claims until verified against a real checkout.

ChatGPT MCP access does **not** install Codex hooks, automatically export ChatGPT transcripts, or guarantee a model will retrieve context or leave a handoff on every turn. Use project/chat instructions to request that workflow. Local Codex capture continues independently.

List and revoke project connections using friendly names:

```sh
spool project connections Wield
spool project revoke Wield "Cloud MCP · ChatGPT"
```

Use the exact label returned by `connections`, or its ID if several active connections have the same label. Workspace cloud connections are listed with `spool workspace status` and revoked with `spool workspace revoke MEMBER_ID` (use the ID shown beside the cloud connection in `spool workspace members`). Project-only connections use the project commands above. Revocation is checked against the workspace Durable Object on every authenticated MCP request and token exchange, so an unexpired OAuth token cannot retain project access after revocation. Ordinary KV propagation still affects OAuth code/refresh state; do not treat this as a globally atomic OAuth transaction store.

To validate locally, run `bun run test:cloudflare`. The workerd test exercises discovery, browser-bound consent, PKCE, redirect rejection, project context, linked findings/handoffs, retry keys, read-only access, revocation, refresh and persisted tokens after Worker restart. Validators for remote tool arguments are precompiled for Workers (no runtime `eval`); regenerate them after changing `src/memory/tools.js` with `bun run generate:memory-schemas`.
