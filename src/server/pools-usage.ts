import { TOOL_CONFIGS, loadAll } from "../cli/identities/resolve-tool.ts";
import { poolsOf } from "../identities/pool/swap-pool.ts";
import { loadGatewayIdentityUsage, type GatewayIdentityUsageView } from "../gateway/usage-view.ts";
import type { IdentityUsageRow } from "../gateway/types.ts";

export interface PoolRef {
  tool: string;
  name: string;
  active?: string;
  members: Array<{ name: string; allowed: boolean }>;
}

export interface GatewayPeriod {
  configured: boolean;
  error?: string;
  rows: IdentityUsageRow[];
}

export interface PoolsUsageResponse {
  /** Local calendar day the server treats as today (the key native daily usage uses). */
  todayKey: string;
  /** First calendar day of the 7-day window (inclusive). */
  weekStartKey: string;
  pools: PoolRef[];
  gateway: { today: GatewayPeriod; week: GatewayPeriod };
}

const key = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export interface PoolsUsageDeps {
  pools?: () => Promise<PoolRef[]>;
  gateway?: (since: Date) => Promise<GatewayIdentityUsageView>;
  now?: () => Date;
}

export async function loadPoolRefs(): Promise<PoolRef[]> {
  const files = await loadAll(Object.values(TOOL_CONFIGS));
  const out: PoolRef[] = [];
  for (const f of files) {
    for (const p of poolsOf(f.file)) {
      const off = new Set(p.swapPool.disallowed ?? []);
      out.push({
        tool: f.cfg.toolName,
        name: p.name,
        ...(p.swapPool.active ? { active: p.swapPool.active } : {}),
        members: p.swapPool.accounts.map((name) => ({ name, allowed: !off.has(name) })),
      });
    }
  }
  return out;
}

/** Pool membership plus the gateway ledger by identity for today and the last 7 calendar days (server local time). */
export async function poolsUsage(deps: PoolsUsageDeps = {}): Promise<PoolsUsageResponse> {
  const now = (deps.now ?? (() => new Date()))();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
  const load = deps.gateway ?? ((since: Date) => loadGatewayIdentityUsage(since));
  const [pools, today, week] = await Promise.all([(deps.pools ?? loadPoolRefs)(), load(dayStart), load(weekStart)]);
  const period = (v: GatewayIdentityUsageView): GatewayPeriod => ({ configured: v.configured, rows: v.rows, ...(v.error ? { error: v.error } : {}) });
  return { todayKey: key(now), weekStartKey: key(weekStart), pools, gateway: { today: period(today), week: period(week) } };
}
