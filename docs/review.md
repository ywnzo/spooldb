## Local app users

Open the project app and choose **Review**. Local access is automatic; you do not need the room/token setup below. Click **Connect Codex** on the project screen to capture native app, terminal and Codex-in-Zed conversations. See [Codex connection](codex-connection.md).

# Web review: branches, code and conversation

Open `/review` on the relay, enter the room identity and a token with read access. The relay serves the UI itself; there is no separate frontend build, account or hosted service. The page puts changed files, a unified line diff and the conversation at the selected causal version beside each other. It also resolves existing file comments through their stable anchors.

For a disposable sample workspace:

```sh
npm run demo:review
```

The command prints a local URL and a public read-only **demo** token. Its code and conversations are synthetic examples, including its harness labels. It contains no real agent session or user repository. SIGINT/SIGTERM stops the server and removes its temporary databases. Generate separate random credentials for real rooms; do not reuse the sample token.

## Publish named branch snapshots

Local branch names are not automatically replicated. The relay's **Synced room** view is the aggregate causal frontier of uploaded work, which can include concurrent features. Publish explicit named review snapshots to compare independent work:

```sh
node src/sync-cli.js project.sqlite https://relay.example.org ROOM_ID main --publish=main
node src/sync-cli.js project.sqlite https://relay.example.org ROOM_ID feature --publish=feature/pagination
```

Both commands read `SPOOL_RELAY_TOKEN`; publishing requires write access. The last positional argument selects the local engine branch. `--publish` names the relay review snapshot. Publishing captures that local frontier, uploads its causal history and publishes the name **without pulling the aggregate relay history into the local branch**.

New names start at revision 1. Updating an existing name requires its current revision, shown in the UI branch selector or returned by the publication command:

```sh
node src/sync-cli.js project.sqlite https://relay.example.org ROOM_ID feature \
  --publish=feature/pagination --revision=1
```

That update produces revision 2. A stale revision returns `BRANCH_CONFLICT`; it does not silently overwrite a concurrent publisher's pointer. The library API is `await client.publishBranch('feature/pagination', {expectedRevision:1})`. `client.sync({mode:'push'})` is also available when work should upload without importing the aggregate. Ordinary bidirectional sync retains its earlier behavior.

Publication requests carry an idempotency identity. A lost acknowledgment can retry the same request without advancing the revision twice. Library callers can provide `requestId` to repeat a logical publication later; changing its payload with the same identity fails. A new publish call gets a new identity and still requires the current revision.

Named snapshots are review references, not Git branches, pull requests or automatically updated remote-tracking refs. Refresh the review page after publishing changes. Rewinding or replacing a snapshot is an explicit revision-checked publication.

## Navigate a review

Choose a review branch and comparison branch at the top. **Empty tree** shows the selected snapshot as additions. File search and **Changed files only** filter the file list. Added, modified, deleted and renamed files are distinguished using stable file identity, including a rename's previous path.

The **Diff** tab shows line numbers, additions/deletions and surrounding context. **File** shows a bounded source preview; a file that exists only in the comparison base is explicitly labeled as a base preview. Binary files show metadata and byte counts; symlinks show their target without following it. Concurrent path/metadata conflicts are reported rather than presented as resolved code. A metadata change or edit followed by a revert can appear in the changed-file list even when there are no text differences.

The conversation panel shows recent stored causal batches, messages and claimed actor/harness labels. **Linked to selected file** filters by the batch's explicit file identities. It is a direct provenance link, not an inferred claim that nearby chat caused an edit. Concurrent siblings have a local stored order; source timestamps are not a global causality proof.

**Inspect this change** pins code, comments and conversation to that historical change and compares its code with its parents. **Back to branch** restores the selected branch snapshot. File chips navigate back to branch-level file context. Code and conversation use the same requested frontier, and older responses are ignored when navigation changes. Existing comments display their resolved text selection or an unavailable-anchor state. The UI does not create comments, merge, approve, run code or edit files.

## Authentication and content handling

The static shell has no room data. Every review request checks the existing room grant, and publishing additionally checks write access after receiving the body. Tokens stay in JavaScript memory; they are not written to URLs, cookies or browser storage. Reloading or disconnecting clears the token, and disconnecting clears displayed workspace content and cancels pending requests. A bookmarked URL contains only room/branch context. Use HTTPS for remote access as described in the [relay guide](relay.md).

Code, paths and conversation text are rendered as text nodes. HTML, Markdown images, repository scripts and received tool events are not executed. A restrictive same-origin Content Security Policy blocks external scripts, inline script, framing and form submission. This does not replace the relay's private-collaborator trust model or authenticate imported author claims.

## API and bounds

The UI uses `POST /v1/rooms/ROOM/review`, with the relay's existing bearer authentication and `spool-relay/1` response envelope. Commands:

| Command | Purpose |
| --- | --- |
| `branches` | Read the live aggregate and named snapshot revisions |
| `publish` | Write a name with `heads`, `expectedRevision` and an idempotent `requestId` |
| `files` | List stable identities/statuses with search, comparison and pagination |
| `diff` / `file` | Compare or preview one file, plus resolved existing comments |
| `timeline` | Page backward through causal batches and linked messages |
| `message` | Read one full message after a truncated preview |

Reads take `branch` (default `@live`) and optional historical `heads`. Historical heads must belong to the selected snapshot's ancestry. A comparison uses `compare` or explicit `baseHeads` (empty means an empty tree). Files use `after` cursors; timeline pages use `before` sequence cursors. Room access covers all history in the room; this UI adds no file-level ACL.

Default pages contain 100 file identities or 25 history entries. History pages are capped at 50 entries, with at most 50 message previews and 16 previews per batch. Message previews are capped at 12,000 characters with a full-message action. File previews show at most 200,000 characters/2,000 lines. Inline diffs reject large inputs, use a bounded line-comparison matrix and mark replacement approximations or truncation explicitly. This is a line diff, not a language-aware semantic diff.

Existing comment discovery scans up to 200 comment documents per requested file and reports a partial scan. Metadata file discovery and causal queries still traverse manifests/history; count/byte bounds do not imply constant-time million-operation review. Multi-megabyte source rendering, very large transcripts, multi-browser compatibility and million-operation UI capacity remain outside the measured scope.

## Verification

The automated suite covers diff reconstruction/limits, independent branch snapshots, stale publishers, historical isolation, branch-specific conversations and anchors, renamed files, non-text metadata, pagination and room authorization. Browser checks exercise the real relay and synthetic workspace, including login, source/diff tabs, branch changes, historical inspection, file-linked activity, disconnect/reload behavior and responsive layout. The existing engine/relay tests remain part of `npm test`.


## Local app navigation

The local app opens on **Memory**. Search across project history, filter by handoffs, decisions, findings, tasks or conversations, and open an entry in its focused reader. Next steps and blockers appear separately from the main text; provenance and Git status are under Sources & code status. The browser URL retains the selected section, filter, search and entry so reload and Back restore that context.

**Activity** contains the existing code comparison and linked conversation history. **Settings** contains capture, Codex connections, workspace membership and advanced relay controls. Project selection stays in the header on every screen. Repository proposals remain on Memory and require explicit approval.
