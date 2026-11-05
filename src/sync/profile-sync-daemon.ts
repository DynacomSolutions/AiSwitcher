import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { markUsageSnapshotDirty, usageSnapshotTargetKey } from "../cli/usage/snapshot-dirty.ts";
import { expandPath } from "../identities/match.ts";
import type { ToolConfig } from "../identities/types.ts";
import { aisStateDir } from "../shared/ais-home.ts";
import { isPidRunning, procStartTime } from "../shared/session-sidecar.ts";
import { startBackgroundProfileSync } from "./background.ts";
import { SYNC_TOOL_CONFIGS } from "./rsync.ts";
import { listLiveSessions, sessionRegistryDir, type IsRunning, type RegisteredSession } from "./session-registry.ts";
import type { SyncRunOptions } from "./types.ts";
import { POLL_MS, scanTree, snapshotsDiffer, type Snapshot } from "./watch.ts";

/**
 * One host-level watcher for every live session, replacing the per-session
 * stat-walk each `__session-sidecar` used to run. Every poll it reads the
 * session registry (session-registry.ts), scans each distinct watched root
 * once, however many sessions share it, and on a change starts one
 * identity-scoped background sync and marks the identity's usage snapshot
 * dirty.
 *
 * Roots and sync scope:
 *  - The identity configDir is shared by every session of that
 *    (tool, identity). The identity-scoped sync resolves its directories from
 *    the identity registry, not from the session, and only crush-backed tools
 *    read `cwd` at all (to add `<cwd>/.crush`). So a configDir change starts
 *    one sync without `cwd`, which is the same sync for every session.
 *  - A crush-backed session's `<cwd>/.crush` is its own root, shared only with
 *    sessions of the same identity in the same cwd. A change there starts a
 *    sync with that `cwd`, so the project dotdir is pushed as before.
 *
 * Each session still runs its own post-exit sync from the sidecar, so when
 * this daemon is not running nothing is lost except the in-session pushes.
 */

export interface WatchTarget {
  key: string;
  root: string;
  cfg: ToolConfig;
  identityName: string;
  /** Set only for a crush project root: the cwd the sync must include. */
  cwd?: string;
}

export interface DaemonDeps {
  registryDir?: string;
  isRunning?: IsRunning;
  scan?: (root: string) => Promise<Snapshot>;
  sync?: (options: SyncRunOptions) => unknown;
  markDirty?: (toolName: string, identityName: string) => void;
  configs?: readonly ToolConfig[];
}

export interface TickResult {
  sessions: number;
  roots: number;
  syncs: number;
}

/** Distinct roots to scan for the given live sessions. */
export function watchTargets(sessions: RegisteredSession[], configs: readonly ToolConfig[] = SYNC_TOOL_CONFIGS): WatchTarget[] {
  const targets = new Map<string, WatchTarget>();
  for (const session of sessions) {
    const cfg = configs.find((c) => c.toolName === session.toolName);
    if (!cfg) continue;
    const root = expandPath(session.configDir);
    const identityKey = `${cfg.toolName}\0${session.identityName}`;
    const configKey = `config\0${identityKey}\0${root}`;
    if (!targets.has(configKey)) targets.set(configKey, { key: configKey, root, cfg, identityName: session.identityName });
    if (cfg.realBinaryName === "crush") {
      const crushRoot = session.crushRoot ?? join(session.cwd, ".crush");
      const crushKey = `crush\0${identityKey}\0${crushRoot}`;
      if (!targets.has(crushKey)) {
        targets.set(crushKey, { key: crushKey, root: crushRoot, cfg, identityName: session.identityName, cwd: session.cwd });
      }
    }
  }
  return [...targets.values()];
}

export interface ProfileSyncDaemon {
  tick(): Promise<TickResult>;
}

export function createProfileSyncDaemon(deps: DaemonDeps = {}): ProfileSyncDaemon {
  const isRunning = deps.isRunning ?? isPidRunning;
  const scan = deps.scan ?? scanTree;
  const sync = deps.sync ?? ((options: SyncRunOptions) => startBackgroundProfileSync(options, { warn: () => {} }));
  const markDirty = deps.markDirty ?? ((tool: string, identity: string) => markUsageSnapshotDirty(usageSnapshotTargetKey(tool, identity)));
  const snapshots = new Map<string, Snapshot>();

  return {
    async tick() {
      const sessions = listLiveSessions(isRunning, deps.registryDir ?? sessionRegistryDir());
      const targets = watchTargets(sessions, deps.configs);
      const wanted = new Set(targets.map((t) => t.key));
      for (const key of snapshots.keys()) if (!wanted.has(key)) snapshots.delete(key);

      // One sync per (tool, identity, cwd) per tick; a sync with a cwd also
      // covers the identity's configDir, so it replaces the cwd-less one.
      const changed = new Map<string, { target: WatchTarget; cwds: Set<string> }>();
      for (const target of targets) {
        let next: Snapshot;
        try {
          next = await scan(target.root);
        } catch {
          continue;
        }
        const previous = snapshots.get(target.key);
        snapshots.set(target.key, next);
        // A root seen for the first time is a baseline, not a change.
        if (!previous || !snapshotsDiffer(previous, next)) continue;
        const identityKey = `${target.cfg.toolName}\0${target.identityName}`;
        const entry = changed.get(identityKey) ?? { target, cwds: new Set<string>() };
        if (target.cwd !== undefined) entry.cwds.add(target.cwd);
        changed.set(identityKey, entry);
      }

      let syncs = 0;
      for (const { target, cwds } of changed.values()) {
        const scopes: Array<string | undefined> = cwds.size > 0 ? [...cwds] : [undefined];
        for (const cwd of scopes) {
          try {
            sync({
              direction: "both",
              scope: { kind: "identity", cfg: target.cfg, identityName: target.identityName, ...(cwd !== undefined ? { cwd } : {}) },
              includeDatabases: false,
            });
            syncs++;
          } catch { /* one failed spawn must not stop the others */ }
        }
        try { markDirty(target.cfg.toolName, target.identityName); } catch { /* best effort */ }
      }
      return { sessions: sessions.length, roots: targets.length, syncs };
    },
  };
}

export function profileSyncDaemonLockPath(): string {
  return join(aisStateDir(), "profile-sync", "daemon.pid");
}

/** Single-instance guard: true when this process may run the daemon. A lock
 * whose owner is gone (PID plus start time) is taken over. */
export function acquireDaemonLock(path = profileSyncDaemonLockPath(), isRunning: IsRunning = isPidRunning): boolean {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const mine = `${process.pid} ${procStartTime(process.pid) ?? ""}\n`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, mine, { flag: "wx", mode: 0o600 });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let owner = "";
    try { owner = readFileSync(path, "utf8"); } catch { continue; }
    const [pidText, startTime] = owner.trim().split(" ");
    const pid = Number(pidText);
    if (pid === process.pid) return true;
    if (Number.isInteger(pid) && pid > 0 && isRunning(pid, startTime || undefined)) return false;
    try { unlinkSync(path); } catch { /* another starter removed it */ }
  }
  return false;
}

/** Body of `ais __profile_sync_daemon`. Runs until SIGTERM/SIGINT. */
export async function runProfileSyncDaemon(options: { pollMs?: number } = {}): Promise<void> {
  const lockPath = profileSyncDaemonLockPath();
  if (!acquireDaemonLock(lockPath)) {
    console.error("ais: a profile sync daemon is already running");
    return;
  }
  const pollMs = options.pollMs ?? POLL_MS;
  const daemon = createProfileSyncDaemon();
  let stopped = false;
  let wake: (() => void) | undefined;
  const onSignal = () => {
    stopped = true;
    wake?.();
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  try {
    while (!stopped) {
      try { await daemon.tick(); } catch { /* keep polling */ }
      if (stopped) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, pollMs);
      });
      wake = undefined;
    }
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    try {
      if (readFileSync(lockPath, "utf8").startsWith(`${process.pid} `)) unlinkSync(lockPath);
    } catch { /* already gone */ }
  }
}
