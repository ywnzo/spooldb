# Connect a real project

## Everyday use

Open the local app. Your project opens without room IDs or token entry. Click **Connect Codex** once, then use the Codex app, terminal, or Codex in Zed normally. Click **Review project** to browse code and conversations. Updates appear automatically. See [Codex connection](codex-connection.md) for the capture scope. Wrapped CLI runs below are an advanced alternative, not the normal workflow.


## Add and switch from the app

Use **+ Add project** in the top bar. Choose a repository folder, select a saved connection (or save one using a workspace invitation), then click **Check repository**. SpoolDB checks for an existing matching shared project. Choose to join it or create a project when no match exists, then approve **Connect and share memory**. The folder gets its own relay/project binding; source files stay in Git. Existing connections and memories do not move.

The top-bar project menu switches back to an existing project. Each project's history, files, branch pointers and Codex setting stay separate. Adding the same canonical folder again reuses its existing history. Setup errors stay in the dialog; a failed new setup removes only the state created by that attempt, leaving source files and previously connected projects intact.

Project selection is remembered in an HTTP-only preference cookie. Open tabs send their own selected project ID, so switching one tab does not redirect another tab's data requests. Reload opens the browser's last selected project. The saved project registry and all newly added state live under the original app's private history directory, outside source checkouts. This preview supports up to 16 registered projects. Opened projects keep capturing during the app run; after restart, stored projects are started when opened or selected. The original host project also remains active.

The folder picker uses KDE's native dialog when available and falls back to path entry elsewhere. Projects must already be Git checkouts; the app does not initialize or modify a source repository. Build/output directories, local harness settings and individual files larger than 1 MB are excluded automatically. Remaining bridge snapshot and relay batch-size limits still apply; additional exclusions can be supplied before adding a large project.

The project service keeps one sharded capture database, one relay database and private credentials outside the source checkout. It watches saved filesystem changes every two seconds, records wrapped native CLI conversations and publishes a `working` review snapshot. `main` is the connection-time baseline, including any pre-existing dirty files; it is not a moving Git branch or an import of Git history. The local app loads newly published snapshots automatically.

## Initialize and start

Choose a **new** state directory whose parent exists. Nothing is installed in the source checkout. Explicit exclusions are literal relative file paths or directory prefixes, not globs. They are persisted in the capture database and apply to watcher and native harness captures alike. Configure them before attachment; excluded content is not reviewed.

```sh
bun src/project-cli.js init /absolute/state/project /absolute/git/root \
  --exclude=.codex --exclude=.claude --exclude=generated-large-assets
bun src/project-cli.js start /absolute/state/project --port=8787
```

Keep the start process running. It binds HTTP only to `127.0.0.1`. Its control socket is inside the private state directory. The service creates a read-only review credential and a separate writer credential; it does not print them in service logs. Obtain the URL, room and reader token when needed:

```sh
bun src/project-cli.js access /absolute/state/project
```

Open the printed HTTP URL, paste the token and select Open review. Do not open the raw HTML file for a live workspace. Tokens and databases stay in the state directory, outside the source repository. Keep that directory private and out of version control. The CLI uses umask 077, directory mode 0700 and credential files mode 0600. It does not install a boot service; restart the same start command after reboot. Ctrl-C/SIGTERM shuts down the service and cancels an active wrapped harness run. If it crashes, the next start checks and clears a refused stale control socket.

## Capture conversations

From the SpoolDB directory, pipe a prompt into a wrapped harness run:

```sh
printf '%s\n' 'Explain this repository without changing files.' \
  | bun src/project-cli.js run /absolute/state/project codex
printf '%s\n' 'Explain this repository without changing files.' \
  | bun src/project-cli.js run /absolute/state/project claude
```

The corresponding CLI must already be installed and authenticated. The default Codex sandbox is read-only; Claude defaults to its restricted tool list. Add `--write` to allow the harness's configured edit workflow. Prompts, assistant messages and selected tool events are retained. Native stderr is counted but not retained. A failed run is recorded as failed, not claimed successful. The wrapper prints event counts/status rather than conversation text; read the conversation in review.

The service serializes wrapped runs on the shared checkout and pauses its ordinary watcher during a run. The adapter captures at tool/turn boundaries and on process exit, then the service publishes the final state. External editors can still change disk concurrently, so observed file changes retain filesystem evidence and unknown authorship. The service never materializes merged code into the checkout. There is no global harness hook: desktop chats and independently started CLI sessions are **not** automatically imported. Use these wrappers for conversations you want captured. See [adapters](adapters.md) for the normalized integration contract for other harnesses.

```sh
bun src/project-cli.js status /absolute/state/project
bun src/project-cli.js capture /absolute/state/project
```

Status reports the root, room, URL, active harness, last capture and latest watcher error without credentials. Capture forces a filesystem observation and publication. The local project app refreshes automatically; a standalone remote relay review still uses Refresh. The bridge still has 1 MB/file, 12 MB snapshot and 10,000-path limits, and each atomic upload batch must fit the relay page budget. Exclusions should cover large generated files/assets and private configuration. Secret-path filtering is limited to documented filename patterns and is not a general content redactor.

## Git submodule memory

Registered Git submodules use their connected parent project’s memory by default. They do not create another relay project. Explicit separate bindings or an explicit skip override inheritance. Independent nested or sibling repositories need their own approved binding. File references include the parent-relative path and the submodule Git repository/commit; source files stay in Git.
