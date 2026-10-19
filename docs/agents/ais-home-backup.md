# ~/.ais root, migration and git-managed backups

_Moved unchanged from the former monolithic AGENTS.md (original line numbers: 994-1276). Read before touching this area._

- **`~/.ais` is the one consolidated root for every directory this project's
  own tooling creates and manages — not `~/.local/bin` (the shims
  themselves, deliberately excluded — see above), and not four unrelated
  scattered locations.** Before 2026-07-23 this project's own data lived at
  `~/.ai-switcher-backups` (backup archives), `~/.cache/ais` (SSH sync's
  local staging/conflict/dedupe trees and lock file), `~/.config/ais`
  (`sync-v2.json`), and `~/.local/share/ais/npm` (the managed real-CLI npm
  prefix `ais upgrade` installs into) — four top-level directories for one
  project's own state, none of them named after the project in a way that
  made "what is this and can I delete it" obvious, and none of it living
  anywhere near the pre-existing, separately-managed `~/.ais/hooks` /
  `~/.ais/skills-shared` / `~/.ais/AGENTS.md` / `~/.ais/STANDING-DEFAULTS.md`
  cross-tool shared infrastructure this project's tooling already reads.
  Requested directly by the user (the immediate trigger was replacing
  `scripts/backup.ts`'s tar.gz-per-run design, which grew without bound,
  with a git-managed repo — see the next bullet — but the consolidation
  request explicitly generalized to "all ais data" going forward), and
  implemented as `src/shared/ais-home.ts`: one function per concern
  (`aisBackupsDir`, `aisRemoteCacheDir`, `aisConfigDir`, `aisNpmDir`,
  `aisManifestPath`), each just `~/.ais/<subdir>`, so every consumer
  computes the SAME path instead of five files independently hardcoding
  `.cache`/`ais`/`.config` segments (which is exactly how the old locations
  drifted into being unrelated top-level directories with no shared
  convention in the first place).
  - **`~/.local/bin` (the shims + `ais` itself) is explicitly NOT part of
    this consolidation.** Those need to be on `PATH` with zero shell-rc
    edits — see "Shims install to ~/.local/bin, not a dedicated shim
    directory" above — which is a PATH-discoverability requirement, not a
    "where does this project keep its data" question. `ais-home.ts`'s own
    doc comment states this explicitly so it isn't relitigated.
  - **Existing env-var overrides are still first-class and skip automatic
    migration entirely** — `AIS_SYNC_CONFIG` and
    `AI_PROFILE_SWITCHER_REAL_BIN_DIR` continue to mean exactly what they did
    before; a user who's already pointed either at a custom location owns
    that choice, and the consolidation only changes the DEFAULT.
  - **Self-healing migration, not a one-time interactive script.**
    `scripts/migrate.ts`'s own precedent (manual, interactive,
    `pgrep`-guarded) is deliberately heavier because it restructures LIVE
    identity data with real running-process risk; this consolidation moves
    comparatively low-risk cache/config/npm-prefix directories and needs to migrate
    transparently on EVERY machine this project runs on, local or remote,
    without requiring separate manual intervention on each one. `src/shared/
    migrate-ais-home.ts`'s `migrateLegacyAisHome()` is called at the very
    top of both `run-wrapper.ts`'s `runWrapper()` and `cli/dispatch.ts`'s
    `runCli()` — the only two entrypoints anything under the old locations
    could be read from — and is a handful of `lstat` calls (cheap, no-op)
    once a machine has already migrated. It never throws: a migration
    failure must not block an actual `claude`/`ais` invocation, so failures
    are caught and logged loudly (`console.error`, matching the open.ts
    precedent of "always loudly, never silently") rather than swallowed —
    code downstream only ever reads the NEW location from here on, so a
    silently-failed migration would otherwise look like the data just
    vanished.
  - **The remote-cache migration additionally checks its own `sync.lock`
    for a still-live PID before anything else** — a cheap, precise,
    purpose-built fast path ahead of the general open-file check below, for
    exactly the case where an in-flight sync (started by a pre-migration
    binary, still reading/writing paths under the OLD `.cache/ais` tree)
    makes renaming the directory out from under it the wrong call.
  - **Adversarial review (2026-07-23, before this was ever run on a real
    machine) caught two real bugs and one real gap in the first cut of
    `migrate-ais-home.ts`, all confirmed by direct reproduction, not just
    read-through — worth recording so they aren't reintroduced:**
    1. **No liveness guard at all on the npm-prefix (or config) migration —
       only remote-cache had one.** The npm prefix is exactly the one
       target with a plausible real long-running writer: `ais upgrade`'s
       `installNpmTool()` (`cli/upgrade.ts`) runs a network-bound
       `npm install --global --prefix ...` directly into it. Reproduced:
       a background writer simulating an in-flight `npm install` raced a
       concurrent migration and failed partway (ENOENT) once the rename
       fired mid-write. There is no existing lock-file convention for an
       npm install the way `sync.lock` exists for sync, and — critically —
       an OLD (pre-this-change) binary's already-running upgrade has no way
       to know about any NEW lock convention this diff could introduce, so
       a lock file could only ever protect NEW-binary-vs-NEW-binary races,
       not the actual one-time deploy-transition race that matters. Fixed
       generically instead: `hasLiveOpenOwner(dir)` (lsof `+D <dir>`, with
       the same Linux `/proc/*/fd` fallback `codex-backfill.ts` uses for
       its own liveness check) scans for ANY process with an open file
       handle anywhere under the legacy directory, and is applied inside
       `migrateDir()` for all three targets uniformly — this works
       regardless of which binary version the writer is, since it doesn't
       depend on the writer knowing about a convention at all. Deliberately
       differs from `codex-backfill.ts`'s own stricter default (there,
       "cannot verify" means don't touch): here, "cannot verify" (neither
       `lsof` nor `/proc` available) means proceed anyway, since an
       interrupted `npm install --global` self-heals on the next
       `ais upgrade` retry, unlike a wrongly-repaired Codex backfill lease
       which risks silent data loss — the stakes don't justify permanently
       blocking this migration on a machine with neither tool.
    2. **`migrateDir()`'s own `pathExists` → `rename` sequence is a TOCTOU
       under concurrent invocation, and the loser logged an alarming false
       "failed to migrate" diagnostic** even when a sibling process had
       already completed the exact same migration a moment earlier.
       Reproduced directly (two concurrent `migrateLegacyAisHome()` calls):
       final on-disk state was always correct (rename is atomic per-call,
       so the loser can only fail cleanly, never corrupt anything) but the
       loser's caught `ENOENT` was unconditionally logged as a failure —
       contradicting its own "loud, never silent" intent by firing just as
       loudly for a completely benign race as for a real one. This project
       spawns detached background sync workers on nearly every invocation
       (see the SSH sync bullet above), so overlapping
       `migrateLegacyAisHome()` calls are a realistic, routine occurrence,
       not an edge case. Fixed: on a caught `rename()` failure, re-check
       whether `target` now exists and `legacy` is now gone — if so, some
       other process already finished this migration, so return silently
       instead of logging a failure.
    3. **Confirmed NOT a bug, despite looking like the highest-stakes
       possible issue**: `MANAGED_REAL_BIN_DIR` (`resolve-binary.ts`) is a
       module-level `const`, computed once at import time — but it's a pure
       string built from `homedir()`, doing zero filesystem I/O, so there is
       no stale pre-migration value for import timing to lock in. The actual
       filesystem lookup (`Bun.which`) happens live, inside
       `resolveRealBinary()`, which both `run-wrapper.ts` and
       `cli/dispatch.ts` call strictly after `await migrateLegacyAisHome()`
       in the same function. Reproduced directly (fresh process, synthetic
       pre-migration `HOME`, migrate then immediately resolve) to be sure
       rather than trusting the read-through.
    - **One residual, understood, and NOT fully closable-by-code risk
      remains, accepted rather than solved**: the npm-prefix race in
      finding 1 above is fundamentally a one-time OLD-binary-vs-NEW-binary
      deploy-transition hazard — once `~/.ais/npm` exists (whether migrated
      or created fresh there), `migrateDir`'s own early-return guard makes
      every future call an instant no-op, so this can only ever occur in
      the narrow window of a machine's very first upgrade to a binary built
      from this change, and only if an OLD binary's `ais upgrade` happens
      to still be mid-`npm install` at that exact moment. `hasLiveOpenOwner`
      closes this for any writer using a CURRENT (this-change-or-later)
      binary, and narrows the OLD-binary case considerably (it still
      detects the old binary's own open file handles as a live owner, since
      lsof doesn't care which code wrote them) — but a truly watertight
      close would require the OLD binary to already know about a
      convention it necessarily predates, which is not something code
      shipped today can retroactively guarantee. Before deploying this to
      any machine, check for an
      in-flight `ais upgrade`/`npm install --prefix .../ais/npm` first
      (e.g. `pgrep -f 'npm install.*ais'`) rather than relying on the code
      alone.
  - **The backup root is NOT auto-migrated — it's a clean-slate mechanism,
    not a location this project's old tar.gz snapshots could sensibly move
    into.** Pre-existing archives at `~/.ai-switcher-backups/*` are left
    exactly where they are, untouched, for manual reference/cleanup; the
    tool simply stops writing there and starts writing to
    `~/.ais/backups` instead (see the next bullet). Don't build automatic
    deletion of the old archives without being asked — they're the user's
    last several backups.
  - `scripts/install.ts`'s own manifest (`~/.local/bin/.ais-manifest.json`
    -> `~/.ais/manifest.json`) is migrated separately, inline in that
    script, rather than through `migrateLegacyAisHome()` — that script is
    dev-tooling only (never compiled into a shipped binary, run only via
    `bun run scripts/install.ts` from a checked-out clone), so it doesn't
    need the general self-healing mechanism every wrapper/`ais` invocation
    goes through.

- **The git-managed backup repo replaces tar.gz-per-run because git's
  content-addressable object store, not just a new destination directory,
  is what actually keeps the size down.** `scripts/backup.ts`'s old design
  wrote a fresh, independent `~/.ai-switcher-backups/<timestamp>/*.tar.gz`
  tree on every `install`/`update`/`migrate` run, and nothing ever pruned
  old ones, allowing redundant full snapshots to accumulate.
  The new design (`runBackup()`) mirrors each backed-up directory into a
  single persistent working tree at `~/.ais/backups` via `rsync -a --delete
  --delete-excluded` (replacing tar's "always a fresh full copy" with "the
  working tree always exactly matches the live source, minus excludes"),
  then `git add -A` + commit whatever changed since the LAST backup. Two
  backups taken minutes apart — the common case around an install/update —
  therefore cost close to nothing beyond the first, since git stores each
  distinct blob once no matter how many commits reference it; an empty diff
  (nothing changed) is detected via `git diff --cached --quiet` and produces
  no commit at all, rather than an empty one. `git gc --auto --quiet` runs
  after every commit to keep loose objects packed/delta-compressed rather
  than accumulating unbounded — cheap (near-instant) when under gc's own
  auto-threshold, so it's safe to call unconditionally every run rather than
  needing its own scheduling logic.
  - **Reproducible/machine-local junk is excluded via rsync, sharing
    `REPRODUCIBLE_JUNK_DIR_NAMES` (`src/shared/reproducible-paths.ts`) with
    SSH sync's own `TRANSIENT_EXCLUDES`** (`sync/rsync.ts`) — one list, not
    two independently-maintained ones that could silently drift apart the
    same way the old scattered `~/.ais`-adjacent paths did. `node_modules`,
    marketplace/browser caches, logs, worktrees, and similar have zero
    restore value and were the biggest driver of the old design's
    unbounded growth. The backup adds `jobs/*/tmp/` (unanchored, so it
    matches at any depth) on top: agent job scratch directories can hold
    GBs of throwaway assets and their own `.gitattributes`.
  - **Unlike SSH sync, SQLite/session databases are deliberately NOT
    excluded.** Sync excludes live databases because it has its own
    VACUUM-based snapshot+merge protocol specifically to avoid corrupting a
    live WAL-mode file (see the zai/Crush addenda above) — a backup has no
    equivalent merge step, it just wants a full-fidelity point-in-time copy,
    and excluding the actual session/auth data would defeat the entire
    point of a pre-install/pre-update/pre-migrate safety net. This carries
    the same small, already-accepted risk of copying a database mid-write
    that the old tar-based backup always had (tar had no special handling
    for this either) — no worse than before, just not improved on either.
  - **Local-only git identity, never the user's global gitconfig.** The
    repo gets `user.name`/`user.email` and `commit.gpgsign=false` set
    LOCALLY (`git config`, no `--global`) the first time it's initialised —
    this repo is a storage engine for automated snapshots, not a place for
    human commits, so it must never depend on the user's global identity
    being configured, and gpg-signing (which could hang an automated
    `install`/`update` waiting on a passphrase prompt if the user's global
    config demands signing) is deliberately disabled for it specifically,
    without touching that global setting for the user's actual project
    repos.
  - **`runBackup()`'s return type and every one of its four call sites
    (`migrate.ts`, `scripts/install.ts`, `src/installer.ts`, `src/cli/
    update.ts`) are unchanged** — it still returns `Promise<string>`, now
    the persistent repo path instead of a fresh per-run directory. Every
    caller already just logs whatever path it returns, so none needed a
    diff at all.
  - **Adversarial review (2026-07-23) caught a real bug before this ever
    ran for real: `git commit` had no pathspec, so it committed the WHOLE
    index, not just the groups this run staged.** `git add -A -- ...mirrored`
    and `git diff --cached --quiet -- ...mirrored` were both already
    correctly scoped to the groups touched THIS run — but a bare
    `git commit` after them commits everything currently staged, including
    leftover staged content from an earlier, interrupted broad run (e.g. a
    crash between `install.ts`'s `git add` and `git commit` for one group,
    followed by a later, narrower `install:shims` run for a different
    group). Reproduced directly: staging drift on an untouched directory
    got silently swept into an unrelated group's commit, mislabeled and
    stale. Fixed by passing the identical `-- ...mirrored` pathspec to
    `git commit` too — confirmed via reproduction that `git commit -- 
    <pathspec>` commits only the matching changes and correctly leaves
    other staged content still staged for a future run, rather than losing
    or misattributing it.
  - **Two more real bugs surfaced only by actually deploying this to a real
    machine (2026-07-23), after the adversarial review above had already
    passed — neither was reproducible in a clean test sandbox:**
    1. **`mirrorInto()` treated ANY non-zero rsync exit as fatal, including
       exit 23 ("partial transfer due to error").** This real machine has a
       genuinely permission-denied file under `~/.codex/backups/` (a
       pre-existing artefact of an earlier incident, its own filename
       literally containing `.ais-unreadable-backup-`), and hitting it
       aborted the ENTIRE backup instead of mirroring everything else — the
       exact same "BSD tar continues past an unreadable file, only the exit
       code says something was skipped" shape backup.ts's OLD tar-based
       design explicitly tolerated (see its own historical doc comment).
       The first cut of the rsync-based rewrite regressed this: it was
       strictly LESS tolerant of real-world unreadable files than the
       design it replaced. Fixed by treating exit 23 as a warning (mirror
       still produced, continue) and reserving a hard failure for any
       other exit code.
    2. **`resolveRealBinary()` had no fallback to the LEGACY npm-prefix
       location, and the deferred-migration window this creates is not
       actually rare.** The migration-safety review's own reproduction
       focused on an in-flight `npm install` being corrupted by a racing
       rename; it didn't surface the separate, more mundane consequence of
       `hasLiveOpenOwner()` correctly deferring for an entirely different,
       completely safe reason — a currently-running `claude`/`codex`/
       `crush` process simply having its own already-loaded binary file
       open (read-only execution, not a write in progress at all).
       Confirmed live: with `~/.local/share/ais/npm` still holding several
       real open file handles (this very machine's own running Claude
       Code/Codex sessions, including the one that authored this change),
       `resolveRealBinary("claude")` resolved to `~/.nvm/versions/node/
       .../claude` — an unrelated nvm-installed copy — instead of erroring
       OR finding the real managed install, because the code had stopped
       checking the old location at all. Fixed by adding
       `LEGACY_MANAGED_REAL_BIN_DIR` (the old `~/.local/share/ais/npm/bin`)
       as an unconditional extra fallback in `preferredDirs`, checked right
       after the current location — cheap when absent, and correctly
       resolves to the real managed binary for as long as the deferred
       migration hasn't relocated it yet.
  - **Observed live during this same deployment, understood and NOT a bug
    to fix: two concurrent `ais sync background` workers, one still
    running the OLD binary (writing to `~/.cache/ais`, including its own
    `sync.lock`) and one running the NEW binary (writing to
    `~/.ais/remote-cache`, including a SEPARATE `sync.lock`), briefly
    active at the same time against the same configured remotes.**
    Replacing `~/.local/bin/ais` mid-flight doesn't affect an
    already-running process using the old inode (standard POSIX rename-
    over-a-running-executable semantics), so an old-binary background sync
    already in flight keeps running to completion on its own old code/
    paths while new invocations start using the new ones — the two don't
    share a lock during this transition, since they resolve to different
    default lock paths. Not corrective action here: forcibly killing a
    process this project doesn't own violates this repo's own standing
    rule against unrequested destructive actions, and the existing sync
    design already tolerates concurrent/overlapping runs by construction
    (isolated per-operation incoming trees with random UUIDs, append-only
    JSONL merging, conflict-archive retention) — this is at most some
    redundant SSH round-trips during the one-time transition, not a
    correctness risk, and stops recurring the moment the last old-binary
    background worker exits.


## Off-host push of the git-managed backup

Optional. Without `~/.ais/config/backup.json` the backup behaves exactly as
described above (same repo content, commits and console output); only the
`~/.ais/backups.lock` serialisation is added.

- **Config:** `~/.ais/config/backup.json` (`aisBackupConfigPath()` in
  `src/shared/ais-home.ts`), overridable with `AIS_BACKUP_CONFIG`. Shape:
  `{ "remote"?: string, "localRetentionDays"?: number }`, for example
  `{ "remote": "backup@backup.example:/srv/ais-backups.git", "localRetentionDays": 30 }`.
  A missing file means no remote and no trim. Invalid JSON or wrong types are
  reported with `console.error` and treated as "no remote"; a bad config never
  fails the local backup. `localRetentionDays` must be a positive integer and is
  ignored (loudly) without a `remote`. `runBackup(groups, home, configPath?)`
  takes the config path as an optional third argument for tests.
- **Git LFS is never used by the backup repo**, even when the user's global
  config ran `git lfs install`. Mirrored config trees can contain nested
  `.gitattributes` files with `filter=lfs`; without a guard `git add` would
  store pointers instead of content and the LFS pre-push hook would fail every
  push to a plain remote (`batch request: missing protocol`). Three guards:
  every git call on the repo passes `-c core.hooksPath=/dev/null -c
  filter.lfs.required=false` (hooks in `.git/hooks` are left in place but never
  run); every run writes `.git/info/attributes` (highest attribute precedence)
  with `* -filter -text -ident -working-tree-encoding`, atomically and only when
  the content differs; and when that file is first created or changed, tracked
  paths that still resolve to `filter=lfs` are renormalised after the mirror
  step (`git add --renormalize`) so real content replaces the pointers in that
  run's commit. Renormalisation skips paths no longer in the working tree
  (for example excluded `jobs/*/tmp/` data), which the normal `git add -A`
  simply drops without hashing them. History is not rewritten.
- **Operator creates the remote.** Run `git init --bare /srv/ais-backups.git` on
  the backup host once. The backup never creates it.
- **Push on every run** where a remote is configured, including the "no changes"
  and "nothing new to commit" runs, so a commit made while the remote was down
  is sent by the next run (catch-up). It pushes the whole current branch to the
  URL directly (no named remote is written to `.git/config`):
  `git push --quiet <remote> HEAD:refs/heads/<branch>`. It is never forced
  (no `--force`, no `+refspec`). The spawn uses stdin ignored,
  `GIT_TERMINAL_PROMPT=0` and `core.sshCommand` with `BatchMode=yes`,
  `ConnectTimeout=10`, `ServerAliveInterval=15`, `ServerAliveCountMax=2` and
  `StrictHostKeyChecking=yes`, so a dead or silent host cannot stall a backup
  beyond those bounds and an unknown host key fails loudly instead of
  prompting. Any failure (non-zero exit, git missing, an exception) logs the
  exit code and trimmed stderr with `console.error` and returns normally; the
  push step never throws out of `runBackup`.
- **Local trim** (only with `localRetentionDays`). After a push attempt, `git
  ls-remote` must show the remote branch at exactly the local `HEAD`; if the
  remote is unreachable, behind or different, the trim is skipped with a
  logged reason. The boundary is the oldest commit of `git rev-list
  --first-parent --since=<N days ago> HEAD`, or `HEAD` when every commit is
  older. If the boundary has no local parent (already a root or already the
  shallow boundary) nothing happens. Otherwise the boundary sha replaces the
  contents of `.git/shallow` (written atomically; history is linear, so the new
  boundary supersedes the old), then `git reflog expire --expire=now --all` and
  `git gc --prune=now --quiet` drop the older objects. The remote keeps the full
  history, and because it already holds the boundary commit later pushes stay
  fast-forwards. Any trim failure is loud and non-fatal.
- **Lock:** `~/.ais/backups.lock` (`aisBackupLockPath()`, outside the repo
  tree) is held for the whole run via `src/shared/pid-lock.ts`, the same
  pid+token helper as the sync lock. A second run waits up to 10 minutes, then
  logs and throws like any other backup failure. A lock whose pid is dead is
  taken over.
- **Manual trigger:** `bun run backup` from a checkout.
