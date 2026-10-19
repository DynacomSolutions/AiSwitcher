import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Exclusive pid+token lock file (`open(path, "wx")`). A lock whose recorded
 * pid is dead (or unreadable as a pid) is taken over. Returns a release
 * function, or undefined when the lock is still held after `waitMs`
 * (0 = try once). Release only removes the file if it still carries our token. */
export async function acquirePidLock(
  path: string,
  { waitMs, retryMs }: { waitMs: number; retryMs: number },
): Promise<(() => Promise<void>) | undefined> {
  await mkdir(dirname(path), { recursive: true });
  const token = `${process.pid}:${crypto.randomUUID()}`;
  const deadline = Date.now() + waitMs;

  for (;;) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() })}\n`);
      await handle.close();
      return async () => {
        try {
          const current = JSON.parse(await readFile(path, "utf8")) as { token?: string };
          if (current.token === token) await unlink(path);
        } catch {
          // Already removed or replaced by a newer owner.
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        const current = JSON.parse(await readFile(path, "utf8")) as { pid?: number };
        if (typeof current.pid !== "number" || !processIsAlive(current.pid)) {
          await unlink(path);
          continue;
        }
      } catch (readErr) {
        if ((readErr as NodeJS.ErrnoException).code === "ENOENT") continue;
      }
      if (Date.now() >= deadline) return undefined;
      await Bun.sleep(retryMs);
    }
  }
}
