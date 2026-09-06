import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aggregateLimitResults,
  applyLastGoodCache,
  fetchLimitResults,
  pendingLimitResult,
  runBatched,
  runLimitPools,
} from "../../../src/cli/limits/collect.ts";
import { lookupCachedLimits, recordLiveLimitsResult } from "../../../src/cli/limits/limits-cache.ts";
import type { ToolLimitResult } from "../../../src/cli/limits/types.ts";
import type { Identity, ToolConfig } from "../../../src/identities/types.ts";

function identity(name: string): Identity {
  return { name, label: name, configDir: `/tmp/does-not-exist/${name}` };
}

function target(toolName: ToolConfig["toolName"], name = "acme") {
  return { toolName, identity: identity(name) };
}

function row(overrides: Partial<ToolLimitResult> & Pick<ToolLimitResult, "toolName" | "provider" | "status">): ToolLimitResult {
  return { identity: identity("acme"), windows: [], ...overrides };
}

// Every cache-touching test points the last-good store at a fresh temp file
// (the optional cachePath parameter); the real ~/.ais/cache/limits.json is
// never read or written by this suite.
let tempDir = "";
let cachePath = "";

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "ais-limits-collect-"));
  cachePath = join(tempDir, "limits.json");
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("pendingLimitResult", () => {
  test("1:1 tools seed a pending row under their known provider", () => {
    const pending = pendingLimitResult(target("claude"))!;
    expect(pending.provider).toBe("anthropic");
    expect(pending.status).toBe("pending");
  });

  test("multi-provider clients seed NOTHING — no fake 'Detecting providers'/'OpenCode' section", () => {
    // Their provider isn't known until the adapter reads the identity's own
    // auth store; a tool-shaped placeholder row renders a section named
    // after a tool, which the provider-first views rule forbids.
    expect(pendingLimitResult(target("pi"))).toBeUndefined();
    expect(pendingLimitResult(target("opencode"))).toBeUndefined();
  });
});

describe("cached-mode results", () => {
  test("1:1 tools with no stored snapshot report their honest cached-unavailable row", async () => {
    const results = await fetchLimitResults([target("claude")], true, false, undefined, cachePath);
    expect(results).toHaveLength(1);
    expect(results[0]!.provider).toBe("anthropic");
    expect(results[0]!.status).toBe("unavailable");
    expect(results[0]!.error).toContain("cached data not available");
  });

  test("multi-provider clients with no stored snapshot render nothing unscoped; an explicit --tool= still gets an honest row", async () => {
    const targets = [target("pi"), target("opencode")];
    expect(await fetchLimitResults(targets, true, false, undefined, cachePath)).toEqual([]);

    const explicit = await fetchLimitResults([targets[0]!], true, true, undefined, cachePath);
    expect(explicit).toHaveLength(1);
    expect(explicit[0]!.status).toBe("unavailable");
    expect(explicit[0]!.error).toContain("cached data not available");
  });
});

describe("aggregateLimitResults", () => {
  test("merges the same provider+identity reached through two sources into one row", async () => {
    // A Z.ai key imported into Pi is the same account the zai tool queries —
    // without merging, the provider-first report would show two acme
    // branches under Z.ai.
    const merged = aggregateLimitResults([
      row({ toolName: "zai", provider: "zai", identity: identity("acme"), status: "unavailable", error: "quota fetch failed: timeout" }),
      row({
        toolName: "pi",
        provider: "zai",
        identity: identity("acme"),
        status: "live",
        windows: [{ label: "session", category: "session", usedPercent: 10 }],
      }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.toolName).toBe("pi");
    expect(merged[0]!.status).toBe("live");
    expect(merged[0]!.windows).toHaveLength(1);
    // A live answer makes the duplicate source's failure irrelevant.
    expect(merged[0]!.error).toBeUndefined();
  });

  test("when both sources fail, their reasons merge instead of one hiding the other", () => {
    const merged = aggregateLimitResults([
      row({ toolName: "zai", provider: "zai", identity: identity("acme"), status: "unavailable", error: "quota fetch timed out" }),
      row({ toolName: "pi", provider: "zai", identity: identity("acme"), status: "unavailable", error: "quota fetch timed out" }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.error).toBe("quota fetch timed out");
  });

  test("canonical aliases collapse onto one row", () => {
    const merged = aggregateLimitResults([
      row({ toolName: "pi", provider: "kimi-coding", identity: identity("acme"), status: "unavailable", error: "x" }),
      row({ toolName: "kimi", provider: "kimi", identity: identity("acme"), status: "unavailable", error: "y" }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.provider).toBe("kimi");
    expect(merged[0]!.error).toBe("x; y");
  });

  test("a resolved result supersedes a pending placeholder for the same key", () => {
    const merged = aggregateLimitResults([
      row({ toolName: "kimi", provider: "kimi", identity: identity("acme"), status: "pending" }),
      row({ toolName: "kimi", provider: "kimi", identity: identity("acme"), status: "unavailable", error: "not authenticated" }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.status).toBe("unavailable");
  });

  test("different identities or providers stay separate, in first-appearance order", () => {
    const merged = aggregateLimitResults([
      row({ toolName: "claude", provider: "anthropic", identity: identity("acme"), status: "live", windows: [] }),
      row({ toolName: "pi", provider: "kimi", identity: identity("acme"), status: "live", windows: [] }),
      row({ toolName: "claude", provider: "anthropic", identity: identity("other"), status: "live", windows: [] }),
    ]);
    expect(merged.map((r) => `${r.provider}/${r.identity.name}`)).toEqual(["anthropic/acme", "kimi/acme", "anthropic/other"]);
  });
});

describe("runBatched", () => {
  test("resolves every item, in original order, regardless of completion order", async () => {
    const delays = [30, 10, 20];
    const results = await runBatched(delays, 3, async (ms) => {
      await Bun.sleep(ms);
      return ms;
    });
    expect(results).toEqual(delays);
  });

  test("never runs more than `limit` items concurrently", async () => {
    let active = 0;
    let maxActive = 0;
    await runBatched([1, 2, 3, 4, 5, 6], 2, async (n) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await Bun.sleep(5);
      active--;
      return n;
    });
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  test("onItemDone fires with each item's ORIGINAL index as it resolves, not worker claim order", async () => {
    // Item 0 is slower than item 1 — with limit=2 both start immediately,
    // but item 1 finishes first. onItemDone must report index 1 before
    // index 0, proving it's keyed to the original position, not call order.
    const done: Array<{ index: number; result: string }> = [];
    const results = await runBatched(
      [30, 5],
      2,
      async (ms) => {
        await Bun.sleep(ms);
        return `took-${ms}`;
      },
      (index, result) => done.push({ index, result }),
    );
    expect(results).toEqual(["took-30", "took-5"]);
    expect(done).toEqual([
      { index: 1, result: "took-5" },
      { index: 0, result: "took-30" },
    ]);
  });

  test("an empty item list resolves to an empty array without calling fn", async () => {
    let calls = 0;
    const results = await runBatched([] as number[], 4, async (n) => {
      calls++;
      return n;
    });
    expect(results).toEqual([]);
    expect(calls).toBe(0);
  });
});

describe("runLimitPools", () => {
  test("codex is capped at 2 concurrent while the rest keep the wider pool, and both pools run at once", async () => {
    const targets = [
      target("codex", "c1"),
      target("codex", "c2"),
      target("codex", "c3"),
      target("codex", "c4"),
      target("claude", "a1"),
    ];
    let codexActive = 0;
    let codexMax = 0;
    let restActive = 0;
    let restMax = 0;
    const done: number[] = [];
    await runLimitPools(
      targets,
      async (t) => {
        if (t.toolName === "codex") {
          codexActive++;
          codexMax = Math.max(codexMax, codexActive);
          await Bun.sleep(25);
          codexActive--;
        } else {
          restActive++;
          restMax = Math.max(restMax, restActive);
          await Bun.sleep(5);
          restActive--;
        }
        return [];
      },
      (i) => done.push(i),
    );
    expect(codexMax).toBeLessThanOrEqual(2);
    expect(restMax).toBeLessThanOrEqual(6);
    // The pools run CONCURRENTLY: the cheap claude fetch (5ms) lands before
    // the throttled codex queue (4 x 25ms at 2-wide) drains. If the codex
    // pool had to finish first, claude (index 4) would be done last.
    expect(done.indexOf(4)).toBeLessThan(done.indexOf(3));
  });

  test("batches land at each target's ORIGINAL index and onItemDone reports that same index", async () => {
    const targets = [target("codex", "slow"), target("claude", "fast")];
    const seen: Array<{ index: number; names: string[] }> = [];
    const batches = await runLimitPools(
      targets,
      async (t) => {
        await Bun.sleep(t.toolName === "codex" ? 20 : 1);
        return [
          row({
            toolName: t.toolName,
            provider: t.toolName === "codex" ? "openai" : "anthropic",
            status: "live",
            identity: t.identity,
          }),
        ];
      },
      (index, results) => seen.push({ index, names: results.map((r) => r.identity.name) }),
    );
    expect(batches.map((b) => b[0]!.identity.name)).toEqual(["slow", "fast"]);
    expect(seen).toEqual([
      { index: 1, names: ["fast"] },
      { index: 0, names: ["slow"] },
    ]);
  });
});

describe("applyLastGoodCache", () => {
  const live = () =>
    row({
      toolName: "codex",
      provider: "openai",
      status: "live",
      capturedAt: "2026-09-07T10:00:00.000Z",
      windows: [{ label: "week", category: "week", usedPercent: 42 }],
    });

  test("a live result is written through to the store and returned untouched", async () => {
    const result = live();
    const out = await applyLastGoodCache([result], cachePath);
    expect(out[0]).toBe(result);
    expect((await lookupCachedLimits("openai", "acme", cachePath))?.capturedAt).toBe("2026-09-07T10:00:00.000Z");
  });

  test("an unavailable result with a stored snapshot converts to cached, keeping the ORIGINAL capturedAt and the live error", async () => {
    await recordLiveLimitsResult(live(), cachePath);
    const out = await applyLastGoodCache(
      [row({ toolName: "codex", provider: "openai", status: "unavailable", error: "error sending request for url (...)" })],
      cachePath,
    );
    expect(out[0]!.status).toBe("cached");
    expect(out[0]!.capturedAt).toBe("2026-09-07T10:00:00.000Z");
    expect(out[0]!.error).toBe("error sending request for url (...)");
    expect(out[0]!.windows).toEqual([{ label: "week", category: "week", usedPercent: 42 }]);
  });

  test("an unavailable result with NO stored snapshot stays an honest error row", async () => {
    const out = await applyLastGoodCache(
      [row({ toolName: "codex", provider: "openai", status: "unavailable", error: "not authenticated" })],
      cachePath,
    );
    expect(out[0]!.status).toBe("unavailable");
    expect(out[0]!.error).toBe("not authenticated");
  });

  test("a fetcher's own cached result (e.g. grok's log-scrape) passes through without touching the store", async () => {
    const out = await applyLastGoodCache(
      [row({ toolName: "grok", provider: "xai", status: "cached", windows: [{ label: "week", category: "week", usedPercent: 1 }] })],
      cachePath,
    );
    expect(out[0]!.status).toBe("cached");
    expect(await lookupCachedLimits("xai", "acme", cachePath)).toBeUndefined();
  });
});

describe("fetchLimitResults + last-good store", () => {
  test("live mode end to end: grok's real (offline) fetcher fails and the stored snapshot answers instead", async () => {
    // target() points the identity at a nonexistent configDir, so the real
    // grok fetcher resolves to "unavailable" without any network; the seeded
    // snapshot must then take over inside fetchTarget, BEFORE aggregation.
    await recordLiveLimitsResult(
      row({
        toolName: "grok",
        provider: "xai",
        status: "live",
        capturedAt: "2026-09-07T10:00:00.000Z",
        windows: [{ label: "week", category: "week", usedPercent: 7 }],
      }),
      cachePath,
    );
    const results = await fetchLimitResults([target("grok")], false, false, undefined, cachePath);
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("cached");
    expect(results[0]!.windows).toEqual([{ label: "week", category: "week", usedPercent: 7 }]);
    expect(results[0]!.capturedAt).toBe("2026-09-07T10:00:00.000Z");
    expect(results[0]!.error).toContain("no usage log found");
  });

  test("--cached reads the store instead of fetching: a hit becomes a cached row with no error", async () => {
    await recordLiveLimitsResult(
      row({
        toolName: "claude",
        provider: "anthropic",
        status: "live",
        capturedAt: "2026-09-07T10:00:00.000Z",
        windows: [{ label: "session (5h)", category: "session", usedPercent: 25 }],
      }),
      cachePath,
    );
    const results = await fetchLimitResults([target("claude")], true, false, undefined, cachePath);
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("cached");
    expect(results[0]!.error).toBeUndefined();
    expect(results[0]!.capturedAt).toBe("2026-09-07T10:00:00.000Z");
    expect(results[0]!.windows).toHaveLength(1);
  });

  test("--cached for a multi-provider client returns one cached row per provider the store holds for that identity", async () => {
    await recordLiveLimitsResult(
      row({ toolName: "pi", provider: "kimi", status: "live", windows: [{ label: "session", category: "session", usedPercent: 10 }] }),
      cachePath,
    );
    await recordLiveLimitsResult(
      row({ toolName: "pi", provider: "zai", status: "live", windows: [{ label: "session", category: "session", usedPercent: 20 }] }),
      cachePath,
    );
    const results = await fetchLimitResults([target("pi")], true, false, undefined, cachePath);
    expect(results.map((r) => r.provider).sort()).toEqual(["kimi", "zai"]);
    expect(results.every((r) => r.status === "cached")).toBe(true);
  });
});
