# SpoolDB in Rust

The Rust binary implements the command line, desktop companion, local MCP,
storage engine, and self-hosted relay. The Cloudflare build runs the shared
relay and memory logic in Rust compiled to WebAssembly. Cloudflare's OAuth
provider adapter uses the existing grant format in KV.

## Build and test

From the repository root, install the compatibility-test dependencies,
then build and test the native binary.

```sh
bun install --frozen-lockfile
cargo build --locked --release --manifest-path rust/Cargo.toml
cargo test --locked --manifest-path rust/Cargo.toml
cargo clippy --locked --manifest-path rust/Cargo.toml --all-targets -- -D warnings
```

The integration tests create old-format data with the previous Bun client,
open it in Rust, and reopen the result with the old client. They cover both
SQLite formats, Automerge history, sync grants, workspace invitations,
capture receipts, the local UI, and a restored relay backup.

For Cloudflare, install the `wasm32-unknown-unknown` Rust target and
`worker-build` 0.9.0. The compatibility fixture uses local workerd and
does not publish a Worker.

```sh
bun scripts/build-rust-worker.js
bun rust/tests/cloudflare-fixture.js rust/cloudflare/build/index.js
SPOOL_RUST_WORKER_CONFIG=rust/cloudflare/wrangler.jsonc bun test --timeout 60000 test/remote-mcp.test.js
rust/target/release/spool-native deploy cloudflare --dry-run --name spooldb-test
```

The fixtures cover old Durable Object databases, OAuth grants and revocation,
workspace privileges, request replay, semantic retrieval, and public downloads.
The Linux container fixture exercises legacy credentials and memory through
Caddy HTTPS and restores a cold backup with the native volume helper.

```sh
bun rust/tests/container-relay-fixture.js /path/to/debian-compatible/spool-native
```

The container fixture defaults to Kiri. Release CI also runs it in Docker and
Podman.

## Existing installations

Use the existing state directory on a client. Every checkout continues to use
its saved project binding and relay credentials. The self-hosted relay reuses
the existing database, `host.json`, and the existing `workspace-key` and
`invite-key` files. For private TLS installations, keep the existing
`relay.crt` and `relay.key` files with the relay data. Managed VPS updates
snapshot the named volume before starting the replacement and retain the
previous image and release for rollback.

When moving an existing Cloudflare Worker to Rust, use the same Worker name,
account, deployment receipt, Durable Object bindings, and OAuth KV namespace.
An interrupted deployment can resume setup with `spool deploy cloudflare
--resume`.

See [storage](../docs/storage.md), [CLI](../docs/cli.md), [server
setup](../docs/workspaces.md), and [updates](../docs/updates.md) for commands
and operating details.
