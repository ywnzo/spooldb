# Server setup and company workspaces

On a fresh Linux x86-64 server, download the SpoolDB package and run:

```sh
sh spool-linux-x64.run --server
```

For a public VPS, install Docker or Podman and systemd first. Point a domain's A/AAAA records at this server and allow TCP 80/443 in its provider firewall. Enter the domain and approve sudo access. Setup builds the bundled relay locally, pulls the official Caddy image, configures automatic HTTPS, and enables `spool-shared.service` to start both containers after reboot. No Git checkout or host Bun/Caddy installation is required.

Only Caddy publishes ports. Memory, certificates and Caddy state live in named volumes (`spool-relay-data`, `spool-caddy-data`, `spool-caddy-config`); application files live under `/opt/spooldb`. Do not delete those volumes. Rerunning setup preserves them. Existing unmanaged services/resources are refused. Active UFW installations receive TCP 80/443 allow rules; DNS and provider firewalls remain your responsibility. Automatic setup uses the rootful engine so low public ports work without changing host sysctl settings.

Manage from the server with `sudo spool server status`, `sudo spool server workspace owner-invite`, and `sudo spool service server restart`. Container logs are available with `sudo docker logs spool-relay` / `sudo docker logs spool-caddy` (substitute `podman` when used). Stop both containers before backing up all three named volumes. Installer reruns rebuild containers while retaining their data; relay upgrades remain manual.

Enter `advanced` instead of a domain to retain the native per-user LAN/custom-proxy setup. That flow asks for workspace name, storage, origin, port and TLS mode, and offers user-service startup through `loginctl enable-linger`. It does not migrate existing native relay data into containers. Source users can run `bun src/server-setup.js` for advanced setup; the automatic container installer needs the self-contained Linux package. Client installation remains `sh spool-linux-x64.run` without `--server`.

## Connect clients and create projects

1. Open the local client's Memory page, or its first-run screen.
2. Under **Company workspace**, paste the owner or teammate workspace enrollment link and name the computer. The interactive client installer also accepts workspace links.
3. Choose **Create shared project**, or select an existing project you can access.
4. Choose your local Git checkout and click **Connect folder to project**. Conversation capture and Codex integration have explicit checkboxes.
5. Use **Invite and manage teammates** to create workspace or project-only invitations. Send links privately; they expire in 24 hours and are single-use.

Each machine enrolls separately. A workspace connection is a per-device identity, not an email/password account. A client can save several management connections without a global active workspace. Each repository keeps its own relay/project binding. Use Add project or `spool init` to select a saved connection for that repository; `--workspace NAME` selects a connection explicitly for CLI administration. Disconnecting workspace management does not revoke or stop existing project capture connections. Reconnecting a folder already bound to the selected shared project preserves its capture identity and history; pre-existing project-only credentials keep their independent revocation scope.

A workspace invite permits workspace-level access, including creating projects if the issuer enables it. A project-only invitation grants just that project. Already-enrolled workspace members can accept a project invite under **Join an additional project by invitation**, then connect a local folder. New clients can also use a project-only link through the existing direct-project join flow.

## Permissions

- **Owner:** manages the workspace and can access every project. Initial enrollment is available only from server-local setup/admin access.
- **Admin:** manages member invitations and revocation, and can access every project. Only an owner can invite or revoke admins.
- **Member:** sees only explicitly granted projects and projects they create. Project creation is controlled by the workspace invitation. A project creator becomes its project admin and can invite teammates to that project.

Revoking a workspace device disables its workspace credential and all project credentials issued through that workspace identity. Independently issued project-only credentials have their own identities and must be revoked separately through the relay administrator. Previously retrieved information cannot be recalled. SSO, email identities and multi-device user accounts are not implemented.

Credentials are kept in private local files; the browser receives workspace/project metadata and invitation links, not the stored workspace bearer token. The relay stores credential hashes. Remote workspace requests use dedicated authentication, distinct from project sync credentials. The existing local UI retains loopback, same-origin, session-cookie and CSRF protection.

## Existing server and recovery

For an already-running relay, its local administrator can initialize the workspace without replacing its service:

```sh
bun src/team-host.js workspace-init /path/to/relay-state 'Company workspace'
```

This prints the private owner link on first setup. If setup was interrupted before owner enrollment, repeating it issues a recovery invitation. Once an owner exists, it does not generate additional owners. Server-local recovery remains available explicitly:

```sh
bun src/team-host.js workspace-owner-invite /path/to/relay-state
```


Project creation uses durable retry IDs; a repeated request cannot create duplicate projects. Enrollment retries reuse the same device claim, including after client restart. Project IDs, grants, invitations and workspace configuration persist across server restarts. Shared storage continues to contain conversations, decisions and handoffs with Git references, not repository files.

Workspace invitations support `--role writer` (read/write access to all current and future projects) and `--role reader` (read only). These roles do not grant workspace administration. The default `member` role sees only explicitly granted projects. Use `--no-create` for a cloud memory connection. The UI offers the same choices under Workspace access.


### Joining the same repository

When a Git repository is already registered, Codex onboarding, `spool init`, and web approval show its existing shared project name and ask whether to join. A local folder name does not create a different shared project. Capture starts only after the user approves joining.

The relay rejects duplicate repository registration, including requests from stale clients or simultaneous creation attempts. Access denial requires an invitation rather than creating a replacement. Existing duplicate associations are retained for recovery and require choosing an existing project; this update does not merge or delete history automatically. Without a supported Git origin, SpoolDB cannot detect repository identity and requires a manual project choice.
