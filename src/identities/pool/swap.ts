import { isRetired } from "../retired.ts";
import { loadIdentitiesFile, saveIdentitiesFile } from "../store.ts";
import type { Identity } from "../types.ts";
import type { PoolAdapter, SwapReason, SwapResult } from "./adapter.ts";
import { appendSwapEvent, ledgerPathFor } from "./ledger.ts";
import { withPoolLock, type LockOptions } from "./lock.ts";
import { isAllowed, memberIdentity, requirePool, SwapPoolError, swapCommandName, type PoolIdentity } from "./swap-pool.ts";

/** Thrown by a `guard` to abandon a swap; `outcome` is the caller's own value. */
export class SwapSkipped<O = unknown> extends Error {
  constructor(readonly outcome: O) {
    super("swap skipped");
    this.name = "SwapSkipped";
  }
}

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
  /** Runs under the pool lock after the registry re-read, before any
   * credential is touched; throw `SwapSkipped` to abandon the swap. */
  guard?: (ctx: { pool: PoolIdentity; ledgerPath: string }) => Promise<void>;
}

/** Full swap: validate, swap credentials through the adapter, persist
 * `swapPool.active`, append the ledger event. */
export async function performPoolSwap(adapter: PoolAdapter<any>, options: PerformSwapOptions): Promise<SwapResult> {
  const registryPath = options.registryPath ?? adapter.config.identitiesJsonPath;
  // Resolve the pool dir unlocked, then hold the pool lock across the whole
  // read-decide-write sequence so two swappers cannot both act on stale state.
  const poolDir = requirePool(await loadIdentitiesFile(registryPath), options.pool, adapter.tool).configDir;
  return withPoolLock(poolDir, () => swapLocked(adapter, options), options.lock);
}

async function swapLocked(adapter: PoolAdapter<any>, options: PerformSwapOptions): Promise<SwapResult> {
  const registryPath = options.registryPath ?? adapter.config.identitiesJsonPath;
  const file = await loadIdentitiesFile(registryPath);
  const pool = requirePool(file, options.pool, adapter.tool);
  const ledgerPath = options.ledgerPath ?? ledgerPathFor(adapter.tool);
  await options.guard?.({ pool, ledgerPath });
  const target = memberIdentity(file, pool, options.target);
  if (isRetired(target)) throw new SwapPoolError(`Account "${target.name}" is retired`);
  if (!options.force && !isAllowed(pool, target.name)) {
    throw new SwapPoolError(`Account "${target.name}" is not allowed in pool "${pool.name}" (run "${swapCommandName(adapter.tool)} allow ${target.name}" or pass --force).`);
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
      ledgerPath,
    );
  }
  let runningSessions: number | undefined;
  if (!fsResult.noop && adapter.notifySwapped) {
    try {
      runningSessions = (await adapter.notifySwapped({ ...pool, swapPool: { ...pool.swapPool, active: target.name } }, fsResult.from, target.name))?.sessions;
    } catch {
      // notification is best effort
    }
  }
  return { ...fsResult, reason: options.reason, ...(runningSessions !== undefined ? { runningSessions } : {}) };
}
