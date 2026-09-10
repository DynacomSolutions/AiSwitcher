import { loadSpendGuardCache, writeSpendGuardCache } from "./cache.ts";
import { runSpendGuardCycle } from "./compute.ts";

/**
 * The internal `ais __spend_refresh` command: one full spend-guard cycle
 * with NO enforcement side effects (kills belong to the daemon), persisting
 * the result to the cache the launch gate reads. Spawned DETACHED by the
 * gate whenever its cache is stale or missing, so a launch never waits on
 * AWS APIs: the gate decides on last-known state instantly, and this
 * process makes the next launch better-informed. Fetch failures land in the
 * cached states as degraded+reason (never thrown), honouring the contract:
 * never block on missing data, never silently skip.
 */
export async function runSpendRefreshCommand(): Promise<void> {
  const [previous, cycle] = await Promise.all([loadSpendGuardCache(), runSpendGuardCycle()]);
  await writeSpendGuardCache({
    version: 1,
    updatedAt: cycle.computedAt,
    accounts: cycle.states,
    recentKills: previous?.recentKills ?? [],
  });
  if (cycle.errors.length > 0) {
    // Stderr is ignored by the detached spawn; this is for anyone running
    // the refresh by hand to watch it work.
    for (const error of cycle.errors) console.error(`spend-guard: ${error}`);
  }
}
