import { checkT3Telemetry } from "../identities/t3-anthropic-proxy.ts";
import { describeCodexTelemetryResult, syncCodexTelemetry, type CodexTelemetryResult } from "../identities/codex-telemetry.ts";

/**
 * Telemetry opt-out guard, run from the host profile-sync daemon every 10 minutes. It repairs the Codex home config.toml keys
 * (an idempotent text edit) and reports a ~/.t3/service.env that does not turn telemetry off (`ais gateway t3-telemetry`
 * repairs it; T3 needs a restart). Each problem is logged once per change.
 */
export const T3_TELEMETRY_INTERVAL_MS = 10 * 60_000;

export interface T3TelemetryTickerDeps {
  codex?: () => Promise<CodexTelemetryResult[]>;
  serviceEnv?: () => Promise<string[]>;
  now?: () => number;
  log?: (message: string) => void;
  intervalMs?: number;
}

export interface T3TelemetryTicker {
  tick(): Promise<void>;
  idle(): Promise<void>;
}

export function createT3TelemetryTicker(deps: T3TelemetryTickerDeps = {}): T3TelemetryTicker {
  const codex = deps.codex ?? (() => syncCodexTelemetry());
  const serviceEnv = deps.serviceEnv ?? (() => checkT3Telemetry());
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((m: string) => console.error(`ais: ${m}`));
  const interval = deps.intervalMs ?? T3_TELEMETRY_INTERVAL_MS;
  let nextAt = -Infinity;
  let running: Promise<void> | undefined;
  const last = new Map<string, string>();
  const report = (key: string, text: string) => {
    if ((last.get(key) ?? "") !== text && text) log(`t3-telemetry: ${text}`);
    last.set(key, text);
  };
  const pass = async () => {
    try {
      for (const r of await codex()) report(r.dir, r.status === "current" ? "" : describeCodexTelemetryResult(r));
    } catch (e) {
      report("codex", e instanceof Error ? e.message : String(e));
    }
    try {
      report("service.env", (await serviceEnv()).join("; "));
    } catch (e) {
      report("service.env", e instanceof Error ? e.message : String(e));
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
