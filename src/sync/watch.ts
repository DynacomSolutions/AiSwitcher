import { lstat, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { expandPath } from "../identities/match.ts";
import type { ToolConfig } from "../identities/types.ts";
import { startBackgroundProfileSync } from "./background.ts";

const DEBOUNCE_MS = 3_000;
// How often the identity tree is re-scanned for sync-relevant changes.
const POLL_MS = 5_000;
// Safety ceiling on entries visited per scan, so a pathological tree cannot
// make a launcher spin.
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

type Snapshot = Map<string, string>;

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

export interface ProfileSyncWatcher {
  stop(): Promise<void>;
}

export function startProfileSyncWatcher(
  cfg: ToolConfig,
  identityName: string,
  configDir: string,
  cwd: string,
  options: { pollMs?: number; debounceMs?: number } = {},
): ProfileSyncWatcher {
  const pollMs = options.pollMs ?? POLL_MS;
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const flush = () => {
    startBackgroundProfileSync({
      direction: "both",
      scope: { kind: "identity", cfg, identityName, cwd },
      includeDatabases: false,
    });
  };

  const schedule = () => {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      flush();
    }, debounceMs);
  };

  // Poll each root. A missing root (normal for a brand-new profile or
  // `.crush` directory) scans as empty and is picked up once it appears.
  // Watcher failures must never take down the real AI CLI; the final
  // post-exit push remains the fallback.
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  const roots = [expandPath(configDir)];
  // Every crush-backed tool (zai, ali; see identities/tool-configs.ts) also
  // has a project-local `.crush` dotdir alongside the identity's own
  // configDir, since that's where Crush's actual session data lives (see
  // resume/crush-resume.ts).
  if (cfg.realBinaryName === "crush") roots.push(join(cwd, ".crush"));

  const snapshots = new Map<string, Snapshot>();
  const poll = async () => {
    for (const root of roots) {
      if (stopped) return;
      try {
        const next = await scanTree(root);
        const previous = snapshots.get(root);
        snapshots.set(root, next);
        if (previous && snapshotsDiffer(previous, next)) schedule();
      } catch {}
    }
    if (!stopped) {
      pollTimer = setTimeout(poll, pollMs);
      pollTimer.unref?.();
    }
  };
  void poll();

  return {
    async stop() {
      stopped = true;
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = undefined;
      }
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      // Always perform one final pull/merge/push: SQLite databases are
      // intentionally quiet during the session, then reconciled by a detached
      // worker after the child has closed. Waiting for the lock happens in
      // that worker and can never hold the caller's terminal open.
      startBackgroundProfileSync({
        direction: "both",
        scope: { kind: "identity", cfg, identityName, cwd },
        waitForLock: true,
        includeDatabases: true,
      });
    },
  };
}
