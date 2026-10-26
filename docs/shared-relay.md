# One relay, many projects and machines

The shared host is independent of local capture. A host serves many shared projects (rooms). Each project can have many per-device/member credentials, with read or write access. Every local folder retains its own local project identity and capture database; connecting it maps its MCP memory operations to one shared project. Project identity is explicit: matching folder names or Git URLs never grants access or silently joins histories.

## Connect to your relay

Run the interactive server setup described in [workspaces](workspaces.md). The server prints the first owner invitation; connect a client to manage projects and create teammate invitations.

## Another computer on this LAN

Create a separate invite for that computer in the host administration panel, then paste it into the interactive installer or local Memory page. The invite includes the relay’s public certificate. The companion validates the certificate and requested hostname/IP for this relay only; it does not install a global root certificate or disable TLS verification. The host’s private key remains in its private state directory.


If the LAN address changes, update the host’s public origin and issue updated connections; certificate SANs must include the new address. Native private certificates expire after a year; renew them and distribute updated connections before expiry. For a stable remote deployment, use a DNS name and the public HTTPS proxy below.

An SSH tunnel remains an alternative for a host that cannot open its LAN firewall. Forward port 8878 and change only the connection URL to `https://127.0.0.1:8878`; keep its certificate and token. The generated native certificate includes loopback as well as this host’s LAN addresses.

## Deploy on another host

The host needs persistent storage and either the bundled Bun runtime or a container engine. The interactive Linux server installer configures Docker/Podman and Caddy containers as described in [workspaces](workspaces.md). It does not need Codex or access to source checkouts. A container deployment is supplied at `deploy/shared-relay/`:

```sh
export SPOOL_DOMAIN=memory.example.com
docker compose -f deploy/shared-relay/compose.yaml up -d --build
```

Point that domain at the host and allow ports 80/443 for Caddy’s certificate provisioning. Only the proxy publishes ports; the relay stays on the compose network. Project data and certificate state use persistent volumes. The installer supports Docker and Podman directly, without a Compose provider. The manual recipe below uses Docker Compose.

Administer projects locally on the deployment host:

```sh
docker compose -f deploy/shared-relay/compose.yaml exec relay bun src/team-host.js create /data 'Wield'
docker compose -f deploy/shared-relay/compose.yaml exec relay bun src/team-host.js list /data
docker compose -f deploy/shared-relay/compose.yaml exec relay bun src/team-host.js create-invite /data ROOM 'Alice laptop' write
docker compose -f deploy/shared-relay/compose.yaml exec relay bun src/team-host.js revoke /data ROOM MEMBER_ID
```

The create-invite command outputs a private, single-use invite link. A `read` credential can use direct remote MCP retrieval but cannot upload captured history; companion capture requires `write`. Native deployment uses `bun src/team-host.js start STATE --host=127.0.0.1 --port=8878 --origin=https://memory.example.com` behind your proxy. For native private TLS, add `--tls`, bind the required LAN interface and use its HTTPS public origin; initial certificate creation requires OpenSSL. Adapt the supplied systemd unit’s paths for that host. Keep the state directory and all SQLite WAL/SHM files on a local persistent filesystem; do not synchronize live database files with a file-sync tool. Stop the service before copying its complete state directory for a consistent cold backup.

## Data, evidence and failures

- Shared task updates are serialized by the relay and checked against task revisions. A stale update cannot silently overwrite another agent’s progress.
- New memory writes record the checkout’s sanitized origin, full HEAD commit (or null for an unborn repository), branch, dirty flag, project-relative file paths, optional content hashes and explicitly cited commits. A dirty checkout is not represented as fully committed evidence. Its hash detects local changes but cannot reconstruct uncommitted code; commit and push work through your normal Git workflow when another machine needs to retrieve it. `file_read` through a companion reads only its local capture; direct relay source reads are unavailable. Use Git to retrieve another commit.
- Captured conversations and existing local memory records are imported. Imported tasks remain namespaced by their original machine. Older snapshot references are marked legacy/unverified; no commit is invented for historical findings. New shared tasks use the common task ID directly.
- Conversation upload is incremental, paged and retry-safe, with durable receipts. Offline capture stays local and uploads after reconnection. The current single-process connector awaits bounded network attempts between capture cycles, so an outage can lengthen the capture interval. Shared task writes report failure while the relay is unavailable; they do not silently fork into a separate local task database.
- The local UI and MCP read authoritative shared memory. Per-device actor labels identify the authenticated connection; agent-authored claims and imported provenance still require verification.
- File contents are never uploaded by the shared connector. Older clients attempting file uploads receive an update-required error. Generic repository push and branch publication endpoints are disabled on the shared host. Native Codex capture still covers completed saved prompts/replies, not hidden reasoning or every tool event.
- All registered local projects restart their capture services when the primary companion starts, even when their UI has not been opened.

This is a single-relay deployment with room-scoped grants. Company SSO, email-based identities, high availability, horizontal database scaling and cryptographic agent authorship are not implemented. Per-device workspace enrollment and scoped remote project management are available. Revoking a credential prevents future requests; it cannot erase information a member previously retrieved.

## Validation

The automated multi-client test uses three independent project directories/state databases and two projects on one host. It checks handoff retrieval, source separation, stale-task rejection, cross-project denial, read-only grants, revocation, offline replay and host restart. A separate live acceptance uses two native Codex sessions with independent companion services and distinct shared-project credentials. All test clients run on this computer; a physical second-machine connection and the HTTPS container deployment require their respective external environments.

## Migrating an existing relay

A relay with old file-shard history refuses startup until migrated. Deleting current file entries is insufficient because immutable historical batches retain their contents. Stop the relay, rebuild it without file history, then restart:

```sh
bun src/team/migrate-memory-only.js /path/to/relay-state /path/to/local-rollback-backups
```

The rollback directory must be outside relay storage. The migration preserves project IDs, message IDs, task revisions, grants, pending invites and write retry receipts. It rewrites storage heads and converts old machine-qualified file references into project-relative legacy references. The previous database is retained separately for rollback; it still contains old captured code. Keep backups outside the served relay state. Remove it according to your backup policy when rollback is no longer needed. Already-downloaded data on other machines cannot be recalled.

New shared-project connections use memory-only local capture: enrollment does not snapshot or synchronize the checkout, so repository size cannot produce an oversized initial code batch. Existing local code-history projects retain their configured capture behavior.


### Background request frequency

The companion checks local capture on its normal cycle, but idle projects do not contact the relay on every cycle. Background state checks back off through 10, 20, 40, 80 and 160 seconds to a five-minute maximum. New or changed memory bypasses that timer on the next capture cycle; file-only changes do not wake remote memory sync. Failed checks also back off, preserving local capture. Explicit sync and agent memory requests bypass the idle timer.

Reads use the current sharing metadata returned with their authorized memory response, avoiding a second state request. Writes still fetch fresh sharing policy before upload. Project credentials remain separate; one project's authorization result is never reused for another project.

An open memory UI starts refreshing after 15 seconds and backs off to two minutes while unchanged. Hidden tabs stop scheduled polling and refresh on return. Stable retrieval/server settings refresh every two minutes; model loading and active maintenance keep two-second progress checks. These are refresh intervals, not a delay on agent queries or writes. With no UI open, a continuously idle project needs about 288 background state checks per day after backoff, plus startup/activity traffic; other clients contribute their own requests.
