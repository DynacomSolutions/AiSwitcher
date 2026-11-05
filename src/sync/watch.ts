import { lstat, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

// How often the host-level profile-sync daemon (profile-sync-daemon.ts)
// re-scans each watched identity tree for sync-relevant changes.
export const POLL_MS = 30_000;
// Safety ceiling on entries visited per scan, so a pathological tree cannot
// make the daemon spin.
const MAX_SCAN_ENTRIES = 200_000;
// High-churn per-session scratch (tens of thousands of directories in a large
// identity) that the final post-exit sync already covers.
const UNSCANNED_DIR_PATTERN = /(?:^|\/)(?:\.trash|session-env)(?:\/|$)/i;
const QUIET_DATABASE_PATTERN = /\.(?:sqlite|db)(?:-(?:shm|wal|journal))?$/i;
const TRANSIENT_PATTERN = /(?:^|\/)(?:[^/]+\.(?:lock|sock|pid|tmp)|daemon\.lock)$/i;
const REPRODUCIBLE_DIR_PATTERN =
  /(?:^|\/)(?:chrome-profile|cache|marketplace-cache|marketplaces|node_modules|\.git|\.venv|__pycache__|vendor|logs|debug|backups|downloads|worktrees|computer-use|generated_images|shell-snapshots|shell_snapshots)(?:\/|$)/i;

/** Whether a directory (relative to the watched root) is worth scanning at all. */
export function shouldScanDirectory(relativePath: string): boolean {
  const rel = relativePath.split(sep).join("/");
  return !REPRODUCIBLE_DIR_PATTERN.test(rel) && !UNSCANNED_DIR_PATTERN.test(rel);
}

export type Snapshot = Map<string, string>;

/**
 * Stat-walk a tree, never descending into excluded directories, and return
 * `relative path -> mtime:size`. Deliberately not fs.watch: Bun's Linux
 * implementation opens an fd for every entry of a watched directory (and, with
 * `recursive`, every file under the root), and never releases them after
 * close(), which exhausted the fd limit of long-lived launchers. Polling holds
 * no descriptors between scans.
 */
export async function scanTree(root: string): Promise<Snapshot> {
  const snapshot: Snapshot = new Map();
  const queue = [root];
  while (queue.length > 0 && snapshot.size < MAX_SCAN_ENTRIES) {
    const dir = queue.pop() as string;
    let names: import("node:fs").Dirent[];
    try {
      names = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    await Promise.all(
      names.map(async (entry) => {
        const full = join(dir, entry.name);
        const rel = relative(root, full).split(sep).join("/");
        if (entry.isDirectory()) {
          if (shouldScanDirectory(rel)) queue.push(full);
          return;
        }
        if (!shouldTriggerProfileSync(rel)) return;
        try {
          const st = await lstat(full);
          snapshot.set(rel, `${st.mtimeMs}:${st.size}`);
        } catch {
          // Removed between readdir and lstat; the next scan sees it gone.
        }
      }),
    );
  }
  return snapshot;
}

export function snapshotsDiffer(before: Snapshot, after: Snapshot): boolean {
  if (before.size !== after.size) return true;
  for (const [path, sig] of after) if (before.get(path) !== sig) return true;
  return false;
}

export function shouldTriggerProfileSync(filename: string): boolean {
  return (
    !QUIET_DATABASE_PATTERN.test(filename) &&
    !TRANSIENT_PATTERN.test(filename) &&
    !REPRODUCIBLE_DIR_PATTERN.test(filename)
  );
}
