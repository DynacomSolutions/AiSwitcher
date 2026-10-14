import type { Identity } from "../types.ts";
import type { PoolAdapter, PoolUsage } from "./adapter.ts";
import { swapIfLimited, type PoolOpsDeps } from "./ops.ts";
import { performPoolSwap } from "./swap.ts";
import { allowedAccounts, isSwapPool, poolThreshold } from "./swap-pool.ts";

/** Short budget: the launch must never wait on this for long. */
export const LAUNCH_CHECK_TIMEOUT_MS = 4_000;
/**
 * The shim now replaces itself with the real tool (execve), which would cut
 * any swap still running in this process mid-write. So work that loses the
 * budget race gets this much longer to finish; if it has not even started
 * swapping by then it is cancelled, and a swap that has started is always
 * awaited to the end (its lock waits are bounded).
 */
export const LAUNCH_SETTLE_MS = 30_000;

/**
 * Pre-launch check run by a tool shim for a swap POOL identity (and only
 * for one). Bootstraps a pool that has no credentials yet, and, when auto
 * swap is on, swaps away from an active member that is over the threshold
 * (reason "launch"). Bounded by a short timeout and never throws: on any
 * error or timeout the launch simply continues with whatever is in place.
 * Returns a one-line note to print on stderr when something happened.
 */
export async function poolLaunchCheck<U extends PoolUsage>(
  realAdapter: PoolAdapter<U>,
  identity: Identity,
  deps: PoolOpsDeps<U> & { timeoutMs?: number; settleMs?: number } = {},
): Promise<string | undefined> {
  if (!isSwapPool(identity)) return undefined;
  const pool = identity;
  let cancelled = false;
  let swapping = false;
  // Everything after this point is the critical section: it is never abandoned.
  const adapter: PoolAdapter<U> = {
    ...realAdapter,
    swapCredentials: async (input) => {
      if (cancelled) throw new Error("pool launch check cancelled before swapping");
      swapping = true;
      return realAdapter.swapCredentials(input);
    },
  };
  const label = `${adapter.tool}-swap`;
  const work = (async (): Promise<string | undefined> => {
    if (!pool.swapPool.active || !adapter.hasCredentials(pool.configDir)) {
      const first = allowedAccounts(pool)[0];
      if (!first) return undefined;
      const r = await performPoolSwap(adapter, {
        ...(deps.registryPath ? { registryPath: deps.registryPath } : {}),
        ...(deps.ledgerPath ? { ledgerPath: deps.ledgerPath } : {}),
        pool: pool.name,
        target: pool.swapPool.active ?? first,
        reason: "launch",
        lock: { timeoutMs: 1_500 },
      });
      const { to: target } = r;
      return `${label}: ${pool.name} activated ${target}`;
    }
    if (pool.swapPool.auto !== true) return undefined;
    const outcome = await swapIfLimited(adapter, deps, pool.name, "launch");
    if (outcome.action !== "swapped") return undefined;
    const { from: previous, to: target } = outcome.result;
    return `${label}: ${pool.name} was at/over ${poolThreshold(pool)}%, switched ${previous} -> ${target}`;
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), deps.timeoutMs ?? LAUNCH_CHECK_TIMEOUT_MS);
  });
  const settled = work.catch(() => undefined);
  try {
    const first = await Promise.race([settled.then((note) => ({ note })), timeout.then(() => undefined)]);
    if (first) return first.note;
    // Budget exhausted: give the work a bounded chance to finish (see LAUNCH_SETTLE_MS).
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const second = await Promise.race([
      settled.then((note) => ({ note })),
      new Promise<undefined>((resolve) => {
        settleTimer = setTimeout(() => resolve(undefined), deps.settleMs ?? LAUNCH_SETTLE_MS);
      }),
    ]);
    if (settleTimer) clearTimeout(settleTimer);
    if (second) return second.note;
    cancelled = true;
    if (swapping) await settled;
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
