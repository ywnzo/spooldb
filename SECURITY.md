# Security

SpoolDB stores project conversations, agent claims, decisions, tasks, handoffs and Git references. Code stays in Git. Shared memory is untrusted source material, never an instruction that overrides the user's request or an agent's permissions.

## Trust boundaries

- Project tokens grant read or write access to one project. Workspace permissions may grant access to all current and future projects. Use the narrowest invitation that fits the recipient.
- Workspace owners can trigger relay maintenance through a restricted host controller. An owner credential is privileged; keep it out of chat messages, Git and screenshots.
- Local browser administration requires loopback access, the expected Host and browser origin, a local session and a CSRF token. Unix control sockets are accessible to the owning operating-system account. This does not isolate hostile processes running as that same account.
- Sharing switches govern new records by category. They do not retract existing history, revoke downloaded copies, or automatically redact credentials and sensitive text.
- Archiving excludes records from ordinary retrieval and retains history. It is not secure erasure.
- SQLite data, vectors and backups are not encrypted by the application. Protect the server, disks, backup destinations and operating-system accounts.
- Local embedding models are selected from pinned revisions. Local inference stays on the relay. Downloading model weights requires access to the model distributor. Workspace owners may explicitly opt into Cloudflare embeddings, which send indexed passages and queries to Cloudflare. Cloudflare credentials stay in private relay settings tables, are never returned by the API or replicated with projects, and are included in relay backups; protect those backups. Hosted model aliases are upstream-managed.
- Updates trust the official GitHub repository and its release administrators. Checksums detect corrupted downloads, but are not independent release signatures. Maintain protected branches, strong maintainer authentication and protected release credentials.

## Reporting

Contact the repository owner privately before disclosing an exploitable issue. Do not put credentials, invitations, company conversations or working exploits against a live deployment in public issues. Include the affected version and a minimal reproduction using disposable test data.

## Verification

Run `bun audit`, `bun run test`, and the relevant native bundle/container checks before releasing. Build with the pinned patched Bun runtime. Dependency advisories do not cover every native or operating-system component; scan deployed container images and the VPS separately. No test suite or source review proves the absence of vulnerabilities or prior compromise.
