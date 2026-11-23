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

/**
 * The members an app may use: the pin, or every live pool member of the provider.
 * A pool app follows the live pool. A member list on an old stored row is ignored.
 */
export async function allowedMembers(app: GatewayApp, deps: Pick<GatewayDeps, "poolMembers">): Promise<string[]> {
  if (app.target.kind === "pin") return [app.target.identity];
  return deps.poolMembers(app.provider);
}

/** The usage readings of the members an app may use, for the native limit answer (reset times), as they apply to `model`; `unfiltered` keeps every per-model window. */
export async function memberUsages(
  app: GatewayApp,
  deps: Pick<GatewayDeps, "usageFor" | "poolMembers">,
  model?: string,
  unfiltered = false,
): Promise<Array<PoolUsage | undefined>> {
  let names: string[];
  try {
    names = await allowedMembers(app, deps);
  } catch {
    return [];
  }
  return Promise.all(names.map(async (n) => (unfiltered ? await usageOf(deps, app, n) : usageForModel(await usageOf(deps, app, n), model))));
}

/**
 * Pinned: the identity, unless its worst window is at or over the reserve.
 * Pool: the member with the lowest utilisation below the reserve; members with
 * no fresh usage figure are allowed after those with one, in turn. A per-model window counts only for a request for that model.
 */
export async function pickIdentity(
  app: GatewayApp,
  deps: Pick<GatewayDeps, "usageFor" | "poolMembers">,
  exclude?: string | ReadonlySet<string>,
  model?: string,
  /** Only asks whether a member would be picked: the rotation does not advance. */
  peek = false,
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
      return { name, noPlan: usage?.noPlan === true, usage: util === undefined ? undefined : ({ status: "live", maxUtilization: util, capturedAt: "", ...(usage?.extraUsage ? { extraUsage: usage.extraUsage } : {}) } as PoolUsage) };
    }),
  );
  // A window at 100% is full whatever the reserve says (reserve 100 must not let a full account through).
  const known = chooseBest(rows, { belowPercent: Math.min(reserve, 99.999), requireKnown: true });
  if (known) return { identity: known };
  // Members with no fresh figure (stale readings: Anthropic's usage API stops answering a busy account) take turns:
  // always taking the first one sent the whole pool's traffic to one account, which then answered burst 429s while
  // the others had capacity.
  // A member with no plan cannot serve: it is tried only when nothing else is left, as before.
  const unknownAll = rows.filter((r) => r.usage === undefined);
  if (unknownAll.length === 0) return { reject: "no-headroom" };
  const unknown = unknownAll.some((r) => !r.noPlan) ? unknownAll.filter((r) => !r.noPlan) : unknownAll.slice(0, 1);
  const turns = unknownTurns(deps, app.provider);
  const next = unknown.reduce((a, b) => ((turns.last.get(b.name) ?? 0) < (turns.last.get(a.name) ?? 0) ? b : a));
  if (!peek) turns.last.set(next.name, ++turns.seq);
  return { identity: next.name };
}

/** Per gateway (deps object) and provider: when each unknown-figure member was last picked, for the rotation above. */
const turnsByDeps = new WeakMap<object, Map<string, { seq: number; last: Map<string, number> }>>();
function unknownTurns(deps: object, provider: string): { seq: number; last: Map<string, number> } {
  let byProvider = turnsByDeps.get(deps);
  if (!byProvider) turnsByDeps.set(deps, (byProvider = new Map()));
  let t = byProvider.get(provider);
  if (!t) byProvider.set(provider, (t = { seq: 0, last: new Map() }));
  return t;
}
