import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { acquire, type LockHandle } from "../claude-swap-lock.ts";

export interface LockOptions {
  /** Total time to wait for one lock. Default 5s. */
  timeoutMs?: number;
  /** A lock dir older than this is presumed abandoned and broken. Default: Claude Code's own
   * proper-lockfile `stale` for that lock, which breaks any lock whose mtime is older
   * (`.oauth_refresh.lock` 60s in 2.1.295, 10s in 2.1.159; `.claude.json.lock` 10s). */
  staleMs?: number;
  /** While held, the lock dir's mtime is touched this often so Claude Code never sees it as
   * stale. Default 5s (proper-lockfile's `update` = stale / 2); keep well under every Claude Code stale value (min 10s). */
  updateMs?: number;
  pollMs?: number;
}

/** Pool-level lock dir inside the pool's configDir. It serialises every
 * read-decide-write on one pool (swap, auto swap, heal) across processes;
 * taken BEFORE any provider lock (`.oauth_refresh.lock`) so the order is
 * always pool lock, then provider locks. */
export const poolLockPath = (poolDir: string): string => join(poolDir, ".ais-pool.lock");

export async function withPoolLock<T>(poolDir: string, fn: (handle: LockHandle) => Promise<T>, options: LockOptions = {}): Promise<T> {
  await mkdir(poolDir, { recursive: true });
  const held = await acquire(poolLockPath(poolDir), options);
  try {
    return await fn(held);
  } finally {
    await held.release();
  }
}
