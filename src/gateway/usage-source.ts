import { findIdentityByNameOrAlias, loadIdentitiesFile } from "../identities/store.ts";
import type { PoolUsage } from "../identities/pool/adapter.ts";
import { adapterFor as poolAdapterFor } from "../identities/pool/registry.ts";
import { TOOL_CONFIGS } from "../cli/identities/resolve-tool.ts";
import type { GatewayProvider } from "./types.ts";

export const USAGE_TTL_MS = 45_000;

/** `fresh`: read the source now, past any short-lived shared cache (claude's one-minute last-good file). */
export type FetchUsage = (provider: GatewayProvider, identity: string, opts?: { fresh?: boolean }) => Promise<PoolUsage | undefined>;

/** The agent reserve's utilisation figure, from the same adapters `ais swap` uses (claude, codex, kimi). Others have none. The poll never refreshes a token (`noRefresh`): rotating a grant is the proxy's job, where it is counted and alerted. */
export const fetchPoolUsage: FetchUsage = async (provider, identity, opts) => {
  if (provider !== "claude" && provider !== "codex" && provider !== "kimi") return undefined;
  const adapter = poolAdapterFor(provider);
  if (!adapter) return undefined;
  const file = await loadIdentitiesFile(TOOL_CONFIGS[provider].identitiesJsonPath);
  const found = findIdentityByNameOrAlias(file.identities, identity);
  return found ? adapter.fetchUsage(found, { noRefresh: true, ...(opts?.fresh ? { fresh: true } : {}) }) : undefined;
};

interface Entry {
  value: PoolUsage | undefined;
  at: number;
}

/**
 * Usage figures cached per provider and identity. A request never waits on the
 * usage API: a cold miss answers "no figure" and fills in the background, a
 * stale entry is served while one refresh (single-flight) runs. "unavailable"
 * counts as no figure; a failed fetch or a reading with no figure keeps the previous value, marked `stale`.
 * A stale figure is for display only: the reserve never refuses on it (an account reset upstream must not stay
 * blocked behind a figure that can no longer be refreshed).
 */
export function createUsageSource(opts: { fetchUsage: FetchUsage; ttlMs?: number; now?: () => number }) {
  const ttl = opts.ttlMs ?? USAGE_TTL_MS;
  const now = opts.now ?? Date.now;
  const entries = new Map<string, Entry>();
  const inflight = new Map<string, Promise<void>>();
  /** Fresh reads in flight: one per member, so a burst of quota answers asks the source once. */
  const freshInflight = new Map<string, Promise<void>>();
  const keyOf = (p: string, i: string): string => `${p}\u0000${i}`;
  const staleOf = (v: PoolUsage | undefined): PoolUsage | undefined => (v ? { ...v, stale: true } : undefined);

  const refresh = (provider: GatewayProvider, identity: string, fresh = false): Promise<void> => {
    const key = keyOf(provider, identity);
    const running = inflight.get(key);
    if (running && !fresh) return running;
    const runningFresh = freshInflight.get(key);
    if (runningFresh) return runningFresh;
    const run = (async () => {
      // A plain read already in flight may answer from before the quota answer: let it land, then read again.
      if (running) await running;
      try {
        const u = await opts.fetchUsage(provider, identity, fresh ? { fresh: true } : undefined);
        // A reading with no figure (the usage API answered 429, as Anthropic's does for an account at its limit, or was
        // unavailable) keeps the last figure: answering "no limits" for a full account is wrong (T3 showed "No limits reported").
        const prev = entries.get(key)?.value;
        const hasFigure = (v: PoolUsage | undefined): boolean => !!v && v.status !== "unavailable" && ((v.windows?.length ?? 0) > 0 || typeof v.maxUtilization === "number");
        entries.set(key, { value: hasFigure(u) ? u : staleOf(prev), at: now() });
      } catch {
        // Keep the old figure; retry after the next ttl.
        entries.set(key, { value: staleOf(entries.get(key)?.value), at: now() });
      } finally {
        if (fresh) freshInflight.delete(key);
        else inflight.delete(key);
      }
    })();
    (fresh ? freshInflight : inflight).set(key, run);
    return run;
  };

  return {
    async get(provider: GatewayProvider, identity: string): Promise<PoolUsage | undefined> {
      const e = entries.get(keyOf(provider, identity));
      if (!e || now() - e.at >= ttl) void refresh(provider, identity);
      return e?.value;
    },
    /** Fetches now and waits; used at warm-up. */
    prefill: (provider: GatewayProvider, identity: string): Promise<void> => refresh(provider, identity),
    /** Reads the source now (past any shared short-lived cache) and waits; single-flight per member. Used after a quota answer. */
    refreshNow: (provider: GatewayProvider, identity: string): Promise<void> => refresh(provider, identity, true),
    /** Waits for fetches in flight (tests). */
    async idle(): Promise<void> {
      while (inflight.size > 0 || freshInflight.size > 0) await Promise.all([...inflight.values(), ...freshInflight.values()]);
    },
  };
}
