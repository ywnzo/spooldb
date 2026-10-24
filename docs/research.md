# DeltaDB research

Research date: October 23, 2026. Public primary sources only. The supplied `https://delta.dev/deltadb` URL did not load in the research browser. The official engineering post, product announcements, documentation, roadmap and public integration repository were accessible. No private beta internals, unpublished source, proprietary protocol or installed application were inspected.

## What we are building toward

Delta is an application; DeltaDB is its underlying version/history layer. The useful abstraction is a shared history of code and conversation, with references that remain useful while work continues. This suggests building a reusable substrate before an editor or agent UI. The official [core concepts](https://delta.dev/docs/concepts/core-concepts) distinguish threads, repositories, replicated worktrees and filesystem checkouts.

The June [announcement](https://zed.dev/blog/introducing-deltadb) describes individually addressable edits, simultaneous work, and links between code and the messages behind it. Git remains the interchange mechanism for commits and existing CI workflows. The key product value is preserving intermediate work and intent, including edits later undone before a commit. A transcript recorder or periodic Git commit script would preserve only part of that behavior.

## Published algorithm

The October 15 [engineering article](https://delta.dev/blog/future-of-version-control) is the most concrete public technical explanation found. It describes edits relative to a version, where a version can start from Git or name a frontier of causal delta IDs. Convergence relies on causal ancestry and deterministic ordering rather than synchronized wall clocks. A fragment index associates text positions with their originating changes. Persistent B-trees share unchanged nodes across versions. The approach draws on Diamond Types, with differences for Git interoperability. The article also highlights filesystem structure as a separate difficulty.

This is enough to identify important invariants, but not to reproduce their implementation or assert compatibility. Our inference: causal identity, version-relative positions and efficient historical lookup must be separate design concerns from relay delivery order. A database auto-increment ID or timestamp alone cannot provide these semantics.

## Real files and Git

The [Git documentation](https://delta.dev/docs/concepts/delta-and-git) says clients replicate a shared file representation, which can also be materialized on disk. Import includes tracked files and untracked files not ignored by Git. Tracked files remain eligible even if an ignore rule matches them. Line-ending conversions follow Git configuration and attributes. Messages, file edits and comments are recorded continuously, and history can restore code with its conversation.

The [worktree documentation](https://delta.dev/docs/concepts/worktrees) distinguishes Delta worktrees from Git's worktree feature. Managed checkouts expose synchronized files to terminal tools; collaborators can have separate checkouts. This means an independent implementation needs both a virtual file API and a safe bidirectional filesystem bridge. A file watcher provides evidence of observed disk changes, but cannot reliably identify which concurrent process authored them.

## Harness interoperability already exists

The August [Delta announcement](https://zed.dev/blog/introducing-delta) explicitly describes Claude Code integration and syncing terminal sessions into shared threads. The public [delta-claude repository](https://github.com/zed-industries/delta-claude) is an AGPL-3.0-only Claude Code plugin. Its README describes a Delta CLI dependency, setup/sharing commands and recording sessions with the checkout. No implementation from that repository was copied here.

The live [roadmap](https://delta.dev/roadmap) lists a general Delta CLI and ACP support as work in progress. It also distinguishes current work from future conversation branching and repository-level context. Product announcements, existing plugins and roadmap items can describe different stages of capability; a roadmap item does not establish that an adapter is complete.

Therefore, “supports another harness” is insufficient differentiation. A better independent target is a documented vendor-neutral data model, local-only operation, self-hosted replication, explicit import/export and adapters that do not depend on one commercial account. These are proposed project priorities, not claims about features Delta will never offer.

## Open-source status

Zed's earlier [funding announcement](https://zed.dev/blog/sequoia-backs-zed?trk=article-ssr-frontend-pulse_little-text-block) states an intention to open-source DeltaDB with an optional paid service. Intention is not a released reusable engine. The public Claude plugin is evidence of an open integration, not of a released database. The examined public Zed `crates/deltadb` URL returned 404. This targeted review did not locate a standalone public engine release and cannot prove none exists elsewhere.

Search also returns an unrelated, older `delta-db/deltadb` JavaScript database. It must not be confused with Zed's current project. Re-evaluate reuse versus independent development if Zed publishes an engine under suitable terms. Maintaining a compatible open adapter ecosystem could be more valuable than maintaining a second database implementation.

## Storage, access and privacy

The official [storage documentation](https://delta.dev/docs/privacy-and-security/data-storage) names R2 for file contents/Git objects/history packs/checkpoints, SQLite-backed Durable Objects for active deltas, and KV/D1 for metadata. It also describes repository-wide history implications when sharing a thread. This supports the architectural distinction between a durable object store, synchronization state and metadata services. It does not establish measured throughput or guarantee arbitrary deployments scale.

The [security documentation](https://delta.dev/docs/privacy-and-security/security) describes TLS, at-rest encryption and local recognized-secret redaction, with explicit limitations. The [comments documentation](https://delta.dev/docs/agents/comments) describes comments attached to code or conversation, with delivery to the agent at submission boundaries. Our proposal: access control must cover historical data and referenced objects, while agent feedback delivery stays separate from history replication. Convergence must never authorize tool execution.

## Reusable building blocks

| Candidate | Evidence | Decision for this milestone |
| --- | --- | --- |
| Automerge | [Official introduction](https://automerge.org/docs/hello/) covers offline merge, historical versions and branching; [JS API](https://automerge.org/automerge/api-docs/js/) exposes change hashes and cursors. | Use for a working local reference engine. Does not supply our Git bridge, provenance model or authorization. |
| Yjs | [Official documentation](https://docs.yjs.dev/) describes shared text/maps and transport-independent updates. | Viable alternative for editor-heavy clients; evaluate retained-history and branching requirements before choosing. |
| Diamond Types / eg-walker | [Internals](https://github.com/josephg/diamond-types/blob/master/INTERNALS.md) explain the causal graph and document projection. [Reference implementation](https://github.com/josephg/eg-walker-reference) distinguishes understandable code from optimized production performance. | Benchmark for a future core only if measured costs justify switching. |
| ACP | [Official introduction](https://agentclientprotocol.com/get-started/introduction) standardizes agent/client communication. | Future adapter ingress; not a storage or replication protocol. |

## Conclusions for SpoolDB

Build a local engine with explicit causal versions first, then a filesystem bridge, then native adapters and a self-hosted relay. Use a mature CRDT; keep our wire protocol versioned and provisional. Treat provenance as a claim with an evidence source. Capture turn/tool boundaries where a harness supplies them; mark watcher attribution as unknown. Expose conflicts and historical recovery instead of silently choosing a plausible story. Scale by independently authorized documents, immutable change packs, bounded caches and checkpoints—not by placing every repository and transcript in one ever-growing object.

Open questions requiring experiments: practical memory per million edits, granularity of document shards, cross-document atomicity during partial replication, stable anchors across Git rebases, directory move semantics, snapshot retention, revocation of previously replicated data, and what each harness actually exposes without relying on private storage formats.
