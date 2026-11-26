import { afterEach, describe, expect, test } from "bun:test";
import type { PoolUsage } from "../../src/identities/pool/adapter.ts";
import { pickIdentity } from "../../src/gateway/select.ts";
import { createCodexResetSource, fetchCodexResetCredits, createUsageSource as createUsageSourceRaw, fetchOpencodeUsage, withOpencodeUsage, zaiTokenUsage } from "../../src/gateway/usage-source.ts";
import { MemoryUsageReadings, type UsageReadings } from "../../src/gateway/usage-readings.ts";
import { MemoryResetCreditInvalidations } from "../../src/gateway/reset-credit-cache.ts";

/** The source with a silent log by default, so the tests print no `usage-read` lines. A test that reads the log passes its own. */
const createUsageSource = (o: Parameters<typeof createUsageSourceRaw>[0]): ReturnType<typeof createUsageSourceRaw> => createUsageSourceRaw({ log: () => {}, ...o });
import type { GatewayApp } from "../../src/gateway/types.ts";

const live = (u: number): PoolUsage => ({ status: "live", maxUtilization: u, capturedAt: "2026-11-02T00:00:00.000Z" });
const app: GatewayApp = {
  name: "a", owner: "o", namespace: "n", provider: "claude", style: "anthropic",
  target: { kind: "pin", identity: "id1" }, reservePercent: 80, state: "active", createdAt: "2026-11-01T00:00:00.000Z",
};

describe("fresh usage refresh ordering", () => {
  test("a reset reconciliation starts a read after an older fresh read finishes", async () => {
    let release!: () => void;
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => { started = resolve; });
    const releaseFirst = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const source = createUsageSource({
      fetchUsage: async (_provider, _identity, opts) => {
        calls++;
        if (calls === 1) {
          started();
          await releaseFirst;
          return { status: "live", windows: [{ label: "~7d", utilization: 100 }], capturedAt: "2026-11-26T10:00:00.000Z" };
        }
        expect(opts?.fresh).toBe(true);
        return { status: "live", windows: [{ label: "~7d", utilization: 0 }], capturedAt: "2026-11-26T10:00:01.000Z" };
      },
    });
    const older = source.refreshNow("codex", "codex-SYNTHETIC_FIXTURE");
    await firstStarted;
    const reconciliation = source.refreshNowAfterInflight("codex", "codex-SYNTHETIC_FIXTURE");
    release();
    await Promise.all([older, reconciliation]);
    expect(calls).toBe(2);
    expect(await source.get("codex", "codex-SYNTHETIC_FIXTURE")).toMatchObject({ windows: [{ utilization: 0 }] });
  });
});

describe("zai token usage", () => {
  test("the web tools window does not count, so pickIdentity does not refuse", async () => {
    const u = zaiTokenUsage({ tool: "zai", status: "ok", windows: [
      { label: "session", category: "session", usedPercent: 10 },
      { label: "week", category: "week", usedPercent: 10 },
      { label: "web tools", category: "other", usedPercent: 100 },
    ] } as never);
    expect(u.maxUtilization).toBe(10);
    const zapp: GatewayApp = { ...app, provider: "zai" };
    expect(await pickIdentity(zapp, { usageFor: async () => u, poolMembers: async () => ["id1"] })).toEqual({ identity: "id1" });
  });
});

describe("Codex reset source", () => {
  test("uses account-scoped upstream headers and parses provider credits without converting them to grants", async () => {
    const calls: Array<{ url: string; auth?: string | null; account?: string | null }> = [];
    const doFetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(input), auth: headers.get("authorization"), account: headers.get("chatgpt-account-id") });
      const index = calls.length;
      return Response.json({
        available_count: index === 1 ? 2 : 0,
        credits: index === 1 ? [{
          id: "RateLimitResetCredit_SYNTHETIC_FIXTURE_002",
          title: "Full reset",
          status: "available",
          expires_at: "2026-12-01T22:27:07.649Z",
        }] : [],
      });
    };
    const first = await fetchCodexResetCredits({ identity: "codex-a", accessToken: "access-SYNTHETIC_FIXTURE_A", accountId: "account-SYNTHETIC_FIXTURE_A" }, doFetch);
    const second = await fetchCodexResetCredits({ identity: "codex-b", accessToken: "access-SYNTHETIC_FIXTURE_B", accountId: "account-SYNTHETIC_FIXTURE_B" }, doFetch);
    expect(calls).toEqual([
      { url: "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits", auth: "Bearer access-SYNTHETIC_FIXTURE_A", account: "account-SYNTHETIC_FIXTURE_A" },
      { url: "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits", auth: "Bearer access-SYNTHETIC_FIXTURE_B", account: "account-SYNTHETIC_FIXTURE_B" },
    ]);
    expect(first).toMatchObject({ availableCount: 2, creditExpiries: [{ id: "RateLimitResetCredit_SYNTHETIC_FIXTURE_002", endsAt: "2026-12-01T22:27:07.649Z" }] });
    expect(first).not.toHaveProperty("grants");
    expect(second).toEqual({ availableCount: 0 });
  });
  test.each([null, {}, { credits: [] }, { available_count: "0", credits: [] }])("treats invalid inventory %j as unknown", async (body) => {
    const result = await fetchCodexResetCredits({ identity: "codex-a", accessToken: "access-SYNTHETIC_FIXTURE_A" }, async () => Response.json(body));
    expect(result).toBeUndefined();
  });
  test("caches repeated reads, keeps known zero, and retains a prior result after errors", async () => {
    let now = 1_000;
    let calls = 0;
    let fail = false;
    const source = createCodexResetSource({
      ttlMs: 100,
      now: () => now,
      fetchCredits: async () => {
        calls++;
        if (fail) throw new Error("synthetic upstream error");
        return { availableCount: 0 };
      },
    });
    expect(await source("codex-a")).toEqual({ availableCount: 0 });
    expect(await source("codex-a")).toEqual({ availableCount: 0 });
    expect(calls).toBe(1);
    now += 101;
    fail = true;
    expect(await source("codex-a")).toEqual({ availableCount: 0, stale: true });
    expect(calls).toBe(2);
    expect(await source("codex-a")).toEqual({ availableCount: 0, stale: true });
    expect(calls).toBe(2);
    expect(await source("codex-b")).toBeUndefined();
    expect(calls).toBe(3);
  });

  test("a spend invalidation clears reset counts on every replica", async () => {
    const invalidations = new MemoryResetCreditInvalidations();
    let count = 2;
    let calls = 0;
    const sourceA = createCodexResetSource({ invalidations, fetchCredits: async () => { calls++; return { availableCount: count }; } });
    const sourceB = createCodexResetSource({ invalidations, fetchCredits: async () => { calls++; return { availableCount: count }; } });
    expect(await sourceA("codex-SYNTHETIC_FIXTURE")).toEqual({ availableCount: 2 });
    expect(await sourceB("codex-SYNTHETIC_FIXTURE")).toEqual({ availableCount: 2 });
    count = 1;
    await sourceA.invalidate("codex-SYNTHETIC_FIXTURE");
    expect(await sourceB("codex-SYNTHETIC_FIXTURE")).toEqual({ availableCount: 1 });
    expect(calls).toBe(3);
  });

  test("a read from an old generation cannot complete as the current value", async () => {
    const invalidations = new MemoryResetCreditInvalidations();
    let release!: () => void;
    let started!: () => void;
    const firstFetch = new Promise<void>((r) => (release = r));
    const fetchStarted = new Promise<void>((r) => (started = r));
    let count = 2;
    let calls = 0;
    const source = createCodexResetSource({ invalidations, fetchCredits: async () => {
      calls++;
      if (calls === 1) { started(); await firstFetch; }
      return { availableCount: count };
    } });
    const oldRead = source("codex-SYNTHETIC_FIXTURE");
    await fetchStarted;
    count = 1;
    await source.invalidate("codex-SYNTHETIC_FIXTURE");
    release();
    expect(await oldRead).toEqual({ availableCount: 1 });
    expect(calls).toBe(2);
  });

  test("a failed read after a spend cannot restore a previous credit count", async () => {
    const identity = "codex-SYNTHETIC_FIXTURE";
    const invalidations = new MemoryResetCreditInvalidations();
    let calls = 0;
    const source = createCodexResetSource({ invalidations, ttlMs: 0, fetchCredits: async () => {
      calls++;
      if (calls === 1) return { availableCount: 1 };
      if (calls === 2) await invalidations.invalidate(identity);
      return undefined;
    } });
    expect(await source(identity)).toEqual({ availableCount: 1 });
    expect(await source(identity)).toBeUndefined();
    expect(calls).toBe(3);
  });

  test("a failed initial generation check fetches live before it can cache a value", async () => {
    let checks = 0;
    let calls = 0;
    const invalidations = {
      version: async () => {
        checks++;
        if (checks === 1) throw new Error("synthetic version read failure");
        return "current";
      },
      invalidate: async () => {},
    };
    const source = createCodexResetSource({ invalidations, fetchCredits: async () => ({ availableCount: ++calls === 1 ? 2 : 1 }) });
    expect(await source("codex-SYNTHETIC_FIXTURE")).toEqual({ availableCount: 1 });
    expect(calls).toBe(2);
  });
});

describe("usage source", () => {
  test("reserve rejects once the cache holds usage above the threshold", async () => {
    const src = createUsageSource({ fetchUsage: async () => live(95), ttlMs: 45_000 });
    const deps = { usageFor: src.get, poolMembers: async () => ["id1"] };
    expect(await pickIdentity(app, deps)).toEqual({ identity: "id1" }); // cold miss allows
    await src.idle();
    expect(await pickIdentity(app, deps)).toEqual({ reject: "reserve" });
  });

  test("cold miss returns undefined at once and fills in the background", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const src = createUsageSource({ fetchUsage: async () => (await hold, live(10)) });
    expect(await src.get("claude", "id1")).toBeUndefined();
    release();
    await src.idle();
    expect(await src.get("claude", "id1")).toEqual(live(10));
  });

  test("concurrent misses trigger one fetch", async () => {
    let calls = 0;
    const src = createUsageSource({ fetchUsage: async () => (calls++, live(1)) });
    await Promise.all([src.get("claude", "id1"), src.get("claude", "id1"), src.get("claude", "id1")]);
    await src.idle();
    expect(calls).toBe(1);
  });

  test("stale value is served while a refresh runs, once", async () => {
    let t = 0;
    let calls = 0;
    let value = live(10);
    let gate: Promise<void> = Promise.resolve();
    const src = createUsageSource({ fetchUsage: async () => (calls++, await gate, value), ttlMs: 1000, now: () => t });
    await src.prefill("claude", "id1");
    let open!: () => void;
    gate = new Promise<void>((r) => (open = r));
    expect(await src.get("claude", "id1")).toEqual(live(10));
    t = 2000;
    value = live(60);
    expect(await src.get("claude", "id1")).toEqual(live(10));
    expect(await src.get("claude", "id1")).toEqual(live(10));
    open();
    await src.idle();
    expect(calls).toBe(2);
    expect(await src.get("claude", "id1")).toEqual(live(60));
  });

  test("unavailable means no figure, and a failing fetch keeps the old value", async () => {
    let mode: "unavailable" | "throw" = "unavailable";
    let t = 0;
    const src = createUsageSource({
      fetchUsage: async () => {
        if (mode === "throw") throw new Error("x");
        return { status: "unavailable", capturedAt: "x" } as PoolUsage;
      },
      ttlMs: 1000,
      now: () => t,
    });
    await src.prefill("claude", "id1");
    expect(await src.get("claude", "id1")).toBeUndefined();
    mode = "throw";
    t = 5000;
    await src.get("claude", "id1");
    await src.idle();
    expect(await src.get("claude", "id1")).toBeUndefined();
  });
});

test("a reading with no figure (usage API 429 or unavailable) keeps the last figure", async () => {
  let next: PoolUsage = { status: "rate-limited", maxUtilization: 100, windows: [{ label: "seven-day", utilization: 100 }], capturedAt: "a" };
  let t = 0;
  const src = createUsageSource({ fetchUsage: async () => next, ttlMs: 1000, now: () => t });
  await src.prefill("claude", "id1");
  for (const empty of [{ status: "rate-limited", error: "HTTP 429", capturedAt: "b" }, { status: "unavailable", capturedAt: "c" }] as PoolUsage[]) {
    next = empty;
    t += 5000;
    await src.get("claude", "id1");
    await src.idle();
    expect((await src.get("claude", "id1"))?.maxUtilization).toBe(100);
  }
});

// Incident 11 Nov 2026: a pinned T3 app stayed refused ("identity is at its usage reserve") after the owner reset the
// account. Anthropic's usage API kept answering 429, so the gateway kept the pre-reset 95% and refused every model call.
test("a kept figure is shown but never refuses: an account reset upstream gets through", async () => {
  let next: PoolUsage = live(95);
  let t = 0;
  const src = createUsageSource({ fetchUsage: async () => next, ttlMs: 1000, now: () => t });
  const deps = { usageFor: src.get, poolMembers: async () => ["id1"] };
  await src.prefill("claude", "id1");
  expect(await pickIdentity(app, deps)).toEqual({ reject: "reserve" }); // fresh 95%: refused
  next = { status: "rate-limited", error: "HTTP 429", capturedAt: "b" };
  t += 5000;
  await src.get("claude", "id1");
  await src.idle();
  const kept = await src.get("claude", "id1");
  expect(kept?.maxUtilization).toBe(95); // still shown
  expect(kept?.stale).toBe(true);
  expect(await pickIdentity(app, deps)).toEqual({ identity: "id1" }); // but not refused on
  next = live(90);
  t += 5000;
  await src.get("claude", "id1");
  await src.idle();
  expect((await src.get("claude", "id1"))?.stale).toBeUndefined();
  expect(await pickIdentity(app, deps)).toEqual({ reject: "reserve" }); // a fresh figure refuses again
});

// Incident 16 Nov 2026: while the usage endpoint backs off after a 429, the claude reading repeats the last good figures
// (100% for a full account) as "rate-limited". Taken as fresh, it kept a member that had been reset out of band refused
// even after its quota hold ended.
test("a claude reading served during the usage 429 backoff (old figures) is stale; codex at 100% is not", async () => {
  const backoff: PoolUsage = { status: "rate-limited", maxUtilization: 100, windows: [{ label: "seven-day", utilization: 100 }], error: "usage endpoint answered HTTP 429", capturedAt: "b" };
  const src = createUsageSource({ fetchUsage: async () => backoff });
  await src.prefill("claude", "id1");
  expect(await src.get("claude", "id1")).toMatchObject({ maxUtilization: 100, stale: true });
  expect(await pickIdentity(app, { usageFor: src.get, poolMembers: async () => ["id1"] })).toEqual({ identity: "id1" });
  await src.prefill("codex", "id1");
  expect((await src.get("codex", "id1"))?.stale).toBeUndefined(); // codex says "rate-limited" for a live reading at 100%
});

test("a failed fetch also marks the kept figure stale", async () => {
  let fail = false;
  let t = 0;
  const src = createUsageSource({
    fetchUsage: async () => {
      if (fail) throw new Error("x");
      return live(97);
    },
    ttlMs: 1000,
    now: () => t,
  });
  await src.prefill("claude", "id1");
  fail = true;
  t += 5000;
  await src.get("claude", "id1");
  await src.idle();
  expect(await src.get("claude", "id1")).toMatchObject({ maxUtilization: 97, stale: true });
});

test("a pool prefers a fresh member under the reserve, and treats a stale one as unknown", async () => {
  const poolApp: GatewayApp = { ...app, target: { kind: "pool" } };
  const usages: Record<string, PoolUsage> = { a: { ...live(99), stale: true }, b: live(50) };
  const deps = { usageFor: async (_p: string, n: string) => usages[n], poolMembers: async () => ["a", "b"] };
  expect(await pickIdentity(poolApp, deps)).toEqual({ identity: "b" });
  usages.b = live(95);
  expect(await pickIdentity(poolApp, deps)).toEqual({ identity: "a" });
});

describe("reserve uses numbers only", () => {
  const pinned = (usage: PoolUsage | undefined) => pickIdentity(app, { usageFor: async () => usage, poolMembers: async () => [] });
  test("rate-limited without a number is no figure", async () => {
    expect(await pinned({ status: "rate-limited", capturedAt: "x" })).toEqual({ identity: "id1" });
    expect(await pinned({ status: "rate-limited", maxUtilization: 100, capturedAt: "x" })).toEqual({ reject: "reserve" });
  });
  test("codex at 100 percent is still rejected, and a worst window counts when there is no max", async () => {
    const codexApp = { ...app, provider: "codex" as const };
    expect(await pickIdentity(codexApp, { usageFor: async () => ({ status: "rate-limited", maxUtilization: 100, capturedAt: "x" }), poolMembers: async () => [] })).toEqual({ reject: "reserve" });
    expect(await pinned({ status: "live", windows: [{ label: "a", utilization: 10 }, { label: "b", utilization: 90 }], capturedAt: "x" })).toEqual({ reject: "reserve" });
  });
  test("a pool treats a number-less rate-limited member as unknown, not full", async () => {
    const pool: GatewayApp = { ...app, target: { kind: "pool" } };
    const usageFor = async (_p: string, i: string): Promise<PoolUsage> => (i === "a" ? { status: "rate-limited", capturedAt: "x" } : { status: "live", maxUtilization: 95, capturedAt: "x" });
    expect(await pickIdentity(pool, { usageFor: usageFor as never, poolMembers: async () => ["a", "b"] })).toEqual({ identity: "a" });
  });
});

describe("empty pool", () => {
  const pool: GatewayApp = { ...app, target: { kind: "pool" } };
  test("a provider with no identities is its own rejection", async () => {
    expect(await pickIdentity(pool, { usageFor: async () => undefined, poolMembers: async () => [] })).toEqual({ reject: "no-identities" });
  });
  test("a stored member list is ignored: the live pool decides", async () => {
    const legacy = { ...app, target: { kind: "pool", identities: ["ghost"] } } as unknown as GatewayApp;
    expect(await pickIdentity(legacy, { usageFor: async () => undefined, poolMembers: async () => ["a"] })).toEqual({ identity: "a" });
  });
  test("members that are all over the reserve stay no-headroom", async () => {
    const full = async (): Promise<PoolUsage> => ({ status: "live", maxUtilization: 99, capturedAt: "x" });
    expect(await pickIdentity(pool, { usageFor: full as never, poolMembers: async () => ["a"] })).toEqual({ reject: "no-headroom" });
  });
});

describe("pool selection details", () => {
  const pool: GatewayApp = { ...app, target: { kind: "pool" } };
  test("extra usage breaks a tie between equal members", async () => {
    const usageFor = async (_p: string, i: string): Promise<PoolUsage> => ({
      status: "live",
      maxUtilization: 50,
      capturedAt: "x",
      ...(i === "b" ? { extraUsage: { available: true } } : {}),
    }) as PoolUsage;
    expect(await pickIdentity(pool, { usageFor: usageFor as never, poolMembers: async () => ["a", "b"] })).toEqual({ identity: "b" });
  });

  test("a member that joins the pool is picked by an existing pool app", async () => {
    let members = ["old"];
    const full = async (_p: string, i: string): Promise<PoolUsage> => ({ status: "live", maxUtilization: i === "old" ? 100 : 10, capturedAt: "x" });
    const deps = { usageFor: full as never, poolMembers: async () => members };
    expect(await pickIdentity(pool, deps)).toEqual({ reject: "no-headroom" });
    members = ["old", "new"];
    expect(await pickIdentity(pool, deps)).toEqual({ identity: "new" });
  });

  test("a stored member list does not hide a new member", async () => {
    const legacy = { ...app, target: { kind: "pool", identities: ["old"] } } as unknown as GatewayApp;
    const usageFor = async (_p: string, i: string): Promise<PoolUsage> => ({ status: "live", maxUtilization: i === "old" ? 100 : 10, capturedAt: "x" }) as PoolUsage;
    expect(await pickIdentity(legacy, { usageFor: usageFor as never, poolMembers: async () => ["old", "new"] })).toEqual({ identity: "new" });
  });
});

describe("refreshNow (after a quota answer)", () => {
  test("reads the source with `fresh`, once for concurrent calls, after a plain read already in flight", async () => {
    const calls: Array<boolean | undefined> = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const src = createUsageSource({
      fetchUsage: async (_p, _i, opts) => {
        calls.push(opts?.fresh);
        if (!opts?.fresh) await gate;
        return live(opts?.fresh ? 77 : 10);
      },
    });
    void src.get("claude", "id1"); // a plain read that may predate the quota answer
    const both = Promise.all([src.refreshNow("claude", "id1"), src.refreshNow("claude", "id1")]);
    release();
    await both;
    expect(calls).toEqual([undefined, true]);
    expect((await src.get("claude", "id1"))?.maxUtilization).toBe(77);
  });
});

describe("opencode Go usage reading", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  const answer = (status: number, body: unknown, seen?: { url?: string; auth?: string }): void => {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (seen) { seen.url = String(url); seen.auth = new Headers(init?.headers).get("authorization") ?? undefined; }
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
  };

  test("reads the three windows with the member's key, percent and ISO reset", async () => {
    const seen: { url?: string; auth?: string } = {};
    answer(200, { usage: { rolling: { percent: 51, resetsAt: "2026-11-20T10:23:00.000Z" }, weekly: { percent: 100, status: "rate-limited", resetsAt: "2026-11-23T00:00:00.000Z" }, monthly: { percent: 20, resetsAt: "2026-12-01T00:00:00.000Z" } } }, seen);
    const u = await fetchOpencodeUsage("KEY-1");
    expect(seen.url).toBe("https://opencode.ai/zen/go/v1/usage");
    expect(seen.auth).toBe("Bearer KEY-1");
    expect(u?.status).toBe("rate-limited");
    expect(u?.windows?.map((w) => [w.label, w.utilization, w.resetsAt])).toEqual([
      ["session (5h)", 51, "2026-11-20T10:23:00.000Z"], ["week", 100, "2026-11-23T00:00:00.000Z"], ["month", 20, "2026-12-01T00:00:00.000Z"],
    ]);
  });

  test("a key with no plan (no windows, or untouched windows with no reset) is a distinct no-plan state", async () => {
    answer(200, { usage: {} });
    expect(await fetchOpencodeUsage("K")).toMatchObject({ noPlan: true });
    answer(200, { usage: { rolling: { percent: 0 }, weekly: { percent: 0 }, monthly: { percent: 0 } } });
    expect(await fetchOpencodeUsage("K")).toMatchObject({ noPlan: true });
  });

  test("a failed read gives no figure, and the source keeps the last figure as stale", async () => {
    answer(200, { usage: { weekly: { percent: 100, resetsAt: "2026-11-23T00:00:00.000Z" } } });
    const fetchUsage = withOpencodeUsage({ get: async () => ({ accessToken: "K" }) }, async () => undefined);
    const src = createUsageSource({ fetchUsage, ttlMs: 0 });
    await src.prefill("opencode", "m1");
    answer(500, {});
    await src.prefill("opencode", "m1");
    const kept = await src.get("opencode", "m1");
    expect(kept?.stale).toBe(true);
    expect(kept?.windows?.[0]?.utilization).toBe(100);
  });

  test("withOpencodeUsage sends other providers to the base fetcher", async () => {
    const f = withOpencodeUsage({ get: async () => { throw new Error("no"); } }, async () => live(5));
    expect(await f("claude", "x")).toEqual(live(5));
  });

  test("a no-plan reading is kept by the source", async () => {
    answer(200, { usage: {} });
    const src = createUsageSource({ fetchUsage: withOpencodeUsage({ get: async () => ({ accessToken: "K" }) }, async () => undefined) });
    await src.prefill("opencode", "m2");
    expect((await src.get("opencode", "m2"))?.noPlan).toBe(true);
  });
});

describe("usage source with shared readings", () => {
  const none: PoolUsage = { status: "unavailable", capturedAt: "2026-11-02T00:00:00.000Z" };
  const clock = () => {
    let t = 1_000_000;
    return { now: () => t, advance: (ms: number) => void (t += ms) };
  };
  const mk = (c: ReturnType<typeof clock>) => new MemoryUsageReadings(c.now);

  test("a young shared reading skips upstream", async () => {
    const c = clock();
    const shared = mk(c);
    await shared.save("claude", "id1", live(30), 10_000);
    let calls = 0;
    const src = createUsageSource({ fetchUsage: async () => (calls++, live(90)), shared, now: c.now });
    await src.prefill("claude", "id1");
    expect(calls).toBe(0);
    expect((await src.get("claude", "id1"))?.maxUtilization).toBe(30);
  });

  test("an old shared reading is not used while upstream answers", async () => {
    const c = clock();
    const shared = mk(c);
    await shared.save("claude", "id1", live(30), 100_000);
    const src = createUsageSource({ fetchUsage: async () => live(90), shared, now: c.now });
    await src.prefill("claude", "id1");
    expect((await src.get("claude", "id1"))?.maxUtilization).toBe(90);
  });

  test("upstream with no figure and no local value falls back to the stale shared reading", async () => {
    const c = clock();
    const shared = mk(c);
    await shared.save("claude", "id1", live(30), 100_000);
    const src = createUsageSource({ fetchUsage: async () => none, shared, now: c.now });
    await src.prefill("claude", "id1");
    expect(await src.get("claude", "id1")).toMatchObject({ maxUtilization: 30, stale: true });
  });

  test("an upstream error with no local value also falls back", async () => {
    const c = clock();
    const shared = mk(c);
    await shared.save("claude", "id1", live(30), 100_000);
    const src = createUsageSource({ fetchUsage: async () => { throw new Error("boom"); }, shared, now: c.now });
    await src.prefill("claude", "id1");
    expect(await src.get("claude", "id1")).toMatchObject({ maxUtilization: 30, stale: true });
  });

  test("the fallback picks the newer of the local and the shared figure", async () => {
    const c = clock();
    const shared = mk(c);
    let n = 0;
    const src = createUsageSource({ fetchUsage: async () => (n++ === 0 ? { ...live(10), capturedAt: "2026-11-02T00:00:00.000Z" } : none), shared, now: c.now });
    await src.prefill("claude", "id1");
    c.advance(100_000);
    await shared.save("claude", "id1", { ...live(70), capturedAt: "2026-11-03T00:00:00.000Z" }, 60_000);
    await src.prefill("claude", "id1");
    expect(await src.get("claude", "id1")).toMatchObject({ maxUtilization: 70, stale: true });
  });

  test("a good upstream read is saved, an empty one is not", async () => {
    const c = clock();
    const shared = mk(c);
    const src = createUsageSource({ fetchUsage: async (_p, i) => (i === "a" ? live(55) : none), shared, now: c.now });
    await src.prefill("claude", "a");
    await src.prefill("claude", "b");
    expect((await shared.load("claude", "a"))?.reading.maxUtilization).toBe(55);
    expect((await shared.load("claude", "b"))?.reading.maxUtilization).toBeUndefined();
  });

  test("a claude rate-limited read with a figure is not saved, a codex one is", async () => {
    const c = clock();
    const shared = mk(c);
    const limited: PoolUsage = { ...live(100), status: "rate-limited" };
    const src = createUsageSource({ fetchUsage: async () => limited, shared, now: c.now });
    await src.prefill("claude", "id1");
    await src.prefill("codex", "id1");
    expect((await shared.load("claude", "id1"))?.reading.maxUtilization).toBeUndefined();
    expect((await shared.load("codex", "id1"))?.reading.maxUtilization).toBe(100);
  });

  test("a last-good read is saved with its own age, clamped to the ttl", async () => {
    const c = clock();
    const shared = mk(c);
    const old: PoolUsage = { ...live(40), capturedAt: new Date(c.now() - 20_000).toISOString() };
    const src = createUsageSource({ fetchUsage: async () => old, shared, now: c.now });
    await src.prefill("claude", "id1");
    expect((await shared.load("claude", "id1"))?.ageMs).toBe(20_000);
  });

  test("shared store errors never fail a read and are logged once", async () => {
    const broken: UsageReadings = {
      load: async () => { throw new Error("db down"); },
      loadAll: async () => { throw new Error("db down"); },
      save: async () => { throw new Error("db down"); },
      claim: async () => { throw new Error("db down"); },
      release: async () => { throw new Error("db down"); },
    };
    const logs: string[] = [];
    let errors = 0;
    const src = createUsageSource({ fetchUsage: async () => live(10), shared: broken, log: (l) => void logs.push(l), onSharedError: () => void errors++ });
    await src.prefill("claude", "id1");
    await src.refreshNow("claude", "id1");
    expect((await src.get("claude", "id1"))?.maxUtilization).toBe(10);
    expect(logs.length).toBe(1);
    expect(errors).toBeGreaterThan(1);
  });

  test("a shared load that never resolves does not stop the upstream read", async () => {
    const hung: UsageReadings = {
      load: () => new Promise(() => {}),
      loadAll: () => new Promise(() => {}),
      save: () => new Promise(() => {}),
      claim: () => new Promise(() => {}),
      release: () => new Promise(() => {}),
    };
    const c = clock();
    let calls = 0;
    const src = createUsageSource({ fetchUsage: async () => (calls++, live(10)), shared: hung, sharedTimeoutMs: 20, now: c.now, log: () => {} });
    await src.prefill("claude", "id1");
    expect(calls).toBe(1);
    expect((await src.get("claude", "id1"))?.stale).toBeUndefined();
    c.advance(50_000);
    await src.get("claude", "id1");
    await src.idle();
    expect(calls).toBe(2);
  });

  test("a fresh read goes upstream even when the shared reading is young, and saves", async () => {
    const c = clock();
    const shared = mk(c);
    await shared.save("claude", "id1", live(30), 1_000);
    let calls = 0;
    const src = createUsageSource({ fetchUsage: async () => (calls++, live(100)), shared, now: c.now });
    c.advance(1);
    await src.refreshNow("claude", "id1");
    expect(calls).toBe(1);
    expect((await shared.load("claude", "id1"))?.reading.maxUtilization).toBe(100);
  });

  test("six replicas past the ttl poll upstream about once", async () => {
    const c = clock();
    const shared = mk(c);
    let calls = 0;
    const fetchUsage = async () => (calls++, await Bun.sleep(200), live(60));
    const srcs = Array.from({ length: 6 }, () => createUsageSource({ fetchUsage, shared, now: c.now }));
    await Promise.all(srcs.map((x) => x.prefill("claude", "id1")));
    expect(calls).toBeLessThanOrEqual(2);
    for (const x of srcs) expect((await x.get("claude", "id1"))?.maxUtilization).toBe(60);
  });

  test("an entry taken from the shared row gets per-replica jitter on its expiry", async () => {
    const c = clock();
    const shared = mk(c);
    await shared.save("claude", "id1", live(30), 0);
    let calls = 0;
    const src = createUsageSource({ fetchUsage: async () => (calls++, live(90)), shared, now: c.now, random: () => 1 });
    await src.prefill("claude", "id1");
    c.advance(50_000); // past the ttl (45 s) but inside ttl plus jitter (60 s)
    await src.get("claude", "id1");
    await src.idle();
    expect(calls).toBe(0);
    c.advance(15_000);
    await src.get("claude", "id1");
    await src.idle();
    expect(calls).toBe(1);
  });

  test("a stored row dated in the future is overwritten by a later save and is not served as live", async () => {
    const c = clock();
    const shared = mk(c);
    await shared.save("claude", "id1", live(1), -60_000); // dated one minute ahead
    let calls = 0;
    const src = createUsageSource({ fetchUsage: async () => (calls++, live(77)), shared, now: c.now });
    await src.prefill("claude", "id1");
    expect(calls).toBe(1);
    expect((await shared.load("claude", "id1"))?.reading.maxUtilization).toBe(77);
  });

  test("seed fills the cache without overwriting, and marks old readings stale", async () => {
    const c = clock();
    const src = createUsageSource({ fetchUsage: async () => none, now: c.now, random: () => 0 });
    src.seed([
      { provider: "claude", identity: "old", reading: live(20), ageMs: 100_000 },
      { provider: "claude", identity: "new", reading: live(21), ageMs: 1_000 },
    ]);
    expect(await src.get("claude", "old")).toMatchObject({ maxUtilization: 20, stale: true });
    expect((await src.get("claude", "new"))?.stale).toBeUndefined();
  });

  test("the metrics hook counts upstream and shared reads", async () => {
    const c = clock();
    const shared = mk(c);
    const reads: string[] = [];
    const src = createUsageSource({ fetchUsage: async () => live(1), shared, now: c.now, onRead: (p, s) => void reads.push(`${p}/${s}`) });
    await src.prefill("claude", "id1");
    expect(reads).toEqual(["claude/upstream"]);
    await shared.save("claude", "id3", live(3), 0);
    await src.prefill("claude", "id3");
    expect(reads.at(-1)).toBe("claude/shared");
  });
});

describe("usage read outcome log", () => {
  test("a member's failing upstream read is logged once when it starts and once when it recovers", async () => {
    const answers: PoolUsage[] = [
      live(10),
      { status: "rate-limited", maxUtilization: 10, error: "usage endpoint answered HTTP 429", capturedAt: "2026-11-02T00:00:00.000Z" },
      { status: "rate-limited", maxUtilization: 10, error: "usage endpoint answered HTTP 429", capturedAt: "2026-11-02T00:00:00.000Z" },
      live(20),
    ];
    let t = 0;
    const logs: string[] = [];
    const src = createUsageSource({ fetchUsage: async () => answers.shift(), ttlMs: 10, now: () => t, log: (l) => void logs.push(l) });
    for (let i = 0; i < 4; i++) {
      await src.get("claude", "id1");
      await src.idle();
      t += 20;
    }
    expect(logs.map((l) => JSON.parse(l))).toEqual([
      { event: "usage-read", provider: "claude", identity: "id1", outcome: "failed", error: "usage endpoint answered HTTP 429" },
      { event: "usage-read", provider: "claude", identity: "id1", outcome: "recovered" },
    ]);
  });
});

describe("usage read log", () => {
  const events = (logs: string[]): Array<{ event: string; provider: string; identity: string; outcome: string; error?: string }> => logs.map((l) => JSON.parse(l));
  const none = { status: "unavailable", capturedAt: "x" } as PoolUsage;

  test("a provider with no usage reader (grok) logs nothing and gives no figure", async () => {
    const logs: string[] = [];
    const src = createUsageSource({ fetchUsage: async () => undefined, log: (l) => void logs.push(l) });
    await src.prefill("grok", "id1");
    expect(await src.get("grok", "id1")).toBeUndefined();
    await src.idle();
    expect(logs).toEqual([]);
  });

  test("a provider with a reader logs a failure once and the recovery once, with the error text in the log only", async () => {
    const logs: string[] = [];
    let next: PoolUsage = { ...none, error: "HTTP 500" };
    let t = 0;
    const src = createUsageSource({ fetchUsage: async () => next, ttlMs: 1000, now: () => t, log: (l) => void logs.push(l) });
    await src.prefill("claude", "id1");
    t += 5000;
    next = { ...none, error: "HTTP 502" }; // another error text: still failed, no second line
    await src.prefill("claude", "id1");
    t += 5000;
    next = live(10);
    await src.prefill("claude", "id1");
    expect(events(logs)).toEqual([{ event: "usage-read", provider: "claude", identity: "id1", outcome: "failed", error: "HTTP 500" }, { event: "usage-read", provider: "claude", identity: "id1", outcome: "recovered" }]);
  });

  test("a thrown fetch logs a failure with the error text", async () => {
    const logs: string[] = [];
    const src = createUsageSource({ fetchUsage: async () => { throw new Error("boom"); }, log: (l) => void logs.push(l) });
    await src.prefill("claude", "id1");
    expect(events(logs)).toEqual([{ event: "usage-read", provider: "claude", identity: "id1", outcome: "failed", error: "boom" }]);
  });

  test("a young shared reading marks a failed member recovered", async () => {
    const logs: string[] = [];
    const shared = new MemoryUsageReadings();
    let t = 1_000_000;
    let fail = true;
    const src = createUsageSource({ fetchUsage: async () => (fail ? none : live(10)), shared, ttlMs: 45_000, now: () => t, log: (l) => void logs.push(l) });
    await src.prefill("claude", "id1");
    expect(events(logs).map((e) => e.outcome)).toEqual(["failed"]);
    fail = false;
    await shared.save("claude", "id1", live(20), 0);
    t += 60_000;
    await src.prefill("claude", "id1");
    expect(events(logs).map((e) => e.outcome)).toEqual(["failed", "recovered"]);
  });
});
