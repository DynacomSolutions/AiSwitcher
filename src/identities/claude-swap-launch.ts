import { performSwap } from "./claude-swap.ts";
import { swapIfLimited, type OpsDeps } from "./claude-swap-ops.ts";
import { allowedAccounts, isSwapPool, poolThreshold } from "./swap-pool.ts";
import type { Identity } from "./types.ts";
import { nativeStorePathFor } from "./oauth-reconcile.ts";
import { existsSync } from "node:fs";

/** Short budget: the launch must never wait on this for long. */
export const LAUNCH_CHECK_TIMEOUT_MS = 4_000;

/**
 * Pre-launch check run by the claude shim for a swap POOL identity (and only
 * for one). Bootstraps a pool that has no credentials yet, and, when auto
 * swap is on, swaps away from an active member that is over the threshold
 * (reason "launch"). Bounded by a short timeout and never throws: on any
 * error or timeout the launch simply continues with whatever is in place.
 * Returns a one-line note to print on stderr when something happened.
 */
export async function claudeSwapLaunchCheck(
  identity: Identity,
  deps: OpsDeps & { timeoutMs?: number } = {},
): Promise<string | undefined> {
  if (!isSwapPool(identity)) return undefined;
  const pool = identity;
  const work = (async (): Promise<string | undefined> => {
    if (!pool.swapPool.active || !existsSync(nativeStorePathFor("claude", pool.configDir))) {
      const first = allowedAccounts(pool)[0];
      if (!first) return undefined;
      const r = await performSwap({
        ...(deps.registryPath ? { registryPath: deps.registryPath } : {}),
        ...(deps.ledgerPath ? { ledgerPath: deps.ledgerPath } : {}),
        pool: pool.name,
        target: pool.swapPool.active ?? first,
        reason: "launch",
        lock: { timeoutMs: 1_500 },
      });
      const { to: target } = r;
      return `claude-swap: ${pool.name} activated ${target}`;
    }
    if (pool.swapPool.auto !== true) return undefined;
    const outcome = await swapIfLimited(deps, pool.name, "launch");
    if (outcome.action !== "swapped") return undefined;
    const { from: previous, to: target } = outcome.result;
    return `claude-swap: ${pool.name} was at/over ${poolThreshold(pool)}%, switched ${previous} -> ${target}`;
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), deps.timeoutMs ?? LAUNCH_CHECK_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work.catch(() => undefined), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
