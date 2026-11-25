import type { SyncItem } from "../t3/instances/sync.ts";

/**
 * Runs `ais gateway t3-instances sync` from the host profile-sync daemon every 5 minutes, so a new gateway pool or pin shows
 * as a T3 provider instance without a hand edit. Each run reads the app list again. A change or a failure is logged once per change.
 */
export const T3_INSTANCES_INTERVAL_MS = 5 * 60_000;

export interface T3InstancesTickerDeps {
  run?: () => Promise<SyncItem[]>;
  now?: () => number;
  log?: (message: string) => void;
  intervalMs?: number;
}

export interface T3InstancesTicker {
  tick(): Promise<void>;
  idle(): Promise<void>;
}

async function defaultRun(): Promise<SyncItem[]> {
  const { syncT3InstancesLive } = await import("../t3/instances/live.ts");
  return syncT3InstancesLive({ fetch, kubectl: (() => Promise.reject(new Error("kubectl is not used"))) as never, out: () => {}, now: Date.now });
}

export function createT3InstancesTicker(deps: T3InstancesTickerDeps = {}): T3InstancesTicker {
  const run = deps.run ?? defaultRun;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((m: string) => console.error(`ais: ${m}`));
  const interval = deps.intervalMs ?? T3_INSTANCES_INTERVAL_MS;
  let nextAt = -Infinity;
  let running: Promise<void> | undefined;
  let last = "";
  const pass = async () => {
    let text = "";
    try {
      const changed = (await run()).filter((i) => i.status !== "current" && i.status !== "skipped");
      text = changed.map((i) => `${i.id} ${i.status}${i.detail ? ` (${i.detail})` : ""}`).join(", ");
    } catch (e) {
      text = `failed: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (text && text !== last) log(`t3-instances: ${text}`);
    last = text;
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
