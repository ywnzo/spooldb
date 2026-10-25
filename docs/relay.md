# Self-hosted relay and multi-client sync

The relay synchronizes sharded SpoolDB databases over authenticated HTTP. It persists code, conversation and comments in a local SQLite database and acknowledges uploads only after commit. Clients keep editing offline, then merge causal history on reconnect. Any harness using the engine or Git bridge can use the same client; the relay does not run harness commands.

The same service now serves a [read-only web review UI](review.md) at `/review`. Named review snapshots can be published with the sync CLI or `SyncClient.publishBranch`; that operation uploads without pulling unrelated aggregate history into the local branch. Ordinary bidirectional sync retains its earlier behavior.

This implementation uses polling and room-level grants. PostgreSQL, object storage, WebSocket fanout, file-level access control and high availability remain future work. The million-edit **local engine** benchmark is separate from the smaller [multi-client HTTP workload](../benchmarks/README.md).

## Start a private relay

Use Bun 1.4.4 or newer and install the project's locked dependencies with `bun install --frozen-lockfile`. Run commands from the project directory. Use a separate relay database, outside any source checkout you capture.

First initialize or attach the first local sharded client database using the existing CLI. Obtain its `room` from the `init` response or `refs`. Other clients must join that same room; independently initializing them creates unrelated rooms.

```sh
printf '%s\n' '{"command":"init","branch":"main"}' \
  | bun src/cli.js alice.sqlite --sharded
bun src/relay-cli.js credential alice ROOM_ID write
```

The credential command outputs a random bearer `token` and its server-side `credential` containing only the SHA-256 `tokenHash`. Give the token to that client and copy the credential into an administrator-owned configuration file. Generate separate credentials per client or person. Do not commit tokens or put them in URLs or command-line arguments.

Example `relay-config.json` (replace both placeholders):

```json
{
  "credentials": [
    {"id":"alice","tokenHash":"TOKEN_HASH_FROM_CREDENTIAL_COMMAND","rooms":{"ROOM_ID":"write"}}
  ],
  "maxPageBytes": 4194304,
  "maxConnections": 64,
  "maxActiveRequests": 16
}
```

```sh
bun src/relay-cli.js relay.sqlite relay-config.json --port=8787
```

The default bind address is `127.0.0.1`. The process emits a JSON listening event and accepts SIGINT/SIGTERM for shutdown. `GET /healthz` reports readiness without listing rooms or data. Bind options are explicit: `--host=127.0.0.1 --port=8787` (port zero selects a free port).

For remote hosting, terminate HTTPS at a reverse proxy and forward to the loopback listener. Forward the Authorization header, preserve the `/v1/rooms/...` paths, and allow request bodies up to 16,000,000 bytes. The client accepts a relay origin, without a path prefix. TLS termination and a real remote deployment are not exercised by the loopback test suite. Run one relay process per database on local storage; SQLite WAL is not a shared-disk multi-host database ([SQLite WAL documentation](https://www.sqlite.org/wal.html)).

## Connect clients

Load the bearer token into `SPOOL_RELAY_TOKEN` through your shell environment or secret manager. It is read only at client startup and is not stored in the client cursor table.

```sh
bun src/sync-cli.js alice.sqlite http://127.0.0.1:8787 ROOM_ID
bun src/sync-cli.js bob.sqlite https://relay.example.org ROOM_ID --watch
```

Create a Bob credential with the same room grant and use Bob's own token. The second command can start with an absent database: it imports the authorized room instead of creating a new identity. HTTP is accepted automatically only for loopback names; remote origins require HTTPS. The library offers an explicit `allowInsecureHttp` override for controlled networks; the CLI does not enable it.

One-shot sync uploads its starting local frontier, then downloads a finite snapshot of the relay frontier. A peer that uploads later can require another sync pass. Watch mode polls every second, with one sync at a time, bounded retries and an abort signal. Authorization failures stop watching; temporary network failures retry on later polls. JSON completion events include page/request counts, attempted JSON upload bytes, completely read response bytes and current local heads. These are payload counters, not network-interface traffic measurements.

Sync modifies the local database. It does not overwrite the source checkout or update a running editor's buffers. Use the existing isolated snapshot materialization command to inspect synchronized code in a new directory. Git captures and native adapter streams continue to write into their local engine branches normally.

## Library use

```js
import { ShardedEngine } from 'spooldb';
import { SyncClient } from 'spooldb/relay';

const engine = new ShardedEngine('client.sqlite');
const client = new SyncClient(engine, {
  url: 'https://relay.example.org',
  room: 'ROOM_ID',
  token: process.env.SPOOL_RELAY_TOKEN,
  branch: 'main',
});
try {
  const result = await client.sync();
  console.log(result);
} finally {
  engine.close();
}
```

`sync({mode:'pull'})` never uploads. A read-only credential needs this option (CLI `--pull`). `watch({intervalMs:1000,signal,onSync,onError})` runs serialized polling. The default request timeout is 30 seconds, with two retries after the initial attempt for transient failures. A sync run has a default 1,000-page budget; it preserves successful cursors and can be called again. Do not reuse a branch for an unrelated room.

## Authorization and revocation

Every data endpoint authenticates a bearer token and checks its exact room grant **before** reading room state or importing data. A `write` grant includes reads; `read` denies uploads. There is no wildcard grant, public join endpoint or remotely callable ACL administration. A read grant includes all retained history and deleted content in the room, not just the current worktree.

Edit the credential configuration and send SIGHUP to reload grants. Invalid replacement configuration leaves the previous grants intact and emits a reload-failed event. The library equivalent is `relay.setCredentials(...)`. Authorization is checked again after an upload body arrives so a credential revoked during an upload cannot commit it. Revocation cannot remove data already downloaded by a client.

Authentication identifies the uploading principal. CRDT actors and imported provenance remain client claims; they are not signatures or proof of authorship. The local `relay_audit` table records the authenticated principal, room, accepted frontier and acceptance time. Repeated acknowledgments of the same principal/frontier do not create duplicate audit rows. The relay can read stored content; end-to-end encryption is not implemented.

## Sync protocol and durability

Responses identify `spool-relay/1`. Data endpoints are:

| Endpoint | Request | Result |
| --- | --- | --- |
| `GET /v1/rooms/ROOM/state` | Bearer token | Current relay heads (empty if not seeded), page-byte limit |
| `POST /v1/rooms/ROOM/push` | `{"bundle": V2_BUNDLE}` | Accepted bundle heads, merged relay heads, `durable:true` |
| `POST /v1/rooms/ROOM/pull` | `{"since": KNOWN_HEADS, "heads": OPTIONAL_TARGET_HEADS}` | Bundle or null, snapshot target heads, `more`, bundle byte count |
| `POST /v1/rooms/ROOM/review` | Review command; writer grant required for `publish` | Named snapshots, files/diffs, causal conversation and existing comments; see [review API](review.md) |

Uploads are validated with the engine's causal dependency, content-hash, manifest reconstruction and document checks. A complete page and its authenticated audit entry commit in one SQLite transaction before acknowledgment. Retrying a dropped acknowledgment is idempotent. Incomplete or malformed batches roll back; earlier successfully committed pages remain valid.

Clients store separate push and pull frontiers in `relay_cursors`, keyed by origin/room/branch. Upload cursors advance only after acknowledgment. Downloads and their cursor advance in one local transaction. Pulling remote data never acknowledges unrelated local edits made while fetch was pending. A relay missing a client's causal base returns `409 MISSING_DEPENDENCIES`; the client resets cursors and tries a full causal replay once. Persistent missing data remains an error, not a retry loop.

Pages default to at most 32 complete global batches and 4 MiB of encoded bundle data; the relay can set a limit between 1 KiB and 8 MiB. The exporter reduces batch count to fit the byte budget. A **single atomic batch must fit**. A huge initial Git capture or tool batch may therefore need smaller submissions; splitting the network transfer of one oversized batch is not implemented. Earlier pages can be visible, but part of one batch cannot be published. A frontier is limited to 128 heads; larger concurrency frontiers require a future protocol extension.

HTTP request/response JSON is capped at 16,000,000 bytes. Compressed requests are rejected. Headers, request time, active requests and connections have explicit bounds; no unbounded fanout queue is maintained. Page discovery/export still walks global causal history and manifest nodes, so a byte bound is not a constant CPU bound. Engine validation runs synchronously in the server process. Worker isolation, storage quotas and per-principal rate limits are needed before exposing this private-collaborator prototype to broadly untrusted writers.

`durable:true` means the page committed to this relay's SQLite WAL/FULL store. It does not mean another host replicated it, a backup completed or the source checkout materialized it. There is no distributed transaction across relay instances.

## Backup and restore

Create a consistent local snapshot while the relay is running:

```sh
bun src/relay-cli.js backup relay.sqlite relay-backup-001.sqlite
```

The destination must be new; the command creates it with mode `0600` and uses SQLite `VACUUM INTO`. Existing files are never overwritten. The library equivalent is `relay.backup(newPath)`. The snapshot includes all relay rooms, history and the audit table. Preserve the credential configuration separately. The operation can be expensive and is not an incremental backup ([SQLite snapshot behavior](https://www.sqlite.org/lang_vacuum.html#vacuum_with_an_into_clause)).

To restore, stop the relay, preserve its current database and WAL/SHM files as rollback material, place the backup at the configured database path with no stale sidecar files at that path, and restart with the intended grants. Clients that retain history newer than the backup can resend it after cursor reset. A backup cannot recover history absent from both the snapshot and surviving clients.

## Verification

`bun test` covers ten HTTP clients, separate relay/CLI client processes, offline concurrency, restart, lost acknowledgments, cursor reset, complete-batch paging, page budgets, read-only access, two populated room boundaries, revocation during upload, rejected partial bundles, cancellation and backup restoration. `bun run benchmark:relay` records a separate ten-client/five-round run with correctness checks and payload counts in [relay-results.json](../benchmarks/relay-results.json).

The measured HTTP workload uses loopback and shares a Node process for relay/client engine work. The CLI process tests establish process separation and persistence, not multi-host capacity. WAN reconnect bandwidth, million-operation network sync, reverse-proxy TLS, destructive power-loss recovery and distributed failover remain unverified.
