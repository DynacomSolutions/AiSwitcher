# SSH sync and resume cwd overrides

_Moved unchanged from the former monolithic AGENTS.md (original line numbers: 589-688). Read before touching this area._

- **SSH sync is a direct home-to-home merge, not a password protocol.**
  `~/.ais/config/sync-v2.json` (formerly `~/.config/ais/sync-v2.json` — see
  "~/.ais: one consolidated root" below) contains validated SSH config
  aliases only; SSH
  owns authentication and always runs with `BatchMode=yes` plus
  `StrictHostKeyChecking=yes`. A top-level wrapper resolves locally and spawns
  the real agent first, then starts full reconciliation in a detached AIS
  worker. Ordinary profile/session mutations use detached workers with a
  three-second debounce, and the final post-exit reconciliation is detached
  too. No
  automatic SSH, rsync, dedupe, or lock wait may block agent startup or keep
  the wrapper open after the child exits. `ais resume` follows the same rule.
  Nested wrappers do not start another full reconciliation. No delete
  flag is used: a stale/offline host must never erase a healthy profile.
  Every exchange deduplicates by the native stable session ID within one
  identity; matching IDs in different identities are never treated as
  interchangeable. Legacy top-level stores are associated only when cwd rules
  or one unambiguous identity make that safe. JSONL copies merge as an
  append-only multiset union (copied events count once and divergent events
  survive), and registry conflicts semantically union identities/list fields.
  Automatic reconciliation never prunes a live path; only explicit
  `ais sync dedupe` may move redundant same-identity paths to
  `~/.ais/remote-cache/dedupe-backups/` (formerly
  `~/.cache/ais/dedupe-backups/`). Pulls and pushes both land in isolated
  incoming trees; the receiver merges from staging, so rsync never overwrites
  a live history. Staging uses `--compare-dest=../../../..`
  against the receiver's live home (rsync's size+mtime quick check, never
  `--checksum`, which would read the whole tree every run), so the isolated tree
  contains only changed files. To keep merged-but-identical files from
  re-transferring forever, the merge raises a byte-identical live file's mtime
  to the incoming one (contents never change). A JSONL with an open owner is
  skipped, not copied to conflicts: the sender still has it and re-stages it.
  Automatic runs (`ais sync background`) are rate limited by `minIntervalMinutes`
  in `sync-v2.json` (default 10, 0 disables): a request inside the interval is
  queued as one file per request in `remote-cache/sync-pending/` (a coalesced run skipped by the sync lock is requeued) and one lock holder
  (`sync-pending.lock`) later runs a single scope-`all` pass; `last-auto-sync`
  stamps the last start. `ais sync now` is never delayed. The background worker
  runs at nice 19 and (Linux) ionice idle; remote rsync and AIS commands run
  under `nice -n 19` plus `ionice -c3` when the remote has it. Staging is
  bounded: snapshots are removed after use, and a prune pass (start of each
  locked run, and inside remote `merge-profile-snapshot`) deletes
  `profile-incoming`, `sqlite-incoming`, `sqlite-snapshots` entries older than 6
  hours and `merge-conflicts` older than 30 days; `dedupe-backups` is never pruned.
  Non-mergeable file conflicts retain the losing bytes.
  `ais sync dedupe [--dry-run] [--json]` exposes the same local invariant.
  `ais sync recover [--dry-run] [--json]` additively restores histories and
  missing sidecars from retained pre-fix conflict/dedupe archives without
  deleting those archives.
  Standard absolute home paths in registries become portable `~/...` paths so
  `/Users/<name>`, `/home/<name>`, and `/root` interoperate.
  `loadIdentitiesFile()` expands every loaded `configDir` back to an absolute
  path at the I/O boundary; usage/resume/limits and other consumers rely on
  that invariant and must never receive a literal `~` path.
  Process locks and every live SQLite main/WAL/SHM/journal file stay local.
  Zai's machine-local `projects.json` is excluded, while registered
  home-relative project `.crush` data is included because its usage/session
  database lives outside the identity configDir. Crush databases transfer only
  as SQLite `VACUUM INTO` snapshots, then upsert by row ID; duplicate session
  counters use `MAX`, never addition. Browser profiles, plugin/marketplace
  caches and clones, dependency trees, logs/debug output, worktrees, generated
  media, shell snapshots, and mutable/rebuildable SQLite databases are also
  excluded because they are reproducible or machine-specific and can be
  incompatible across operating systems.
  Never restore a generic `*.tmp` rsync exclusion: Grok URL-encodes working
  directories as session bucket names, so a cwd ending in `.tmp` must remain
  eligible for transfer. Rsync's own atomic staging is
  the protection for temporary transfer state.
  Rsync must always use `--no-owner --no-group --no-perms`: copying ownership
  or modes across hosts can make sshd `StrictModes` reject authorised keys.
  Do not weaken that
  cross-host metadata boundary. Exit 24 is a normal live-tree race; retry once,
  then accept it because deletes are intentionally not propagated. Remote AIS
  commands share rsync's ControlMaster so verification reuses its authenticated
  connection. Sync config version 2 marks this ownership-safe merge protocol
  and deliberately lives in `sync-v2.json`. Already-running v1 wrappers keep
  reading a separate valid-but-empty `sync.json`; they neither emit repeated
  unsupported-version warnings nor revive the pre-fix transport. New binaries
  can still read/migrate a v1 document when an explicit `AIS_SYNC_CONFIG` path
  points at one, but always save version 2.
  Automatic failures warn and continue; explicit `ais sync now` failures are
  hard errors.
- **Never rewrite a live Codex rollout just to repair its recorded cwd.** A
  restored process may still hold that JSONL open, so replacing it can split
  future events onto an unlinked inode and lose history. Put an explicit,
  stable-session-ID correction in
  `~/.ais/config/resume-cwd-overrides.json` instead. The version-1 shape is
  `{ "version": 1, "sessions": { "codex": { "<session-id>":
  "/absolute/project/path" } } }`. `ais resume` treats the corrected path as
  authoritative: the session appears in that project and no longer leaks
  into its wrongly recorded cwd. Missing, malformed, relative-path, and
  unknown-tool entries are ignored so this repair file can never break the
  normal picker.
  **Regression, caught and fixed 2026-07-23: `ais limits`/`ais usage`/
  `ais identities`/`ais doctor` hung forever, sometimes, because `cli/
  dispatch.ts`'s top-level `runCli` directly `await`ed `automaticSync()`
  in-process** — the exact blocking SSH/rsync/lock-wait work this same bullet
  says must never happen, reintroduced one layer up from where the three
  commits above had already fixed it for `run-wrapper.ts`/`resume/launch.ts`.
  Whichever invocation won the sync lock race did the full two-way
  reconciliation against every configured remote synchronously, so a slow
  or unreachable host meant that `ais`
  invocation itself hung; a losing invocation happened to return fast (lock
  already held, `waitForLock` defaults to `false`), which is why the bug was
  intermittent rather than constant and easy to miss in a single manual test.
  There was also a second, always-redundant `await automaticSync()` after the
  command ran — dead for `usage`/`sync`, whose switch cases `return` early
  and skip it, and pointlessly duplicated work for every other sync-aware
  command. Fixed by replacing both with a single call to the same detached
  `startBackgroundProfileSync()` (`sync/background.ts`) `run-wrapper.ts`
  already uses, spawning `ais sync background` and returning immediately
  regardless of remote latency. Reporting commands do not announce this
  automatic detached work, keeping their output focused; explicit `ais sync
  now` continues to report its result or failure.

