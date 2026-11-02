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
 * Pinned: the identity, unless its worst window is at or over the reserve.
 * Pool: the member with the lowest utilisation below the reserve; members with
 * no usage figure are allowed after those with one.
 */
export async function pickIdentity(
  app: GatewayApp,
  deps: Pick<GatewayDeps, "usageFor" | "poolMembers">,
  exclude?: string,
): Promise<{ identity: string } | { reject: "reserve" | "no-headroom" }> {
  const reserve = app.reservePercent ?? DEFAULT_RESERVE_PERCENT;
  if (app.target.kind === "pin") {
    const usage = await usageOf(deps, app, app.target.identity);
    if (usage?.status === "rate-limited" || (usage?.status === "live" && (usage.maxUtilization ?? 0) >= reserve)) {
      return { reject: "reserve" };
    }
    return { identity: app.target.identity };
  }
  let names = await deps.poolMembers(app.provider);
  if (app.target.identities && app.target.identities.length > 0) {
    const allowed = new Set(app.target.identities);
    names = names.filter((n) => allowed.has(n));
  }
  names = names.filter((n) => n !== exclude);
  const rows = await Promise.all(names.map(async (name) => ({ name, usage: await usageOf(deps, app, name) })));
  const known = chooseBest(rows, { belowPercent: reserve, requireKnown: true });
  if (known) return { identity: known };
  const unknown = rows.find((r) => r.usage?.status !== "live" && r.usage?.status !== "rate-limited");
  return unknown ? { identity: unknown.name } : { reject: "no-headroom" };
}
