import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import { aisCacheDir } from "../shared/ais-home.ts";
import type { AccountSpendState } from "./state.ts";

/**
 * The spend guard's derived-state cache: the last computed per-account state,
 * written by the daemon's periodic cycle and by the internal refresh command
 * the launch gate spawns. The gate is a pure READER — it enforces on
 * last-known state and never recomputes synchronously when a cached answer
 * exists, which is what keeps a fresh-cache launch under 50ms of added work.
 * The file is always safe to delete: the next cycle or refresh rebuilds it.
 */

export interface SpendKillRecord {
  pid: number;
  tool: string;
  identity: string;
  accountId: string;
  command: string;
  /** Signal that actually terminated the process ("SIGTERM" within grace,
   * else "SIGKILL"). */
  signal: "SIGTERM" | "SIGKILL" | "ALREADY-GONE";
  reason: string;
  at: string;
}

export interface SpendGuardCache {
  version: 1;
  updatedAt: string;
  accounts: Record<string, AccountSpendState>;
  recentKills: SpendKillRecord[];
}

export const SPEND_GUARD_CACHE_MAX_KILLS = 20;

export function spendGuardCachePath(home: string = homedir()): string {
  return join(aisCacheDir(home), "spend-guard.json");
}

/** Tolerant loader: a missing, corrupt, or wrong-version file is simply no
 * cache (the gate then treats the account as unmonitored this launch and
 * queues a refresh; it never crashes a launch over its own bookkeeping).
 * Exported for tests. */
export function parseSpendGuardCache(text: string): SpendGuardCache | undefined {
  try {
    const parsed = JSON.parse(text) as Partial<SpendGuardCache>;
    if (parsed.version !== 1 || typeof parsed !== "object" || parsed === null) return undefined;
    return {
      version: 1,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
      accounts: (parsed.accounts ?? {}) as Record<string, AccountSpendState>,
      recentKills: Array.isArray(parsed.recentKills) ? parsed.recentKills : [],
    };
  } catch {
    return undefined;
  }
}

export async function loadSpendGuardCache(path: string = spendGuardCachePath()): Promise<SpendGuardCache | undefined> {
  try {
    return parseSpendGuardCache(await Bun.file(path).text());
  } catch {
    return undefined;
  }
}

export async function writeSpendGuardCache(cache: SpendGuardCache, path: string = spendGuardCachePath()): Promise<void> {
  // The file's own directory is created on demand (default layout: the
  // ~/.ais/cache dir), so an injected path from tests or future callers
  // never depends on a pre-made tree.
  await mkdir(dirname(path), { recursive: true });
  const trimmed: SpendGuardCache = {
    ...cache,
    recentKills: cache.recentKills.slice(-SPEND_GUARD_CACHE_MAX_KILLS),
  };
  await Bun.write(path, `${JSON.stringify(trimmed, null, 2)}\n`);
}

/** Cache age in seconds, or undefined when the cache carries no usable
 * timestamp. Exported pure for tests. */
export function cacheAgeS(cache: SpendGuardCache | undefined, now: Date): number | undefined {
  if (!cache) return undefined;
  const ms = Date.parse(cache.updatedAt);
  if (!Number.isFinite(ms)) return undefined;
  return Math.max(0, (now.getTime() - ms) / 1000);
}

/** A cache older than the guard's own interval is "stale": still enforced
 * on (last-known state is the contract), but a background refresh is
 * queued. Exported pure for tests. */
export function isCacheFresh(cache: SpendGuardCache | undefined, now: Date, intervalS: number): boolean {
  const age = cacheAgeS(cache, now);
  return age !== undefined && age <= intervalS;
}
