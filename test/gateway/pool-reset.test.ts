import { describe, expect, test } from "bun:test";
import type { ManualResetInfo } from "../../src/cli/limits/types.ts";
import { consumeCodexResetForIdentity, type CodexRedemptionGuard } from "../../src/gateway/account.ts";
import { confirmPoolReset, poolResetReview, poolUtilisation } from "../../src/gateway/pool-reset.ts";
import type { PoolResetConfirmation } from "../../src/gateway/pool-reset-view.ts";
import type { PoolUsage } from "../../src/identities/pool/adapter.ts";

const NOW = Date.parse("2026-01-01T00:00:00Z");
const DAY = 86_400_000;
const iso = (value: number) => new Date(value).toISOString();
const creditA = "credit-SYNTHETIC_FIXTURE-a";
const creditB = "credit-SYNTHETIC_FIXTURE-b";
const scope = { tool: "codex", pool: "sample-pool", members: ["sample-a", "sample-b"] } as const;
const pool = { ...scope, members: [...scope.members] };
const usage = (short: number, weekly: number, days = 2): PoolUsage => ({
  status: "live",
  capturedAt: iso(NOW),
  windows: [
    { label: "5h", utilization: short, resetsAt: iso(NOW + DAY / 6) },
    { label: "week", utilization: weekly, resetsAt: iso(NOW + days * DAY) },
  ],
});
const inventory = (id: string, days: number): ManualResetInfo => ({
  availableCount: 1,
  readAt: iso(NOW),
  creditExpiries: [{ id, endsAt: iso(NOW + days * DAY) }],
});

describe("pool threshold and manual reset review", () => {
  test("uses the highest average and requires current readings from all members", () => {
    expect(poolUtilisation([usage(100, 70), usage(80, 80)], NOW)).toEqual({ percent: 90, complete: true });
    expect(poolUtilisation([usage(110, 70), usage(70, 80)], NOW)).toEqual({ percent: 90, complete: true });
    expect(poolUtilisation([usage(100, 70), undefined], NOW)).toEqual({ complete: false });
    expect(poolUtilisation([usage(100, 70), { ...usage(90, 100), stale: true }], NOW)).toEqual({ complete: false });
    expect(poolUtilisation([usage(100, 70), { ...usage(90, 100), capturedAt: iso(NOW - 46_000) }], NOW)).toEqual({ complete: false });
    const shortOnly = { ...usage(100, 70), windows: usage(100, 70).windows?.slice(0, 1) };
    expect(poolUtilisation([shortOnly, usage(80, 80)], NOW)).toEqual({ percent: 90, complete: false });
  });

  test("ranks current credits without opt-ins or weekly exhaustion", () => {
    const readings = [usage(91, 50, 3), usage(93, 40, 2)];
    expect(poolResetReview(pool, readings, [inventory(creditA, 2), inventory(creditB, 1)], new Set(), NOW).candidate?.identity).toBe("sample-b");
    expect(poolResetReview(pool, readings, [inventory(creditA, 1), inventory(creditB, 1)], new Set(), NOW).candidate?.identity).toBe("sample-a");
    expect(poolResetReview(pool, readings, [inventory(creditA, 1), inventory(creditB, 1)], new Set([creditA]), NOW).candidate?.identity).toBe("sample-b");
    expect(poolResetReview(pool, readings, [undefined, inventory(creditB, 1)], new Set(), NOW).availability).toBe("unavailable");
    expect(poolResetReview({ ...pool, tool: "claude" }, readings, [], new Set(), NOW)).toMatchObject({ percent: 92, availability: "unsupported" });
  });
});

function harness(readings = [usage(94, 92), usage(98, 90)]) {
  const review = poolResetReview(pool, readings, [inventory(creditA, 1), inventory(creditB, 2)], new Set(), NOW);
  const confirmation: PoolResetConfirmation = { candidate: review.candidate!, redeemRequestId: crypto.randomUUID() };
  let release = Promise.resolve();
  let locked = false;
  let completedGuards = 0;
  const guard: CodexRedemptionGuard = async (run) => {
    const previous = release;
    let unlock!: () => void;
    release = new Promise<void>((resolve) => { unlock = resolve; });
    await previous;
    locked = true;
    try {
      return await run(async () => { steps.push("invalidate"); });
    } finally {
      locked = false;
      completedGuards++;
      unlock();
    }
  };
  const tried = new Set<string>();
  const requests = new Set<string>();
  const steps: string[] = [];
  const posts: Record<string, unknown>[] = [];
  const postStarted = Promise.withResolvers<void>();
  const assessStarted = Promise.withResolvers<void>();
  const state = {
    waitForPost: Promise.resolve(), waitForAssess: Promise.resolve(), afterJournal: () => {}, review, ambiguous: false,
    verified: true, members: review.members, now: NOW, refreshReview: false, deadlineAt: Infinity,
  };
  const credential = { identity: "sample-a", accessToken: "token-SYNTHETIC_FIXTURE", accountId: "account-SYNTHETIC_FIXTURE" };
  const doFetch = (async (_url, init) => {
    expect(locked).toBe(true);
    if (init?.method === "POST") {
      steps.push("post");
      posts.push(JSON.parse(String(init.body)));
      postStarted.resolve();
      await state.waitForPost;
      if (state.ambiguous) throw new Error("synthetic lost response");
      return Response.json({ code: "reset", windows_reset: 2, credit: { id: creditA } });
    }
    return Response.json({ available_count: 1, credits: [{
      id: creditA, expires_at: iso(NOW + DAY), reset_type: "codex_rate_limits", status: "available",
    }] });
  }) as typeof fetch;
  const run = (selection = confirmation, signal = new AbortController().signal) => confirmPoolReset(pool.pool, selection, signal, {
    now: () => state.now,
    deadlineAt: state.deadlineAt,
    guard,
    journal: {
      manualAttempted: async (id) => tried.has(id),
      markConsumed: async () => { steps.push("consumed"); },
      recordAttempt: async (id, request, identity, accountId) => {
        expect(identity).toBe(credential.identity);
        expect(accountId).toBe(credential.accountId);
        if (tried.has(id) || requests.has(request)) return false;
        steps.push("journal");
        tried.add(id);
        requests.add(request);
        state.afterJournal();
        return true;
      },
      releaseAttempt: async (id, request) => {
        expect(locked).toBe(true);
        steps.push("release");
        tried.delete(id);
        requests.delete(request);
      },
    },
    version: async () => "1",
    assess: async () => {
      if (!locked && state.refreshReview) {
        const fresh = [usage(30, 67), usage(32, 60)].map((reading) => ({ ...reading, capturedAt: iso(state.now) }));
        return { review: poolResetReview(pool, fresh, [], new Set(), state.now), readings: fresh };
      }
      expect(locked).toBe(true);
      assessStarted.resolve();
      await state.waitForAssess;
      return { review: state.review, readings };
    },
    members: async () => state.members,
    spend: (mark, identity, requestId, chosen) => consumeCodexResetForIdentity(identity, requestId, {
      creds: { get: async () => credential, refreshAfter401: async () => credential },
      fetch: doFetch,
    }, chosen, mark),
    reconcile: async (identity, baseline, _at, version) => {
      expect(completedGuards).toBeGreaterThan(0);
      expect(identity).toBe("sample-a");
      expect(baseline).toEqual(readings[0]);
      expect(version).toBe("1");
      return { status: state.verified ? "confirmed" : "pending" };
    },
  });
  return { run, state, posts, steps, confirmation, postStarted: postStarted.promise, assessStarted: assessStarted.promise };
}

describe("pool reset confirmation", () => {
  test("needs a new confirmation when the credit or account changes", async () => {
    const { run, state, posts } = harness();
    state.review = { ...state.review, candidate: { ...state.review.candidate!, identity: "sample-b", creditId: creditB } };
    expect(await run()).toMatchObject({ status: "changed", review: { candidate: { identity: "sample-b", creditId: creditB } } });
    expect(posts).toEqual([]);
  });

  test("holds the spend guard and records exactly one POST across competing requests", async () => {
    const { run, posts, steps, confirmation } = harness();
    expect(await Promise.all([run(), run()])).toEqual([{ status: "confirmed" }, { status: "already_attempted" }]);
    expect(steps).toEqual(["invalidate", "journal", "post", "consumed"]);
    expect(posts).toEqual([{ credit_id: creditA, redeem_request_id: confirmation.redeemRequestId }]);
  });

  test("refuses all repeats after an ambiguous POST, including a new request ID", async () => {
    const { run, state, posts, confirmation } = harness();
    state.ambiguous = true;
    expect(await run()).toEqual({ status: "pending" });
    expect(await run()).toEqual({ status: "already_attempted" });
    expect(await run({ ...confirmation, redeemRequestId: crypto.randomUUID() })).toEqual({ status: "already_attempted" });
    expect(posts).toHaveLength(1);
  });

  test("keeps a reset pending until fresh usage verifies it", async () => {
    const { run, state, posts } = harness();
    state.verified = false;
    expect(await run()).toEqual({ status: "pending" });
    expect(posts).toHaveLength(1);
  });

  test("refuses a changed pool membership before the provider POST", async () => {
    const { run, state, posts } = harness();
    state.members = ["sample-b"];
    expect(await run()).toEqual({ status: "declined" });
    expect(posts).toHaveLength(0);
  });
});

test("late assessment does not journal or send a new POST", async () => {
  const { run, state, steps, confirmation, assessStarted } = harness();
  const assess = Promise.withResolvers<void>();
  const controller = new AbortController();
  state.waitForAssess = assess.promise;
  const attempt = run(confirmation, controller.signal);
  await assessStarted;
  controller.abort();
  assess.resolve();
  await expect(attempt).rejects.toThrow();
  expect(steps).toEqual([]);
});

test("a POST already in progress can finish and still prevents another POST", async () => {
  const { run, state, steps, confirmation, postStarted } = harness();
  const provider = Promise.withResolvers<void>();
  const controller = new AbortController();
  state.waitForPost = provider.promise;
  const attempt = run(confirmation, controller.signal);
  await postStarted;
  controller.abort();
  provider.resolve();
  expect(await attempt).toEqual({ status: "confirmed" });
  expect(await run()).toEqual({ status: "already_attempted" });
  expect(steps).toEqual(["invalidate", "journal", "post", "consumed"]);
});

test("releases an attempt on a definite pre-POST abort and allows the same confirmation to retry", async () => {
  const { run, state, steps, posts, confirmation } = harness();
  const controller = new AbortController();
  state.afterJournal = () => controller.abort();
  await expect(run(confirmation, controller.signal)).resolves.toEqual({ status: "declined" });
  expect(steps).toEqual(["invalidate", "journal", "release"]);
  expect(posts).toHaveLength(0);

  state.afterJournal = () => {};
  expect(await run()).toEqual({ status: "confirmed" });
  expect(posts).toHaveLength(1);
});

test.each([false, true])("checks the remaining crossing proof at the POST boundary (second crossing %s)", async (anotherCrossing) => {
  const readings = [usage(94, anotherCrossing ? 91 : 60), usage(98, anotherCrossing ? 91 : 70)];
  for (const reading of readings) reading.windows![0].resetsAt = iso(NOW + 1_000);
  const { run, state, posts, steps } = harness(readings);
  state.refreshReview = true;
  state.afterJournal = () => { state.now += 1_000; };
  if (anotherCrossing) {
    expect(await run()).toEqual({ status: "confirmed" });
    expect(posts).toHaveLength(1);
  } else {
    expect(await run()).toMatchObject({
      status: "changed", review: { availability: "below_threshold", percent: 63.5, observedAt: NOW + 1_000 },
    });
    expect(steps).toEqual(["invalidate", "journal", "release"]);
    expect(posts).toEqual([]);
  }
});

test("an elapsed preflight deadline stops the POST even before the timeout signal fires", async () => {
  const { run, state, steps, posts } = harness();
  state.deadlineAt = performance.now() - 1;
  expect(await run()).toEqual({ status: "declined" });
  expect(steps).toEqual([]);
  expect(posts).toHaveLength(0);
});
