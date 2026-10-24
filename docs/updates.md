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

Shared relays and Cloudflare deployments use their existing deployment workflow; this updater does not redeploy servers or change Cloudflare settings. Upgrade the relay before clients use new shared-memory metadata such as submodule references.
