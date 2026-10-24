# Server setup and company workspaces

On a fresh Linux x86-64 server, download the SpoolDB package and run:

```sh
sh spool-linux-x64.run --server
```

The terminal guides you through the workspace name, persistent storage, public URL, listening port and HTTPS mode. It installs a separate server app and `spool-shared.service` for the current user, initializes the workspace and prints a private, single-use owner enrollment link. It offers to enable startup after logout/reboot through `loginctl enable-linger`; that may need administrator authentication. It refuses to overwrite an independently managed relay service.

Choose private LAN TLS for this host-style deployment. Open the chosen port in the server firewall and use an address reachable from the clients. The invite carries the server's public certificate, which clients verify for that server only. OpenSSL is required for private certificate generation. For public deployments, choose your HTTPS reverse proxy and configure it to forward the public origin to the loopback relay port; the provided Caddy/Compose recipe is an alternative. The installer does not configure DNS, a reverse proxy or firewall rules automatically.

Source installations can run `bun src/server-setup.js` after installing the documented Node dependencies. Server storage must be on a persistent local filesystem. The client installer remains `sh spool-linux-x64.run` without `--server`. Server setup needs a Linux user systemd manager; containers should use the Compose deployment instead.

## Connect clients and create projects

1. Open the local client's Memory page, or its first-run screen.
2. Under **Company workspace**, paste the owner or teammate workspace enrollment link and name the computer. The interactive client installer also accepts workspace links.
3. Choose **Create shared project**, or select an existing project you can access.
4. Choose your local Git checkout and click **Connect folder to project**. Conversation capture and Codex integration have explicit checkboxes.
5. Use **Invite and manage teammates** to create workspace or project-only invitations. Send links privately; they expire in 24 hours and are single-use.

Each machine enrolls separately. A workspace connection is a per-device identity, not an email/password account. One client has one active workspace management connection; reconnecting switches it. Disconnecting workspace management does not revoke or stop existing project capture connections. Reconnecting a folder already bound to the selected shared project preserves its capture identity and history; pre-existing project-only credentials keep their independent revocation scope.

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
