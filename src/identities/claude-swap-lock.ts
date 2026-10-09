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
  /** A lock dir older than this is presumed abandoned and broken. Default 10s: Claude Code's
   * proper-lockfile `stale` (v2.1.159: `stale: 1e4`), which breaks any lock whose mtime is older. */
  staleMs?: number;
  /** While held, the lock dir's mtime is touched this often so Claude Code never sees it as
   * stale. Default 5s (proper-lockfile's `update` = stale / 2); keep well under `staleMs`. */
  updateMs?: number;
  pollMs?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Keeps a just-created lock dir fresh (like proper-lockfile's update loop) and
 * returns a release that removes the dir only while it is still the one we
 * made. If Claude Code broke it as stale and re-took it, its dir has another
 * inode/mtime and must be left alone.
 */
async function own(lockPath: string, updateMs: number): Promise<() => Promise<void>> {
  let mine = await stat(lockPath);
  let lost = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const same = (s: { ino: number; mtimeMs: number }) => s.ino === mine.ino && s.mtimeMs === mine.mtimeMs;
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
    timer = setTimeout(tick, updateMs);
    timer.unref();
  };
  timer = setTimeout(tick, updateMs);
  timer.unref();
  return async () => {
    clearTimeout(timer);
    if (lost) return;
    try {
      if (same(await stat(lockPath))) await rmdir(lockPath);
    } catch {
      // already gone or not ours
    }
  };
}

async function acquire(lockPath: string, options: LockOptions): Promise<() => Promise<void>> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const staleMs = options.staleMs ?? 10_000;
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

/** Runs `fn` while holding both Claude Code locks of `configDir`. */
export async function withClaudeLocks<T>(configDir: string, fn: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  await mkdir(configDir, { recursive: true });
  const releaseRefresh = await acquire(oauthRefreshLockPath(configDir), options);
  try {
    const releaseJson = await acquire(claudeJsonLockPath(configDir), options);
    try {
      return await fn();
    } finally {
      await releaseJson();
    }
  } finally {
    await releaseRefresh();
  }
}

/** Runs `fn` while holding only `<configDir>/.oauth_refresh.lock`. */
export async function withOauthRefreshLock<T>(configDir: string, fn: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  await mkdir(configDir, { recursive: true });
  const release = await acquire(oauthRefreshLockPath(configDir), options);
  try {
    return await fn();
  } finally {
    await release();
  }
}

/** Runs `fn` while holding `.oauth_refresh.lock` of every dir, acquired in
 * sorted order (a stable order across callers, so two holders of
 * overlapping sets cannot deadlock). */
export async function withOauthRefreshLocks<T>(dirs: string[], fn: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const [first, ...rest] = [...new Set(dirs)].sort();
  if (first === undefined) return fn();
  return withOauthRefreshLock(first, () => withOauthRefreshLocks(rest, fn, options), options);
}
