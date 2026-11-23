import { existsSync } from "node:fs";
import { t3Paths } from "../identities/t3-anthropic-proxy.ts";
import { createFavouritesClient, type FavouritesApi } from "../t3/favourites/client.ts";
import { gatewayAdmin } from "../t3/favourites/config.ts";
import { FavSyncMetrics } from "../t3/favourites/metrics.ts";
import { homeKey, hostNames, metricsPathOf, runFavouritesSync, type FavSyncDeps, type HostNames, type RunOptions } from "../t3/favourites/sync.ts";
import { settingsPathOf } from "../t3/favourites/settings.ts";

/**
 * Runs the T3 favourites sync (src/t3/favourites/sync.ts) inside the host profile-sync daemon, for each T3 home that AIS manages
 * on this host: the home that `ais gateway t3-instance` writes to (T3CODE_HOME, else ~/.t3), once it has a settings file.
 * It waits for the gateway admin address and token, checks again every minute, and restarts a loop that ended with a growing pause.
 */

const RECHECK_MS = 60_000;
const RESTART_MIN_MS = 10_000;
const RESTART_MAX_MS = 5 * 60_000;

export interface T3FavouritesTickerDeps {
  homes?: () => string[];
  admin?: () => Promise<{ url: string; token: string } | undefined>;
  client?: (admin: { url: string; token: string }) => FavouritesApi;
  names?: () => Promise<HostNames>;
  /** Replaces the loop (tests). */
  run?: (d: FavSyncDeps, o: RunOptions) => Promise<void>;
  stateDir?: string;
  runOptions?: RunOptions;
  now?: () => number;
  log?: (message: string) => void;
}

export interface T3FavouritesTicker {
  tick(): Promise<void>;
  stop(): void;
  /** Tests and status: the homes whose loop runs now. */
  running(): string[];
}

export function createT3FavouritesTicker(deps: T3FavouritesTickerDeps = {}): T3FavouritesTicker {
  const homes = deps.homes ?? (() => [t3Paths().t3Home]);
  const admin = deps.admin ?? (() => gatewayAdmin());
  const makeClient = deps.client ?? ((a) => createFavouritesClient(a));
  const run = deps.run ?? runFavouritesSync;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((m: string) => console.error(`ais: ${m}`));
  const ctl = new AbortController();
  const loops = new Map<string, Promise<void>>();
  const restartAt = new Map<string, number>();
  const pause = new Map<string, number>();
  let checkedAt = -Infinity;
  let stopped = false;

  const start = (home: string, a: { url: string; token: string }): void => {
    const startedAt = now();
    const d: FavSyncDeps = {
      t3Home: home,
      client: makeClient(a),
      names: deps.names ?? hostNames,
      metrics: new FavSyncMetrics(metricsPathOf(home, deps.stateDir)),
      ...(deps.stateDir ? { stateDir: deps.stateDir } : {}),
      log,
    };
    log(`t3 favourites sync: following ${homeKey(home)}`);
    const p = run(d, { signal: ctl.signal, ...(deps.runOptions ?? {}) })
      .catch((err: unknown) => log(`t3 favourites sync: stopped (${err instanceof Error ? err.message : String(err)})`))
      .finally(() => {
        loops.delete(home);
        if (stopped) return;
        // A loop that ran for ten minutes starts over with the short pause.
        const next = now() - startedAt >= 10 * 60_000 ? RESTART_MIN_MS : Math.min((pause.get(home) ?? RESTART_MIN_MS / 2) * 2, RESTART_MAX_MS);
        pause.set(home, next);
        restartAt.set(home, now() + next);
      });
    loops.set(home, p);
  };

  return {
    running: () => [...loops.keys()],
    async tick() {
      if (stopped || now() - checkedAt < RECHECK_MS) return;
      checkedAt = now();
      const a = await admin().catch(() => undefined);
      if (!a) return;
      for (const home of homes()) {
        if (loops.has(home) || (restartAt.get(home) ?? 0) > now() || !existsSync(settingsPathOf(home))) continue;
        start(home, a);
      }
    },
    stop() {
      stopped = true;
      ctl.abort();
    },
  };
}
