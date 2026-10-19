import { link, mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Exclusive pid+token lock file (published via `link()`). A lock whose recorded
 * pid is dead (or unreadable as a pid) is taken over via a single-winner claim. Returns a release
 * function, or undefined when the lock is still held after `waitMs`
 * (0 = try once). Release only removes the file if it still carries our token. */
export async function acquirePidLock(
  path: string,
  { waitMs, retryMs }: { waitMs: number; retryMs: number },
): Promise<(() => Promise<void>) | undefined> {
  await mkdir(dirname(path), { recursive: true });
  const token = `${process.pid}:${crypto.randomUUID()}`;
  const deadline = Date.now() + waitMs;

  const body = `${JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() })}\n`;
  const tmp = `${path}.${token.replace(":", "-")}.tmp`;
  const isStale = (raw: string): boolean => {
    try {
      const pid = (JSON.parse(raw) as { pid?: unknown }).pid;
      return typeof pid !== "number" || !processIsAlive(pid);
    } catch {
      return true;
    }
  };

  // Best effort: reap temp files left by crashed acquirers (pid in the name is dead).
  const tmpName = new RegExp(`^${basename(path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(\\d+)-[0-9a-f-]+\\.tmp$`);
  for (const name of await readdir(dirname(path)).catch(() => [] as string[])) {
    const m = tmpName.exec(name);
    if (m && !processIsAlive(Number(m[1]))) await unlink(join(dirname(path), name)).catch(() => {});
  }

  for (;;) {
    // link() publishes a complete file atomically and fails with EEXIST if the lock exists.
    await writeFile(tmp, body, { mode: 0o600 });
    try {
      await link(tmp, path);
      await unlink(tmp);
      return async () => {
        try {
          const current = JSON.parse(await readFile(path, "utf8")) as { token?: string };
          if (current.token === token) await unlink(path);
        } catch {
          // Already removed or replaced by a newer owner.
        }
      };
    } catch (err) {
      await unlink(tmp).catch(() => {});
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    let seen: string;
    try {
      seen = await readFile(path, "utf8");
    } catch (readErr) {
      if ((readErr as NodeJS.ErrnoException).code === "ENOENT") continue; // Vanished between link and read.
      if (Date.now() >= deadline) return undefined; // Unreadable (e.g. root-owned): honour waitMs.
      await Bun.sleep(retryMs);
      continue;
    }
    if (isStale(seen)) {
      // Claim this exact stale content by linking our own file to a name derived from it: only one
      // claimant succeeds. Only the claimant ever removes that stale file, and a fresh lock can only
      // appear after it is gone, so the unlink below can never hit someone else's new lock.
      const claim = `${path}.claim-${new Bun.CryptoHasher("sha1").update(seen).digest("hex")}`;
      let won = false;
      try {
        await writeFile(tmp, body, { mode: 0o600 });
        await link(tmp, claim);
        won = true;
        try {
          if ((await readFile(path, "utf8")) === seen) await unlink(path);
        } finally {
          await unlink(claim);
        }
      } catch (claimErr) {
        if ((claimErr as NodeJS.ErrnoException).code === "EEXIST") {
          // shortcut: a claimant that crashed between claim and unlink leaves its claim behind;
          // reap it when its pid is dead. That reap is itself a check-then-delete, but only
          // reachable after a crash inside a few microseconds. Upgrade to flock if that matters.
          try {
            if (isStale(await readFile(claim, "utf8"))) await unlink(claim);
          } catch {}
        }
      } finally {
        await unlink(tmp).catch(() => {});
      }
      if (won) continue;
    }
    if (Date.now() >= deadline) return undefined;
    await Bun.sleep(retryMs);
  }
}
