/**
 * Directory names that hold reproducible or machine-specific payloads —
 * safe to exclude from both SSH profile sync (sync/rsync.ts's
 * TRANSIENT_EXCLUDES) and the local git-managed backup (scripts/backup.ts).
 * Copying these just makes every scan slower and, for the git-managed
 * backup specifically, bloats the repo with content that has no restore
 * value: caches/clones/logs regenerate on next use, and browser profiles
 * and shell snapshots are machine-local. One source of truth so the two
 * consumers' exclude lists can't silently drift apart — each still adds its
 * OWN additional excludes on top of this (sync also excludes live SQLite
 * databases in favour of its own VACUUM-based merge protocol; backup does
 * not, since it wants a full-fidelity point-in-time copy).
 */
export const REPRODUCIBLE_JUNK_DIR_NAMES = [
  "chrome-profile/",
  "cache/",
  "marketplace-cache/",
  "marketplaces/",
  "node_modules/",
  ".git/",
  ".venv/",
  "__pycache__/",
  "vendor/",
  "logs/",
  "debug/",
  "downloads/",
  "worktrees/",
  "computer-use/",
  "generated_images/",
  "shell-snapshots/",
  "shell_snapshots/",
];
