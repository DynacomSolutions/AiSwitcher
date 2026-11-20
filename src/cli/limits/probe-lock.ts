import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export interface ProbeLockDeps {
  now?: () => number;
  isPidAlive?: (pid: number) => boolean;
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function isStale(path: string, staleAfterMs: number, deps: ProbeLockDeps): Promise<boolean> {
  const now = (deps.now ?? Date.now)();
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown; startedAtMs?: unknown };
    if (typeof parsed.pid === "number" && !(deps.isPidAlive ?? defaultIsPidAlive)(parsed.pid)) return true;
    if (typeof parsed.startedAtMs === "number") return now - parsed.startedAtMs > staleAfterMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
  }
  // Unreadable content: judge by file age.
  try {
    return now - (await stat(path)).mtimeMs > staleAfterMs;
  } catch {
    return false;
  }
}

/**
 * Takes an exclusive lock file. Returns a release function, or undefined when
 * a live holder has it. A lock is stale when its process is dead or it is
 * older than `staleAfterMs`; a stale lock is removed and taken again.
 */
export async function acquireProbeLock(path: string, staleAfterMs: number, deps: ProbeLockDeps = {}): Promise<(() => Promise<void>) | undefined> {
  await mkdir(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, "wx");
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, startedAtMs: (deps.now ?? Date.now)() }));
      } finally {
        await handle.close();
      }
      return async () => {
        await unlink(path).catch(() => undefined);
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (!(await isStale(path, staleAfterMs, deps))) return undefined;
      await unlink(path).catch(() => undefined);
    }
  }
  return undefined;
}
