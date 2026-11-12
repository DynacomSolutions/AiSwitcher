import { chooseBest } from "../identities/pool/ops.ts";
import type { PoolUsage } from "../identities/pool/adapter.ts";
import type { GatewayDeps } from "./app.ts";
import type { GatewayApp } from "./types.ts";

export const DEFAULT_RESERVE_PERCENT = 100;

async function usageOf(deps: Pick<GatewayDeps, "usageFor">, app: GatewayApp, identity: string): Promise<PoolUsage | undefined> {
  try {
    return await deps.usageFor(app.provider, identity);
  } catch {
    return undefined; // No usage figure: allowed and counted.
  }
}

function normalisedModel(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** True when a scoped window's model (a display name such as "Fable") names the request model id (e.g. "claude-fable-5-2"). */
export function scopedModelMatches(windowModel: string, requestModel: string | undefined): boolean {
  if (requestModel === undefined) return false;
  const needle = normalisedModel(windowModel);
  return needle !== "" && normalisedModel(requestModel).includes(needle);
}

/**
 * The reading as it applies to one request: per-model windows (a Fable weekly, say) are kept only when the request
 * model is that model, so a full Fable window never blocks Opus. Without a request model every per-model window goes.
 */
export function usageForModel(usage: PoolUsage | undefined, model: string | undefined): PoolUsage | undefined {
  if (!usage?.windows?.some((w) => w.model !== undefined)) return usage;
  return { ...usage, windows: usage.windows.filter((w) => w.model === undefined || scopedModelMatches(w.model, model)) };
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
 * The figure the reserve may refuse on: a fresh reading only. A stale one (the
 * usage API stopped answering, as Anthropic's does with 429 for a full account)
 * may predate a reset, so it never blocks: the provider's own answer decides.
 */
export function reserveUtilisationOf(usage: PoolUsage | undefined): number | undefined {
  return usage?.stale ? undefined : utilisationOf(usage);
}

/** The members an app may use: the pin, or the pool members narrowed by the app's identity list. */
export async function allowedMembers(app: GatewayApp, deps: Pick<GatewayDeps, "poolMembers" | "canonical">): Promise<string[]> {
  if (app.target.kind === "pin") return [app.target.identity];
  let names = await deps.poolMembers(app.provider);
  if (app.target.identities && app.target.identities.length > 0) {
    const canon = deps.canonical;
    const allowed = new Set(await Promise.all(app.target.identities.map((n) => (canon ? canon(app.provider, n).catch(() => n) : n))));
    names = names.filter((n) => allowed.has(n));
  }
  return names;
}

/** The usage readings of the members an app may use, for the native limit answer (reset times), as they apply to `model`. */
export async function memberUsages(
  app: GatewayApp,
  deps: Pick<GatewayDeps, "usageFor" | "poolMembers" | "canonical">,
  model?: string,
): Promise<Array<PoolUsage | undefined>> {
  let names: string[];
  try {
    names = await allowedMembers(app, deps);
  } catch {
    return [];
  }
  return Promise.all(names.map(async (n) => usageForModel(await usageOf(deps, app, n), model)));
}

/**
 * Pinned: the identity, unless its worst window is at or over the reserve.
 * Pool: the member with the lowest utilisation below the reserve; members with
 * no usage figure are allowed after those with one. A per-model window counts only for a request for that model.
 */
export async function pickIdentity(
  app: GatewayApp,
  deps: Pick<GatewayDeps, "usageFor" | "poolMembers" | "canonical">,
  exclude?: string | ReadonlySet<string>,
  model?: string,
): Promise<{ identity: string } | { reject: "reserve" | "no-headroom" | "no-identities" }> {
  const reserve = app.reservePercent ?? DEFAULT_RESERVE_PERCENT;
  if (app.target.kind === "pin") {
    const util = reserveUtilisationOf(usageForModel(await usageOf(deps, app, app.target.identity), model));
    if (util !== undefined && util >= reserve) return { reject: "reserve" };
    return { identity: app.target.identity };
  }
  let names = await allowedMembers(app, deps);
  // Nothing to choose from at all (as opposed to everything being full): say so.
  if (names.length === 0) return { reject: "no-identities" };
  const skip = typeof exclude === "string" ? new Set([exclude]) : exclude;
  if (skip && skip.size > 0) names = names.filter((n) => !skip.has(n));
  const rows = await Promise.all(
    names.map(async (name) => {
      const usage = usageForModel(await usageOf(deps, app, name), model);
      const util = reserveUtilisationOf(usage);
      return { name, usage: util === undefined ? undefined : ({ status: "live", maxUtilization: util, capturedAt: "", ...(usage?.extraUsage ? { extraUsage: usage.extraUsage } : {}) } as PoolUsage) };
    }),
  );
  // A window at 100% is full whatever the reserve says (reserve 100 must not let a full account through).
  const known = chooseBest(rows, { belowPercent: Math.min(reserve, 99.999), requireKnown: true });
  if (known) return { identity: known };
  const unknown = rows.find((r) => r.usage === undefined);
  return unknown ? { identity: unknown.name } : { reject: "no-headroom" };
}
