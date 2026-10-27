import { isRetired } from "../retired.ts";
import { loadIdentitiesFile } from "../store.ts";
import type { Identity } from "../types.ts";
import type { PoolAdapter, PoolUsage } from "./adapter.ts";
import { withPoolLock } from "./lock.ts";
import { requirePool, type PoolIdentity } from "./swap-pool.ts";

/**
 * The one pool-heal mechanic, shared by the scheduler tick and the launch
 * check: under the pool lock, reload the registry (a swap that landed while
 * waiting must not be undone), re-resolve the pool (a legacy duplicate name
 * redirects to the canonical record) and its non-retired members, then let
 * the adapter repair its pool folder. Returns the adapter's human notes; an
 * adapter without heal yields none. Every lock wait is bounded.
 */
export async function healPool<U extends PoolUsage>(
  adapter: PoolAdapter<U>,
  pool: PoolIdentity,
  opts: { registryPath?: string; lockTimeoutMs?: number } = {},
): Promise<string[]> {
  if (!adapter.heal) return [];
  const lock = { timeoutMs: opts.lockTimeoutMs ?? 1_500 };
  return withPoolLock(pool.configDir, async () => {
    const file = await loadIdentitiesFile(opts.registryPath ?? adapter.config.identitiesJsonPath);
    const fresh = requirePool(file, pool.name, adapter.tool);
    const members = fresh.swapPool.accounts
      .map((name) => file.identities.find((i) => i.name === name))
      .filter((i): i is Identity => i !== undefined && !isRetired(i));
    return adapter.heal!(fresh, members, lock);
  }, lock);
}
