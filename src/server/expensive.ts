import { runLimitsQuery } from "../cli/limits/collect.ts";
import { runUsageQuery, usageResultsForJson } from "../cli/usage/run.ts";
import type { ParsedArgs } from "../cli/args.ts";
import type { LimitsEnvelope, UsageEnvelope } from "./types.ts";

/** Server-side cache for the two expensive endpoints. Both hit live provider
 * APIs (or scan multi-GB local stores), and BOTH frontends poll on an
 * interval, so identical concurrent requests must share one in-flight fetch
 * and repeated requests inside the TTL must not re-fetch at all. */

interface CacheEntry<T> {
  at: number;
  value: T;
  inflight?: Promise<T>;
}

export function flagsFor(tool: string | undefined, identity: string | undefined): ParsedArgs["flags"] {
  return {
    ...(tool !== undefined ? { tool } : {}),
    ...(identity !== undefined ? { identity } : {}),
  };
}

/** Hard ceiling for handlers that touch live provider APIs or scan many
 * local stores. Without it a single wedged fetch (hung network mount,
 * stalled upstream) holds client connections open forever and, from the
 * frontends' point of view, looks like the whole console being down. */
export async function withTimeout<T>(ms: number, label: string, fn: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HttpError(504, `${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class PollCache {
  private readonly entries = new Map<string, CacheEntry<unknown>>();

  constructor(private readonly ttlMs: number) {}

  async get<T>(key: string, fetcher: () => Promise<T>, maxAgeMs = this.ttlMs): Promise<{ value: T; cached: boolean }> {
    const existing = this.entries.get(key) as CacheEntry<T> | undefined;
    const fresh = existing && Date.now() - existing.at < maxAgeMs;
    if (fresh && existing) return { value: existing.value, cached: true };
    if (existing?.inflight) return { value: await existing.inflight, cached: false };
    const entry: CacheEntry<T> = existing ?? { at: 0, value: undefined as T };
    entry.inflight = fetcher()
      .then((value) => {
        entry.value = value;
        entry.at = Date.now();
        return value;
      })
      .finally(() => {
        entry.inflight = undefined;
      });
    this.entries.set(key, entry);
    return { value: await entry.inflight, cached: false };
  }

  clear(): void {
    this.entries.clear();
  }
}

const LIMITS_TTL_MS = 45_000;

export async function limitsEnvelope(
  cache: PollCache,
  tool: string | undefined,
  identity: string | undefined,
  maxAgeS: number,
): Promise<LimitsEnvelope> {
  const key = `limits:${tool ?? "*"}:${identity ?? "*"}`;
  const { value, cached } = await cache.get(key, () => runLimitsQuery(identity, flagsFor(tool, identity), false), Math.max(5, maxAgeS) * 1000);
  return { results: value as unknown[], cached, fetchedAt: new Date().toISOString() };
}

const USAGE_TTL_MS = 45_000;

export async function usageEnvelope(cache: PollCache, tool: string | undefined, identity: string | undefined): Promise<UsageEnvelope> {
  const key = `usage:${tool ?? "*"}:${identity ?? "*"}`;
  const { value } = await cache.get(key, () => runUsageQuery(flagsFor(tool, identity)), USAGE_TTL_MS);
  return { results: usageResultsForJson(value as never[]), generatedAt: new Date().toISOString() };
}
