import { runLimitsQuery } from "../cli/limits/collect.ts";
import { runUsageQuery, usageResultsForJson } from "../cli/usage/run.ts";
import { runBreakdownQuery, type BreakdownDeps, type BreakdownResult } from "../cli/usage/breakdown.ts";
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

/** Breakdown scans stream raw JSONL, so they cache a little longer than the
 * live-API envelopes; still short enough that the view's own slow poll sees
 * fresh-ish data after a session ends. */
const BREAKDOWN_TTL_MS = 60_000;

export interface BreakdownEnvelope {
  results: BreakdownResult[];
  generatedAt: string;
}

export async function breakdownEnvelope(
  cache: PollCache,
  tool: string | undefined,
  identity: string | undefined,
  days: number,
  deps: BreakdownDeps = {},
): Promise<BreakdownEnvelope> {
  const key = `breakdown:${tool ?? "*"}:${identity ?? "*"}:${days}`;
  const { value } = await cache.get(key, () => runBreakdownQuery({ ...(tool ? { tool } : {}), ...(identity ? { identity } : {}), days }, deps), BREAKDOWN_TTL_MS);
  return { results: value, generatedAt: new Date().toISOString() };
}
