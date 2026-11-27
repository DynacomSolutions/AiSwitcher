import type { SQL } from "bun";
import type { ManualResetInfo } from "../cli/limits/types.ts";
import type { PoolUsage } from "../identities/pool/adapter.ts";
import { CodexResetFenced, type BeforeCodexPost, type CodexCreditSelection, type CodexPostContext, type CodexRedemptionGuard, type consumeCodexResetForIdentity } from "./account.ts";
import { bounded } from "./refresh-guard.ts";
import { chooseAutoResetCandidate, liveCredits, MIN_WEEKLY_REMAINING_MS, weeklyWindow } from "./auto-reset.ts";
import { POOL_RESET_THRESHOLD, type PoolResetCandidate, type PoolResetConfirmation, type PoolResetResult, type PoolResetReview, type PoolThreshold } from "./pool-reset-view.ts";
import type { GatewayProvider } from "./types.ts";
import { codexCreditIds, USAGE_TTL_MS } from "./usage-source.ts";

export const poolWindowKey = (window: NonNullable<PoolUsage["windows"]>[number]): string =>
  JSON.stringify([window.label.trim().toLowerCase(), window.model?.trim().toLowerCase() ?? ""]);

export function poolUtilisation(readings: ReadonlyArray<PoolUsage | undefined>, now: number): Pick<PoolThreshold, "percent" | "complete"> {
  if (!readings.length) return { complete: false };
  const windows = new Map<string, number[]>();
  let complete = true;
  for (const reading of readings) {
    const age = now - Date.parse(reading?.capturedAt ?? "");
    if (!reading?.windows?.length || reading.stale || reading.noPlan || reading.status === "unavailable" || !(age >= 0 && age <= USAGE_TTL_MS)) {
      return { complete: false };
    }
    if ("incompleteWindows" in reading && reading.incompleteWindows === true) complete = false;
    const seen = new Set<string>();
    for (const window of reading.windows) {
      const key = poolWindowKey(window);
      if (seen.has(key)) return { complete: false };
      seen.add(key);
      const reset = window.resetsAt === undefined ? Infinity : Date.parse(window.resetsAt);
      if (!window.label.trim() || !(reset > now) || !Number.isFinite(window.utilization) || window.utilization < 0) {
        complete = false;
        continue;
      }
      const values = windows.get(key) ?? [];
      values.push(window.utilization);
      windows.set(key, values);
    }
  }
  const averages = [];
  for (const values of windows.values()) {
    if (values.length !== readings.length) complete = false;
    else averages.push(values.reduce((total, value) => total + value, 0) / readings.length);
  }
  return averages.length ? { percent: Math.max(...averages), complete } : { complete: false };
}

function usageProof(reading: PoolUsage) {
  return Object.fromEntries((reading.windows ?? []).map((window) => [poolWindowKey(window), {
    utilisation: window.utilization, resetsAt: window.resetsAt,
  }]));
}

function provesRelief(reading: PoolUsage | undefined, consumedAt: number, baseline: unknown): boolean {
  if (!reading || reading.stale || reading.status === "unavailable" || !baseline || typeof baseline !== "object") return false;
  const capturedAt = Date.parse(reading.capturedAt);
  if (!(capturedAt > consumedAt)) return false;
  return reading.windows?.some((window) => {
    const original = (baseline as Record<string, unknown>)[poolWindowKey(window)];
    // Older proofs stored a number and lack evidence of when the window would reset.
    if (!original || typeof original !== "object") return false;
    const { utilisation, resetsAt } = original as { utilisation?: unknown; resetsAt?: unknown };
    return typeof utilisation === "number" && typeof resetsAt === "string" && Date.parse(resetsAt) > capturedAt &&
      (window.resetsAt === undefined || Date.parse(window.resetsAt) > capturedAt) &&
      Number.isFinite(window.utilization) && window.utilization >= 0 && window.utilization < utilisation;
  }) === true;
}

export function codexResetRelieved(reading: PoolUsage | undefined, consumedAt: number, baseline: PoolUsage | undefined): boolean {
  return !!baseline && provesRelief(reading, consumedAt, usageProof(baseline));
}

export interface NamedGatewayPool {
  tool: GatewayProvider;
  pool: string;
  members: string[];
}

export function poolResetReview(
  scope: NamedGatewayPool,
  readings: ReadonlyArray<PoolUsage | undefined>,
  inventories: ReadonlyArray<ManualResetInfo | undefined>,
  usedCredits: ReadonlySet<string>,
  now: number,
): PoolResetReview {
  const review = { ...scope, ...poolUtilisation(readings, now), observedAt: now };
  if (scope.tool !== "codex") return { ...review, availability: "unsupported" };
  if (review.percent === undefined) return { ...review, availability: "unavailable" };
  if (review.percent < POOL_RESET_THRESHOLD) return { ...review, availability: review.complete ? "below_threshold" : "unavailable" };
  const windows = readings.map((reading) => weeklyWindow(reading, now));
  if (windows.some((window) => !window)) return { ...review, availability: "unavailable" };
  const eligible = windows.flatMap((window, index) =>
    window && window.reset - now >= MIN_WEEKLY_REMAINING_MS &&
      readings[index]?.windows?.some((usage) => usage.utilization > 0)
      ? [{ weeklyReset: window.reset, identity: scope.members[index], inventory: inventories[index] }] : []);
  if (eligible.some(({ inventory }) => !inventory || inventory.stale)) return { ...review, availability: "unavailable" };
  const candidate = chooseAutoResetCandidate(eligible.flatMap(({ identity, inventory, weeklyReset }) =>
    liveCredits(inventory, now).flatMap(({ id, expiry }) => usedCredits.has(id) ? [] : [{
      pool: scope.pool, identity, creditId: id, creditExpiresAt: expiry, weeklyReset,
    }])), now);
  if (!candidate) return { ...review, availability: "no_credit" };
  const { identity, creditId, creditExpiresAt, weeklyReset } = candidate;
  return { ...review, availability: "available", candidate: { identity, creditId, creditExpiresAt, weeklyReset } };
}

export function samePoolResetCandidate(a: PoolResetCandidate | undefined, b: PoolResetCandidate): boolean {
  return a?.identity === b.identity && a.creditId === b.creditId &&
    a.creditExpiresAt === b.creditExpiresAt && a.weeklyReset === b.weeklyReset;
}

interface RedemptionFences {
  usedCredits(ids: string[], ownClaim?: string): Promise<Set<string>>;
  inventoryFenceScope(identity: string, accountId?: string): Promise<{ any: boolean; relevant: boolean }>;
}

/** Check the account that will send the POST while the shared redemption lock is held. */
export async function checkCodexRedemptionFence(journal: RedemptionFences, identity: string, context: CodexPostContext, ownClaim?: string): Promise<void> {
  const read = <T>(operation: Promise<T>) => bounded(operation, 2_000, "Codex redemption journal");
  const { credential, creditId, inventory, signal } = context;
  signal?.throwIfAborted();
  if (creditId !== undefined) {
    if ((await read(journal.usedCredits([creditId], ownClaim))).has(creditId)) throw new CodexResetFenced();
    return;
  }
  const scope = await read(journal.inventoryFenceScope(identity, credential.accountId));
  signal?.throwIfAborted();
  if (!scope.any) return;
  const { ids, complete } = codexCreditIds(await inventory().catch(() => undefined));
  signal?.throwIfAborted();
  if ((!complete && scope.relevant) || (await read(journal.usedCredits([...ids]))).size > 0) {
    throw new CodexResetFenced();
  }
}

type SpendResult = Awaited<ReturnType<typeof consumeCodexResetForIdentity>>;

interface UnsentReservation {
  creditId: string;
  inserted: Promise<boolean>;
  deleting?: Promise<void>;
}

/** Retains only reservations that this process knows did not send a POST. Use under the shared lock. */
export class PoolResetReservationCleanup {
  private readonly unsent = new Map<string, UnsentReservation>();

  constructor(private readonly releaseAttempt: (creditId: string, reservationId: string) => Promise<void>) {}

  get pending(): boolean {
    return this.unsent.size > 0;
  }

  get full(): boolean {
    return this.unsent.size >= 64;
  }

  async release(creditId: string, reservationId: string, inserted: Promise<boolean>): Promise<void> {
    this.unsent.set(reservationId, { creditId, inserted });
    await this.retry(reservationId);
  }

  async retry(reservationId = this.unsent.keys().next().value): Promise<void> {
    if (reservationId === undefined) return;
    const entry = this.unsent.get(reservationId);
    if (!entry) return;
    try {
      // The SQL insert can finish after the request stops waiting for it.
      // A failed acknowledgement can still leave this exact reservation in the database.
      if (await bounded(entry.inserted.catch(() => true), 2_000, "pool reset reservation")) {
        entry.deleting ??= this.releaseAttempt(entry.creditId, reservationId).finally(() => { entry.deleting = undefined; });
        await bounded(entry.deleting, 2_000, "pool reset journal release");
      }
      this.unsent.delete(reservationId);
    } catch {
      // Give other queued reservations a chance on the next access.
      this.unsent.delete(reservationId);
      this.unsent.set(reservationId, entry);
    }
  }
}

interface ConfirmPoolDeps {
  journal: Pick<PgPoolResetJournal, "manualAttempted" | "recordAttempt" | "recordReportedCredit" | "markConsumed">;
  cleanup: PoolResetReservationCleanup;
  guard: CodexRedemptionGuard;
  assess: (pool: string, signal: AbortSignal) => Promise<{ review: PoolResetReview; readings: Array<PoolUsage | undefined> } | undefined>;
  members: (pool: string) => Promise<string[] | undefined>;
  spend: (beforePost: BeforeCodexPost, identity: string, requestId: string, selection: CodexCreditSelection) => Promise<SpendResult>;
  version: (identity: string) => Promise<string>;
  reconcile: (identity: string, baseline: PoolUsage | undefined, consumedAt: number, version?: string) => Promise<{ status: "confirmed" | "pending" }>;
  now: () => number;
  deadlineAt?: number;
}

type LockedPoolResult = PoolResetResult
  | { status: "refresh"; review: PoolResetReview }
  | { status: "reconcile"; baseline: PoolUsage | undefined; version: string | undefined; consumedAt: number };

export async function confirmPoolReset(
  pool: string,
  confirmation: PoolResetConfirmation,
  signal: AbortSignal,
  deps: ConfirmPoolDeps,
): Promise<PoolResetResult | undefined> {
  const { candidate, redeemRequestId } = confirmation;
  const { identity, creditId } = candidate;
  const spend = await deps.guard<LockedPoolResult | undefined>(async (invalidate) => {
    signal.throwIfAborted();
    if (await bounded(deps.journal.manualAttempted(creditId), 2_000, "pool reset journal")) return { status: "already_attempted" as const };
    signal.throwIfAborted();
    const current = await deps.assess(pool, signal);
    signal.throwIfAborted();
    if (!current) return undefined;
    if (!samePoolResetCandidate(current.review.candidate, candidate)) return { status: "changed" as const, review: current.review };
    const baseline = current.readings[current.review.members.indexOf(identity)];
    let crossingExpired = false;
    const stillCurrent = () => {
      const now = deps.now();
      const percent = poolUtilisation(current.readings, now).percent;
      crossingExpired = percent === undefined || percent < POOL_RESET_THRESHOLD;
      return !signal.aborted && performance.now() < (deps.deadlineAt ?? Infinity) &&
        now < candidate.creditExpiresAt && candidate.weeklyReset - now >= MIN_WEEKLY_REMAINING_MS && !crossingExpired;
    };
    const stillEligible = async () => {
      if (!stillCurrent()) return false;
      const members = await bounded(deps.members(pool), 2_000, "pool reset membership");
      const expected = new Set(current.review.members);
      return stillCurrent() && members?.length === expected.size && members.every((member) => expected.has(member));
    };
    let version: string | undefined;
    let postStarted = false;
    let reserved = false;
    const reservationId = crypto.randomUUID();
    let attempt: Promise<boolean> | undefined;
    let result: SpendResult;
    try {
      result = await deps.spend(async (_, context) => {
        signal.throwIfAborted();
        if (!stillCurrent()) return;
        await invalidate(identity, context);
        if (!stillCurrent()) return;
        version = await deps.version(identity);
        if (!stillCurrent()) return;
        if (!await stillEligible() || !stillCurrent()) return;
        if (deps.cleanup.full) throw new Error("The pool reset journal could not clear unsent reservations");
        attempt = deps.journal.recordAttempt(creditId, redeemRequestId, identity, reservationId, context.credential.accountId);
        reserved = await bounded(attempt, 2_000, "pool reset journal");
        if (!reserved) throw new CodexResetFenced();
      }, identity, redeemRequestId, {
        id: creditId,
        endsAt: new Date(candidate.creditExpiresAt).toISOString(),
        signal,
        now: deps.now,
        stillCurrent: () => stillCurrent() && reserved,
        stillEligible,
        onPost: () => { postStarted = true; },
        onReportedCredit: (reportedId) => deps.journal.recordReportedCredit(creditId, reservationId, reportedId),
        finishPostAfterDeadline: true,
      });
    } catch (error) {
      if (postStarted) return { status: "pending" as const };
      throw error;
    } finally {
      if (attempt && !postStarted) {
        await deps.cleanup.release(creditId, reservationId, attempt);
      }
    }
    if (!postStarted && crossingExpired) {
      const observedAt = deps.now();
      const { percent, complete } = poolUtilisation(current.readings, observedAt);
      const fallback: PoolResetReview = {
        ...current.review, observedAt, percent, complete, candidate: undefined,
        availability: complete && percent !== undefined && percent < POOL_RESET_THRESHOLD ? "below_threshold" : "unavailable",
      };
      return { status: "refresh", review: fallback };
    }
    if (result.creditId !== undefined && result.creditId !== creditId) return { status: "pending" as const };
    if (result.result === "already_redeemed") return { status: "already_attempted" as const };
    if (result.result !== "reset") return { status: "declined" as const };
    const consumedAt = deps.now();
    if (baseline && version !== undefined) {
      await bounded(deps.journal.markConsumed(creditId, identity, version, baseline, consumedAt), 2_000, "pool reset recovery").catch(() => undefined);
    }
    return { status: "reconcile", baseline, version, consumedAt };
  });
  if (!spend) return spend;
  if (spend.status === "refresh") {
    const budget = Math.min(2_000, Math.floor((deps.deadlineAt ?? Infinity) - performance.now() - 100));
    if (signal.aborted || budget <= 0) return { status: "changed", review: spend.review };
    const refreshSignal = AbortSignal.any([signal, AbortSignal.timeout(budget)]);
    const fresh = await bounded(deps.assess(pool, refreshSignal), budget, "pool reset review").catch(() => undefined);
    return { status: "changed", review: fresh?.review ?? spend.review };
  }
  if (spend.status !== "reconcile") return spend;
  const reconciled = await deps.reconcile(identity, spend.baseline, spend.consumedAt, spend.version)
    .catch(() => ({ status: "pending" as const }));
  return { status: reconciled.status };
}

/** Idempotency records for the explicit credit POST. Both reset paths share the redemption lock. */
export class PgPoolResetJournal {
  constructor(private readonly sql: SQL) {}

  async usedCredits(ids: string[], ownClaim?: string): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const own = ownClaim ?? null;
    const rows = await this.sql`SELECT credit_id FROM codex_pool_reset_attempts WHERE credit_id IN ${this.sql(ids)}
      UNION SELECT credited_id FROM codex_pool_reset_attempts WHERE credited_id IN ${this.sql(ids)}
      UNION SELECT credit_id FROM codex_auto_reset_claims WHERE credit_id IN ${this.sql(ids)}
        AND redeem_request_id IS DISTINCT FROM ${own}::uuid
      UNION SELECT credited_id FROM codex_auto_reset_claims WHERE credited_id IN ${this.sql(ids)}`;
    return new Set(rows.map((row: { credit_id: string }) => row.credit_id));
  }

  async manualAttempted(id: string): Promise<boolean> {
    const rows = await this.sql`SELECT 1 FROM codex_pool_reset_attempts WHERE credit_id = ${id} OR credited_id = ${id}`;
    return rows.length > 0;
  }

  async inventoryFenceScope(identity: string, accountId?: string): Promise<{ any: boolean; relevant: boolean }> {
    const [row] = await this.sql`SELECT
      EXISTS (SELECT 1 FROM codex_pool_reset_attempts UNION ALL SELECT 1 FROM codex_auto_reset_claims) AS has_attempts,
      (EXISTS (SELECT 1 FROM codex_pool_reset_attempts
        WHERE identity IS NULL OR identity = ${identity} OR account_id = ${accountId ?? null})
        OR EXISTS (SELECT 1 FROM codex_auto_reset_claims WHERE identity = ${identity})) AS relevant`;
    return { any: row.has_attempts, relevant: row.relevant };
  }

  async recordAttempt(creditId: string, redeemRequestId: string, identity: string, reservationId: string, accountId?: string): Promise<boolean> {
    const rows = await this.sql`INSERT INTO codex_pool_reset_attempts (credit_id, redeem_request_id, identity, reservation_id, account_id)
      VALUES (${creditId}, ${redeemRequestId}, ${identity}, ${reservationId}, ${accountId ?? null})
      ON CONFLICT DO NOTHING RETURNING credit_id`;
    return rows.length === 1;
  }

  async releaseAttempt(creditId: string, reservationId: string): Promise<void> {
    await this.sql`DELETE FROM codex_pool_reset_attempts
      WHERE credit_id = ${creditId} AND reservation_id = ${reservationId} AND credited_id IS NULL AND consumed_at IS NULL`;
  }

  async recordReportedCredit(creditId: string, reservationId: string, reportedId: string): Promise<void> {
    const rows = await this.sql`UPDATE codex_pool_reset_attempts SET credited_id = ${reportedId}
      WHERE credit_id = ${creditId} AND reservation_id = ${reservationId} RETURNING credit_id`;
    if (rows.length !== 1) throw new Error("The pool reset reservation is missing");
  }

  async markConsumed(creditId: string, identity: string, version: string, baseline: PoolUsage, consumedAt: number): Promise<void> {
    const proof = JSON.stringify(usageProof(baseline));
    await this.sql`UPDATE codex_pool_reset_attempts SET identity = ${identity}, version = ${version}::bigint,
      baseline = ${proof}::text::jsonb, consumed_at = ${new Date(consumedAt).toISOString()}::text::timestamptz WHERE credit_id = ${creditId}`;
  }

  async reconcileReading(identity: string, reading: PoolUsage | undefined): Promise<void> {
    if (!reading || reading.stale || reading.status === "unavailable") return;
    const pending = await this.sql`SELECT attempt.version::text AS version, consumed_at, baseline
      FROM codex_pool_reset_attempts attempt JOIN reset_credit_invalidations invalidation
        ON invalidation.provider = 'codex' AND invalidation.identity = attempt.identity AND invalidation.version = attempt.version
      WHERE attempt.identity = ${identity} AND baseline IS NOT NULL ORDER BY consumed_at DESC LIMIT 1`;
    const row = pending[0];
    if (row && provesRelief(reading, new Date(row.consumed_at).getTime(), row.baseline)) {
      await this.markVerified(identity, String(row.version));
    }
  }

  async verifiedAt(identities: string[]): Promise<number | undefined> {
    if (!identities.length) return undefined;
    const rows = await this.sql`SELECT max(verified_at) AS at FROM (
      SELECT verified_at FROM reset_credit_invalidations WHERE provider = 'codex' AND identity IN ${this.sql(identities)}
      UNION ALL SELECT recovered_at FROM codex_auto_reset_claims WHERE identity IN ${this.sql(identities)} AND status = 'reset'
    ) AS verified`;
    const value: unknown = rows[0]?.at;
    const timestamp = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : NaN;
    return Number.isFinite(timestamp) ? timestamp : undefined;
  }

  async markVerified(identity: string, version: string): Promise<void> {
    await this.sql`WITH verified AS (
      UPDATE reset_credit_invalidations SET verified_at = clock_timestamp(), verified_version = version
      WHERE provider = 'codex' AND identity = ${identity} AND version = ${version}::bigint
        AND verified_version IS DISTINCT FROM version RETURNING version
    )
    UPDATE codex_pool_reset_attempts SET baseline = NULL
      WHERE identity = ${identity} AND baseline IS NOT NULL AND version <= (SELECT version FROM verified)`;
  }
}
