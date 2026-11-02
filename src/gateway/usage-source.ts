import { findIdentityByNameOrAlias, loadIdentitiesFile } from "../identities/store.ts";
import type { PoolUsage } from "../identities/pool/adapter.ts";
import { adapterFor as poolAdapterFor } from "../identities/pool/registry.ts";
import { TOOL_CONFIGS } from "../cli/identities/resolve-tool.ts";
import type { GatewayProvider } from "./types.ts";

export const USAGE_TTL_MS = 45_000;

export type FetchUsage = (provider: GatewayProvider, identity: string) => Promise<PoolUsage | undefined>;

/** The agent reserve's utilisation figure, from the same adapters `ais swap` uses (claude, codex, kimi). Others have none. The poll never refreshes a token (`noRefresh`): rotating a grant is the proxy's job, where it is counted and alerted. */
export const fetchPoolUsage: FetchUsage = async (provider, identity) => {
  if (provider !== "claude" && provider !== "codex" && provider !== "kimi") return undefined;
  const adapter = poolAdapterFor(provider);
  if (!adapter) return undefined;
  const file = await loadIdentitiesFile(TOOL_CONFIGS[provider].identitiesJsonPath);
  const found = findIdentityByNameOrAlias(file.identities, identity);
  return found ? adapter.fetchUsage(found, { noRefresh: true }) : undefined;
};

interface Entry {
  value: PoolUsage | undefined;
  at: number;
}

/**
 * Usage figures cached per provider and identity. A request never waits on the
 * usage API: a cold miss answers "no figure" and fills in the background, a
 * stale entry is served while one refresh (single-flight) runs. "unavailable"
 * counts as no figure; a failed fetch keeps the previous value.
 */
export function createUsageSource(opts: { fetchUsage: FetchUsage; ttlMs?: number; now?: () => number }) {
  const ttl = opts.ttlMs ?? USAGE_TTL_MS;
  const now = opts.now ?? Date.now;
  const entries = new Map<string, Entry>();
  const inflight = new Map<string, Promise<void>>();
  const keyOf = (p: string, i: string): string => `${p}\u0000${i}`;

  const refresh = (provider: GatewayProvider, identity: string): Promise<void> => {
    const key = keyOf(provider, identity);
    const running = inflight.get(key);
    if (running) return running;
    const run = (async () => {
      try {
        const u = await opts.fetchUsage(provider, identity);
        entries.set(key, { value: u && u.status !== "unavailable" ? u : undefined, at: now() });
      } catch {
        // Keep the old figure; retry after the next ttl.
        entries.set(key, { value: entries.get(key)?.value, at: now() });
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, run);
    return run;
  };

  return {
    async get(provider: GatewayProvider, identity: string): Promise<PoolUsage | undefined> {
      const e = entries.get(keyOf(provider, identity));
      if (!e || now() - e.at >= ttl) void refresh(provider, identity);
      return e?.value;
    },
    /** Fetches now and waits; used at warm-up. */
    prefill: refresh,
    /** Waits for fetches in flight (tests). */
    async idle(): Promise<void> {
      while (inflight.size > 0) await Promise.all([...inflight.values()]);
    },
  };
}
