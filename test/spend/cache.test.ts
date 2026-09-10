import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cacheAgeS,
  isCacheFresh,
  loadSpendGuardCache,
  parseSpendGuardCache,
  spendGuardCachePath,
  writeSpendGuardCache,
  type SpendGuardCache,
} from "../../src/spend/cache.ts";
import type { AccountSpendState } from "../../src/spend/state.ts";

function state(overrides: Partial<AccountSpendState> = {}): AccountSpendState {
  return {
    accountId: "123456789012",
    profile: "acme-prod",
    localEstimateUsd: 100,
    effectiveUsd: 100,
    breached: false,
    enforced: true,
    degraded: false,
    identities: ["acme-bedrock"],
    computedAt: "2026-09-10T10:00:00.000Z",
    ...overrides,
  };
}

function cache(overrides: Partial<SpendGuardCache> = {}): SpendGuardCache {
  return {
    version: 1,
    updatedAt: "2026-09-10T10:00:00.000Z",
    accounts: { "123456789012": state() },
    recentKills: [],
    ...overrides,
  };
}

describe("parseSpendGuardCache", () => {
  test("accepts a well-formed v1 cache", () => {
    const parsed = parseSpendGuardCache(JSON.stringify(cache()));
    expect(parsed?.accounts["123456789012"]?.profile).toBe("acme-prod");
  });

  test("tolerates corrupt JSON, wrong versions, and missing fields (no cache, not a crash)", () => {
    expect(parseSpendGuardCache("not json at all{")).toBeUndefined();
    expect(parseSpendGuardCache(JSON.stringify({ version: 2, accounts: {} }))).toBeUndefined();
    const holey = parseSpendGuardCache(JSON.stringify({ version: 1 }));
    expect(holey?.accounts).toEqual({});
    expect(holey?.recentKills).toEqual([]);
  });
});

describe("cache round-trip", () => {
  test("write then load returns the same states and trims the kill ring", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ais-spend-cache-"));
    try {
      const path = join(dir, "spend-guard.json");
      const kills = Array.from({ length: 30 }, (_, i) => ({
        pid: i,
        tool: "codex",
        identity: "guarded",
        accountId: "123456789012",
        command: `codex ${i}`,
        signal: "SIGTERM" as const,
        reason: "test",
        at: "2026-09-10T10:00:00.000Z",
      }));
      await writeSpendGuardCache(cache({ recentKills: kills }), path);
      const loaded = await loadSpendGuardCache(path);
      expect(loaded?.accounts["123456789012"]).toEqual(state());
      expect(loaded?.recentKills.length).toBe(20); // ring trimmed to the last 20
      expect(loaded?.recentKills[0]?.pid).toBe(10);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing file is no cache", async () => {
    expect(await loadSpendGuardCache("/nonexistent/spend-guard.json")).toBeUndefined();
  });
});

describe("cache freshness", () => {
  const NOW = new Date("2026-09-10T10:05:00.000Z");

  test("age derives from updatedAt", () => {
    expect(cacheAgeS(cache(), NOW)).toBe(300);
    expect(cacheAgeS(undefined, NOW)).toBeUndefined();
    expect(cacheAgeS(cache({ updatedAt: "garbage" }), NOW)).toBeUndefined();
  });

  test("fresh means age within the interval; stale or absent queues a refresh", () => {
    expect(isCacheFresh(cache(), NOW, 300)).toBe(true);
    expect(isCacheFresh(cache(), NOW, 299)).toBe(false);
    expect(isCacheFresh(undefined, NOW, 300)).toBe(false);
    expect(isCacheFresh(cache({ updatedAt: new Date(0).toISOString() }), NOW, 300)).toBe(false);
  });
});

describe("spendGuardCachePath", () => {
  test("lives under ~/.ais/cache per the ais-home conventions", () => {
    expect(spendGuardCachePath("/home/x")).toBe("/home/x/.ais/cache/spend-guard.json");
  });

  test("the written file is human-readable JSON on disk, parent dir created on demand", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ais-spend-cache2-"));
    try {
      const path = join(dir, "c.json");
      await writeSpendGuardCache(cache(), path);
      expect(readFileSync(path, "utf8")).toContain("\"version\": 1");
      const nested = join(dir, "sub", "c.json");
      await writeSpendGuardCache(cache(), nested);
      expect(readFileSync(nested, "utf8")).toContain("acme-prod");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
