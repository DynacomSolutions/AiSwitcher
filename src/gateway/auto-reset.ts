import { createHash, randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import type { ManualResetInfo } from "../cli/limits/types.ts";
import type { PoolUsage } from "../identities/pool/adapter.ts";
import {
  canRearmClaim, type AutoResetClaim, type AutoResetClaimInput, type AutoResetClaimSummary,
  type AutoResetCreditEvidence, type AutoResetStore,
} from "./auto-reset-store.ts";
import { bounded } from "./refresh-guard.ts";
import { reserveUtilisationOf, usageForModel } from "./select.ts";

export type { AutoResetClaimSummary } from "./auto-reset-store.ts";

const RECOVERY_MS = 25_000;
const READING_MAX_AGE_MS = 45_000;
export const MIN_WEEKLY_REMAINING_MS = 5 * 60_000;
const NATURAL_RESET_WAIT_MS = 8_000;
const NATURAL_RESET_VERIFY_MS = 4_000;
const NATURAL_RESET_CREDIT_MS = 60_000;
const CONFIRMATION_MS = 8_000;
const REPLAY_RESERVE_MS = 2_000;
const CONFIRMATION_READ_MS = 2_000;

export interface AutoResetPool {
  name: string;
  members: string[];
}

interface RecoverInput {
  members: string[];
  reservePercent: number;
  model?: string;
  signal: AbortSignal;
  /** Absolute performance.now() deadline from receipt of the quota response. */
  deadlineAt?: number;
  /** Gateway wall-clock milliseconds at receipt of this request's confirmed provider 429 headers. */
  provider429At?: number;
  onConfirmed?(identity: string, reading: AutoResetUsage): void;
}

export interface AutoResetRecovery {
  enabled(): Promise<boolean>;
  recover(input: RecoverInput): Promise<string | undefined>;
}

/** The optional permission flag comes from the Codex usage response's rate_limit.allowed. */
export type AutoResetUsage = PoolUsage & { codexRateLimitAllowed?: boolean };

interface SpendEvidence {
  endsAt: string;
  stillCurrent(): boolean;
  postAttempted(attempted: boolean): void;
}

interface RecoveryOptions {
  store: AutoResetStore;
  claim?: (input: Parameters<AutoResetStore["claim"]>[0], signal: AbortSignal) => ReturnType<AutoResetStore["claim"]>;
  pools: () => Promise<AutoResetPool[]>;
  freshUsage: (identity: string, signal: AbortSignal) => Promise<AutoResetUsage | undefined>;
  readCredits: (identity: string, signal: AbortSignal) => Promise<ManualResetInfo | undefined>;
  spend: (identity: string, creditId: string, redeemRequestId: string, signal: AbortSignal, evidence: SpendEvidence) =>
    Promise<{ result: "reset" | "nothing_to_reset" | "no_credit" | "already_redeemed"; creditId?: string }>;
  now?: () => number;
  confirmationBudgetMs?: number;
  log?: (line: string) => void;
}

export interface AutoResetCandidate {
  pool: string;
  identity: string;
  creditId: string;
  creditExpiresAt: number;
  weeklyReset: number;
}

const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const iso = (ms: number): string => new Date(ms).toISOString();

function absoluteTime(value: string | undefined): number {
  return value && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    ? Date.parse(value) : Number.NaN;
}

function currentReading(time: string | undefined, now: number): boolean {
  const age = now - absoluteTime(time);
  return age >= 0 && age <= READING_MAX_AGE_MS;
}

export function weeklyWindow(usage: PoolUsage | undefined, now: number) {
  if (!usage || usage.stale || usage.noPlan || usage.status === "unavailable" || !currentReading(usage.capturedAt, now)) return undefined;
  const windows = usage.windows?.filter((w) => w.model === undefined && /^(?:week|weekly|7d)$/i.test(w.label.trim()));
  if (windows?.length !== 1) return undefined;
  const [{ utilization, resetsAt }] = windows;
  const reset = absoluteTime(resetsAt);
  if (!(reset > now) || !Number.isFinite(utilization) || utilization < 0) return undefined;
  return { utilization, reset };
}

function exhaustedWeeklyWindow(usage: AutoResetUsage | undefined, now: number) {
  if (usage?.codexRateLimitAllowed === true) return undefined;
  const extra = usage?.extraUsage;
  if (extra?.available || (extra?.enabled && extra.stale)) return undefined;
  const window = weeklyWindow(usage, now);
  return window && window.utilization >= 100 ? window : undefined;
}

/** Proof of an account-wide weekly limit for the cached probe and fresh recovery paths. */
export function exhaustedWeeklyReset(usage: AutoResetUsage | undefined, now: number): number | undefined {
  return exhaustedWeeklyWindow(usage, now)?.reset;
}

/** Keep only provider-listed credits with a usable ID and an absolute future expiry. */
export function liveCredits(info: ManualResetInfo | undefined, now: number) {
  if (!info || info.stale || !Number.isSafeInteger(info.availableCount) || info.availableCount < 1) return [];
  if (info.readAt !== undefined && !currentReading(info.readAt, now)) return [];
  const ids = new Map<string, number>();
  for (const { id, endsAt } of info.creditExpiries ?? []) {
    const expiry = absoluteTime(endsAt);
    if (id.trim() === "") continue;
    const prior = ids.get(id);
    ids.set(id, prior === undefined || prior === expiry ? expiry : Number.NaN);
  }
  return [...ids].flatMap(([id, expiry]) => expiry > now ? [{ id, expiry }] : []);
}

function rankCandidates(candidates: readonly AutoResetCandidate[], now: number): AutoResetCandidate[] {
  return candidates.filter((candidate) => candidate.creditExpiresAt > now && candidate.weeklyReset - now >= MIN_WEEKLY_REMAINING_MS)
    .sort((a, b) => a.creditExpiresAt - b.creditExpiresAt || b.weeklyReset - a.weeklyReset ||
      compare(a.identity, b.identity) || compare(a.pool, b.pool) || compare(a.creditId, b.creditId));
}

/** Select with one timestamp and code-unit ordering for every stable tie. */
export function chooseAutoResetCandidate(candidates: readonly AutoResetCandidate[], now: number): AutoResetCandidate | undefined {
  return rankCandidates(candidates, now)[0];
}

function reasonFor(winner: AutoResetCandidate, next: AutoResetCandidate | undefined): AutoResetCreditEvidence["reason"] {
  if (!next) return "only_candidate";
  if (winner.creditExpiresAt !== next.creditExpiresAt) return "earliest_expiry";
  if (winner.weeklyReset !== next.weeklyReset) return "latest_weekly_reset";
  if (winner.identity !== next.identity) return "identity_order";
  if (winner.pool !== next.pool) return "pool_order";
  return "credit_id_order";
}

function hasHeadroom(reading: AutoResetUsage | undefined, input: RecoverInput, now: number, since: number): reading is AutoResetUsage {
  if (!reading || reading.status !== "live" || reading.codexRateLimitAllowed === false ||
    !weeklyWindow(reading, now) || absoluteTime(reading.capturedAt) < since) return false;
  const scoped = input.model === undefined ? reading : usageForModel(reading, input.model);
  const utilisation = reserveUtilisationOf(scoped);
  return scoped?.windows?.every((w) => Number.isFinite(w.utilization) && w.utilization >= 0) === true &&
    utilisation !== undefined && utilisation < Math.min(100, input.reservePercent);
}

function withSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function createAutoResetRecovery({
  store, claim: claimCredit = (input) => store.claim(input), pools, freshUsage, readCredits, spend, now = Date.now, confirmationBudgetMs = CONFIRMATION_MS, log = console.info,
}: RecoveryOptions): AutoResetRecovery {
  async function enabledPools(): Promise<AutoResetPool[]> {
    const all = await pools();
    const rules = await Promise.all(all.map(async (pool) => ({ pool, enabled: await store.enabled("pool", pool.name) })));
    return rules.filter((rule) => rule.enabled).map((rule) => rule.pool);
  }

  async function confirm(
    identity: string, input: RecoverInput, since: number, deadline: number, maxWaitMs = confirmationBudgetMs,
    onHeadroom?: (confirmedAt: number) => Promise<void>,
  ): Promise<string | undefined> {
    const budget = Math.floor(Math.min(maxWaitMs, deadline - performance.now() - REPLAY_RESERVE_MS));
    if (budget <= 0 || input.signal.aborted) return undefined;
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(budget)]);
    let delay = 150;
    try {
      while (!signal.aborted) {
        const readSignal = AbortSignal.any([signal, AbortSignal.timeout(CONFIRMATION_READ_MS)]);
        const readStartedAt = now();
        const reading = await withSignal(freshUsage(identity, readSignal), readSignal).catch(() => undefined);
        signal.throwIfAborted();
        const confirmedAt = now();
        if (hasHeadroom(reading, input, confirmedAt, Math.max(since, readStartedAt))) {
          if (onHeadroom) await withSignal(onHeadroom(confirmedAt).catch(() => undefined), signal);
          input.onConfirmed?.(identity, reading);
          return identity;
        }
        await wait(delay, undefined, { signal });
        delay = Math.min(delay * 2, 1_500);
      }
    } catch {
      // The caller or the confirmation budget ended.
    }
    return undefined;
  }

  async function follow(eventKey: string, claim: AutoResetClaim, input: RecoverInput, deadline: number): Promise<string | undefined> {
    let delay = 100;
    while (claim.status === "pending") {
      if (now() - absoluteTime(claim.startedAt) >= RECOVERY_MS ||
        performance.now() + delay >= deadline - REPLAY_RESERVE_MS) return undefined;
      await wait(delay, undefined, { signal: input.signal });
      const updated = await store.findClaim(eventKey, claim.generation);
      if (!updated) return undefined;
      claim = updated;
      delay = Math.min(delay * 2, 1_000);
    }
    if (!input.members.includes(claim.identity) || claim.status === "rejected" ||
      (claim.creditedId !== undefined && claim.creditedId !== claim.creditId)) return undefined;
    const since = absoluteTime(claim.finishedAt ?? claim.startedAt);
    const mark = claim.status === "reset" && claim.finishedAt && !claim.recoveredAt
      ? (at: number) => store.markRecovered(eventKey, claim.redeemRequestId, iso(at))
      : undefined;
    return confirm(claim.identity, input, since, deadline, confirmationBudgetMs, mark);
  }

  async function run(input: RecoverInput, deadline: number): Promise<string | undefined> {
    const { signal } = input;
    const names = [...new Set(input.members)].sort(compare);
    if (!names.length) return undefined;
    signal.throwIfAborted();
    const rules = await enabledPools();
    const poolsByMember = new Map<string, string[]>();
    for (const name of names) {
      const matches = rules.filter((pool) => pool.members.includes(name)).map((pool) => pool.name);
      if (matches.length) poolsByMember.set(name, matches);
    }
    if (!poolsByMember.size) return undefined;

    signal.throwIfAborted();
    const readStartedAt = now();
    const readings = await Promise.all(names.map((name) => freshUsage(name, signal).catch(() => undefined)));
    signal.throwIfAborted();
    const checkedAt = now();
    const { provider429At } = input;
    if (provider429At !== undefined && (!Number.isSafeInteger(provider429At) || provider429At > readStartedAt ||
      checkedAt - provider429At >= RECOVERY_MS)) return undefined;

    const windows = readings.map((reading) => weeklyWindow(reading, checkedAt));
    const eventKey = windows.every((window) => window !== undefined)
      ? createHash("sha256").update(JSON.stringify(windows.map((window, index) => [names[index], iso(window.reset)]))).digest("hex")
      : undefined;
    const headroom = readings.findIndex((reading) => hasHeadroom(reading, input, checkedAt, readStartedAt));
    if (headroom !== -1) {
      if (eventKey) {
        const prior = await store.findClaim(eventKey).catch(() => undefined);
        if (prior?.status === "reset" && !prior.recoveredAt && absoluteTime(prior.finishedAt) <= readStartedAt &&
          (prior.creditedId === undefined || prior.creditedId === prior.creditId)) {
          const winnerIndex = names.indexOf(prior.identity);
          if (hasHeadroom(readings[winnerIndex], input, checkedAt, readStartedAt)) {
            await store.markRecovered(eventKey, prior.redeemRequestId, iso(checkedAt)).catch(() => undefined);
          }
        }
      }
      signal.throwIfAborted();
      input.onConfirmed?.(names[headroom], readings[headroom]!);
      return names[headroom];
    }

    if (!eventKey) return undefined;
    const evidence = readings.flatMap((reading, index) => {
      const weekly = exhaustedWeeklyWindow(reading, checkedAt);
      if (!reading || !weekly || absoluteTime(reading.capturedAt) < readStartedAt) return [];
      return [{
        identity: names[index], resetAt: iso(weekly.reset), capturedAt: reading.capturedAt,
        weeklyUtilisation: weekly.utilization, codexRateLimitAllowed: reading.codexRateLimitAllowed,
      }];
    });
    if (evidence.length !== names.length) return undefined;
    let existing = await store.findClaim(eventKey);
    if (existing && !canRearmClaim(existing, provider429At, checkedAt, evidence)) return follow(eventKey, existing, input, deadline);

    signal.throwIfAborted();
    const inventories = await Promise.all(evidence.map(async ({ identity, resetAt }) => {
      const poolNames = poolsByMember.get(identity);
      if (!poolNames || !await store.enabled("identity", identity) || signal.aborted) return undefined;
      const info = await readCredits(identity, signal).catch(() => undefined);
      return { identity, poolNames, weeklyResetAt: resetAt, info };
    }));

    signal.throwIfAborted();
    existing = await store.findClaim(eventKey);
    const decisionTime = now();
    if (provider429At !== undefined && decisionTime - provider429At >= RECOVERY_MS) return undefined;
    if (existing && !canRearmClaim(existing, provider429At, decisionTime, evidence)) return follow(eventKey, existing, input, deadline);
    const evaluated = inventories.flatMap((row) => {
      if (!row) return [];
      const { identity, poolNames, weeklyResetAt, info } = row;
      const credits = liveCredits(info, decisionTime).map(({ id, expiry }) => ({ id, expiresAt: iso(expiry) }));
      return [{
        identity, pools: poolNames, weeklyResetAt, credits,
        availableCount: Number.isSafeInteger(info?.availableCount) ? info?.availableCount : undefined,
        readAt: info?.readAt && Number.isFinite(absoluteTime(info.readAt)) ? info.readAt : undefined,
      }];
    });
    const candidates = evaluated.flatMap(({ identity, pools, weeklyResetAt, credits }) =>
      credits.flatMap(({ id, expiresAt }) => pools.map((pool) => ({
        identity, pool, creditId: id, creditExpiresAt: absoluteTime(expiresAt), weeklyReset: absoluteTime(weeklyResetAt),
      }))));
    const [chosen, next] = rankCandidates(candidates, decisionTime);
    const firstReset = Math.min(...evidence.map((row) => absoluteTime(row.resetAt)));
    const imminent = firstReset - decisionTime <= NATURAL_RESET_WAIT_MS;
    const expiresNearReset = chosen && chosen.creditExpiresAt <= firstReset + NATURAL_RESET_CREDIT_MS;
    if (imminent && !expiresNearReset) {
      const resetDelay = Math.max(0, firstReset - decisionTime);
      if (deadline - performance.now() - resetDelay < NATURAL_RESET_VERIFY_MS) return undefined;
      await wait(resetDelay, undefined, { signal });
      const resetting = evidence.filter((row) => absoluteTime(row.resetAt) === firstReset);
      const naturalBudget = Math.min(NATURAL_RESET_VERIFY_MS, confirmationBudgetMs);
      const recovered = await Promise.all(resetting.map(({ identity }) => confirm(identity, input, firstReset, deadline, naturalBudget)));
      return recovered.find((identity) => identity !== undefined);
    }
    if (!chosen || firstReset <= decisionTime) return undefined;

    const { identity, pool, creditId, creditExpiresAt } = chosen;
    const creditEvidence: AutoResetCreditEvidence = {
      reason: reasonFor(chosen, next), inventories: evaluated, ...(imminent ? { imminentResetAt: iso(firstReset) } : {}),
    };
    const redeemRequestId = randomUUID();
    signal.throwIfAborted();
    const claim = await claimCredit({
      eventKey, identity, pool, creditId, creditExpiresAt: iso(creditExpiresAt), startedAt: iso(decisionTime),
      redeemRequestId, provider429At, usageEvidence: evidence, creditEvidence,
    }, signal);
    if (claim.kind === "existing") return follow(eventKey, claim.claim, input, deadline);
    if (claim.kind === "blocked") return undefined;

    const audit = (status: AutoResetClaimSummary["status"], outcome?: string, creditedId?: string): void => {
      try {
        log(JSON.stringify({
          event: "codex-auto-reset", status, pool, identity, creditId, redeemRequestId,
          eventKey, startedAt: iso(decisionTime), creditExpiresAt: iso(creditExpiresAt),
          provider429At: provider429At === undefined ? undefined : iso(provider429At),
          reason: creditEvidence.reason, imminentResetAt: creditEvidence.imminentResetAt,
          usageEvidence: evidence, creditEvidence, outcome, creditedId,
        }));
      } catch {
        // A logger failure must not leave a completed claim pending.
      }
    };
    audit("pending");
    let status: Exclude<AutoResetClaimSummary["status"], "pending"> = "rejected";
    let creditedId: string | undefined;
    let outcome = "evidence_expired";
    let postAttempted: boolean | undefined;
    let finishedAt: number;
    const stillCurrent = () => {
      const at = now();
      return !signal.aborted && at < creditExpiresAt && chosen.weeklyReset - at >= MIN_WEEKLY_REMAINING_MS &&
        (provider429At === undefined || at - provider429At < RECOVERY_MS) &&
        evidence.every((row) => absoluteTime(row.resetAt) > at && currentReading(row.capturedAt, at));
    };
    try {
      if (stillCurrent()) {
        status = "unknown";
        outcome = "consume_unknown";
        const spent = await withSignal(spend(identity, creditId, redeemRequestId, signal, {
          endsAt: iso(creditExpiresAt),
          stillCurrent,
          postAttempted: (attempted) => { postAttempted = attempted; },
        }), signal);
        creditedId = spent.creditId;
        if (creditedId === undefined || creditedId === creditId) {
          outcome = spent.result;
          status = spent.result === "reset" ? "reset" : "rejected";
        } else {
          outcome = "credit_mismatch";
        }
      } else if (signal.aborted) {
        outcome = "cancelled_before_post";
      }
    } catch (error) {
      const refusal = error as { status?: number; postAttempted?: boolean } | null;
      if (postAttempted === false || refusal?.postAttempted === false) {
        status = "rejected";
        outcome = "preflight_failed";
      } else if (refusal?.status !== undefined && refusal.status >= 400 && refusal.status < 500) {
        status = "rejected";
        outcome = "provider_refused";
      }
    } finally {
      finishedAt = now();
      audit(status, outcome, creditedId);
      await store.finish(eventKey, status, creditedId, { redeemRequestId, finishedAt: iso(finishedAt), outcome });
    }
    if (status === "rejected" || (creditedId !== undefined && creditedId !== creditId)) return undefined;
    const mark = status === "reset" ? (at: number) => store.markRecovered(eventKey, redeemRequestId, iso(at)) : undefined;
    return confirm(identity, input, finishedAt, deadline, confirmationBudgetMs, mark);
  }

  return {
    enabled: () => bounded(enabledPools(), 1_500, "Codex auto-reset rules").then((rules) => rules.length > 0),
    recover(input) {
      const started = performance.now();
      const deadline = Math.min(input.deadlineAt ?? Infinity, started + RECOVERY_MS);
      const budget = Math.floor(deadline - started - REPLAY_RESERVE_MS);
      if (input.signal.aborted || !(budget > 0)) return Promise.resolve(undefined);
      const signal = AbortSignal.any([input.signal, AbortSignal.timeout(budget)]);
      return withSignal(run({ ...input, signal }, deadline), signal).catch(() => undefined);
    },
  };
}
