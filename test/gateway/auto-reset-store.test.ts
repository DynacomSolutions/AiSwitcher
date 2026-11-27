import { describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { MemoryAutoResetStore, PgAutoResetStore, type AutoResetClaimInput, type AutoResetStore } from "../../src/gateway/auto-reset-store.ts";
import { checkCodexRedemptionFence, PgPoolResetJournal } from "../../src/gateway/pool-reset.ts";
import { migrate } from "../../src/gateway/pg-store.ts";

const AT = "2026-11-27T08:00:00.000Z";
const EXPIRES = "2026-11-27T08:30:00.000Z";
const RESET = "2026-11-27T14:00:00.000Z";

function claim(key: string, members = ["alpha", "beta"]): AutoResetClaimInput {
  const names = members.map((name) => `renewal-test-${name}`);
  return {
    eventKey: `renewal-test-${key}`, pool: "renewal-test-pool", identity: names[0],
    creditId: `credit-SYNTHETIC_FIXTURE-${key}`, creditExpiresAt: EXPIRES, startedAt: AT,
    redeemRequestId: randomUUID(),
    usageEvidence: names.map((identity) => ({ identity, resetAt: RESET, capturedAt: AT, weeklyUtilisation: 100 })),
    creditEvidence: {
      reason: "only_candidate",
      inventories: [{ identity: names[0], pools: ["renewal-test-pool"], weeklyResetAt: RESET, availableCount: 1,
        readAt: AT, credits: [{ id: `credit-SYNTHETIC_FIXTURE-${key}`, expiresAt: EXPIRES }] }],
    },
  };
}

async function checkContract(a: AutoResetStore, b: AutoResetStore): Promise<void> {
  const original = claim("original");
  const { pool, identity, eventKey, creditId } = original;
  expect(await a.enabled("pool", pool)).toBeFalse();
  expect(await b.claim(original)).toEqual({ kind: "blocked" });
  await a.setEnabled("pool", pool, true);
  expect(await b.claim(original)).toEqual({ kind: "blocked" });
  await a.setEnabled("identity", identity, true);
  expect(await b.enabled("identity", identity)).toBeTrue();
  await b.setEnabled("pool", pool, false);
  expect(await a.claim(original)).toEqual({ kind: "blocked" });
  await a.setEnabled("pool", pool, true);

  const result = await Promise.all([a.claim(original), b.claim({ ...original, redeemRequestId: randomUUID() })]);
  expect(result.map((r) => r.kind).sort()).toEqual(["created", "existing"]);
  expect(await b.findClaim(eventKey)).toMatchObject({
    pool, identity, creditId, creditExpiresAt: EXPIRES, startedAt: AT, status: "pending", generation: 1,
  });

  await b.finish(eventKey, "reset", creditId);
  await a.finish(eventKey, "rejected");
  expect(await a.lastClaim("identity", identity)).toMatchObject({ status: "reset", creditedId: creditId });
  expect(await b.lastClaim("pool", pool)).toMatchObject({ status: "reset", creditedId: creditId });

  const overlap = claim("overlap", ["beta", "gamma"]);
  await a.setEnabled("identity", overlap.identity, true);
  expect(await b.claim(overlap)).toEqual({ kind: "blocked" });
  const disjoint = claim("disjoint", ["gamma"]);
  await a.setEnabled("identity", disjoint.identity, true);
  expect(await b.claim({ ...disjoint, creditId })).toEqual({ kind: "blocked" });
  expect(await b.claim(disjoint)).toEqual({ kind: "created" });
}

const dated = (offset: number): string => new Date(Date.parse(AT) + offset).toISOString();

async function checkRearm(
  a: AutoResetStore, b: AutoResetStore, ageFirstClaim: (eventKey: string) => Promise<void>,
): Promise<string> {
  const first = claim("generation-first", ["epsilon", "zeta"]);
  const { pool, identity, eventKey, redeemRequestId } = first;
  const next: AutoResetClaimInput = {
    ...claim("generation-next", ["epsilon", "zeta"]),
    eventKey,
    startedAt: dated(2_000),
    provider429At: Date.parse(dated(1_900)),
    usageEvidence: first.usageEvidence.map((row) => ({ ...row, capturedAt: dated(1_950) })),
  };
  const settledAt = dated(5);
  const recoveredAt = dated(800);
  await a.setEnabled("pool", pool, true);
  await a.setEnabled("identity", identity, true);
  expect(await a.claim(first)).toEqual({ kind: "created" });
  await b.markRecovered(eventKey, redeemRequestId, recoveredAt);
  expect(await b.findClaim(eventKey)).toMatchObject({ generation: 1, status: "pending" });

  await a.finish(eventKey, "reset", first.creditId, { redeemRequestId, finishedAt: settledAt, outcome: "reset" });
  expect((await b.claim(next)).kind).toBe("existing");
  await b.markRecovered(eventKey, redeemRequestId, dated(4));
  expect((await a.findClaim(eventKey))?.recoveredAt).toBeUndefined();
  await b.markRecovered(eventKey, redeemRequestId, recoveredAt);
  await a.markRecovered(eventKey, redeemRequestId, dated(1_000));
  expect((await b.findClaim(eventKey))?.recoveredAt).toBe(recoveredAt);

  expect(await b.claim(next)).toEqual({ kind: "blocked" });
  await ageFirstClaim(eventKey);
  for (const provider429At of [undefined, Date.parse(dated(700)), Date.parse(recoveredAt), Date.parse(dated(2_001))]) {
    expect((await b.claim({ ...next, provider429At })).kind).toBe("existing");
  }
  expect((await b.claim({ ...next, usageEvidence: first.usageEvidence })).kind).toBe("existing");
  const partial = [next.usageEvidence[0], { ...next.usageEvidence[1], weeklyUtilisation: 99 }];
  expect((await b.claim({ ...next, usageEvidence: partial })).kind).toBe("existing");
  expect(await b.claim({ ...next, creditId: first.creditId })).toEqual({ kind: "blocked" });

  const other = { ...next, creditId: "credit-SYNTHETIC_FIXTURE-racing", redeemRequestId: randomUUID() };
  const results = await Promise.all([a.claim(next), b.claim(other)]);
  expect(results.map(({ kind }) => kind).sort()).toEqual(["created", "existing"]);
  const follower = results.find((result) => result.kind === "existing");
  expect(follower).toMatchObject({ kind: "existing", claim: { generation: 2, status: "pending" } });
  const second = (await a.findClaim(eventKey))!;
  const winning = [next, other].find((planned) => planned.redeemRequestId === second.redeemRequestId)!;
  expect(second.creditId).toBe(winning.creditId);
  await b.finish(eventKey, "unknown", undefined, { redeemRequestId, finishedAt: settledAt, outcome: "consume_unknown" });
  expect((await a.findClaim(eventKey))?.status).toBe("pending");
  expect(await b.findClaim(eventKey, 1)).toMatchObject({ generation: 1, status: "reset", recoveredAt, creditId: first.creditId });
  await a.finish(eventKey, "reset", second.creditId, {
    redeemRequestId: second.redeemRequestId, finishedAt: dated(2_100), outcome: "reset",
  });
  await b.markRecovered(eventKey, second.redeemRequestId, dated(2_200));
  await ageFirstClaim(eventKey);
  expect(await a.claim({
    ...next, startedAt: dated(2_300), creditId: "credit-SYNTHETIC_FIXTURE-old", redeemRequestId: randomUUID(),
  })).toMatchObject({ kind: "existing", claim: { generation: 2, recoveredAt: dated(2_200) } });
  return eventKey;
}

async function checkReportedCreditFence(store: AutoResetStore) {
  const original = claim("reported-original", ["reporter"]);
  const next = claim("reported-another", ["other"]);
  await store.setEnabled("pool", original.pool, true);
  await store.setEnabled("identity", original.identity, true);
  await store.setEnabled("identity", next.identity, true);
  expect(await store.claim(original)).toEqual({ kind: "created" });
  await store.recordReportedCredit(original.redeemRequestId, next.creditId);
  expect(await store.claim(next)).toEqual({ kind: "blocked" });
  await store.finish(original.eventKey, "unknown");
  expect(await store.lastClaim("identity", original.identity)).toMatchObject({
    status: "unknown", creditId: original.creditId, creditedId: next.creditId,
  });
  expect(await store.claim(next)).toEqual({ kind: "blocked" });
  return { original, next };
}

describe("memory Codex renewal store", () => {
  test("fences both the requested and reported credit across claims", async () => {
    await checkReportedCreditFence(new MemoryAutoResetStore());
  });

  test("shares settings, claims one winner and blocks duplicate credits and overlapping evidence", async () => {
    const store = new MemoryAutoResetStore();
    await checkContract(store, store);
  });

  test("rearms only after confirmed recovery and lets racing requests join one generation", async () => {
    let clock = Date.parse(AT);
    const store = new MemoryAutoResetStore(() => clock);
    await checkRearm(store, store, async () => { clock += 25_000; });
  });

  test.each(["pending", "rejected", "unknown", "mismatched"] as const)(
    "keeps a %s claim closed to future generations", async (outcome) => {
      let clock = Date.parse(AT);
      const store = new MemoryAutoResetStore(() => clock);
      const first = claim(outcome);
      await store.setEnabled("pool", first.pool, true);
      await store.setEnabled("identity", first.identity, true);
      await store.claim(first);
      if (outcome !== "pending") {
        await store.finish(first.eventKey, outcome === "mismatched" ? "reset" : outcome, "credit-SYNTHETIC_FIXTURE-wrong");
      }
      await store.markRecovered(first.eventKey, first.redeemRequestId, dated(10));
      expect((await store.findClaim(first.eventKey))?.recoveredAt).toBeUndefined();
      clock += 25_000;
      expect(await store.claim({
        ...claim("second"), eventKey: first.eventKey, startedAt: dated(25_000),
        provider429At: Date.parse(dated(25_000)),
        usageEvidence: first.usageEvidence.map((row) => ({ ...row, capturedAt: dated(25_000) })),
      })).toMatchObject({ kind: "existing", claim: { generation: 1 } });
    },
  );

  test("bounds the guard on different overlapping events and keeps exact events and credits", async () => {
    let clock = Date.now();
    const store = new MemoryAutoResetStore(() => clock);
    const original = claim("early");
    const later = claim("later");
    await store.setEnabled("pool", original.pool, true);
    await store.setEnabled("identity", original.identity, true);
    expect(await store.claim(original)).toEqual({ kind: "created" });
    clock += 24_999;
    expect(await store.claim(later)).toEqual({ kind: "blocked" });
    clock++;
    expect(await store.claim({ ...later, creditId: original.creditId })).toEqual({ kind: "blocked" });
    expect(await store.claim(later)).toEqual({ kind: "created" });
    expect((await store.claim(original)).kind).toBe("existing");
  });
});

const url = process.env.AIS_GATEWAY_TEST_DATABASE_URL;
const optOut = process.env.AIS_GATEWAY_TEST_NO_DATABASE === "1";

if (!url && process.env.CI && !optOut) {
  test("PostgreSQL renewal tests need AIS_GATEWAY_TEST_DATABASE_URL in CI", () => {
    throw new Error("AIS_GATEWAY_TEST_DATABASE_URL is unset in CI; provide a PostgreSQL service or set AIS_GATEWAY_TEST_NO_DATABASE=1");
  });
} else if (!url) {
  test.skip("PostgreSQL renewal tests need AIS_GATEWAY_TEST_DATABASE_URL", () => {});
} else {
  if (!new URL(url).pathname.includes("test")) throw new Error("The PostgreSQL renewal test needs a database with test in its name");

  test("separate PostgreSQL clients share permissions, claim one winner and preserve audit evidence", async () => {
    await migrate(url);
    const sqlA = new SQL(url, { max: 2 });
    const sqlB = new SQL(url, { max: 2 });
    try {
      const a = new PgAutoResetStore(sqlA);
      const b = new PgAutoResetStore(sqlB);
      await checkContract(a, b);

      const { original: reporting, next: reported } = await checkReportedCreditFence(a);
      const journal = new PgPoolResetJournal(sqlB);
      const reportedIds = [reporting.creditId, reported.creditId];
      expect(await journal.usedCredits(reportedIds)).toEqual(new Set(reportedIds));
      expect(await journal.usedCredits(reportedIds, reporting.redeemRequestId)).toEqual(new Set([reported.creditId]));
      const context = {
        credential: { identity: reporting.identity, accessToken: "access-SYNTHETIC_FIXTURE-reported" },
        inventory: async () => ({ available_count: 1, credits: [{ id: reported.creditId, status: "available" }] }),
      };
      await expect(checkCodexRedemptionFence(journal, reporting.identity, context)).rejects.toThrow("already attempted");
      await expect(checkCodexRedemptionFence(journal, reporting.identity, {
        ...context, creditId: reported.creditId,
      }, reporting.redeemRequestId)).rejects.toThrow("already attempted");

      const poolReported = claim("reported-by-pool", ["other"]);
      const poolRequestedId = "credit-SYNTHETIC_FIXTURE-confirmed-requested";
      const accountId = "account-SYNTHETIC_FIXTURE-confirmed";
      const reservation = randomUUID();
      const writer = new PgPoolResetJournal(sqlA);
      const member = poolReported.identity;
      const alias = claim("same-provider-account", ["alias"]).identity;
      const explicit = {
        ...context, creditId: poolReported.creditId,
        credential: { ...context.credential, identity: alias, accountId },
      };
      const unspecified = {
        ...explicit, creditId: undefined,
        inventory: async () => ({ available_count: 1, credits: [{ id: poolReported.creditId, status: "available" }] }),
      };
      try {
        expect(await writer.recordAttempt(poolRequestedId, randomUUID(), member, reservation, accountId)).toBe(true);
        await journal.releaseAttempt(poolRequestedId, randomUUID());
        await expect(checkCodexRedemptionFence(journal, alias, explicit)).rejects.toThrow("unresolved outcome");
        await expect(checkCodexRedemptionFence(journal, alias, unspecified)).rejects.toThrow("unresolved outcome");
        expect(await journal.accountOutcomePending(member)).toBe(true);
        expect(await journal.accountOutcomePending(reporting.identity)).toBe(false);
        expect(await journal.recordAttempt(poolReported.creditId, randomUUID(), alias, randomUUID(), accountId)).toBe(false);
        await a.setEnabled("identity", member, true);
        expect(await b.claim(poolReported)).toEqual({ kind: "blocked" });

        // Roll back both writes to simulate failures before commit.
        for (let retry = 0; retry < 2; retry++) {
          await expect(sqlA.begin(async (tx) => {
            await tx`UPDATE codex_pool_reset_attempts SET credited_id = ${poolReported.creditId}, outcome = 'reset'
              WHERE reservation_id = ${reservation}::uuid`;
            throw new Error("synthetic failure before commit");
          })).rejects.toThrow("synthetic failure before commit");
        }
        expect(await journal.usedCredits([poolReported.creditId])).toEqual(new Set());
        await expect(checkCodexRedemptionFence(journal, alias, explicit)).rejects.toThrow("unresolved outcome");
        await expect(checkCodexRedemptionFence(journal, alias, unspecified)).rejects.toThrow("unresolved outcome");

        await writer.recordOutcome(poolRequestedId, reservation, poolReported.creditId, "reset");
        await writer.recordOutcome(poolRequestedId, reservation, poolReported.creditId, "reset");
        await journal.releaseAttempt(poolRequestedId, reservation);
        expect(await journal.accountOutcomePending(alias, accountId)).toBe(false);
        expect(await journal.usedCredits([poolRequestedId, poolReported.creditId])).toEqual(new Set([poolRequestedId, poolReported.creditId]));
        await expect(checkCodexRedemptionFence(journal, alias, explicit)).rejects.toThrow("already attempted");
        await expect(checkCodexRedemptionFence(journal, alias, {
          ...explicit, creditId: "credit-SYNTHETIC_FIXTURE-next",
        })).resolves.toBeUndefined();
        expect(await b.claim(poolReported)).toEqual({ kind: "blocked" });
      } finally {
        await sqlA`DELETE FROM codex_pool_reset_attempts WHERE credit_id = ${poolRequestedId}`;
      }

      const automatic = claim("armed-automatic", ["auto-pending"]);
      await a.setEnabled("identity", automatic.identity, true);
      expect(await a.claim(automatic)).toEqual({ kind: "created" });
      expect(await a.beginSpend(automatic.redeemRequestId, automatic.identity, accountId)).toBe(true);
      expect(await b.beginSpend(automatic.redeemRequestId, automatic.identity, accountId)).toBe(false);
      await expect(checkCodexRedemptionFence(journal, alias, explicit)).rejects.toThrow("unresolved outcome");
      await expect(checkCodexRedemptionFence(journal, alias, unspecified)).rejects.toThrow("unresolved outcome");
      expect(await b.lastClaim("identity", automatic.identity)).toMatchObject({ spendPending: true });
      await a.finish(automatic.eventKey, "unknown", undefined, {
        redeemRequestId: automatic.redeemRequestId, finishedAt: AT, outcome: "consume_unknown",
      });
      expect(await journal.accountOutcomePending(alias, accountId)).toBe(true);
      await a.recordReportedCredit(automatic.redeemRequestId, poolReported.creditId, "reset");
      expect(await journal.accountOutcomePending(alias, accountId)).toBe(false);
      expect(await journal.usedCredits([poolReported.creditId])).toEqual(new Set([poolReported.creditId]));

      const original = claim("original");
      const rows = await sqlA`SELECT redeem_request_id, usage_evidence, credit_evidence, finished_at FROM codex_auto_reset_claims
        WHERE event_key = ${original.eventKey}`;
      expect(rows[0]?.redeem_request_id).toMatch(/^[0-9a-f-]{36}$/i);
      expect(rows[0]?.usage_evidence).toEqual(original.usageEvidence);
      expect(rows[0]?.credit_evidence).toEqual(original.creditEvidence);
      expect(rows[0]?.finished_at).toBeInstanceOf(Date);

      const eventKey = await checkRearm(a, b, async (key) => {
        await sqlA`UPDATE codex_auto_reset_claims SET recorded_at = statement_timestamp() - interval '25 seconds'
          WHERE event_key = ${key}`;
      });
      const generations = await sqlB`SELECT generation, provider_429_at, recovered_at, outcome FROM codex_auto_reset_claims
        WHERE event_key = ${eventKey} ORDER BY generation`;
      expect(generations).toEqual([
        { generation: 1, provider_429_at: null, recovered_at: new Date(dated(800)), outcome: "reset" },
        { generation: 2, provider_429_at: new Date(dated(1_900)), recovered_at: new Date(dated(2_200)), outcome: "reset" },
      ]);

      const target = claim("disabled-during-claim", ["delta"]);
      await a.setEnabled("identity", target.identity, true);
      const updated = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const disable = sqlA.begin(async (tx) => {
        await tx`UPDATE codex_auto_reset_settings SET enabled = false WHERE kind = 'identity' AND name = ${target.identity}`;
        updated.resolve();
        await release.promise;
      });
      await updated.promise;
      const pending = b.claim(target);
      await wait(50);
      release.resolve();
      await disable;
      expect(await pending).toEqual({ kind: "blocked" });
      expect(await a.findClaim(target.eventKey)).toBeUndefined();
    } finally {
      await sqlA`DELETE FROM codex_auto_reset_claims WHERE left(event_key, 13) = 'renewal-test-'`;
      await sqlA`DELETE FROM codex_auto_reset_settings WHERE left(name, 13) = 'renewal-test-'`;
      await Promise.all([sqlA.close(), sqlB.close()]);
    }
  }, 10_000);
}
