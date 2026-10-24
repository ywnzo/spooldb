# Install SpoolDB on Linux

Install directly from your relay with one command (replace the hostname for another relay):

```sh
curl -fsSL https://github.com/ywnzo/spooldb/releases/latest/download/install.sh -o install-spooldb.sh && sh install-spooldb.sh
```

This downloads a checksum-verifying setup script and starts the interactive installer. It asks for the invite link and project folder.

Open your team’s HTTPS project invite link. It shows the project name and offers **Download setup for PROJECT**. Run the downloaded script:

```sh
sh ~/Downloads/install-spooldb.sh
```

The script downloads a pinned installer, checks its SHA-256 and passes the invitation through a private temporary file. You still approve installation and sharing interactively. Start a new Codex session after setup. If SpoolDB is already installed, choose **Open SpoolDB** instead.

Alternatively, download `spool-linux-x64.run` from the relay’s download page or your administrator. In its download folder, run:

```sh
sh spool-linux-x64.run
```

The interactive installer asks before installing, then guides you through:

1. Paste the project's invite link (or skip and open it later).
2. Enter the path to your existing Git checkout.
3. Name your computer.
4. Confirm sharing saved Codex conversations and memory with Git references.
5. Choose automatic Codex integration, including Codex in Zed.

No JSON editing, separate runtime installation, or sudo are needed. Git must already be installed. The package includes Bun 1.4.3 and production dependencies. It supports Linux x86-64 on glibc systems; Alpine/musl and ARM are not supported.

The app registers `spool://` invite links and an application-menu entry. Capture and MCP start at sign-in through a user systemd service; desktops without a user systemd manager receive an autostart entry. Automatic Codex connection writes the project's managed MCP configuration and lifecycle hooks. Start a new Codex session after joining so it loads those settings. Existing Codex installations and authentication are prerequisites for using Codex.

The source folder stays in place. Private history and credentials live under `$XDG_STATE_HOME/spool` (normally `~/.local/state/spool`); the application lives under `$XDG_DATA_HOME/spool/app`. Re-running the installer updates the application while preserving state and keeping the previous app directory for rollback. It refuses to replace an independently managed development service.

## Initialize another project

Run `spool init` from its Git project folder. It guides you through creating or joining a shared project and automatically connects Codex after sharing approval. You can paste a project/workspace invite if this computer is not yet connected. Start a new Codex session afterward.

## Server setup and workspace management

Run the same package with `--server` for interactive server setup. Clients can connect a workspace, create projects and join through the UI. See [workspace setup](workspaces.md).

## Inviting teammates

In SpoolDB, open Memory → Manage shared projects on this host, choose a project and create an invite link. Send one link per teammate privately. Each link expires after 24 hours and can be redeemed once; a retry from the same installation recovers its existing credential. Each computer receives a separate revocable identity. A relay can host many projects, and a local app can connect multiple folders.

The administrator CLI also supports:

```sh
spool project invite Wield --label 'Alice laptop'
```

For a private LAN relay, the invite carries its public TLS certificate. SpoolDB validates that certificate specifically for this relay; it does not disable TLS checks or modify the operating system trust store. Distribute the installer through a trusted file channel. Cloudflare deployments can host the download page and installer assets as described in [Cloudflare deployment](cloudflare.md). Packages have SHA-256 verification; they are not signed releases.

## Check or stop the background service

```sh
systemctl --user status spool.service
systemctl --user disable --now spool.service
```

If the installer reported desktop autostart instead, remove `~/.config/autostart/spool.desktop` to disable it. Disabling background startup preserves local history and credentials.

## Build and verify the package

```sh
bun install --frozen-lockfile
bun scripts/build-linux-installer.js
sh installers/spool-linux-x64.run --verify-only
```

The build downloads and verifies the pinned portable Bun runtime. Set `SPOOL_BUILD_BUN` to use an existing standalone Bun executable. The runtime's license is included. Verification checks packaged file hashes and opens an in-memory engine using the bundled runtime; hashes detect corruption, not publisher authenticity.

## Runtime and Cloudflare options

`spool deploy cloudflare` adds a hosted workspace without replacing a self-hosted relay. See [Cloudflare deployment](cloudflare.md).

Application launchers, services and MCP hooks use the bundled Bun executable. Existing databases remain compatible; no data-format migration is required.
