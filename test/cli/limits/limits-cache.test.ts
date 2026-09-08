import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cachedLimitsForIdentity,
  cachedLimitsFromRecord,
  limitsCacheKey,
  lookupCachedLimits,
  recordLiveLimitsResult,
  type CachedLimitsRecord,
} from "../../../src/cli/limits/limits-cache.ts";
import type { ToolLimitResult } from "../../../src/cli/limits/types.ts";
import type { Identity } from "../../../src/identities/types.ts";

// Every test points the store at a fresh temp file; the real
// ~/.ais/cache/limits.json is never touched.
let dir = "";
let cachePath = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ais-limits-cache-"));
  cachePath = join(dir, "limits.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function identity(name: string): Identity {
  return { name, label: name, configDir: `/tmp/does-not-exist/${name}` };
}

function liveResult(overrides: Partial<ToolLimitResult> = {}): ToolLimitResult {
  return {
    toolName: "codex",
    provider: "openai",
    identity: identity("acme"),
    status: "live",
    capturedAt: "2026-09-07T10:00:00.000Z",
    windows: [{ label: "week", category: "week", usedPercent: 42, resetsAt: "Sep 11 8am" }],
    ...overrides,
  };
}

describe("recordLiveLimitsResult + lookupCachedLimits", () => {
  test("round-trips a live result through the store, atomically and mode 0600", async () => {
    await recordLiveLimitsResult(liveResult(), cachePath);

    const record = await lookupCachedLimits("openai", "acme", cachePath);
    expect(record).toEqual({
      provider: "openai",
      toolName: "codex",
      identityName: "acme",
      windows: [{ label: "week", category: "week", usedPercent: 42, resetsAt: "Sep 11 8am" }],
      capturedAt: "2026-09-07T10:00:00.000Z",
    });
    // Atomic write convention: real file at the final path, no temp left
    // behind, mode 0600 (same store convention as kimi-store.ts).
    expect((await stat(cachePath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(cachePath, "utf8"))["openai:acme"].provider).toBe("openai");
  });

  test("preserves overage and manualReset when the live result carries them", async () => {
    await recordLiveLimitsResult(
      liveResult({
        overage: { active: false, label: "spend control reached" },
        manualReset: { availableCount: 1, label: "Full reset (Weekly + 5 hr)" },
      }),
      cachePath,
    );
    const record = await lookupCachedLimits("openai", "acme", cachePath);
    expect(record?.overage).toEqual({ active: false, label: "spend control reached" });
    expect(record?.manualReset).toEqual({ availableCount: 1, label: "Full reset (Weekly + 5 hr)" });
  });

  test("a second write for another provider+identity keeps the first record", async () => {
    await recordLiveLimitsResult(liveResult(), cachePath);
    await recordLiveLimitsResult(
      liveResult({ toolName: "kimi", provider: "kimi", identity: identity("other") }),
      cachePath,
    );
    expect(await lookupCachedLimits("openai", "acme", cachePath)).toBeDefined();
    expect(await lookupCachedLimits("kimi", "other", cachePath)).toBeDefined();
  });

  test("a newer live result for the same key replaces the older snapshot", async () => {
    await recordLiveLimitsResult(liveResult(), cachePath);
    await recordLiveLimitsResult(
      liveResult({ capturedAt: "2026-09-07T11:00:00.000Z", windows: [{ label: "week", category: "week", usedPercent: 55 }] }),
      cachePath,
    );
    const record = await lookupCachedLimits("openai", "acme", cachePath);
    expect(record?.capturedAt).toBe("2026-09-07T11:00:00.000Z");
    expect(record?.windows[0]!.usedPercent).toBe(55);
  });

  test("non-live results are never recorded: a failure must not overwrite the last good data", async () => {
    await recordLiveLimitsResult(liveResult(), cachePath);
    await recordLiveLimitsResult(
      liveResult({ status: "unavailable", windows: [], error: "error sending request", capturedAt: "2026-09-07T12:00:00.000Z" }),
      cachePath,
    );
    expect((await lookupCachedLimits("openai", "acme", cachePath))?.capturedAt).toBe("2026-09-07T10:00:00.000Z");
  });

  test("provider aliases canonicalise to one key on BOTH write and lookup", async () => {
    // pi reports Kimi as "kimi-coding"; the native kimi tool looks up "kimi".
    await recordLiveLimitsResult(liveResult({ toolName: "pi", provider: "kimi-coding" }), cachePath);
    expect(limitsCacheKey("kimi-coding", "acme")).toBe(limitsCacheKey("kimi", "acme"));
    expect((await lookupCachedLimits("kimi", "acme", cachePath))?.toolName).toBe("pi");
  });
});

describe("read-side corruption tolerance", () => {
  test("a missing file reads as no snapshots", async () => {
    expect(await lookupCachedLimits("openai", "acme", join(dir, "nope.json"))).toBeUndefined();
  });

  test("unparseable JSON reads as no snapshots rather than throwing", async () => {
    await writeFile(cachePath, "{not json");
    expect(await lookupCachedLimits("openai", "acme", cachePath)).toBeUndefined();
    expect(await cachedLimitsForIdentity("acme", cachePath)).toEqual([]);
  });

  test("a valid JSON file of the wrong shape reads as no snapshots", async () => {
    await writeFile(cachePath, JSON.stringify(["openai:acme"]));
    expect(await lookupCachedLimits("openai", "acme", cachePath)).toBeUndefined();
  });

  test("one malformed entry does not poison the rest of the store", async () => {
    await recordLiveLimitsResult(liveResult(), cachePath);
    const store = JSON.parse(await readFile(cachePath, "utf8"));
    store["broken:entry"] = { provider: 42 };
    await writeFile(cachePath, JSON.stringify(store));
    expect(await lookupCachedLimits("openai", "acme", cachePath)).toBeDefined();
    expect(await lookupCachedLimits("broken", "entry", cachePath)).toBeUndefined();
  });
});

describe("cachedLimitsFromRecord (live -> cached fallback conversion)", () => {
  const record: CachedLimitsRecord = {
    provider: "openai",
    toolName: "codex",
    identityName: "acme",
    windows: [{ label: "week", category: "week", usedPercent: 42 }],
    capturedAt: "2026-09-07T10:00:00.000Z",
    manualReset: { availableCount: 1, label: "Full reset (Weekly + 5 hr)" },
  };

  test("builds a cached result with the ORIGINAL capturedAt and the live fetch's error preserved", () => {
    const result = cachedLimitsFromRecord(record, identity("acme"), "error sending request for url (...)");
    expect(result.status).toBe("cached");
    expect(result.capturedAt).toBe("2026-09-07T10:00:00.000Z");
    expect(result.error).toBe("error sending request for url (...)");
    expect(result.windows).toEqual(record.windows);
    expect(result.manualReset).toEqual(record.manualReset);
    // The target's own identity object (label/aliases) applies, not just the name.
    expect(result.identity.label).toBe("acme");
  });

  test("a pure --cached conversion carries no error", () => {
    expect(cachedLimitsFromRecord(record, identity("acme")).error).toBeUndefined();
  });
});

describe("cachedLimitsForIdentity (identity-wide lookup for the multi-provider clients)", () => {
  test("returns every provider recorded for the identity, whichever tool recorded it", async () => {
    await recordLiveLimitsResult(liveResult(), cachePath);
    await recordLiveLimitsResult(liveResult({ toolName: "pi", provider: "kimi" }), cachePath);
    await recordLiveLimitsResult(liveResult({ toolName: "zai", provider: "zai", identity: identity("other") }), cachePath);

    const records = await cachedLimitsForIdentity("acme", cachePath);
    expect(records.map((r) => r.provider).sort()).toEqual(["kimi", "openai"]);
    // ...and does not leak another identity's snapshots.
    expect(records.every((r) => r.identityName === "acme")).toBe(true);
  });
});
