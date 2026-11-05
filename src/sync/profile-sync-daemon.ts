import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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
  /** Earliest `registeredAt` of the live sessions behind this root; undefined when one has none (older sidecar). */
  since?: number;
}

export interface DaemonDeps {
  registryDir?: string;
  isRunning?: IsRunning;
  scan?: (root: string) => Promise<Snapshot>;
  sync?: (options: SyncRunOptions) => unknown;
  markDirty?: (toolName: string, identityName: string) => void;
  configs?: readonly ToolConfig[];
  /** Clock override for tests (epoch ms). */
  now?: () => number;
}

export interface TickResult {
  sessions: number;
  roots: number;
  syncs: number;
}

/** Distinct roots to scan for the given live sessions. */
export function watchTargets(sessions: RegisteredSession[], configs: readonly ToolConfig[] = SYNC_TOOL_CONFIGS): WatchTarget[] {
  const targets = new Map<string, WatchTarget>();
  const add = (key: string, target: WatchTarget, registeredAt: number | undefined) => {
    const existing = targets.get(key);
    if (!existing) {
      targets.set(key, { ...target, ...(registeredAt !== undefined ? { since: registeredAt } : {}) });
    } else if (existing.since !== undefined) {
      if (registeredAt === undefined) delete existing.since;
      else existing.since = Math.min(existing.since, registeredAt);
    }
  };
  for (const session of sessions) {
    const cfg = configs.find((c) => c.toolName === session.toolName);
    if (!cfg) continue;
    const root = expandPath(session.configDir);
    const identityKey = `${cfg.toolName}\0${session.identityName}`;
    const configKey = `config\0${identityKey}\0${root}`;
    add(configKey, { key: configKey, root, cfg, identityName: session.identityName }, session.registeredAt);
    if (cfg.realBinaryName === "crush") {
      const crushRoot = session.crushRoot ?? join(session.cwd, ".crush");
      const crushKey = `crush\0${identityKey}\0${crushRoot}`;
      add(crushKey, { key: crushKey, root: crushRoot, cfg, identityName: session.identityName, cwd: session.cwd }, session.registeredAt);
    }
  }
  return [...targets.values()];
}

/** File timestamps come from the kernel's coarse clock and can trail
 * Date.now() by a few milliseconds; a write right after registration must
 * still count. An extra sync for a slightly older write is harmless. */
const CLOCK_SLACK_MS = 2_000;

/** True when any entry's mtime (the `mtime:size` signature) is at or after `since`. */
export function modifiedSince(snapshot: Snapshot, since: number): boolean {
  for (const sig of snapshot.values()) if (Number.parseFloat(sig) >= since) return true;
  return false;
}

export interface ProfileSyncDaemon {
  tick(): Promise<TickResult>;
}

export function createProfileSyncDaemon(deps: DaemonDeps = {}): ProfileSyncDaemon {
  const isRunning = deps.isRunning ?? isPidRunning;
  const scan = deps.scan ?? scanTree;
  const sync = deps.sync ?? ((options: SyncRunOptions) => startBackgroundProfileSync(options, { warn: () => {} }));
  const markDirty = deps.markDirty ?? ((tool: string, identity: string) => markUsageSnapshotDirty(usageSnapshotTargetKey(tool, identity)));
  const now = deps.now ?? Date.now;
  const startedAt = now();
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
        // A root seen for the first time has no previous snapshot. Anything
        // written there since its earliest live session registered (or, for
        // an older sidecar without registeredAt, since this daemon started)
        // counts as a change, so writes before the first poll and during a
        // daemon restart are not lost. Older files are the baseline.
        const isChange = previous
          ? snapshotsDiffer(previous, next)
          : modifiedSince(next, (target.since ?? startedAt) - CLOCK_SLACK_MS);
        if (!isChange) continue;
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

/** An empty or unparseable lock younger than this is an owner mid-write: busy. */
const LOCK_GRACE_MS = 10_000;

function readLock(path: string): { content: string; ageMs: number } | undefined {
  try {
    const content = readFileSync(path, "utf8");
    return { content, ageMs: Date.now() - statSync(path).mtimeMs };
  } catch {
    return undefined;
  }
}

function lockOwner(content: string): { pid: number; startTime?: string } | undefined {
  const match = /^(\d+) (\S*)\n$/.exec(content);
  if (!match) return undefined;
  const pid = Number(match[1]);
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  return { pid, ...(match[2] ? { startTime: match[2] } : {}) };
}

function myLockContent(): string {
  return `${process.pid} ${procStartTime(process.pid) ?? ""}\n`;
}

/** True while `path` still names this process as the owner. */
export function ownsDaemonLock(path = profileSyncDaemonLockPath()): boolean {
  return readLock(path)?.content === myLockContent();
}

/**
 * Single-instance guard: true when this process may run the daemon. The lock
 * file always appears with its full content (written to a temporary file,
 * then linked into place), so a reader never sees a half-written lock from
 * this code; an empty or unparseable one is still treated as busy until it is
 * older than a short grace period. A lock whose owner is gone (PID plus start
 * time) is replaced by rename only if it still holds exactly the stale content
 * that was judged, and the result is re-read to confirm. The running daemon
 * also re-checks ownership every poll (daemonLockState) and exits non-zero if
 * another process holds the lock, so even a lost race cannot leave two
 * daemons for long.
 */
export function acquireDaemonLock(path = profileSyncDaemonLockPath(), isRunning: IsRunning = isPidRunning): boolean {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const mine = myLockContent();
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, mine, { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        linkSync(temporary, path);
        return readLock(path)?.content === mine;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const seen = readLock(path);
      if (!seen) continue; // removed meanwhile: try to create it again
      if (seen.content === mine) return true;
      const owner = lockOwner(seen.content);
      if (!owner) {
        if (seen.ageMs < LOCK_GRACE_MS) return false;
      } else if (isRunning(owner.pid, owner.startTime)) {
        return false;
      }
      // Stale. Replace it only if nobody has replaced it since we read it.
      if (readLock(path)?.content !== seen.content) continue;
      renameSync(temporary, path);
      return readLock(path)?.content === mine;
    }
    return false;
  } finally {
    try { unlinkSync(temporary); } catch { /* linked or renamed away */ }
  }
}

export type LockState = "mine" | "other" | "missing" | "unknown";

/** Who holds the lock, judged by PID only. Read errors and unparseable
 * content are "unknown": never a reason to stop. */
export function daemonLockState(path: string, pid = process.pid): LockState {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unknown";
  }
  const owner = lockOwner(content);
  if (!owner) return "unknown";
  return owner.pid === pid ? "mine" : "other";
}

export interface RunDaemonOptions {
  pollMs?: number;
  lockPath?: string;
  /** Stops the loop (tests); SIGTERM/SIGINT do the same in production. */
  signal?: AbortSignal;
  deps?: DaemonDeps;
}

/**
 * Body of `ais __profile_sync_daemon`. Runs until SIGTERM/SIGINT and returns
 * the process exit code. Non-zero when another daemon holds the lock, so the
 * user unit (Restart=on-failure) retries instead of staying dead. A lock that
 * vanished is recreated; a transient read error is ignored.
 */
export async function runProfileSyncDaemon(options: RunDaemonOptions = {}): Promise<number> {
  const lockPath = options.lockPath ?? profileSyncDaemonLockPath();
  if (!acquireDaemonLock(lockPath)) {
    console.error("ais: a profile sync daemon is already running");
    return 1;
  }
  const pollMs = options.pollMs ?? POLL_MS;
  const daemon = createProfileSyncDaemon(options.deps);
  let stopped = false;
  let wake: (() => void) | undefined;
  const onSignal = () => {
    stopped = true;
    wake?.();
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  options.signal?.addEventListener("abort", onSignal, { once: true });
  if (options.signal?.aborted) stopped = true;
  try {
    while (!stopped) {
      const state = daemonLockState(lockPath);
      if (state === "other") {
        console.error("ais: profile sync daemon lock taken by another process; exiting");
        return 1;
      }
      if (state === "missing") {
        try {
          if (!acquireDaemonLock(lockPath)) {
            console.error("ais: profile sync daemon lock taken by another process; exiting");
            return 1;
          }
        } catch { /* state dir unavailable right now: keep running, retry next poll */ }
      }
      try { await daemon.tick(); } catch { /* keep polling */ }
      if (stopped) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, pollMs);
      });
      wake = undefined;
    }
    return 0;
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    options.signal?.removeEventListener("abort", onSignal);
    try {
      if (daemonLockState(lockPath) === "mine") unlinkSync(lockPath);
    } catch { /* already gone */ }
  }
}
