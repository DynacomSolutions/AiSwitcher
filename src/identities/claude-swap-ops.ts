import { aisClaudeSwapLedgerPath } from "../shared/ais-home.ts";
import { readSwapEvents, performSwap, type SwapReason, type SwapResult } from "./claude-swap.ts";
import { fetchMemberUsage, type FetchUsageDeps, type MemberUsage } from "./claude-usage-api.ts";
import { isRetired } from "./retired.ts";
import { loadIdentitiesFile } from "./store.ts";
import { allowedAccounts, isAllowed, poolThreshold, requirePool, type PoolIdentity } from "./swap-pool.ts";
import { CLAUDE_CONFIG } from "./tool-configs.ts";
import type { Identity } from "./types.ts";

/** Selection and orchestration on top of claude-swap.ts: who has headroom,
 * and whether a limited active member should be swapped out. */

/** Minimum time between automatic/launch swaps of one pool (hysteresis). */
export const SWAP_COOLDOWN_MS = 10 * 60_000;

export interface MemberRow {
  name: string;
  active: boolean;
  allowed: boolean;
  usage?: MemberUsage;
}

/** Headroom = 100 - worst window. Unknown usage sorts last and is never
 * chosen when `requireKnown` is set. */
export function chooseBest(
  rows: Array<{ name: string; usage?: MemberUsage }>,
  options: { exclude?: string; belowPercent?: number; requireKnown?: boolean },
): string | undefined {
  const ranked = rows
    .filter((r) => r.name !== options.exclude)
    .map((r) => ({ name: r.name, util: r.usage?.status === "live" ? r.usage.maxUtilization : undefined }))
    .filter((r) => (options.requireKnown ? r.util !== undefined : true))
    .filter((r) => options.belowPercent === undefined || (r.util !== undefined && r.util < options.belowPercent))
    .sort((a, b) => (a.util ?? 1000) - (b.util ?? 1000));
  return ranked[0]?.name;
}

export interface OpsDeps extends FetchUsageDeps {
  registryPath?: string;
  ledgerPath?: string;
  now?: () => number;
  fetchUsage?: (member: Identity) => Promise<MemberUsage>;
}

function usageOf(deps: OpsDeps) {
  return deps.fetchUsage ?? ((member: Identity) => fetchMemberUsage(member, { ...deps, claudeRegistryPath: deps.claudeRegistryPath ?? deps.registryPath }));
}

async function load(deps: OpsDeps, poolKey: string | undefined) {
  const file = await loadIdentitiesFile(deps.registryPath ?? CLAUDE_CONFIG.identitiesJsonPath);
  const pool = requirePool(file, poolKey);
  const members = pool.swapPool.accounts
    .map((name) => file.identities.find((i) => i.name === name))
    .filter((i): i is Identity => i !== undefined);
  return { file, pool, members };
}

export async function poolStatus(deps: OpsDeps, poolKey: string | undefined, options: { usage?: boolean } = {}): Promise<{ pool: PoolIdentity; thresholdPercent: number; rows: MemberRow[] }> {
  const { pool, members } = await load(deps, poolKey);
  const fetchUsage = usageOf(deps);
  const rows = await Promise.all(
    pool.swapPool.accounts.map(async (name): Promise<MemberRow> => {
      const member = members.find((m) => m.name === name);
      const base = { name, active: pool.swapPool.active === name, allowed: isAllowed(pool, name) };
      if (!member || isRetired(member) || options.usage === false) return base;
      return { ...base, usage: await fetchUsage(member) };
    }),
  );
  return { pool, thresholdPercent: poolThreshold(pool), rows };
}

/** Switch to the allowed member (other than the active one) with the most headroom. */
export async function swapToNext(deps: OpsDeps, poolKey: string | undefined, reason: SwapReason, options: { requireBelowThreshold?: boolean } = {}): Promise<SwapResult | undefined> {
  const status = await poolStatus(deps, poolKey);
  const candidates = status.rows.filter((r) => r.allowed && !r.active);
  const target = chooseBest(candidates, {
    ...(options.requireBelowThreshold ? { belowPercent: status.thresholdPercent, requireKnown: true } : {}),
  });
  if (!target) return undefined;
  return performSwap({
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
 * swap to the best allowed member below the threshold. Honors the cooldown
 * recorded in the ledger. Used by the daemon poll, the launch check and the
 * optional in-session hook (`next --if-limited`). */
export async function swapIfLimited(
  deps: OpsDeps,
  poolKey: string | undefined,
  reason: SwapReason,
  options: { assumeLimited?: boolean; cooldownMs?: number } = {},
): Promise<LimitedOutcome> {
  const { pool, members } = await load(deps, poolKey);
  const active = pool.swapPool.active;
  if (!active) return { action: "skipped", why: "pool has no active account yet" };
  const now = deps.now?.() ?? Date.now();
  const cooldownMs = options.cooldownMs ?? SWAP_COOLDOWN_MS;
  const events = (await readSwapEvents(deps.ledgerPath ?? aisClaudeSwapLedgerPath())).filter((e) => e.pool === pool.name && e.reason !== "manual");
  const last = events[events.length - 1];
  if (last && now - Date.parse(last.ts) < cooldownMs) return { action: "cooldown", retryAfterMs: cooldownMs - (now - Date.parse(last.ts)) };

  const fetchUsage = usageOf(deps);
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
  const target = chooseBest(rows, { belowPercent: threshold, requireKnown: true });
  if (!target) return { action: "no-candidate", ...(usage.maxUtilization !== undefined ? { utilization: usage.maxUtilization } : {}) };
  const result = await performSwap({
    ...(deps.registryPath ? { registryPath: deps.registryPath } : {}),
    ...(deps.ledgerPath ? { ledgerPath: deps.ledgerPath } : {}),
    pool: pool.name,
    target,
    reason,
    now: () => new Date(now),
  });
  return { action: "swapped", result, ...(usage.maxUtilization !== undefined ? { utilization: usage.maxUtilization } : {}) };
}
