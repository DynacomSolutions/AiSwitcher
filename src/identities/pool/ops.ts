import { isRetired } from "../retired.ts";
import { loadIdentitiesFile } from "../store.ts";
import type { Identity } from "../types.ts";
import type { PoolAdapter, PoolUsage, SwapReason, SwapResult } from "./adapter.ts";
import { eventsForPool, ledgerPathFor, readSwapEvents } from "./ledger.ts";
import { performPoolSwap, SwapSkipped } from "./swap.ts";
import { allowedAccounts, isAllowed, poolThreshold, requirePool, type PoolIdentity } from "./swap-pool.ts";

/** Selection and orchestration on top of an adapter: who has headroom, and
 * whether a limited active member should be swapped out. */

/** Minimum time between automatic/launch swaps of one pool (hysteresis). */
export const SWAP_COOLDOWN_MS = 10 * 60_000;

export interface MemberRow<U extends PoolUsage = PoolUsage> {
  name: string;
  active: boolean;
  allowed: boolean;
  usage?: U;
}

/** Headroom = 100 - worst window. Unknown usage sorts last and is never
 * chosen when `requireKnown` is set. Equal headroom: a member with available
 * extra usage ranks first. */
export function chooseBest(
  rows: Array<{ name: string; usage?: PoolUsage }>,
  options: { exclude?: string; belowPercent?: number; requireKnown?: boolean },
): string | undefined {
  const ranked = rows
    .filter((r) => r.name !== options.exclude)
    .map((r) => ({ name: r.name, util: r.usage?.status === "live" ? r.usage.maxUtilization : undefined, extra: r.usage?.extraUsage?.available === true }))
    .filter((r) => (options.requireKnown ? r.util !== undefined : true))
    .filter((r) => options.belowPercent === undefined || (r.util !== undefined && r.util < options.belowPercent))
    .sort((a, b) => (a.util ?? 1000) - (b.util ?? 1000) || Number(b.extra) - Number(a.extra));
  return ranked[0]?.name;
}

export interface PoolOpsDeps<U extends PoolUsage = PoolUsage> {
  registryPath?: string;
  ledgerPath?: string;
  now?: () => number;
  fetchUsage?: (member: Identity) => Promise<U>;
}

function usageOf<U extends PoolUsage>(adapter: PoolAdapter<U>, deps: PoolOpsDeps<U>) {
  return deps.fetchUsage ?? ((member: Identity) => adapter.fetchUsage(member, deps));
}

async function load(adapter: PoolAdapter<any>, deps: PoolOpsDeps<any>, poolKey: string | undefined) {
  const file = await loadIdentitiesFile(deps.registryPath ?? adapter.config.identitiesJsonPath);
  const pool = requirePool(file, poolKey, adapter.tool);
  const members = pool.swapPool.accounts
    .map((name) => file.identities.find((i) => i.name === name))
    .filter((i): i is Identity => i !== undefined);
  return { file, pool, members };
}

export async function poolStatus<U extends PoolUsage>(adapter: PoolAdapter<U>, deps: PoolOpsDeps<U>, poolKey: string | undefined, options: { usage?: boolean } = {}): Promise<{ pool: PoolIdentity; thresholdPercent: number; rows: MemberRow<U>[] }> {
  const { pool, members } = await load(adapter, deps, poolKey);
  const fetchUsage = usageOf(adapter, deps);
  const rows = await Promise.all(
    pool.swapPool.accounts.map(async (name): Promise<MemberRow<U>> => {
      const member = members.find((m) => m.name === name);
      const base = { name, active: pool.swapPool.active === name, allowed: isAllowed(pool, name) };
      if (!member || isRetired(member) || options.usage === false) return base;
      return { ...base, usage: await fetchUsage(member) };
    }),
  );
  return { pool, thresholdPercent: poolThreshold(pool), rows };
}

/** Switch to the allowed member (other than the active one) with the most headroom. */
export async function swapToNext<U extends PoolUsage>(adapter: PoolAdapter<U>, deps: PoolOpsDeps<U>, poolKey: string | undefined, reason: SwapReason, options: { requireBelowThreshold?: boolean } = {}): Promise<SwapResult | undefined> {
  const status = await poolStatus(adapter, deps, poolKey);
  const candidates = status.rows.filter((r) => r.allowed && !r.active);
  const target = chooseBest(candidates, {
    ...(options.requireBelowThreshold ? { belowPercent: status.thresholdPercent, requireKnown: true } : {}),
  });
  if (!target) return undefined;
  return performPoolSwap(adapter, {
    ...(deps.registryPath ? { registryPath: deps.registryPath } : {}),
    ...(deps.ledgerPath ? { ledgerPath: deps.ledgerPath } : {}),
    pool: status.pool.name,
    target,
    reason,
  });
}

export type LimitedOutcome =
  | { action: "not-limited"; utilization?: number }
  | { action: "cooldown"; retryAfterMs: number }
  | { action: "no-candidate"; utilization?: number; retryAtMs?: number; activeRetryAtMs?: number }
  | { action: "swapped"; result: SwapResult; utilization?: number }
  | { action: "skipped"; why: string };

/** If the pool's active member is at/over the threshold (or its usage call
 * was itself rate limited, or `assumeLimited` because a 429 was observed),
 * swap to the best allowed member below the threshold (else the least-used
 * member that is under 100% and better than the active one). When none of
 * those exists and the active member is exhausted (100%, rate-limited or
 * unknown), an active member with available extra usage (Claude extra
 * usage, Codex credits) stays put, since it already runs on paid capacity;
 * otherwise the best allowed member with available extra usage is chosen, at
 * any utilisation. Members under 100% always win over paid capacity. Honors the cooldown
 * recorded in the ledger. Used by the daemon poll, the launch check and the
 * optional in-session hook (`next --if-limited`). */
export async function swapIfLimited<U extends PoolUsage>(
  adapter: PoolAdapter<U>,
  deps: PoolOpsDeps<U>,
  poolKey: string | undefined,
  reason: SwapReason,
  options: { assumeLimited?: boolean; trustLimitEvidence?: boolean; cooldownMs?: number; expectedActive?: string; failureAtMs?: number } = {},
): Promise<LimitedOutcome> {
  const { pool, members } = await load(adapter, deps, poolKey);
  const active = pool.swapPool.active;
  if (!active) return { action: "skipped", why: "pool has no active account yet" };
  if (options.expectedActive !== undefined && active !== options.expectedActive) {
    return { action: "skipped", why: `pool changed to "${active}" before limit recovery` };
  }
  const now = deps.now?.() ?? Date.now();
  const failureAtMs = options.failureAtMs ?? (options.assumeLimited ? now : undefined);
  const cooldownMs = options.cooldownMs ?? SWAP_COOLDOWN_MS;
  const ledgerPath = deps.ledgerPath ?? ledgerPathFor(adapter.tool);
  const recentEvents = async (p: PoolIdentity) => eventsForPool(await readSwapEvents(ledgerPath), p);
  const alreadyHandled = async (p: PoolIdentity): Promise<boolean> => {
    if (failureAtMs === undefined) return false;
    const events = await recentEvents(p);
    const last = events[events.length - 1];
    return Boolean(last && Date.parse(last.ts) >= failureAtMs);
  };
  const cooldown = async (p: PoolIdentity): Promise<LimitedOutcome | undefined> => {
    const events = (await recentEvents(p)).filter((e) => e.reason !== "manual");
    const last = events[events.length - 1];
    // Another hook or process may already have handled this exact failure.
    // Use the failing turn's start timestamp when supplied, so a delayed
    // classic hook cannot rotate through a second member after its swap.
    if (failureAtMs !== undefined && last && Date.parse(last.ts) >= failureAtMs) {
      return { action: "skipped", why: "limit failure was already handled by a pool swap" };
    }
    if (last && now - Date.parse(last.ts) < cooldownMs) return { action: "cooldown", retryAfterMs: cooldownMs - (now - Date.parse(last.ts)) };
    return undefined;
  };
  if (options.assumeLimited && await alreadyHandled(pool)) {
    return { action: "skipped", why: "limit failure was already handled by a pool swap" };
  }
  // A hard limit event is direct evidence that this credential cannot continue
  // the current request. The ordinary hysteresis must not hide that signal.
  const cooling = options.assumeLimited ? undefined : await cooldown(pool);
  if (cooling) return cooling;

  const fetchUsage = usageOf(adapter, deps);
  const activeMember = members.find((m) => m.name === active);
  if (!activeMember) return { action: "skipped", why: `active account "${active}" is not an identity` };
  const usage = await fetchUsage(activeMember);
  const threshold = poolThreshold(pool);
  // Fresh live headroom is stronger evidence than a generic StopFailure
  // rate_limit code (for example a server-side throttle).
  if (options.assumeLimited && !options.trustLimitEvidence && usage.status === "live" && typeof usage.maxUtilization === "number" && usage.maxUtilization < 100) {
    return { action: "not-limited", ...(usage.maxUtilization !== undefined ? { utilization: usage.maxUtilization } : {}) };
  }
  const limited = options.assumeLimited || usage.status === "rate-limited" || (usage.status === "live" && (usage.maxUtilization ?? 0) >= threshold);
  if (!limited) return { action: "not-limited", ...(usage.maxUtilization !== undefined ? { utilization: usage.maxUtilization } : {}) };

  const others = allowedAccounts(pool).filter((n) => n !== active);
  const events = eventsForPool(await readSwapEvents(ledgerPath), pool);
  const blockedUntil = new Map<string, number>();
  for (const event of events) {
    if (event.from && event.hardLimitUntilMs && event.hardLimitUntilMs > now) {
      blockedUntil.set(event.from, Math.max(blockedUntil.get(event.from) ?? 0, event.hardLimitUntilMs));
    }
  }
  const rows = await Promise.all(
    others.map(async (name) => {
      const member = members.find((m) => m.name === name);
      const memberUsage = member && !isRetired(member) ? await fetchUsage(member) : undefined;
      return { name, usage: memberUsage, blockedUntil: blockedUntil.get(name) };
    }),
  );
  // Nobody below the threshold: fall back to the known member with the lowest
  // utilization if it still has headroom (< 100) and beats the active member
  // (rate-limited or unknown active usage counts as 100).
  const activeUtil = usage.status === "live" ? usage.maxUtilization ?? 100 : 100;
  const usableRows = rows.filter((row) => row.blockedUntil === undefined);
  const fallback = chooseBest(usableRows, { belowPercent: 100, requireKnown: true });
  const fallbackUtil = rows.find((r) => r.name === fallback)?.usage?.maxUtilization;
  const target = chooseBest(usableRows, { belowPercent: threshold, requireKnown: true }) ??
    (fallbackUtil !== undefined && (options.assumeLimited || fallbackUtil < activeUtil) ? fallback : undefined);
  // Hard limit evidence and no known headroom (e.g. usage API 429s for all): move to a member not known to be exhausted rather than stay stuck.
  const unknownTarget = options.assumeLimited && !target ? usableRows.find((r) => r.usage && r.usage.status !== "live")?.name : undefined;
  const paid = options.assumeLimited
    ? target ?? unknownTarget
    : target ?? (activeUtil < 100 || usage.extraUsage?.available ? undefined : chooseBest(usableRows.filter((r) => r.usage?.extraUsage?.available), {}));
  if (!paid) {
    const resetRows = [...rows, { name: active, usage, blockedUntil: blockedUntil.get(active) }];
    const resetAccounts = allowedAccounts(pool).filter((name) =>
      name !== active || usage.status === "rate-limited" || (usage.status === "live" && (usage.maxUtilization ?? 0) >= 100),
    );
    const usableRetryAtMs = earliestPoolReset(resetAccounts, members, resetRows, now);
    return {
      action: "no-candidate",
      ...(usage.maxUtilization !== undefined ? { utilization: usage.maxUtilization } : {}),
      ...(usableRetryAtMs !== undefined ? { retryAtMs: usableRetryAtMs } : {}),
      ...(exhaustedResetAt(usage, now) !== undefined ? { activeRetryAtMs: exhaustedResetAt(usage, now) } : {}),
    };
  }
  let result: SwapResult;
  try {
    result = await performPoolSwap(adapter, {
      ...(deps.registryPath ? { registryPath: deps.registryPath } : {}),
      ...(deps.ledgerPath ? { ledgerPath: deps.ledgerPath } : {}),
      pool: pool.name,
      target: paid,
      reason,
      now: () => new Date(now),
      ...(options.assumeLimited ? { hardLimitUntilMs: knownResetOrCooldown(usage, now, cooldownMs) } : {}),
      // Decided on a snapshot taken before the usage calls; re-check under the pool lock.
      guard: async ({ pool: current }) => {
        if (current.swapPool.active !== active) throw new SwapSkipped<LimitedOutcome>({ action: "skipped", why: `pool changed to "${current.swapPool.active}" while deciding` });
        if (options.expectedActive !== undefined && current.swapPool.active !== options.expectedActive) throw new SwapSkipped<LimitedOutcome>({ action: "skipped", why: `pool changed to "${current.swapPool.active}" before limit recovery` });
        if (options.assumeLimited && failureAtMs !== undefined) {
          if (await alreadyHandled(current)) throw new SwapSkipped<LimitedOutcome>({ action: "skipped", why: "limit failure was already handled by a pool swap" });
        }
        if (options.assumeLimited) {
          const againUsage = await fetchUsage(activeMember);
          if (!options.trustLimitEvidence && againUsage.status === "live" && typeof againUsage.maxUtilization === "number" && againUsage.maxUtilization < 100) throw new SwapSkipped<LimitedOutcome>({ action: "not-limited", utilization: againUsage.maxUtilization });
        }
        const again = options.assumeLimited ? undefined : await cooldown(current);
        if (again) throw new SwapSkipped<LimitedOutcome>(again);
      },
    });
  } catch (err) {
    if (err instanceof SwapSkipped) return err.outcome as LimitedOutcome;
    throw err;
  }
  return { action: "swapped", result, ...(usage.maxUtilization !== undefined ? { utilization: usage.maxUtilization } : {}) };
}

/** Earliest time at which one allowed member is known to have every exhausted
 * usage window reset. Unknown or malformed reset data keeps the scheduler's
 * ordinary bounded backoff instead of promising an unsafe retry time. */
function earliestPoolReset<U extends PoolUsage>(
  allowed: string[],
  members: Identity[],
  rows: Array<{ name: string; usage?: U; blockedUntil?: number }>,
  now: number,
): number | undefined {
  const memberResets = allowed.map((name) => {
    const blockedUntil = rows.find((row) => row.name === name)?.blockedUntil;
    if (blockedUntil !== undefined && blockedUntil > now) return blockedUntil;
    const member = members.find((entry) => entry.name === name);
    const usage = rows.find((row) => row.name === name)?.usage;
    if (!member || usage?.status !== "live") return undefined;
    const windows = usage.windows ?? [];
    if (!windows.length) return undefined;
    let latestReset = now;
    let exhausted = false;
    for (const window of windows) {
      if (window.utilization < 100) continue;
      exhausted = true;
      const reset = typeof window.resetsAt === "string" ? Date.parse(window.resetsAt) : Number.NaN;
      if (!Number.isFinite(reset) || reset <= now) return undefined;
      latestReset = Math.max(latestReset, reset);
    }
    return exhausted ? latestReset : undefined;
  });
  const validResets = memberResets.filter((reset): reset is number => reset !== undefined);
  if (!validResets.length) return undefined;
  const earliestKnown = Math.min(...validResets);
  return memberResets.some((reset) => reset === undefined) ? Math.min(earliestKnown, now + 30_000) : earliestKnown;
}

function knownResetOrCooldown(usage: PoolUsage, now: number, cooldownMs: number): number {
  const windows = usage.windows ?? [];
  const exhausted = windows.filter((window) => window.utilization >= 100);
  const resets = exhausted.map((window) => typeof window.resetsAt === "string" ? Date.parse(window.resetsAt) : Number.NaN)
    .filter((value) => Number.isFinite(value) && value > now);
  return resets.length ? Math.max(...resets) : now + cooldownMs;
}

function exhaustedResetAt(usage: PoolUsage, now: number): number | undefined {
  const exhausted = (usage.windows ?? []).filter((window) => window.utilization >= 100);
  if (!exhausted.length) return undefined;
  const resets = exhausted.map((window) => typeof window.resetsAt === "string" ? Date.parse(window.resetsAt) : Number.NaN);
  if (resets.some((value) => !Number.isFinite(value) || value <= now)) return undefined;
  return Math.max(...resets);
}
