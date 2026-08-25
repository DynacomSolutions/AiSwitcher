import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { expandPath } from "../identities/match.ts";
import type { ToolConfig } from "../identities/types.ts";
import { startBackgroundProfileSync } from "./background.ts";

const DEBOUNCE_MS = 3_000;
const QUIET_DATABASE_PATTERN = /\.(?:sqlite|db)(?:-(?:shm|wal|journal))?$/i;
const TRANSIENT_PATTERN = /(?:^|\/)(?:[^/]+\.(?:lock|sock|pid|tmp)|daemon\.lock)$/i;
const REPRODUCIBLE_DIR_PATTERN =
  /(?:^|\/)(?:chrome-profile|cache|marketplace-cache|marketplaces|node_modules|\.git|\.venv|__pycache__|vendor|logs|debug|backups|downloads|worktrees|computer-use|generated_images|shell-snapshots|shell_snapshots)(?:\/|$)/i;

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
): ProfileSyncWatcher {
  const watchers: FSWatcher[] = [];
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
    }, DEBOUNCE_MS);
  };

  const addWatcher = (root: string) => {
    try {
      const watcher = watch(root, { recursive: true }, (_event, filename) => {
        if (!filename || shouldTriggerProfileSync(String(filename))) schedule();
      });
      // Filesystem-watch errors must never take down the real AI CLI. The
      // final post-exit push remains the fallback.
      watcher.on("error", () => {});
      watchers.push(watcher);
    } catch {
      // A missing root (normal for a brand-new profile/.crush directory) or
      // a platform without recursive watch support still gets the final
      // post-exit push below.
    }
  };

  addWatcher(expandPath(configDir));
  // Every crush-backed tool (zai, ali; see identities/tool-configs.ts) also
  // has a project-local `.crush` dotdir alongside the identity's own
  // configDir, since that's where Crush's actual session data lives (see
  // resume/crush-resume.ts).
  if (cfg.realBinaryName === "crush") addWatcher(join(cwd, ".crush"));

  return {
    async stop() {
      stopped = true;
      for (const watcher of watchers) watcher.close();
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
