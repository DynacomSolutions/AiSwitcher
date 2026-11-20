import { createWarmGate, positiveIntEnv, WARM_STATES, type WarmGate, type WarmResult } from "../shared/warm-gate.ts";
import type { ServerLifecycle } from "./lifecycle.ts";

/** Console readiness metrics. Process-local, like scan-metrics.ts. */
const metricState: { gate?: WarmGate; lifecycle?: ServerLifecycle; timeouts: number } = { timeouts: 0 };

/** Registers the gate and lifecycle that the console readiness metrics report. */
export function registerConsoleReadiness(gate: WarmGate, lifecycle: ServerLifecycle): void {
  metricState.gate = gate;
  metricState.lifecycle = lifecycle;
}

export function renderReadinessMetrics(): string {
  const gate = metricState.gate;
  const lifecycle = metricState.lifecycle;
  const state = lifecycle?.isDraining ? "draining" : (gate?.state() ?? "cold");
  const seconds = (gate?.result()?.durationMs ?? 0) / 1000;
  return [
    "# HELP ais_console_ready 1 while /api/ready answers 200, else 0.",
    "# TYPE ais_console_ready gauge",
    `ais_console_ready ${lifecycle?.isReady ? 1 : 0}`,
    "# HELP ais_console_readiness_state 1 for the current readiness state (cold, warm, timeout, draining), 0 for the others.",
    "# TYPE ais_console_readiness_state gauge",
    ...WARM_STATES.map((s) => `ais_console_readiness_state{state="${s}"} ${state === s ? 1 : 0}`),
    "# HELP ais_console_limits_warmup_seconds Duration of the first limits read (0 until it ends).",
    "# TYPE ais_console_limits_warmup_seconds gauge",
    `ais_console_limits_warmup_seconds ${seconds}`,
    "# HELP ais_console_limits_warmup_timeouts_total First limits reads that hit the timeout.",
    "# TYPE ais_console_limits_warmup_timeouts_total counter",
    `ais_console_limits_warmup_timeouts_total ${metricState.timeouts}`,
    "",
  ].join("\n");
}

/** Resets the process-local state (tests). */
export function resetReadinessMetrics(): void {
  metricState.gate = undefined;
  metricState.lifecycle = undefined;
  metricState.timeouts = 0;
}

export interface LimitsWarmOptions {
  timeoutMs?: number;
  log?(line: string): void;
  gate?: WarmGate;
}

/**
 * Fills the limits widget cache once, then marks the console ready. Readiness waits at most the timeout.
 * If draining began meanwhile, markReady does nothing, so draining wins.
 */
export async function warmLimitsThenReady(
  lifecycle: ServerLifecycle,
  widgets: { warm(panelId: string): Promise<unknown> },
  options: LimitsWarmOptions = {},
): Promise<WarmResult> {
  const gate = options.gate ?? createWarmGate({ timeoutMs: options.timeoutMs ?? positiveIntEnv("AIS_WEB_LIMITS_WARM_TIMEOUT_MS", 90_000) });
  registerConsoleReadiness(gate, lifecycle);
  const log = options.log ?? console.warn;
  const result = await gate.run(["limits"], (key) => widgets.warm(key));
  if (result.outcome === "timeout") {
    metricState.timeouts += 1;
    log(`console: first limits read still running after ${result.durationMs} ms; ready anyway`);
  }
  lifecycle.markReady();
  return result;
}
