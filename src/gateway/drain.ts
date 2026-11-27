/**
 * Graceful drain of one gateway replica (the owner rule for every service: a pod that stops fails readiness, takes no new
 * work, finishes the work it holds and exits when that work is done; the grace period is only a kill ceiling).
 *
 * Phases after SIGTERM:
 * 1. settle. Readiness fails at once, so the Service stops listing the pod, but kube-proxy and the routers need a moment
 *    to stop sending new connections. The pod keeps serving every request that still arrives (each answer carries
 *    `connection: close`, so no connection is reused) until no new request has arrived for `settleQuietMs`. It is a
 *    condition, not a fixed sleep. `settleMaxMs` only bounds a busy replica.
 * 2. refuse. A new request gets 503 with `retry-after`, a status every client retries on another replica. Health, readiness
 *    and metrics still answer, so the kubelet and the monitoring see the drain.
 * 3. wait. The replica exits when no request, stream or tunnel is in flight. There is no timer on this wait. With
 *    `ceilingMs` set, the replica counts what it cuts and holds `cutHoldMs` so one scrape sees the count, before it exits.
 *    The platform grace period must be longer than `ceilingMs + cutHoldMs`.
 */

export interface DrainTiming {
  /** No new request for this long ends the settle phase. */
  settleQuietMs: number;
  /** The settle phase never lasts longer than this. */
  settleMaxMs: number;
  /** 0: wait for ever. Else the drain gives up after this long and counts the streams it cuts. */
  ceilingMs: number;
  /** After the ceiling, how long the replica stays up so the cut count is scraped. */
  cutHoldMs: number;
  /** How often the wait phases look at the counters. */
  pollMs: number;
}

export const DEFAULT_DRAIN_TIMING: DrainTiming = { settleQuietMs: 2_000, settleMaxMs: 15_000, ceilingMs: 0, cutHoldMs: 45_000, pollMs: 100 };

function envMs(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  return Number(raw);
}

export function drainTiming(env: Record<string, string | undefined>, over: Partial<DrainTiming> = {}): DrainTiming {
  const d = DEFAULT_DRAIN_TIMING;
  return {
    settleQuietMs: over.settleQuietMs ?? envMs(env, "AIS_GATEWAY_DRAIN_SETTLE_QUIET_MS", d.settleQuietMs),
    settleMaxMs: over.settleMaxMs ?? envMs(env, "AIS_GATEWAY_DRAIN_SETTLE_MAX_MS", d.settleMaxMs),
    ceilingMs: over.ceilingMs ?? envMs(env, "AIS_GATEWAY_DRAIN_CEILING_MS", d.ceilingMs),
    cutHoldMs: over.cutHoldMs ?? envMs(env, "AIS_GATEWAY_DRAIN_CUT_HOLD_MS", d.cutHoldMs),
    pollMs: over.pollMs ?? d.pollMs,
  };
}

/** What a replica holds that a stop would cut. */
export interface DrainLoad {
  /** HTTP requests and streams in flight (Bun's pendingRequests of the proxy listener). */
  requests: number;
  /** Tunnels of the CONNECT proxy that moved bytes lately. */
  tunnels: number;
}

export type SettleResult = "quiet" | "max";

/** Phase 1: wait until no client request has arrived for `quietMs`, at most `maxMs` after `startedAt`. */
export async function settle(o: {
  startedAt: number;
  lastArrivalAt(): number;
  timing: Pick<DrainTiming, "settleQuietMs" | "settleMaxMs" | "pollMs">;
  now?(): number;
  sleep?(ms: number): Promise<void>;
}): Promise<SettleResult> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  for (;;) {
    const t = now();
    if (t - o.startedAt >= o.timing.settleMaxMs) return "max";
    if (t - Math.max(o.startedAt, o.lastArrivalAt()) >= o.timing.settleQuietMs) return "quiet";
    await sleep(o.timing.pollMs);
  }
}

export type WaitResult = { outcome: "drained" } | { outcome: "ceiling"; cut: DrainLoad };

/** Phase 3: wait until nothing is in flight, or until the ceiling when one is set. */
export async function waitIdle(o: {
  startedAt: number;
  load(): DrainLoad;
  timing: Pick<DrainTiming, "ceilingMs" | "pollMs">;
  now?(): number;
  sleep?(ms: number): Promise<void>;
}): Promise<WaitResult> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  for (;;) {
    const load = o.load();
    if (load.requests + load.tunnels === 0) return { outcome: "drained" };
    if (o.timing.ceilingMs > 0 && now() - o.startedAt >= o.timing.ceilingMs) return { outcome: "ceiling", cut: load };
    await sleep(o.timing.pollMs);
  }
}

/** Counters of the drain, rendered as Prometheus text and read by the tests. */
export class DrainStats {
  draining = false;
  startedAtMs = 0;
  endedAtMs = 0;
  /** Load at the moment the drain began. */
  loadAtStart: DrainLoad = { requests: 0, tunnels: 0 };
  /** Streams, requests and tunnels cut by the shutdown (the ceiling was reached). */
  cutTotal = 0;
  /** Requests refused with 503 after the settle phase. */
  refusedTotal = 0;
  phase: "serving" | "settle" | "refuse" | "wait" = "serving";

  constructor(
    private readonly load: () => DrainLoad,
    private readonly now: () => number = Date.now,
  ) {}

  begin(): void {
    this.draining = true;
    this.startedAtMs = this.now();
    this.loadAtStart = this.load();
    this.phase = "settle";
  }

  end(): void {
    this.endedAtMs = this.now();
  }

  /** Seconds since the drain began (it keeps its last value once the drain ended). */
  seconds(): number {
    if (!this.draining) return 0;
    return ((this.endedAtMs || this.now()) - this.startedAtMs) / 1000;
  }

  render(): string[] {
    const l = this.load();
    return [
      "# HELP ais_gateway_inflight_requests HTTP requests and streams in flight on the proxy listener.",
      "# TYPE ais_gateway_inflight_requests gauge",
      `ais_gateway_inflight_requests ${l.requests}`,
      "# HELP ais_gateway_open_tunnels CONNECT tunnels that moved bytes in the last few seconds (probe tunnels excluded).",
      "# TYPE ais_gateway_open_tunnels gauge",
      `ais_gateway_open_tunnels ${l.tunnels}`,
      "# HELP ais_gateway_draining 1 from SIGTERM until the process exits.",
      "# TYPE ais_gateway_draining gauge",
      `ais_gateway_draining ${this.draining ? 1 : 0}`,
      "# HELP ais_gateway_drain_phase 1 for the current drain phase (serving, settle, refuse, wait).",
      "# TYPE ais_gateway_drain_phase gauge",
      ...(["serving", "settle", "refuse", "wait"] as const).map((p) => `ais_gateway_drain_phase{phase="${p}"} ${this.phase === p ? 1 : 0}`),
      "# HELP ais_gateway_drain_seconds Seconds since the drain began (0 when no drain runs).",
      "# TYPE ais_gateway_drain_seconds gauge",
      `ais_gateway_drain_seconds ${this.seconds()}`,
      "# HELP ais_gateway_drain_inflight_at_start Requests and streams in flight when the drain began.",
      "# TYPE ais_gateway_drain_inflight_at_start gauge",
      `ais_gateway_drain_inflight_at_start ${this.loadAtStart.requests + this.loadAtStart.tunnels}`,
      "# HELP ais_gateway_drain_cut_streams_total Requests, streams and tunnels that a shutdown cut because the drain ceiling was reached.",
      "# TYPE ais_gateway_drain_cut_streams_total counter",
      `ais_gateway_drain_cut_streams_total ${this.cutTotal}`,
      "# HELP ais_gateway_drain_refused_total Requests refused with 503 after the settle phase of a drain.",
      "# TYPE ais_gateway_drain_refused_total counter",
      `ais_gateway_drain_refused_total ${this.refusedTotal}`,
    ];
  }
}
