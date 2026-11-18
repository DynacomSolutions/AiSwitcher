import { describeUsageResult, syncT3UsageCredentials, type UsageResult } from "../identities/t3-usage-credentials.ts";

/**
 * Runs the T3 usage credential sync (src/identities/t3-usage-credentials.ts) from the host profile-sync daemon: at the
 * first tick, then every 10 minutes, in the background and one pass at a time. Changes and new failures or problems are
 * logged once; one that repeats unchanged is not logged again.
 */

export const T3_USAGE_INTERVAL_MS = 10 * 60_000;

export interface T3UsageTickerDeps {
  sync?: () => Promise<UsageResult[]>;
  now?: () => number;
  log?: (message: string) => void;
  intervalMs?: number;
}

export interface T3UsageTicker {
  tick(): Promise<void>;
  /** Tests: the pass in flight, if any. */
  idle(): Promise<void>;
}

export function createT3UsageTicker(deps: T3UsageTickerDeps = {}): T3UsageTicker {
  const sync = deps.sync ?? (() => syncT3UsageCredentials());
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((m: string) => console.error(`ais: ${m}`));
  const interval = deps.intervalMs ?? T3_USAGE_INTERVAL_MS;
  let nextAt = -Infinity;
  let running: Promise<void> | undefined;
  const lastTrouble = new Map<string, string>();
  const pass = async () => {
    try {
      for (const r of await sync()) {
        const key = `${r.id}#${r.file}`;
        if (r.status === "failed" || r.status === "problem") {
          const text = `${r.status}: ${r.detail ?? ""}`;
          if (lastTrouble.get(key) !== text) log(`t3-usage: ${describeUsageResult(r)}`);
          lastTrouble.set(key, text);
          continue;
        }
        lastTrouble.delete(key);
        if (r.status === "updated") log(`t3-usage: ${describeUsageResult(r)}`);
      }
    } catch (e) {
      log(`t3-usage: ${e instanceof Error ? e.message : String(e)}`);
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
