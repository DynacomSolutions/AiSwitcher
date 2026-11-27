import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { setTimeout as wait } from "node:timers/promises";
import type { ManualResetInfo } from "../../src/cli/limits/types.ts";
import type { PoolUsage } from "../../src/identities/pool/adapter.ts";
import { MemoryAutoResetStore, PgAutoResetStore } from "../../src/gateway/auto-reset-store.ts";
import {
  chooseAutoResetCandidate, createAutoResetRecovery, exhaustedWeeklyReset, type AutoResetCandidate, type AutoResetUsage,
} from "../../src/gateway/auto-reset.ts";

const NOW = Date.parse("2026-11-27T08:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const alphaCredit = "credit-SYNTHETIC_FIXTURE-alpha";
const betaCredit = "credit-SYNTHETIC_FIXTURE-beta";
const RESETS = { alpha: NOW + 600_000, beta: NOW + 610_000 };

function usage(resetAt: number, capturedAt = NOW, used = 100): PoolUsage {
  return { status: used >= 100 ? "rate-limited" : "live", capturedAt: iso(capturedAt), windows: [
    { label: "session", utilization: used, resetsAt: iso(resetAt) },
    { label: "week", utilization: used, resetsAt: iso(resetAt) },
  ] };
}

function credits(id = alphaCredit, expiry = NOW + 100_000): ManualResetInfo {
  return { availableCount: 1, creditExpiries: [{ id, endsAt: iso(expiry) }] };
}

async function allow(store: MemoryAutoResetStore, names = ["alpha", "beta"]): Promise<void> {
  await store.setEnabled("codex", "renewal", true);
}

const input = (signal = AbortSignal.timeout(2_500), members = ["alpha", "beta"]) => ({ members, reservePercent: 90, signal });
type Details = Parameters<typeof createAutoResetRecovery>[0];

function harness(store = new MemoryAutoResetStore(() => NOW), overrides: Partial<Details> = {}) {
  const spends: { identity: string; creditId: string; redeemRequestId: string }[] = [];
  const logs: string[] = [];
  const reads: string[] = [];
  const recovered = new Set<string>();
  const options: Details = {
    store,
    now: () => NOW,
    confirmationBudgetMs: 55,
    pools: async () => [{ name: "renewal", members: ["alpha", "beta"] }],
    freshUsage: async (identity) => {
      reads.push(identity);
      const reset = RESETS[identity as keyof typeof RESETS];
      return reset === undefined ? undefined : usage(reset, NOW, recovered.has(identity) ? 4 : 100);
    },
    readCredits: async (identity) => identity === "alpha" ? credits() : credits(betaCredit, NOW + 100_001),
    spend: async (identity, creditId, redeemRequestId) => {
      spends.push({ identity, creditId, redeemRequestId });
      recovered.add(identity);
      return { result: "reset", creditId };
    },
    log: (line) => logs.push(line),
    ...overrides,
  };
  return { recovery: createAutoResetRecovery(options), options, store, spends, logs, reads, recovered };
}

describe("Codex renewal choice", () => {
  const a: AutoResetCandidate = {
    pool: "pool-A", identity: "account-A", creditId: alphaCredit, creditExpiresAt: NOW + 500,
    weeklyReset: NOW + 300_000,
  };

  test("one millisecond of expiry beats a later weekly reset", () => {
    const later = { ...a, creditExpiresAt: a.creditExpiresAt + 1, weeklyReset: a.weeklyReset + 1_000 };
    expect(chooseAutoResetCandidate([later, a], NOW)).toBe(a);
  });

  test("on identical expiry one millisecond of later weekly reset wins", () => {
    const laterReset = { ...a, weeklyReset: a.weeklyReset + 1 };
    expect(chooseAutoResetCandidate([a, laterReset], NOW)).toBe(laterReset);
  });

  test("breaks exact time ties by identity, then pool, then credit ID in code-unit order", () => {
    const laterIdentity = { ...a, identity: "account-a", pool: "pool-0", creditId: "credit-SYNTHETIC_FIXTURE-0" };
    const laterPool = { ...a, pool: "pool-a", creditId: "credit-SYNTHETIC_FIXTURE-0" };
    const laterCredit = { ...a, creditId: betaCredit };
    for (const competitor of [laterIdentity, laterPool, laterCredit]) {
      expect(chooseAutoResetCandidate([competitor, a], NOW)).toBe(a);
      expect(chooseAutoResetCandidate([a, competitor], NOW)).toBe(a);
    }
  });

  test("requires a live credit and at least five minutes until reset", () => {
    expect(chooseAutoResetCandidate([a], NOW)).toBe(a);
    expect(chooseAutoResetCandidate([{ ...a, weeklyReset: NOW + 299_999 }], NOW)).toBeUndefined();
    expect(chooseAutoResetCandidate([{ ...a, creditExpiresAt: NOW }], NOW)).toBeUndefined();
  });

  test("requires fresh account-wide weekly proof and excludes paid headroom", () => {
    const full = usage(RESETS.alpha);
    expect(exhaustedWeeklyReset(full, NOW)).toBe(RESETS.alpha);
    expect(exhaustedWeeklyReset({ ...full, codexRateLimitAllowed: false }, NOW)).toBe(RESETS.alpha);
    expect(exhaustedWeeklyReset({ ...full, status: "live" }, NOW)).toBe(RESETS.alpha);
    const unavailable: Array<AutoResetUsage | undefined> = [
      undefined, { ...full, codexRateLimitAllowed: true }, { ...full, stale: true }, { ...full, noPlan: true }, { ...full, status: "unavailable" },
      usage(RESETS.alpha, NOW - 45_001), usage(NOW), usage(RESETS.alpha, NOW, 99.999),
      { ...full, windows: [{ label: "session", utilization: 100, resetsAt: iso(RESETS.alpha) }] },
      { ...full, windows: [{ label: "weekly", utilization: 100, resetsAt: "tomorrow" }] },
      { ...full, windows: [{ label: "weekly", utilization: 100, resetsAt: "2026-11-27T09:00:00", model: "specific" }] },
      { ...full, extraUsage: { enabled: true, available: true, label: "synthetic paid credits" } },
    ];
    for (const reading of unavailable) expect(exhaustedWeeklyReset(reading, NOW)).toBeUndefined();
  });
});

describe("Codex renewal recovery", () => {
  test("distinguishes an explicitly disabled database rule from a failed read", async () => {
    const failure = new Error("synthetic database failure");
    const { options } = harness();
    const off = new PgAutoResetStore((async () => [{ enabled: false }]) as unknown as SQL);
    const failed = new PgAutoResetStore((async () => { throw failure; }) as unknown as SQL);
    expect(await createAutoResetRecovery({ ...options, store: off }).enabled()).toBeFalse();
    await expect(createAutoResetRecovery({ ...options, store: failed }).enabled()).rejects.toBe(failure);
  });

  test("rejects when the database rule read exceeds its 1.5-second budget", async () => {
    const { options } = harness();
    const hung = new PgAutoResetStore((() => new Promise(() => {})) as unknown as SQL);
    await expect(createAutoResetRecovery({ ...options, store: hung }).enabled()).rejects.toThrow("Codex auto-reset rules timed out");
  });

  test("defaults off, needs only the pool setting, and verifies every routed member", async () => {
    const h = harness();
    expect(await h.recovery.enabled()).toBeFalse();
    expect(await h.recovery.recover(input())).toBeUndefined();
    expect(h.reads).toEqual([]);
    await h.store.setEnabled("codex", "renewal", true);
    expect(await h.recovery.enabled()).toBeTrue();
    expect(await h.recovery.recover(input(undefined, ["alpha", "beta", "missing"]))).toBeUndefined();
    expect(h.reads).toContain("missing");
    expect(h.spends).toEqual([]);
    expect(await h.store.lastClaim("codex", "renewal")).toBeUndefined();
    await h.store.setEnabled("codex", "renewal", false);
    expect(await h.recovery.recover(input())).toBeUndefined();
    expect(h.spends).toEqual([]);
  });

  test("a disable after credit selection blocks the claim and spend", async () => {
    const h = harness();
    await allow(h.store);
    const recovery = createAutoResetRecovery({
      ...h.options,
      claim: async (planned) => {
        await h.store.setEnabled("codex", planned.pool, false);
        return h.store.claim(planned);
      },
    });
    expect(await recovery.recover(input())).toBeUndefined();
    expect(await h.store.lastClaim("codex", "renewal")).toBeUndefined();
    expect(h.spends).toEqual([]);
  });

  test("chooses credits only from routed members of enabled pools", async () => {
    const h = harness(undefined, {
      pools: async () => [{ name: "renewal", members: ["beta"] }, { name: "disabled", members: ["alpha"] }],
    });
    await allow(h.store);
    expect(await h.recovery.recover(input())).toBe("beta");
    expect(h.reads).toContain("alpha");
    expect(h.spends).toEqual([{ identity: "beta", creditId: betaCredit, redeemRequestId: expect.any(String) }]);
  });

  test("durably records the plan before spend, then records and confirms the result", async () => {
    const h = harness();
    await allow(h.store);
    const base = h.options.spend;
    const claim = h.store.claim.bind(h.store);
    h.store.claim = async (planned) => {
      expect(planned.creditEvidence).toEqual({
        reason: "earliest_expiry",
        inventories: [
          { identity: "alpha", pools: ["renewal"], weeklyResetAt: iso(RESETS.alpha), availableCount: 1,
            readAt: undefined, credits: [{ id: alphaCredit, expiresAt: iso(NOW + 100_000) }] },
          { identity: "beta", pools: ["renewal"], weeklyResetAt: iso(RESETS.beta), availableCount: 1,
            readAt: undefined, credits: [{ id: betaCredit, expiresAt: iso(NOW + 100_001) }] },
        ],
      });
      return claim(planned);
    };
    const recovery = createAutoResetRecovery({ ...h.options, spend: async (...args) => {
      expect(await h.store.lastMemberClaim("codex", args[0])).toMatchObject({
        creditId: alphaCredit, creditExpiresAt: iso(NOW + 100_000), startedAt: iso(NOW), status: "pending",
      });
      return base(...args);
    } });
    expect(await recovery.recover(input())).toBe("alpha");
    expect(h.spends).toEqual([{ identity: "alpha", creditId: alphaCredit, redeemRequestId: expect.any(String) }]);
    expect(await h.store.lastClaim("codex", "renewal")).toMatchObject({ status: "reset", creditedId: alphaCredit });
    expect(h.logs.map((line) => JSON.parse(line))).toMatchObject([
      {
        status: "pending", reason: "earliest_expiry", startedAt: iso(NOW), creditExpiresAt: iso(NOW + 100_000),
        eventKey: expect.any(String),
        usageEvidence: [
          { identity: "alpha", resetAt: iso(RESETS.alpha), capturedAt: iso(NOW), weeklyUtilisation: 100 },
          { identity: "beta", resetAt: iso(RESETS.beta), capturedAt: iso(NOW), weeklyUtilisation: 100 },
        ],
        creditEvidence: { inventories: [
          { identity: "alpha", credits: [{ id: alphaCredit, expiresAt: iso(NOW + 100_000) }] },
          { identity: "beta", credits: [{ id: betaCredit, expiresAt: iso(NOW + 100_001) }] },
        ] },
      },
      { status: "reset", reason: "earliest_expiry", outcome: "reset", creditedId: alphaCredit },
    ]);
  });

  test("requires a live dated credit with a stable identifier", async () => {
    const invalid: Array<ManualResetInfo | undefined> = [
      undefined, { ...credits(), stale: true }, credits(""), credits(alphaCredit, NOW),
      { availableCount: 1 }, { ...credits(), availableCount: 0 },
      { ...credits(), creditExpiries: [...credits().creditExpiries!, ...credits(alphaCredit, NOW + 1).creditExpiries!] },
      { ...credits(), readAt: iso(NOW - 45_001) },
    ];
    for (const info of invalid) {
      const h = harness(undefined, { readCredits: async () => info });
      await allow(h.store);
      expect(await h.recovery.recover(input())).toBeUndefined();
      expect(h.spends).toEqual([]);
    }
  });

  test.each([
    { secondExpiry: NOW + 49_999, winner: "credit-SYNTHETIC_FIXTURE-A" },
    { secondExpiry: NOW + 50_000, winner: "credit-SYNTHETIC_FIXTURE-A" },
  ])("passes the exact winning credit from a multi-credit account", async ({ secondExpiry, winner }) => {
    const h = harness(undefined, { readCredits: async (identity) => identity === "alpha"
      ? {
        availableCount: 4,
        creditExpiries: [
          { id: alphaCredit, endsAt: iso(NOW + 50_000) },
          { id: "credit-SYNTHETIC_FIXTURE-A", endsAt: iso(secondExpiry) },
          { id: "credit-SYNTHETIC_FIXTURE-invalid", endsAt: "unknown" },
        ],
      }
      : credits(betaCredit, NOW + 50_001) });
    await allow(h.store);
    expect(await h.recovery.recover(input())).toBe("alpha");
    expect(h.spends).toMatchObject([{ identity: "alpha", creditId: winner }]);
    expect(await h.store.lastMemberClaim("codex", "alpha")).toMatchObject({ creditId: winner, creditedId: winner });
  });

  test("joins the same winner across recovery instances and sorted member sets", async () => {
    const h = harness();
    await allow(h.store);
    const spending = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const first = createAutoResetRecovery({ ...h.options, spend: async (...args) => {
      spending.resolve();
      await release.promise;
      return h.options.spend(...args);
    } });
    const a = first.recover(input());
    await spending.promise;
    let followerCreditReads = 0;
    const follower = createAutoResetRecovery({ ...h.options, readCredits: async () => {
      followerCreditReads++;
      return undefined;
    }, spend: async () => { throw new Error("unexpected follower spend"); } });
    const b = follower.recover(input(undefined, ["beta", "alpha", "beta"]));
    await wait(15);
    release.resolve();
    expect(await Promise.all([a, b])).toEqual(["alpha", "alpha"]);
    expect(h.spends).toHaveLength(1);
    expect(h.logs).toHaveLength(2);
    expect(followerCreditReads).toBe(0);
  });

  test("recovers when the winner restores headroom during a follower's initial readings", async () => {
    const h = harness();
    await allow(h.store);
    const reading = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let creditReads = 0;
    const follower = createAutoResetRecovery({ ...h.options,
      freshUsage: async (identity, signal) => {
        if (identity === "alpha") {
          reading.resolve();
          await release.promise;
        }
        return h.options.freshUsage(identity, signal);
      },
      readCredits: async () => { creditReads++; return undefined; },
    });
    const b = follower.recover(input());
    await reading.promise;
    expect(await h.recovery.recover(input())).toBe("alpha");
    release.resolve();
    expect(await b).toBe("alpha");
    expect(creditReads).toBe(0);
    expect(h.spends).toHaveLength(1);
  });

  test("requires a new provider receipt and all-member proof to claim a second credit in the same weekly window", async () => {
    let clock = NOW;
    let staleBeta = false;
    let restored = false;
    let inventory = alphaCredit;
    const store = new MemoryAutoResetStore(() => clock);
    const spend = async (_identity: string, creditId: string) => {
      restored = true;
      return { result: "reset" as const, creditId };
    };
    const h = harness(store, {
      now: () => clock,
      freshUsage: async (identity) => {
        const reset = RESETS[identity as keyof typeof RESETS];
        return usage(reset, identity === "beta" && staleBeta ? clock - 1 : clock, restored && identity === "alpha" ? 5 : 100);
      },
      readCredits: async (identity) => identity === "alpha" ? credits(inventory) : undefined,
      spend,
    });
    await allow(store);
    const oldReceipt = { ...input(), provider429At: clock };
    expect(await h.recovery.recover(oldReceipt)).toBe("alpha");
    const first = JSON.parse(h.logs[0]);
    expect(await store.findClaim(first.eventKey)).toMatchObject({ generation: 1, recoveredAt: iso(NOW) });

    restored = false;
    inventory = betaCredit;
    clock += 24_999;
    expect(await h.recovery.recover({ ...input(), provider429At: clock })).toBeUndefined();
    clock++;
    expect(await h.recovery.recover(oldReceipt)).toBeUndefined();
    expect(await h.recovery.recover(input())).toBeUndefined();
    expect(await h.recovery.recover({ ...input(), provider429At: clock + 1 })).toBeUndefined();
    staleBeta = true;
    expect(await h.recovery.recover({ ...input(), provider429At: clock })).toBeUndefined();
    staleBeta = false;
    expect(await h.recovery.recover({ ...input(), provider429At: clock })).toBe("alpha");
    const second = JSON.parse(h.logs[2]);
    expect(second).toMatchObject({ eventKey: first.eventKey, provider429At: iso(clock), creditId: betaCredit });
    expect(await store.findClaim(first.eventKey)).toMatchObject({ generation: 2, recoveredAt: iso(clock), creditId: betaCredit });
    expect(h.logs).toHaveLength(4);
  });

  test("records later fresh headroom for a successful claim with no immediate confirmation", async () => {
    let clock = NOW;
    let restored = false;
    const store = new MemoryAutoResetStore(() => clock);
    const h = harness(store, {
      now: () => clock,
      freshUsage: async (identity) => usage(RESETS[identity as keyof typeof RESETS], clock, restored && identity === "alpha" ? 5 : 100),
      spend: async () => ({ result: "reset", creditId: alphaCredit }),
    });
    await allow(store);
    expect(await h.recovery.recover(input())).toBeUndefined();
    const { eventKey } = JSON.parse(h.logs[0]);
    expect((await store.findClaim(eventKey))?.recoveredAt).toBeUndefined();
    clock++;
    restored = true;
    expect(await h.recovery.recover(input())).toBe("alpha");
    expect((await store.findClaim(eventKey))?.recoveredAt).toBe(iso(clock));
  });

  test("does not replay if the provider disallows requests despite low utilisation", async () => {
    const h = harness(undefined, { freshUsage: async (identity) => identity === "alpha"
      ? { ...usage(RESETS.alpha, NOW, 4), codexRateLimitAllowed: false }
      : usage(RESETS.beta) });
    await allow(h.store);
    expect(await h.recovery.recover(input())).toBeUndefined();
    expect(h.spends).toHaveLength(0);
  });

  test("does not retry an ambiguous POST and redacts provider error details", async () => {
    let calls = 0;
    const h = harness(undefined, { spend: async () => {
      calls++;
      throw new Error("SYNTHETIC_FIXTURE-private-error");
    } });
    await allow(h.store);
    expect(await h.recovery.recover(input())).toBeUndefined();
    expect(await h.recovery.recover(input())).toBeUndefined();
    expect(calls).toBe(1);
    expect(await h.store.lastMemberClaim("codex", "alpha")).toMatchObject({ status: "unknown" });
    expect(h.logs.join("\n")).not.toContain("SYNTHETIC_FIXTURE-private-error");
  });

  test("can confirm headroom after an ambiguous POST without sending a second one", async () => {
    const h = harness();
    await allow(h.store);
    const recovery = createAutoResetRecovery({ ...h.options, spend: async (...args) => {
      await h.options.spend(...args);
      throw new Error("Synthetic connection closed");
    } });
    expect(await recovery.recover(input())).toBe("alpha");
    expect(h.spends).toHaveLength(1);
    expect(await h.store.lastMemberClaim("codex", "alpha")).toMatchObject({ status: "unknown" });
    expect((await h.store.findClaim(JSON.parse(h.logs[0]).eventKey))?.recoveredAt).toBeUndefined();
  });

  test.each(["reset", "unknown"] as const)("waits for delayed headroom after the POST outcome %s", async (outcome) => {
    const started = Promise.withResolvers<void>();
    const weeklyReset = Date.now() + 600_000;
    let spentAt = 0;
    let checks = 0;
    const h = harness(undefined, {
      now: Date.now,
      confirmationBudgetMs: 2_000,
      freshUsage: async () => {
        const at = Date.now();
        if (spentAt) checks++;
        return usage(weeklyReset, at, spentAt && at - spentAt > 750 ? 5 : 100);
      },
      readCredits: async () => credits(alphaCredit, Date.now() + 60_000),
      spend: async () => {
        spentAt = Date.now();
        started.resolve();
        if (outcome === "unknown") throw new Error("Synthetic acknowledgement lost");
        return { result: "reset" };
      },
    });
    await allow(h.store);
    const pending = h.recovery.recover(input());
    await started.promise;
    expect(await pending).toBe("alpha");
    expect(checks).toBeGreaterThanOrEqual(4);
    expect(await h.store.lastMemberClaim("codex", "alpha")).toMatchObject({ status: outcome });
  });

  test.each(["no_credit", "nothing_to_reset", "already_redeemed", "provider_refused"] as const)(
    "confirmed consume rejection (%s) returns fallback without polling usage again", async (outcome) => {
    const h = harness(undefined, { spend: async () => {
      if (outcome === "provider_refused") throw Object.assign(new Error("Synthetic refusal"), { status: 403 });
      return { result: outcome };
    } });
    await allow(h.store);
    expect(await h.recovery.recover(input())).toBeUndefined();
    expect(h.reads).toEqual(["alpha", "beta"]);
    expect(await h.store.lastMemberClaim("codex", "alpha")).toMatchObject({ status: "rejected" });
    expect(JSON.parse(h.logs[1])).toMatchObject({ status: "rejected", outcome });
  });

  test("fails conservatively when the credited ID differs, even with headroom", async () => {
    const h = harness();
    await allow(h.store);
    const recovery = createAutoResetRecovery({ ...h.options, spend: async (...args) => {
      await h.options.spend(...args);
      return { result: "reset", creditId: betaCredit };
    } });
    expect(await recovery.recover(input())).toBeUndefined();
    expect(await h.store.lastMemberClaim("codex", "alpha")).toMatchObject({ status: "unknown", creditedId: betaCredit });
  });

  test("keeps a late automatic mismatch fenced after the caller cancels", async () => {
    const h = harness();
    await allow(h.store);
    const controller = new AbortController();
    const posted = Promise.withResolvers<void>();
    const acknowledge = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    const finish = h.store.finish.bind(h.store);
    h.store.finish = async (...args) => {
      await finish(...args);
      finished.resolve();
    };
    const recovery = createAutoResetRecovery({ ...h.options, spend: async (...args) => {
      const [, , requestId, , evidence] = args;
      evidence.postAttempted(true);
      posted.resolve();
      await acknowledge.promise;
      await h.store.recordReportedCredit(requestId, betaCredit);
      return { result: "reset", creditId: betaCredit };
    } });
    const answer = recovery.recover(input(controller.signal));
    await posted.promise;
    controller.abort();
    expect(await answer).toBeUndefined();
    expect(await h.store.lastMemberClaim("codex", "alpha")).toMatchObject({ status: "pending", creditId: alphaCredit });
    acknowledge.resolve();
    await finished.promise;
    expect(await h.store.lastMemberClaim("codex", "alpha")).toMatchObject({
      status: "unknown", creditId: alphaCredit, creditedId: betaCredit,
    });
  });

  test("requires fresh evidence below the app reserve for the requested model", async () => {
    const h = harness();
    await allow(h.store);
    const recovery = createAutoResetRecovery({ ...h.options, freshUsage: async (identity, signal) => {
      const reading = await h.options.freshUsage(identity, signal);
      if (!reading || !h.recovered.has(identity)) return reading;
      return { ...reading, windows: [...reading.windows!, { label: "week", utilization: 90, model: "specific" }] };
    } });
    expect(await recovery.recover({ ...input(), model: "model-specific" })).toBeUndefined();
    expect(h.spends).toHaveLength(1);
    expect(await h.store.lastMemberClaim("codex", "alpha")).toMatchObject({ status: "reset" });
  });

  test.each([
    { label: "week", utilization: 90, expected: undefined },
    { label: "provider limit", utilization: 100, expected: undefined },
    { label: "session", utilization: Number.NaN, expected: undefined },
    { label: "week", utilization: 89, expected: "alpha" },
  ])("checks every scoped window with no request model ($label, $utilization)", async ({ label, utilization, expected }) => {
    const h = harness();
    await allow(h.store);
    const recovery = createAutoResetRecovery({ ...h.options, freshUsage: async (identity, signal) => {
      const reading = await h.options.freshUsage(identity, signal);
      if (!reading || !h.recovered.has(identity)) return reading;
      return { ...reading, windows: [...reading.windows!,
        { label: "week", utilization: 10, model: "other" },
        { label, utilization, model: "specific" },
      ] };
    } });
    expect(await recovery.recover(input())).toBe(expected);
    expect(h.spends).toHaveLength(1);
  });

  test("waits for imminent natural rollover and confirms headroom before replay", async () => {
    const reset = Date.now() + 150;
    const h = harness(undefined, {
      now: Date.now,
      freshUsage: async (identity) => {
        const at = Date.now();
        return identity === "alpha"
          ? at < reset ? usage(reset, at) : usage(at + 600_000, at, 5)
          : usage(at + 600_000, at);
      },
      readCredits: async () => credits(betaCredit, reset + 60_001),
    });
    await allow(h.store);
    expect(await h.recovery.recover(input())).toBe("alpha");
    expect(h.spends).toEqual([]);
    expect(await h.store.lastClaim("codex", "renewal")).toBeUndefined();
  });

  test.each([59_999, 60_000])("claims before the natural reset when credit expiry is near (%i ms)", async (expiryOffset) => {
    const reset = NOW + 4_000;
    const h = harness(undefined, {
      freshUsage: async (identity) => identity === "alpha"
        ? usage(reset)
        : usage(RESETS.beta, NOW, h.recovered.has(identity) ? 5 : 100),
      readCredits: async (identity) => identity === "beta" ? credits(betaCredit, reset + expiryOffset) : undefined,
    });
    await allow(h.store);
    expect(await h.recovery.recover(input())).toBe("beta");
    expect(h.spends).toHaveLength(1);
    expect(JSON.parse(h.logs[0])).toMatchObject({ status: "pending", imminentResetAt: iso(reset) });
  });

  test("returns fallback without claiming when a natural reset fails to restore headroom", async () => {
    const reset = Date.now() + 150;
    const h = harness(undefined, {
      now: Date.now,
      freshUsage: async (identity) => {
        const at = Date.now();
        const nextReset = identity === "alpha" && at < reset ? reset : reset + 600_000;
        return usage(nextReset, at);
      },
      readCredits: async (identity) => identity === "beta" ? credits(betaCredit, reset + 60_001) : undefined,
    });
    await allow(h.store);
    expect(await h.recovery.recover(input())).toBeUndefined();
    expect(h.spends).toHaveLength(0);
    expect(await h.store.lastClaim("codex", "renewal")).toBeUndefined();
  });

  test("reserves replay time when recovery starts late in the caller's budget", async () => {
    const h = harness();
    await allow(h.store);
    const deadlineAt = performance.now() + 1_500;
    expect(await h.recovery.recover({ ...input(), deadlineAt })).toBeUndefined();
    expect(h.reads).toEqual([]);
    expect(h.spends).toEqual([]);
  });

  test("ends a hung verification on cancellation and never spends", async () => {
    const controller = new AbortController();
    const h = harness(undefined, { freshUsage: () => new Promise(() => {}) });
    await allow(h.store);
    setTimeout(() => controller.abort(), 20);
    expect(await h.recovery.recover(input(controller.signal))).toBeUndefined();
    expect(h.spends).toEqual([]);
  });

  test("keeps a claim when cancelled during spend and marks the outcome unknown", async () => {
    const h = harness();
    await allow(h.store);
    const controller = new AbortController();
    const began = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    const finish = h.store.finish.bind(h.store);
    h.store.finish = async (...args) => {
      await finish(...args);
      finished.resolve();
    };
    const recovery = createAutoResetRecovery({ ...h.options, spend: async () => {
      began.resolve();
      return new Promise(() => {});
    } });
    const pending = recovery.recover(input(controller.signal));
    await began.promise;
    controller.abort();
    expect(await pending).toBeUndefined();
    await finished.promise;
    expect(await h.store.lastMemberClaim("codex", "alpha")).toMatchObject({ status: "unknown" });
  });
});
