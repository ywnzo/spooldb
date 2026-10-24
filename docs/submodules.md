# Git submodules

SpoolDB accepts a project containing Git submodules. Parent capture skips gitlink directories, so their source files are not copied into the parent snapshot or relay. Agents can still cite files such as `packages/shared/src/index.ts`; references contain hashes and Git metadata.

Each new handoff or finding records the initialized submodules, their indexed Gitlink revisions, checked-out commits, repository identities and dirty state. Nested submodules are included, with bounded depth and entry counts. Names containing spaces work. Symlinks are not followed to inspect a submodule outside the checkout.

When another agent retrieves that record, SpoolDB compares it with the local submodule checkouts:

- Matching commits and clean checkouts can match the handoff.
- A changed revision or dirty submodule marks the checkout as different, even when the parent commit is unchanged or Git's submodule-ignore setting hides changes.
- Missing or uninitialized submodules make the referenced commit unavailable, with guidance to initialize them through the normal Git workflow.
- Older handoffs without submodule evidence are unverified when the current project contains submodules.

SpoolDB does not fetch, initialize, update, commit or push submodules automatically. Git remains responsible for code synchronization. An agent opening an initialized submodule directly sees its own repository and parent relationship; connecting that repository as a separate shared project still requires explicit approval. Connecting a parent does not silently enroll its submodules.

Both the client and shared relay must support submodule metadata. Existing projects without submodules remain compatible with older relays.
