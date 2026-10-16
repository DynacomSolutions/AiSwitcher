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
  | { action: "no-candidate"; utilization?: number }
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
  options: { assumeLimited?: boolean; cooldownMs?: number } = {},
): Promise<LimitedOutcome> {
  const { pool, members } = await load(adapter, deps, poolKey);
  const active = pool.swapPool.active;
  if (!active) return { action: "skipped", why: "pool has no active account yet" };
  const now = deps.now?.() ?? Date.now();
  const cooldownMs = options.cooldownMs ?? SWAP_COOLDOWN_MS;
  const ledgerPath = deps.ledgerPath ?? ledgerPathFor(adapter.tool);
  const cooldown = async (p: PoolIdentity): Promise<LimitedOutcome | undefined> => {
    const events = eventsForPool(await readSwapEvents(ledgerPath), p).filter((e) => e.reason !== "manual");
    const last = events[events.length - 1];
    if (last && now - Date.parse(last.ts) < cooldownMs) return { action: "cooldown", retryAfterMs: cooldownMs - (now - Date.parse(last.ts)) };
    return undefined;
  };
  const cooling = await cooldown(pool);
  if (cooling) return cooling;

  const fetchUsage = usageOf(adapter, deps);
  const activeMember = members.find((m) => m.name === active);
  if (!activeMember) return { action: "skipped", why: `active account "${active}" is not an identity` };
  const usage = await fetchUsage(activeMember);
  const threshold = poolThreshold(pool);
  const limited = options.assumeLimited || usage.status === "rate-limited" || (usage.status === "live" && (usage.maxUtilization ?? 0) >= threshold);
  if (!limited) return { action: "not-limited", ...(usage.maxUtilization !== undefined ? { utilization: usage.maxUtilization } : {}) };

  const others = allowedAccounts(pool).filter((n) => n !== active);
  const rows = await Promise.all(
    others.map(async (name) => {
      const member = members.find((m) => m.name === name);
      return { name, usage: member && !isRetired(member) ? await fetchUsage(member) : undefined };
    }),
  );
  // Nobody below the threshold: fall back to the known member with the lowest
  // utilization if it still has headroom (< 100) and beats the active member
  // (rate-limited or unknown active usage counts as 100).
  const activeUtil = usage.status === "live" ? usage.maxUtilization ?? 100 : 100;
  const fallback = chooseBest(rows, { belowPercent: 100, requireKnown: true });
  const fallbackUtil = rows.find((r) => r.name === fallback)?.usage?.maxUtilization;
  const target = chooseBest(rows, { belowPercent: threshold, requireKnown: true }) ?? (fallbackUtil !== undefined && fallbackUtil < activeUtil ? fallback : undefined);
  const paid = target ?? (activeUtil < 100 || usage.extraUsage?.available ? undefined : chooseBest(rows.filter((r) => r.usage?.extraUsage?.available), {}));
  if (!paid) return { action: "no-candidate", ...(usage.maxUtilization !== undefined ? { utilization: usage.maxUtilization } : {}) };
  let result: SwapResult;
  try {
    result = await performPoolSwap(adapter, {
      ...(deps.registryPath ? { registryPath: deps.registryPath } : {}),
      ...(deps.ledgerPath ? { ledgerPath: deps.ledgerPath } : {}),
      pool: pool.name,
      target: paid,
      reason,
      now: () => new Date(now),
      // Decided on a snapshot taken before the usage calls; re-check under the pool lock.
      guard: async ({ pool: current }) => {
        if (current.swapPool.active !== active) throw new SwapSkipped<LimitedOutcome>({ action: "skipped", why: `pool changed to "${current.swapPool.active}" while deciding` });
        const again = await cooldown(current);
        if (again) throw new SwapSkipped<LimitedOutcome>(again);
      },
    });
  } catch (err) {
    if (err instanceof SwapSkipped) return err.outcome as LimitedOutcome;
    throw err;
  }
  return { action: "swapped", result, ...(usage.maxUtilization !== undefined ? { utilization: usage.maxUtilization } : {}) };
}
