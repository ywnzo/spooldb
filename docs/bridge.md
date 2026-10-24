# Git capture and isolated snapshots

The first filesystem bridge is intentionally directional: it observes an existing Git checkout into the engine, and renders selected engine versions into new, separate folders. It never applies remote edits back into the source checkout or updates a previous snapshot. This makes the workflow usable without a dangerous overwrite mode. A future bidirectional checkout adapter needs a separate conflict and recovery design.

## Capturing saved work

Attach a top-level Git checkout with `git.attach`, then call `git.capture` after changes or use the CLI's polling watch mode. No Git remote or initial commit is required. Git's [NUL-delimited file listing](https://git-scm.com/docs/git-ls-files) supplies tracked files and untracked files eligible under standard ignore rules. A tracked file still counts even if an ignore rule matches it. The bridge reads the worktree version, including staged and unstaged differences; it does not import staged content as a separate version.

The source checkout stays untouched. Git listing runs with fsmonitor disabled and hooks redirected; no clean/smudge filters, build scripts, repository setup scripts, commits, fetches or pushes run. Capture records the observed HEAD hash when available, not the full Git object database or commit history. Empty Git-only changes update the local source record without producing a code event.

The source has its own `disk-*` branch holding the last observed disk state. Text differences are calculated on that branch and then merged into the primary branch. Thus an engine-side edit does not get overwritten just because the source file has not yet changed. A later local edit merges as genuinely concurrent work. Neither capture nor merging writes the resulting primary state back into the original repository.

File paths have stable IDs while unchanged. An exact-content rename preserves identity only when there is exactly one removed and one added file with that fingerprint, including kind and executable mode. This is an inference from snapshots, not a witnessed rename syscall. Ambiguous or simultaneously edited renames become deletion/creation. Do not infer author identity from the watcher: provenance explicitly says actor `unknown` and evidence `observed-disk-snapshot`.

Polling can miss intermediate saves and unsaved buffers. A scan is a sequence of stable per-file reads, not an atomic snapshot of a running build across many files. It rejects detected changes during an individual file read; changes between files can still appear in one observation. Stop a tool or use an explicit turn boundary if a consistent project snapshot is required.

## Bytes and types

Regular files containing NUL or invalid UTF-8 become binary records; other files become text. Valid text retains BOMs and CRLF exactly as observed. No Git attribute normalization is performed. Binary bytes use inline base64. Executability maps to 0755 or 0644; ownership, extended attributes, setuid bits, hardlink identity and arbitrary permission bits are not modeled.

Source symlinks are recorded with `lstat`/`readlink` and never followed. A symlink parent for a listed path aborts scanning rather than reading outside the chosen root. Sources can contain links that are not safe to materialize; recording one does not imply permission to follow it.

## Exclusions and bounds

The bridge excludes `.env` and `.env.*` basenames except `.example`, `.sample` and `.template` variants; `.pem`, `.key`, `.p12`, `.pfx`, `id_rsa` and `id_ed25519`; `.spool*` path segments; and its own configured SQLite file plus WAL/SHM sidecars. Exclusions are reported, including tracked matches. These are filename policies, not a content-based secret scanner. Other filenames and direct API writes can contain secrets. Removing a recorded secret later does not erase its history.

Each scanned file is limited to 1,000,000 bytes, at most 10,000 Git-listed paths are accepted, and the serialized observation must fit within 12 MB. A submission is also limited to 10,000 operations/16 MB. Unsupported or oversized entries fail the scan instead of silently dropping files. A policy-excluded previously recorded path becomes a tombstone, while its old history remains. Git submodules and unresolved index conflicts currently fail capture.

## Snapshot publication and recovery

`snapshot.create` plans the selected version before creating output. Recorded conflicts, paths containing reserved bridge names, case/Unicode aliases and file/directory prefix collisions fail preflight. The target must not exist, and its parent must exist. It cannot sit inside, contain, or equal an attached source checkout. Parent paths are resolved to a canonical location. The bridge is currently verified on Linux only.

A new output root is claimed exclusively. It receives a `.spool-snapshot.json` ownership marker, and SQLite stores the immutable output plan. Regular files are written into private temporary files, synced, chmodded, and published with an exclusive hard link. Publication cannot replace an existing path. Directory metadata is synced too. These use Node's [filesystem APIs](https://nodejs.org/api/fs.html#file-system-flags); crash guarantees still depend on the filesystem honoring synchronization.

Symlink output is conservative: targets must be relative and contain no parent (`..`) segments or backslashes. The entire snapshot is checked for symlink/path prefix conflicts. This deliberately rejects some ordinary, internally safe `../file` links until more complete link-graph handling exists. Absolute and escaping links are refused before creating the output folder.

If writing is interrupted after journal creation, `snapshot.list` exposes an incomplete snapshot ID. Run `snapshot.recover` with that ID. Recovery takes the SQLite writer lock, validates the real output root and ownership marker, accepts already published files only if contents/type/mode match the plan, and creates remaining files exclusively. Missing directories can be recreated; symlink parents, edited files and foreign ownership markers stop recovery without replacing them. Completion is recorded only after all planned files are present. A completed snapshot is not reset or rewritten by recovery.

An interruption between claiming the initial directory and storing its journal can leave an orphan output directory. It is never silently adopted; preserve or remove it manually and choose a new destination. The marker and database must both be retained for journaled recovery. This is not a globally atomic directory snapshot: incomplete files are visible during output, and consumers should wait for the successful completion response. Extra user-created files are not deleted by recovery.

The bridge assumes trusted local processes and a cooperative output directory. Parent checks and no-follow file opens resist ordinary symlink mistakes; they are not an OS sandbox against a hostile process continually renaming directories between syscalls. Do not use output directories controlled by an adversary.

## Verification

The automated suite exercises real temporary repositories, tracked/ignored/untracked selection, dirty source preservation, conservative rename inference, concurrent disk/engine changes, more than 100 files per observation, binary/BOM/CRLF round trips, executable flags, symlinks, destination conflicts, root/marker tampering, polling watch with SIGTERM, and recovery after SIGKILL during a write transaction. It also retains the original engine/CLI tests. No distributed scalability or non-Linux behavior has been established by these checks.
