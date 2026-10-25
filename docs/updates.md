# Updates

Updates are opt-in. Workspace connections, project approvals and stored memory are preserved.

## From Codex

Ask **“Enable automatic SpoolDB updates.”** The setup tool configures a per-user scheduler. It checks GitHub daily and updates through Codex after active SpoolDB sessions finish. The scheduler retries hourly while a session is active. Start a new chat to load the update, and review any changed hooks in Codex. An update never approves hooks for you.

Plugin updates require the public `ywnzo/spooldb` Git marketplace; older local marketplace copies must be replaced through Codex first. The Codex CLI executable must be available. The updater uses an installed CLI command or the CLI bundled in a standard macOS Codex/ChatGPT app location. If neither is available, setup asks you to install the CLI command. Automatic plugin updates work on Linux and Apple Silicon macOS.

Ask **“Check for SpoolDB updates”**, **“Update SpoolDB now”**, or **“Disable automatic SpoolDB updates”** to check, install or stop updates through the setup tool. A one-time update requires approval too.

## From the terminal

```sh
spool update check
spool update
spool update enable
spool update status
spool update disable
```

Enabling automatic updates prompts for approval. Use `--yes` for an explicitly authorized noninteractive run. Choose `--target plugin` or `--target client` when both are installed. These targets have separate settings. `spool update enable --mode check` records availability without installing it.

The standalone client updater supports installer-managed Linux x86-64 installations. Downloads use a pinned release URL and its SHA-256 checksum, then the installer performs a noninteractive update. Application copies and the prior service definition are restored if installation fails after replacement. The installation keeps the previous application copy; it does not delete project state or create new sharing approvals.

A Linux systemd user timer or macOS LaunchAgent runs the updater without an open chat. Its runtime is copied to a stable per-user location, so removing an old plugin cache does not break the scheduler. Status and errors are stored locally in the selected SpoolDB state directory. No automatic updates are enabled merely by installing the plugin.

Managed containerized VPS relays support the separate updater described below. Cloudflare deployments retain their deployment workflow; client/plugin updates do not change Cloudflare settings. Upgrade the relay before clients use new shared-memory metadata such as submodule references.

## Containerized VPS relay

On a managed Linux x86-64 Docker or Podman VPS, updates are off by default. The server installer offers an opt-in prompt. On an existing installation, first upgrade once with the server installer to obtain this feature, then:

```sh
sudo spool update enable --target relay
sudo spool update status
sudo spool update check
sudo spool update --yes
sudo spool update disable
sudo spool update cleanup --dry-run  # Preview backup/image/release cleanup
sudo spool update cleanup            # Apply retention now
```

The VPS command automatically selects the relay. A system systemd timer checks stable GitHub releases daily around 04:00–05:00 (server time), including a missed check after reboot. View failures with `journalctl -u spool-relay-update.service`.

The updater verifies the official installer checksum and package manifest, builds the candidate while the current relay runs, then stops the relay and backs up its data volume. Client requests receive a retryable maintenance response while HTTPS, candidate version, and the local memory administration API are checked. Success resumes requests; validation failure restores the previous container, database, file ownership, configuration and CLI. Caddy and its certificates remain in place. A failed release is quarantined rather than retried daily.

There is a brief maintenance window and disk space is needed for both images and a full memory backup. Backups are private under `/opt/spooldb/relay-backups`; they contain historical memory, including content subsequently deleted, and use automatic retention: keep the newest three backups for up to 30 days, plus any protected backups. The latest successful rollback backup and backups referenced by an unfinished transaction are always protected, regardless of age or count. Cleanup runs before daily update checks (even when already up to date or the release server is unreachable), after successful updates and restored rollbacks, and after recovery. Disabling scheduled updates also stops the daily cleanup; manual updates still clean up.

`sudo spool update status` shows the effective policy and last cleanup result. To change the limits, set `"backupRetention": {"keep": 3, "maxAgeDays": 30}` in `/opt/spooldb/relay-updates.json`, keeping its existing settings. Supported ranges are 1–100 backups and 1–3650 days. No extra configuration is needed for the defaults.

Cleanup recognizes legacy v0.4.13/v0.4.14 snapshots, skips unknown folders and directory symlinks, and refuses deletion when recovery references are corrupt. Cleanup failures are recorded without undoing a healthy update. Backup retention runs before the image and application retention below; repository files and active data/certificate volumes are untouched.


### Relay images and application releases

The same automatic cleanup also retains up to three recent relay images and application releases for 30 days, **plus every protected version**. It always preserves the current installation, the previous manual installation, all versions referenced by retained backups or an update/recovery transaction, the running updater and installed CLI, and images used by any running or stopped container. Retained image/release pairs stay together. Bind-mounted releases are protected too.

`sudo spool update cleanup --dry-run` previews backup, image and release cleanup together; omit `--dry-run` to apply it. `sudo spool update status` includes `artifactRetention` and the last `artifactCleanup` result. Optional limits use `"artifactRetention": {"keep": 3, "maxAgeDays": 30}` in `/opt/spooldb/relay-updates.json`, with the same ranges as backup retention.

Only SpoolDB relay tags and recognized installer release directories are eligible. Cleanup never runs engine-wide prune, forces image removal, or removes Caddy/base images, unrelated tags, data volumes or unknown directories. Engine inventory or reference errors stop artifact cleanup without rolling back a healthy update.

New backups record their original release and image. Older retained backups may lack that association; if it cannot be recovered from existing rollback records, image/release cleanup waits until backup retention expires those backups. This preserves rollback resources rather than guessing. Details appear in `artifactCleanup.errors`. Legacy image names and self-contained release layouts are recognized conservatively, and directory symlinks are skipped.

A power loss or forced process termination leaves a transaction journal and blocks further updates. Run `sudo spool update recover` to restore an unfinished transaction, or finish an already committed update without discarding accepted writes. Inspect `/opt/spooldb/relay-updates.json` and the journal before retrying a quarantined release. This updater covers the managed VPS relay; Cloudflare deployments and separately managed installations keep their own deployment process.


### Manage the relay from Settings

With a v0.4.18 or newer client and managed Docker/Podman VPS relay, open **Settings → Relay** while connected as a workspace owner. The page shows relay version, running status, free disk space, scheduled updates and recent maintenance results. Check for releases, install an update, enable or disable daily updates, and set backup and application/image retention limits there. These settings apply to the entire relay, across all workspaces and projects.

**Preview cleanup** reports eligible backups, images and application releases before confirmation. The server checks the preview again under its maintenance lock; if eligible resources change, request another preview. Current and rollback resources remain protected regardless of retention limits. Interrupted updates offer recovery when no maintenance process is still running. Jobs run in the background and survive closing the browser.

New managed installations include these controls. Existing managed VPS installations need one upgrade to v0.4.18 or newer to install the host controller; subsequent maintenance can be done in the UI. The container connects to a narrowly scoped root service over a Unix socket in a read-only directory mount. No container-engine socket is exposed. Only authenticated workspace owners can invoke its fixed maintenance actions; project tokens and other workspace roles cannot. Cloudflare and independently managed deployments show that host maintenance is unavailable and retain their existing deployment tools.
