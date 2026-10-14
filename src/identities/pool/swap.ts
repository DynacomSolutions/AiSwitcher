import type { LockOptions } from "../claude-swap-lock.ts";
import { isRetired } from "../retired.ts";
import { loadIdentitiesFile, saveIdentitiesFile } from "../store.ts";
import type { Identity } from "../types.ts";
import type { PoolAdapter, SwapReason, SwapResult } from "./adapter.ts";
import { appendSwapEvent, ledgerPathFor } from "./ledger.ts";
import { isAllowed, memberIdentity, requirePool, SwapPoolError } from "./swap-pool.ts";

export interface PerformSwapOptions {
  registryPath?: string;
  /** Pool name; omitted when exactly one pool exists. */
  pool?: string;
  /** Member name or alias. */
  target: string;
  reason: SwapReason;
  /** Manual swaps may override the allowed set. */
  force?: boolean;
  ledgerPath?: string;
  lock?: LockOptions;
  now?: () => Date;
}

/** Full swap: validate, swap credentials through the adapter, persist
 * `swapPool.active`, append the ledger event. */
export async function performPoolSwap(adapter: PoolAdapter<any>, options: PerformSwapOptions): Promise<SwapResult> {
  const registryPath = options.registryPath ?? adapter.config.identitiesJsonPath;
  const file = await loadIdentitiesFile(registryPath);
  const pool = requirePool(file, options.pool);
  const target = memberIdentity(file, pool, options.target);
  if (isRetired(target)) throw new SwapPoolError(`Account "${target.name}" is retired`);
  if (!options.force && !isAllowed(pool, target.name)) {
    throw new SwapPoolError(`Account "${target.name}" is not allowed in pool "${pool.name}" (run "ais ${adapter.tool}-swap allow ${target.name}" or pass --force).`);
  }
  const members = pool.swapPool.accounts
    .map((name) => file.identities.find((i) => i.name === name))
    .filter((i): i is Identity => i !== undefined && !isRetired(i));
  const fsResult = await adapter.swapCredentials({ pool, members, target, reason: options.reason, ...(options.lock ? { lock: options.lock } : {}) });

  // Re-read so a registry edit made while we waited for the locks survives.
  const fresh = await loadIdentitiesFile(registryPath);
  const freshPool = fresh.identities.find((i) => i.name === pool.name);
  if (freshPool?.swapPool && freshPool.swapPool.active !== target.name) {
    freshPool.swapPool.active = target.name;
    await saveIdentitiesFile(registryPath, fresh);
  }
  if (!fsResult.noop) {
    await appendSwapEvent(
      { ts: (options.now?.() ?? new Date()).toISOString(), pool: pool.name, from: fsResult.from, to: target.name, reason: options.reason },
      options.ledgerPath ?? ledgerPathFor(adapter.tool),
    );
  }
  return { ...fsResult, reason: options.reason };
}
