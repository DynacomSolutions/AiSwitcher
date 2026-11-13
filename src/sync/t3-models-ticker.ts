import { describeResult, syncT3GatewayModels, type FolderResult } from "../identities/t3-gateway-models.ts";

/**
 * Runs the T3 gateway model-list sync (src/identities/t3-gateway-models.ts) from the host profile-sync daemon: at the
 * first tick, then every 10 minutes. A pass runs in the background (the daemon's 30 s poll never waits on the network),
 * one at a time. Changes and new failures are logged once; a failure that repeats is not logged again.
 */

export const T3_MODELS_INTERVAL_MS = 10 * 60_000;

export interface T3ModelsTickerDeps {
  sync?: () => Promise<FolderResult[]>;
  now?: () => number;
  log?: (message: string) => void;
  intervalMs?: number;
}

export interface T3ModelsTicker {
  tick(): Promise<void>;
  /** Tests: the pass in flight, if any. */
  idle(): Promise<void>;
}

export function createT3ModelsTicker(deps: T3ModelsTickerDeps = {}): T3ModelsTicker {
  const sync = deps.sync ?? (() => syncT3GatewayModels());
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((m: string) => console.error(`ais: ${m}`));
  const interval = deps.intervalMs ?? T3_MODELS_INTERVAL_MS;
  let nextAt = -Infinity;
  let running: Promise<void> | undefined;
  const lastError = new Map<string, string>();
  const pass = async () => {
    try {
      for (const r of await sync()) {
        const key = `${r.file}#${r.provider}`;
        if (r.status === "failed") {
          if (lastError.get(key) !== r.error) log(`t3-models: ${describeResult(r)}`);
          lastError.set(key, r.error ?? "");
          continue;
        }
        lastError.delete(key);
        if (r.status === "updated") log(`t3-models: ${describeResult(r)}`);
      }
    } catch (e) {
      log(`t3-models: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  return {
    async tick() {
      if (running || now() < nextAt) return;
      nextAt = now() + interval;
      running = pass().finally(() => {
        running = undefined;
      });
    },
    idle: () => running ?? Promise.resolve(),
  };
}
