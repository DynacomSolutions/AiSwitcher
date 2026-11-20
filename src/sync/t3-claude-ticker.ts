import { describeT3ClaudeResult, syncT3ClaudeHomes, type T3ClaudeSyncResult } from "../shared/t3-claude-sync.ts";

/**
 * Drift check of the T3 Claude homes against their source identities, run from the host profile-sync daemon every 10
 * minutes. It only reports (`ais gateway t3-claude-sync` repairs). A drift or failure is logged once per change.
 */
export const T3_CLAUDE_INTERVAL_MS = 10 * 60_000;

export interface T3ClaudeTickerDeps {
  check?: () => Promise<T3ClaudeSyncResult[]>;
  now?: () => number;
  log?: (message: string) => void;
  intervalMs?: number;
}

export interface T3ClaudeTicker {
  tick(): Promise<void>;
  idle(): Promise<void>;
}

export function createT3ClaudeTicker(deps: T3ClaudeTickerDeps = {}): T3ClaudeTicker {
  const check = deps.check ?? (() => syncT3ClaudeHomes({ check: true }));
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((m: string) => console.error(`ais: ${m}`));
  const interval = deps.intervalMs ?? T3_CLAUDE_INTERVAL_MS;
  let nextAt = -Infinity;
  let running: Promise<void> | undefined;
  const last = new Map<string, string>();
  const pass = async () => {
    try {
      for (const r of await check()) {
        if (r.status === "skipped") continue;
        const text = r.status === "current" ? "" : describeT3ClaudeResult(r);
        if ((last.get(r.folder) ?? "") !== text && text) log(`t3-claude-sync: ${text}`);
        last.set(r.folder, text);
      }
    } catch (e) {
      log(`t3-claude-sync: ${e instanceof Error ? e.message : String(e)}`);
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
