import { mkdir, rmdir, stat, utimes } from "node:fs/promises";
import { join } from "node:path";

/**
 * Claude Code serialises its own OAuth refresh and `.claude.json` writes with
 * mkdir-style lock directories. A credential swap must take the same locks
 * (same order) so it can never interleave with a refresh that would
 * overwrite the swapped grant. Names are Claude Code's own:
 *   <configDir>/.oauth_refresh.lock   then   <configDir>/.claude.json.lock
 */

export class SwapLockError extends Error {
  constructor(
    message: string,
    readonly lockPath: string,
    /** True only for a wait timeout (a holder is busy), not for mkdir failures like EACCES. */
    readonly timedOut = false,
  ) {
    super(message);
    this.name = "SwapLockError";
  }
}

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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Passed to the callback of the `with*Lock` helpers. */
export interface LockHandle {
  /** True once the lock dir was removed or replaced under us (e.g. Claude Code broke it as stale). */
  isLost(): boolean;
}

interface HeldLock extends LockHandle {
  release(): Promise<void>;
}

/**
 * Keeps a just-created lock dir fresh (like proper-lockfile's update loop) and
 * returns a release that removes the dir only while it is still the one we
 * made. If Claude Code broke it as stale and re-took it, its dir has another
 * inode/mtime and must be left alone. Release waits for an in-flight touch so
 * the two never interleave.
 */
async function own(lockPath: string, updateMs: number): Promise<HeldLock> {
  let mine = await stat(lockPath);
  let lost = false;
  let released = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> = Promise.resolve();
  const same = (s: { ino: number; mtimeMs: number }) => s.ino === mine.ino && s.mtimeMs === mine.mtimeMs;
  const schedule = () => {
    if (released || lost) return;
    timer = setTimeout(() => { running = tick(); }, updateMs);
    timer.unref();
  };
  const tick = async () => {
    try {
      if (!same(await stat(lockPath))) { lost = true; return; }
      const now = new Date();
      await utimes(lockPath, now, now);
      mine = await stat(lockPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") { lost = true; return; }
      // transient failure: retry next tick, the lock is still ours
    }
    schedule();
  };
  schedule();
  return {
    isLost: () => lost,
    release: async () => {
      released = true;
      clearTimeout(timer);
      await running;
      if (lost) return;
      try {
        if (same(await stat(lockPath))) await rmdir(lockPath);
      } catch {
        // already gone or not ours
      }
    },
  };
}

async function acquire(lockPath: string, options: LockOptions): Promise<HeldLock> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const staleMs = options.staleMs ?? (lockPath.endsWith(".oauth_refresh.lock") ? 60_000 : 10_000);
  const updateMs = options.updateMs ?? 5_000;
  const pollMs = options.pollMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await mkdir(lockPath);
      return await own(lockPath, updateMs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new SwapLockError(`could not create lock ${lockPath}: ${(err as Error).message}`, lockPath);
      }
    }
    try {
      const age = Date.now() - (await stat(lockPath)).mtimeMs;
      if (age > staleMs) {
        await rmdir(lockPath).catch(() => undefined);
        continue;
      }
    } catch {
      continue; // vanished between mkdir and stat: retry immediately
    }
    if (Date.now() >= deadline) {
      throw new SwapLockError(
        `could not take lock ${lockPath} within ${timeoutMs}ms (a Claude Code session is probably refreshing its token right now; retry in a moment)`,
        lockPath,
        true,
      );
    }
    await sleep(pollMs);
  }
}

export function oauthRefreshLockPath(configDir: string): string {
  return join(configDir, ".oauth_refresh.lock");
}

export function claudeJsonLockPath(configDir: string): string {
  return join(configDir, ".claude.json.lock");
}

const noteLost = (path: string, held: HeldLock) => {
  if (held.isLost()) console.warn(`[ais] lock ${path} was broken while held; Claude Code may have used the same refresh token`);
};

/** Runs `fn` while holding both Claude Code locks of `configDir`. */
export async function withClaudeLocks<T>(configDir: string, fn: (handle: LockHandle) => Promise<T>, options: LockOptions = {}): Promise<T> {
  await mkdir(configDir, { recursive: true });
  const refresh = await acquire(oauthRefreshLockPath(configDir), options);
  try {
    const json = await acquire(claudeJsonLockPath(configDir), options);
    try {
      return await fn({ isLost: () => refresh.isLost() || json.isLost() });
    } finally {
      await json.release();
      noteLost(claudeJsonLockPath(configDir), json);
    }
  } finally {
    await refresh.release();
    noteLost(oauthRefreshLockPath(configDir), refresh);
  }
}

/** Runs `fn` while holding only `<configDir>/.oauth_refresh.lock`. */
export async function withOauthRefreshLock<T>(configDir: string, fn: (handle: LockHandle) => Promise<T>, options: LockOptions = {}): Promise<T> {
  await mkdir(configDir, { recursive: true });
  const held = await acquire(oauthRefreshLockPath(configDir), options);
  try {
    return await fn(held);
  } finally {
    await held.release();
    noteLost(oauthRefreshLockPath(configDir), held);
  }
}

/** Runs `fn` while holding `.oauth_refresh.lock` of every dir, acquired in
 * sorted order (a stable order across callers, so two holders of
 * overlapping sets cannot deadlock). */
export async function withOauthRefreshLocks<T>(dirs: string[], fn: (handle: LockHandle) => Promise<T>, options: LockOptions = {}): Promise<T> {
  const [first, ...rest] = [...new Set(dirs)].sort();
  if (first === undefined) return fn({ isLost: () => false });
  return withOauthRefreshLock(first, (own) => withOauthRefreshLocks(rest, (inner) => fn({ isLost: () => own.isLost() || inner.isLost() }), options), options);
}
