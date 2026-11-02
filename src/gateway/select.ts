import { chooseBest } from "../identities/pool/ops.ts";
import type { PoolUsage } from "../identities/pool/adapter.ts";
import type { GatewayDeps } from "./app.ts";
import type { GatewayApp } from "./types.ts";

export const DEFAULT_RESERVE_PERCENT = 80;

async function usageOf(deps: Pick<GatewayDeps, "usageFor">, app: GatewayApp, identity: string): Promise<PoolUsage | undefined> {
  try {
    return await deps.usageFor(app.provider, identity);
  } catch {
    return undefined; // No usage figure: allowed and counted.
  }
}

/**
 * The worst window percent, or undefined when the reading carries no number.
 * A status alone never counts: for claude "rate-limited" means the usage
 * endpoint answered 429, not that the account is full.
 */
export function utilisationOf(usage: PoolUsage | undefined): number | undefined {
  if (!usage) return undefined;
  const nums: number[] = [];
  if (typeof usage.maxUtilization === "number" && Number.isFinite(usage.maxUtilization)) nums.push(usage.maxUtilization);
  for (const w of usage.windows ?? []) if (typeof w.utilization === "number" && Number.isFinite(w.utilization)) nums.push(w.utilization);
  return nums.length === 0 ? undefined : Math.max(...nums);
}

/**
 * Pinned: the identity, unless its worst window is at or over the reserve.
 * Pool: the member with the lowest utilisation below the reserve; members with
 * no usage figure are allowed after those with one.
 */
export async function pickIdentity(
  app: GatewayApp,
  deps: Pick<GatewayDeps, "usageFor" | "poolMembers" | "canonical">,
  exclude?: string,
): Promise<{ identity: string } | { reject: "reserve" | "no-headroom" }> {
  const reserve = app.reservePercent ?? DEFAULT_RESERVE_PERCENT;
  if (app.target.kind === "pin") {
    const util = utilisationOf(await usageOf(deps, app, app.target.identity));
    if (util !== undefined && util >= reserve) return { reject: "reserve" };
    return { identity: app.target.identity };
  }
  let names = await deps.poolMembers(app.provider);
  if (app.target.identities && app.target.identities.length > 0) {
    const canon = deps.canonical;
    const allowed = new Set(await Promise.all(app.target.identities.map((n) => (canon ? canon(app.provider, n).catch(() => n) : n))));
    names = names.filter((n) => allowed.has(n));
  }
  names = names.filter((n) => n !== exclude);
  const rows = await Promise.all(
    names.map(async (name) => {
      const usage = await usageOf(deps, app, name);
      const util = utilisationOf(usage);
      return { name, usage: util === undefined ? undefined : ({ status: "live", maxUtilization: util, capturedAt: "", ...(usage?.extraUsage ? { extraUsage: usage.extraUsage } : {}) } as PoolUsage) };
    }),
  );
  const known = chooseBest(rows, { belowPercent: reserve, requireKnown: true });
  if (known) return { identity: known };
  const unknown = rows.find((r) => r.usage === undefined);
  return unknown ? { identity: unknown.name } : { reject: "no-headroom" };
}
