import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  /** True once a fetch has succeeded; `value` is meaningless before that. */
  hasValue?: boolean;
  lastError?: string;
  lastErrorAt?: number;
}

export interface SwrResult<T> {
  value: T;
  cached: boolean;
  /** True when the value is older than its max age and a background refresh was started or is running. */
  stale: boolean;
  /** Message of the most recent failed refresh, while the last-good value is still being served. */
  lastError?: string;
  lastErrorAt?: number;
}

export function flagsFor(tool: string | undefined, identity: string | undefined): ParsedArgs["flags"] {
  return {
    ...(tool !== undefined ? { tool } : {}),
    ...(identity !== undefined ? { identity } : {}),
  };
}

export interface SwrOptions<T> {
  /** First-ever request only (no memory or disk value): answer `pending()` immediately; the fetch keeps running. */
  pending?: () => Promise<T>;
}

export class PollCache {
  private readonly entries = new Map<string, CacheEntry<unknown>>();

  /** `persistDir`: getSwr last-good values are written there (one 0600 JSON per hashed key) and reloaded after a restart. */
  constructor(private readonly ttlMs: number, private readonly persistDir?: string) {}

  private warned = false;

  private fileFor(key: string): string {
    return join(this.persistDir!, `${new Bun.CryptoHasher("sha256").update(key).digest("hex")}.json`);
  }

  private load<T>(key: string): CacheEntry<T> | undefined {
    if (!this.persistDir) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(this.fileFor(key), "utf8")) as { key?: unknown; at?: unknown; value?: T };
      if (parsed.key !== key || typeof parsed.at !== "number" || parsed.value === undefined) return undefined;
      const entry: CacheEntry<T> = { at: parsed.at, value: parsed.value, hasValue: true };
      this.entries.set(key, entry);
      return entry;
    } catch {
      return undefined; // missing or corrupt: behave as a cold cache
    }
  }

  private save(key: string, entry: CacheEntry<unknown>): void {
    if (!this.persistDir) return;
    const tmp = `${this.fileFor(key)}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      mkdirSync(this.persistDir, { recursive: true, mode: 0o700 });
      const file = this.fileFor(key);
      writeFileSync(tmp, JSON.stringify({ key, at: entry.at, value: entry.value }), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, file);
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {
        // no temp file left
      }
      if (!this.warned) {
        this.warned = true;
        console.warn(`[ais] cache persist failed (${this.persistDir}): ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  async get<T>(key: string, fetcher: () => Promise<T>, maxAgeMs = this.ttlMs): Promise<{ value: T; cached: boolean }> {
    const existing = this.entries.get(key) as CacheEntry<T> | undefined;
    const fresh = existing && Date.now() - existing.at < maxAgeMs;
    if (fresh && existing) return { value: existing.value, cached: true };
    if (existing?.inflight) return { value: await existing.inflight, cached: false };
    const entry: CacheEntry<T> = existing ?? { at: 0, value: undefined as T };
    entry.inflight = fetcher()
      .then((value) => {
        entry.value = value;
        entry.hasValue = true;
        entry.at = Date.now();
        return value;
      })
      .finally(() => {
        entry.inflight = undefined;
      });
    this.entries.set(key, entry);
    return { value: await entry.inflight, cached: false };
  }

  /** Stale-while-revalidate read. With a last-good value this NEVER waits
   * and never fails: a value older than `maxAgeMs` is returned immediately
   * (`stale: true`) while ONE background refresh runs (deduplicated through
   * the shared inflight promise). A failed refresh keeps the last-good value
   * and records `lastError`/`lastErrorAt` until a refresh succeeds. The
   * first-ever request (no value yet) waits for the fetch (or gets
   * `opts.pending()` straight away); a failed cold fetch is rethrown to the
   * next request, which then retries. */
  async getSwr<T>(key: string, fetcher: () => Promise<T>, maxAgeMs = this.ttlMs, opts: SwrOptions<T> = {}): Promise<SwrResult<T>> {
    let existing = this.entries.get(key) as CacheEntry<T> | undefined;
    if (!existing?.hasValue && !existing?.inflight) existing = this.load<T>(key) ?? existing;
    if (!existing?.hasValue) {
      if (existing && !existing.inflight && existing.lastError !== undefined) {
        // The cold scan failed: surface the error once (later request retries; never loop).
        const message = existing.lastError;
        existing.lastError = undefined;
        existing.lastErrorAt = undefined;
        throw new Error(message);
      }
      let entry = existing;
      if (!entry?.inflight) {
        entry = existing ?? { at: 0, value: undefined as T };
        this.entries.set(key, entry);
        this.refresh(key, entry, fetcher).catch(() => undefined);
      }
      const inflight = entry.inflight!;
      if (!opts.pending) return { value: await inflight, cached: false, stale: false };
      return { value: await opts.pending(), cached: false, stale: true };
    }
    const errorInfo = existing.lastError !== undefined ? { lastError: existing.lastError, lastErrorAt: existing.lastErrorAt } : {};
    if (Date.now() - existing.at < maxAgeMs) {
      return { value: existing.value, cached: true, stale: false, ...errorInfo };
    }
    if (!existing.inflight) {
      this.refresh(key, existing, fetcher).catch(() => undefined);
    }
    return { value: existing.value, cached: true, stale: true, ...errorInfo };
  }

  private refresh<T>(key: string, entry: CacheEntry<T>, fetcher: () => Promise<T>): Promise<T> {
    entry.inflight = fetcher()
      .then((value) => {
        entry.value = value;
        entry.hasValue = true;
        entry.at = Date.now();
        entry.lastError = undefined;
        entry.lastErrorAt = undefined;
        this.save(key, entry);
        return value;
      })
      .catch((error: unknown) => {
        entry.lastError = error instanceof Error ? error.message : String(error);
        entry.lastErrorAt = Date.now();
        throw error;
      })
      .finally(() => {
        entry.inflight = undefined;
      });
    return entry.inflight;
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
