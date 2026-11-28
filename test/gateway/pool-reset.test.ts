import { type SQL } from "bun";
import { describe, expect, test } from "bun:test";
import type { ManualResetInfo } from "../../src/cli/limits/types.ts";
import { consumeCodexResetForIdentity, type CodexRedemptionGuard } from "../../src/gateway/account.ts";
import { codexResetRelieved, checkCodexRedemptionFence, confirmPoolReset, PgPoolResetJournal, PoolResetReservationCleanup, poolResetReview, poolUtilisation, poolWindowKey } from "../../src/gateway/pool-reset.ts";
import type { PoolResetConfirmation } from "../../src/gateway/pool-reset-view.ts";
import type { PoolUsage } from "../../src/identities/pool/adapter.ts";
import { PrometheusMetrics } from "../../src/gateway/metrics.ts";
import { createResetLogger, MemoryResetLog, type ResetLogger } from "../../src/gateway/reset-log.ts";

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
    expect(poolResetReview(pool, readings, [inventory(creditA, 1), inventory(creditB, 2)], new Set(), NOW, new Set(["sample-a"])).candidate?.identity).toBe("sample-b");
    expect(poolResetReview(pool, readings, [inventory(creditA, 1), inventory(creditB, 2)], new Set(), NOW, new Set(pool.members)).availability).toBe("unavailable");
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
      await cleanup.retry();
      return await run(async () => { steps.push("invalidate"); });
    } finally {
      locked = false;
      completedGuards++;
      unlock();
    }
  };
  const tried = new Map<string, { request: string; reservation: string; resolved: boolean }>();
  const reported = new Set<string>();
  const requests = new Set<string>();
  const steps: string[] = [];
  const posts: Record<string, unknown>[] = [];
  const postStarted = Promise.withResolvers<void>();
  const assessStarted = Promise.withResolvers<void>();
  const state = {
    waitForPost: Promise.resolve(), waitForAssess: Promise.resolve(), afterJournal: () => {}, review, ambiguous: false,
    releaseFailures: 0, outcomeFailures: 0, windowsReset: 1 as number | undefined, reportedCredit: creditA as string | null | undefined, verified: true, members: review.members, now: NOW, refreshReview: false, deadlineAt: Infinity,
    resetLog: undefined as ResetLogger | undefined,
  };
  const cleanup = new PoolResetReservationCleanup(async (id, reservation) => {
    expect(locked).toBe(true);
    steps.push("release");
    if (state.releaseFailures > 0) {
      state.releaseFailures--;
      throw new Error("synthetic release failure");
    }
    const row = tried.get(id);
    if (row?.reservation !== reservation) return;
    tried.delete(id);
    requests.delete(row.request);
  });
  const credential = { identity: "sample-a", accessToken: "token-SYNTHETIC_FIXTURE", accountId: "account-SYNTHETIC_FIXTURE" };
  const doFetch = (async (_url, init) => {
    expect(locked).toBe(true);
    if (init?.method === "POST") {
      steps.push("post");
      posts.push(JSON.parse(String(init.body)));
      postStarted.resolve();
      await state.waitForPost;
      if (state.ambiguous) throw new Error("synthetic lost response");
      return Response.json({
        code: "reset", windows_reset: state.windowsReset,
        ...(state.reportedCredit === undefined ? {} : { credit: { id: state.reportedCredit } }),
      });
    }
    return Response.json({ available_count: 1, credits: [{
      id: creditA, expires_at: iso(NOW + DAY), reset_type: "codex_rate_limits", status: "available",
    }] });
  }) as typeof fetch;
  const run = (selection = confirmation, signal = new AbortController().signal) => confirmPoolReset(pool.pool, selection, signal, {
    now: () => state.now,
    get deadlineAt() { return state.deadlineAt; },
    get resetLog() { return state.resetLog; },
    guard,
    cleanup,
    journal: {
      manualAttempted: async (id) => tried.has(id) || reported.has(id),
      recordAttempt: async (id, request, identity, reservation, accountId) => {
        expect(identity).toBe(credential.identity);
        expect(accountId).toBe(credential.accountId);
        if (tried.has(id) || requests.has(request)) return false;
        steps.push("journal");
        tried.set(id, { request, reservation, resolved: false });
        requests.add(request);
        state.afterJournal();
        return true;
      },
      recordObservedCredit: async (id, reservation, reportedId) => {
        expect(locked).toBe(true);
        expect(tried.get(id)?.reservation).toBe(reservation);
        reported.add(reportedId);
      },
      recordOutcome: async (id, reservation, reportedId, outcome, recovery) => {
        expect(locked).toBe(true);
        const row = tried.get(id)!;
        expect(row.reservation).toBe(reservation);
        expect(outcome).toBe("reset");
        steps.push(recovery ? "consumed" : "reported");
        if (state.outcomeFailures > 0) {
          state.outcomeFailures--;
          throw new Error("synthetic failure before commit");
        }
        row.resolved = true;
        reported.add(reportedId);
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
  const otherReplica = {
    accountOutcomePending: async () => [...tried.values()].some((row) => !row.resolved),
    usedCredits: async (ids: string[]) => new Set(ids.filter((id) => tried.has(id) || reported.has(id))),
    inventoryFenceScope: async () => ({ any: tried.size > 0, relevant: tried.size > 0 }),
  };
  return { run, state, posts, steps, confirmation, credential, otherReplica, postStarted: postStarted.promise, assessStarted: assessStarted.promise };
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

test("retries a failed reservation release under the shared lock before the next confirmation", async () => {
  const { run, state, steps, posts } = harness();
  const controller = new AbortController();
  state.releaseFailures = 1;
  state.afterJournal = () => controller.abort();
  expect(await run(undefined, controller.signal)).toEqual({ status: "declined" });
  expect(steps).toEqual(["invalidate", "journal", "release"]);
  expect(posts).toHaveLength(0);

  state.afterJournal = () => {};
  expect(await run()).toEqual({ status: "confirmed" });
  expect(steps).toEqual(["invalidate", "journal", "release", "release", "invalidate", "journal", "post", "consumed"]);
  expect(posts).toHaveLength(1);
});

test("retains both credit IDs from a confirmed pool POST that reports a different ID", async () => {
  const { run, state, steps, posts, confirmation } = harness();
  state.reportedCredit = creditB;
  expect(await run()).toEqual({ status: "pending" });
  expect(steps).toEqual(["invalidate", "journal", "post", "reported"]);
  expect(await run()).toEqual({ status: "already_attempted" });
  expect(await run({
    candidate: { ...confirmation.candidate, creditId: creditB }, redeemRequestId: crypto.randomUUID(),
  })).toEqual({ status: "already_attempted" });
  expect(posts).toHaveLength(1);
});

test("two failed outcome writes leave every credit on the account fenced on another replica", async () => {
  const { run, state, steps, posts, otherReplica, credential } = harness();
  state.reportedCredit = creditB;
  state.outcomeFailures = 2;
  expect(await run()).toEqual({ status: "pending" });
  expect(steps).toEqual(["invalidate", "journal", "post", "reported", "reported"]);

  const context = {
    credential,
    inventory: async () => ({ available_count: 1, credits: [{ id: creditB, status: "available" }] }),
  };
  expect(await otherReplica.usedCredits([creditB])).toEqual(new Set());
  await expect(checkCodexRedemptionFence(otherReplica, credential.identity, { ...context, creditId: creditB }))
    .rejects.toThrow("unresolved outcome");
  await expect(checkCodexRedemptionFence(otherReplica, credential.identity, context)).rejects.toThrow("unresolved outcome");
  expect(posts).toHaveLength(1);
});

test("a known success clears the account fence and retains its credit fence", async () => {
  const { run, otherReplica, credential } = harness();
  expect(await run()).toEqual({ status: "confirmed" });
  const context = {
    credential,
    inventory: async () => ({ available_count: 1, credits: [{ id: creditB, status: "available" }] }),
  };
  await expect(checkCodexRedemptionFence(otherReplica, credential.identity, { ...context, creditId: creditA }))
    .rejects.toThrow("already attempted");
  await expect(checkCodexRedemptionFence(otherReplica, credential.identity, { ...context, creditId: creditB })).resolves.toBeUndefined();
  await expect(checkCodexRedemptionFence(otherReplica, credential.identity, context)).resolves.toBeUndefined();
});

test("a standard success without a credit field records the requested credit and verifies relief", async () => {
  const { run, state, steps, otherReplica } = harness();
  state.reportedCredit = undefined;
  expect(await run()).toEqual({ status: "confirmed" });
  expect(steps).toEqual(["invalidate", "journal", "post", "consumed"]);
  expect(await otherReplica.accountOutcomePending()).toBe(false);
  expect(await otherReplica.usedCredits([creditA])).toEqual(new Set([creditA]));
});

test("an invalid explicit credit field leaves the account fence in place", async () => {
  const { run, state, otherReplica } = harness();
  state.reportedCredit = null;
  expect(await run()).toEqual({ status: "pending" });
  expect(await otherReplica.accountOutcomePending()).toBe(true);
});

test("a malformed response can fence a reported credit without clearing the account guard", async () => {
  const { run, state, otherReplica } = harness();
  state.reportedCredit = creditB;
  state.windowsReset = undefined;
  expect(await run()).toEqual({ status: "pending" });
  expect(await otherReplica.usedCredits([creditB])).toEqual(new Set([creditB]));
  expect(await otherReplica.accountOutcomePending()).toBe(true);
});

test("requires relief before the baseline window resets naturally", () => {
  const baseline = usage(94, 92);
  const resetAt = Date.parse(baseline.windows![0].resetsAt!);
  const after = (at: number): PoolUsage => ({
    ...baseline, capturedAt: iso(at),
    windows: [{ label: "5h", utilization: 10, resetsAt: iso(resetAt + DAY) }, baseline.windows![1]],
  });
  expect(codexResetRelieved(after(resetAt - 1), NOW + 1, baseline)).toBe(true);
  expect(codexResetRelieved(after(resetAt), NOW + 1, baseline)).toBe(false);
  expect(codexResetRelieved(after(resetAt + 1), NOW + 1, baseline)).toBe(false);
});

test("persisted recovery verifies only a window with a known future natural reset", async () => {
  const [baseline] = usage(94, 92).windows!;
  const key = poolWindowKey(baseline);
  const consumedAt = new Date(NOW + 1);
  const resetAt = Date.parse(baseline.resetsAt!);
  let proof: Record<string, unknown> = { [key]: baseline.utilization };
  const sql = (async (query: TemplateStringsArray) => {
    expect(query.join(" ")).toContain("SELECT attempt.version");
    return [{ version: "7", consumed_at: consumedAt, baseline: proof }];
  }) as unknown as SQL;
  const verified: Array<[string, string]> = [];
  const journal = new PgPoolResetJournal(sql);
  journal.markVerified = async (identity, version) => { verified.push([identity, version]); };
  const fresh = (at: number): PoolUsage => ({
    ...usage(10, 92), capturedAt: iso(at), windows: [{ ...baseline, utilization: 10, resetsAt: iso(resetAt + DAY) }],
  });
  await journal.reconcileReading("sample-a", fresh(resetAt - 1));
  expect(verified).toEqual([]);

  proof = { [key]: { utilisation: baseline.utilization, resetsAt: baseline.resetsAt } };
  await journal.reconcileReading("sample-a", fresh(resetAt));
  expect(verified).toEqual([]);
  await journal.reconcileReading("sample-a", fresh(resetAt - 1));
  expect(verified).toEqual([["sample-a", "7"]]);
});

test("does not send the POST if the deadline expires during reservation", async () => {
  const { run, state, steps, posts } = harness();
  state.afterJournal = () => { state.deadlineAt = performance.now() - 1; };
  expect(await run()).toEqual({ status: "declined" });
  expect(steps).toEqual(["invalidate", "journal", "release"]);
  expect(posts).toHaveLength(0);
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

describe("pool reset log", () => {
  function logged(over: { failInserts?: boolean } = {}) {
    const h = harness();
    const store = new MemoryResetLog();
    store.failInserts = over.failInserts === true;
    const metrics = new PrometheusMetrics({ ledgerDepth: () => 0, ledgerDropped: () => 0 });
    h.state.resetLog = createResetLogger({ store, metrics, now: () => NOW, log: () => {} });
    return { ...h, store, metrics };
  }

  test("a confirmed reset writes one row with the windows of the reading that the decision used", async () => {
    const { run, store, metrics, confirmation } = logged();
    expect(await run()).toEqual({ status: "confirmed" });
    const rows = (await store.list({})).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: "codex", trigger: "manual", actor: "pool-route", identity: "sample-a", pool: "sample-pool",
      grantId: confirmation.candidate.creditId, account: "account-SYNTHETIC_FIXTURE", outcome: "reset",
    });
    expect(rows[0]?.before.map((window) => [window.key, window.percent])).toEqual([["five_hour", 94], ["weekly", 92]]);
    expect(metrics.render()).toContain('ais_gateway_resets_total{provider="codex",trigger="manual",outcome="reset"} 1');
  });

  test("a reset that the provider accepted is a reset even while the relief check is pending", async () => {
    const { run, state, store } = logged();
    state.verified = false;
    expect(await run()).toEqual({ status: "pending" });
    expect((await store.list({})).rows.map((row) => row.outcome)).toEqual(["reset"]);
  });

  test("a lost answer is an error row, and a repeat is an already redeemed row", async () => {
    const { run, state, store } = logged();
    state.ambiguous = true;
    expect(await run()).toEqual({ status: "pending" });
    expect(await run()).toEqual({ status: "already_attempted" });
    const rows = (await store.list({})).rows.reverse();
    expect(rows.map((row) => row.outcome)).toEqual(["error", "already_redeemed"]);
    expect(rows[0]?.message).toContain("no recorded outcome");
  });

  test("a changed candidate and a changed membership write a rejected or no credit row and send nothing", async () => {
    const changed = logged();
    changed.state.review = { ...changed.state.review, candidate: { ...changed.state.review.candidate!, identity: "sample-b", creditId: creditB } };
    expect(await changed.run()).toMatchObject({ status: "changed" });
    expect((await changed.store.list({})).rows.map((row) => row.outcome)).toEqual(["rejected"]);
    expect(changed.posts).toEqual([]);

    const members = logged();
    members.state.members = ["sample-b"];
    expect(await members.run()).toEqual({ status: "declined" });
    expect((await members.store.list({})).rows.map((row) => row.outcome)).toEqual(["no_credit"]);
    expect(members.posts).toEqual([]);
  });

  test("a failure that stops the confirmation still writes its row, and a failed write never blocks the reset", async () => {
    const aborted = logged();
    const controller = new AbortController();
    aborted.state.afterJournal = () => controller.abort();
    await aborted.run(aborted.confirmation, controller.signal);
    expect((await aborted.store.list({})).rows).toHaveLength(1);

    const broken = logged({ failInserts: true });
    expect(await broken.run()).toEqual({ status: "confirmed" });
    expect(broken.posts).toHaveLength(1);
    expect(broken.metrics.render()).toContain('ais_gateway_reset_log_write_failures_total{provider="codex"} 1');
  });
});
