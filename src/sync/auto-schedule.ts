import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { aisRemoteCacheDir } from "../shared/ais-home.ts";
import { acquirePidLock } from "../shared/pid-lock.ts";
import type { SyncDirection, SyncRunOptions } from "./types.ts";

export const DEFAULT_MIN_INTERVAL_MINUTES = 10;

export interface AutoScheduleDeps {
  /** Directory holding the stamp, pending and lock files. */
  dir?: string;
  minIntervalMinutes?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  run?: (options: SyncRunOptions) => Promise<{ skipped: boolean } | undefined>;
}

interface PendingRequest {
  databases: boolean;
  direction: SyncDirection;
}

function union(a: SyncDirection, b: SyncDirection): SyncDirection {
  return a === b ? a : "both";
}

async function readStamp(path: string): Promise<number | undefined> {
  try {
    const value = Number((await readFile(path, "utf8")).trim());
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Queue one request as its own file: written under a temp name, then renamed
 * into place, so a reader never sees a torn entry and no request is lost. */
async function enqueue(dir: string, entry: PendingRequest): Promise<void> {
  await mkdir(dir, { recursive: true });
  const name = crypto.randomUUID();
  await writeFile(join(dir, `.${name}.tmp`), JSON.stringify(entry));
  await rename(join(dir, `.${name}.tmp`), join(dir, `${name}.json`));
}

async function pendingNames(dir: string): Promise<string[]> {
  return (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".json") && !n.startsWith("."));
}

/** Fold the queued requests into one, unlinking only the files that were read. */
async function takePending(dir: string): Promise<PendingRequest | undefined> {
  let taken: PendingRequest | undefined;
  for (const name of await pendingNames(dir)) {
    try {
      const req = JSON.parse(await readFile(join(dir, name), "utf8")) as PendingRequest;
      taken = taken ? { databases: taken.databases || req.databases, direction: union(taken.direction, req.direction) } : req;
    } catch {
      // Unreadable entry: drop it; the next automatic run reconciles anyway.
    }
    await rm(join(dir, name), { force: true });
  }
  return taken;
}

async function hasPending(dir: string): Promise<boolean> {
  return (await pendingNames(dir)).length > 0;
}

/**
 * Rate-limit automatic reconciliation. A request outside the interval runs at
 * once with its own scope. One inside it is queued (append-only, so concurrent
 * requests never lose each other) and a single lock holder sleeps until the
 * interval is due, then runs ONE scope-`all` reconciliation for the union.
 * Other callers return immediately.
 */
export async function scheduleAutomaticSync(request: SyncRunOptions, deps: AutoScheduleDeps = {}): Promise<void> {
  const intervalMs = (deps.minIntervalMinutes ?? DEFAULT_MIN_INTERVAL_MINUTES) * 60_000;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const run = deps.run!;
  const dir = deps.dir ?? aisRemoteCacheDir(homedir());
  const stampPath = join(dir, "last-auto-sync");
  const pendingDir = join(dir, "sync-pending");
  const lockPath = join(dir, "sync-pending.lock");

  await mkdir(dir, { recursive: true });
  const last = intervalMs > 0 ? await readStamp(stampPath) : undefined;
  // A stamp in the future (clock change) counts as stale.
  const due = last === undefined || last > now() || now() - last >= intervalMs;
  if (due) {
    await Bun.write(stampPath, String(now()));
    // Skipped because another sync held the lock: queue it like a coalesced run.
    if (!(await run(request))?.skipped) return;
  }

  const entry: PendingRequest = {
    databases: request.includeDatabases !== false,
    direction: request.direction ?? "both",
  };
  await enqueue(pendingDir, entry);

  // Re-check after releasing: a request queued between our last take and the
  // release would otherwise have no holder.
  do {
    const release = await acquirePidLock(lockPath, { waitMs: 0, retryMs: 100 });
    if (!release) return;
    try {
      while (await hasPending(pendingDir)) {
        for (;;) {
          const wait = ((await readStamp(stampPath)) ?? 0) + intervalMs - now();
          if (wait <= 0) break;
          await sleep(wait);
        }
        const pending = await takePending(pendingDir);
        if (!pending) continue;
        await Bun.write(stampPath, String(now()));
        const result = await run({
          direction: pending.direction,
          scope: { kind: "all" },
          includeDatabases: pending.databases,
          waitForLock: false,
        });
        // Skipped because another sync held the lock: retry after the next interval.
        if (result?.skipped) await enqueue(pendingDir, pending);
      }
    } finally {
      await release();
    }
  } while (await hasPending(pendingDir));
}
