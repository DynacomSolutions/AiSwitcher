/**
 * Runaway session detection. A bounded in-memory tracker that flags one agent session which burns requests or tokens far
 * above normal inside a sliding window, or whose tool results fail many times in a row (a loop).
 *
 * Rules (docs/agents/gateway.md, "Runaway session alert"):
 *  - Detection only. `observe` is synchronous, allocation-light and never throws; nothing here blocks, slows or throttles a request.
 *  - No per-session metric labels. The session key lives in the tracker only, and in one JSON log line when a session starts to run away.
 *  - Bounded memory: at most `maxSessions` entries, each a fixed set of buckets. The oldest entry goes first, and idle entries expire.
 *  - No content. It reads counts only (requests, tokens, tool error flags), never a prompt, answer or tool name.
 *  - One tracker for each replica: a session whose requests reach several replicas is counted on each of them separately.
 */

export interface RunawayConfig {
  /** False turns the tracker off: `observe` does nothing and the metrics stay at zero. */
  enabled: boolean;
  /** Length of the sliding window in milliseconds. */
  windowMs: number;
  /** Requests from one session inside the window at which it counts as running away. 0 turns this check off. */
  requests: number;
  /** Tokens (input, output and cache write, not cache reads) from one session inside the window. 0 turns this check off. */
  tokens: number;
  /** Consecutive served requests that each report at least one tool error. 0 turns this check off. */
  toolErrorStreak: number;
  /** Most sessions tracked at once. */
  maxSessions: number;
}

export const DEFAULT_RUNAWAY: RunawayConfig = {
  enabled: true,
  windowMs: 10 * 60_000,
  requests: 300,
  tokens: 3_000_000,
  toolErrorStreak: 20,
  maxSessions: 5_000,
};

/** Reads the limits from `AIS_GATEWAY_RUNAWAY_*`. A bad value falls back to its default; `0` turns one check off. */
export function runawayFromEnv(env: Record<string, string | undefined> = process.env): RunawayConfig {
  const num = (key: string, fallback: number, scale = 1, allowZero = true): number => {
    const raw = env[key]?.trim();
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || (!allowZero && n === 0)) return fallback;
    return Math.floor(n * scale);
  };
  const flag = env.AIS_GATEWAY_RUNAWAY?.trim().toLowerCase();
  return {
    enabled: !(flag === "off" || flag === "0" || flag === "false"),
    windowMs: num("AIS_GATEWAY_RUNAWAY_WINDOW_S", DEFAULT_RUNAWAY.windowMs, 1000, false),
    requests: num("AIS_GATEWAY_RUNAWAY_REQUESTS", DEFAULT_RUNAWAY.requests),
    tokens: num("AIS_GATEWAY_RUNAWAY_TOKENS", DEFAULT_RUNAWAY.tokens),
    toolErrorStreak: num("AIS_GATEWAY_RUNAWAY_TOOL_ERROR_STREAK", DEFAULT_RUNAWAY.toolErrorStreak),
    maxSessions: num("AIS_GATEWAY_RUNAWAY_MAX_SESSIONS", DEFAULT_RUNAWAY.maxSessions, 1, false),
  };
}

export type RunawayReason = "requests" | "tokens" | "tool_errors";

/** One finished request, as far as the tracker needs it. */
export interface RunawayObservation {
  sessionKey: string | undefined;
  provider: string;
  app: string;
  identity: string;
  /** Tokens that count toward the limit: input, output and cache write. */
  tokens: number;
  /** Tool errors the request reported back. Undefined when the request cannot tell (not Anthropic Messages, or not served). */
  toolErrors: number | undefined;
  /** True when the request was served (status `ok`); the tool error streak moves only on served requests. */
  served: boolean;
}

/** What `observe` returns when a session starts to run away. The caller writes the log line. */
export interface RunawayEvent {
  sessionKey: string;
  provider: string;
  app: string;
  identity: string;
  reasons: RunawayReason[];
  requests: number;
  tokens: number;
  toolErrorStreak: number;
  windowSeconds: number;
}

const BUCKETS = 10;

interface State {
  provider: string;
  app: string;
  identity: string;
  /** Index of the newest bucket (time divided by bucket length). */
  head: number;
  lastMs: number;
  requests: number[];
  tokens: number[];
  streak: number;
  active: boolean;
}

export class RunawayTracker {
  private readonly cfg: RunawayConfig;
  private readonly bucketMs: number;
  /** Insertion order is least recently seen first: a touched session moves to the end. */
  private readonly sessions = new Map<string, State>();
  private readonly events = new Map<string, number>();
  private evictedTotal = 0;

  constructor(cfg: Partial<RunawayConfig> = {}, private readonly now: () => number = Date.now) {
    this.cfg = { ...DEFAULT_RUNAWAY, ...cfg };
    this.bucketMs = Math.max(1, Math.floor(this.cfg.windowMs / BUCKETS));
  }

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  /** Sessions tracked now. */
  get size(): number {
    return this.sessions.size;
  }

  /** Records one finished request. Returns an event only when the session just started to run away. Never throws. */
  observe(o: RunawayObservation): RunawayEvent | undefined {
    if (!this.cfg.enabled || !o.sessionKey) return undefined;
    try {
      const nowMs = this.now();
      const key = `${o.provider}:${o.sessionKey}`;
      this.expire(nowMs);
      let s = this.sessions.get(key);
      if (s) this.sessions.delete(key);
      else s = this.fresh(o, nowMs);
      this.sessions.set(key, s);
      this.advance(s, nowMs);
      const slot = s.head % BUCKETS;
      s.requests[slot] = (s.requests[slot] ?? 0) + 1;
      s.tokens[slot] = (s.tokens[slot] ?? 0) + Math.max(0, o.tokens);
      s.lastMs = nowMs;
      if (o.served && o.toolErrors !== undefined) s.streak = o.toolErrors > 0 ? s.streak + 1 : 0;
      while (this.sessions.size > this.cfg.maxSessions) {
        const oldest = this.sessions.keys().next().value;
        if (oldest === undefined) break;
        this.sessions.delete(oldest);
        this.evictedTotal += 1;
      }
      const reasons = this.reasons(s);
      if (reasons.length === 0) {
        s.active = false;
        return undefined;
      }
      if (s.active) return undefined;
      s.active = true;
      this.events.set(s.provider, (this.events.get(s.provider) ?? 0) + 1);
      return {
        sessionKey: o.sessionKey,
        provider: s.provider,
        app: s.app,
        identity: s.identity,
        reasons,
        requests: sum(s.requests),
        tokens: sum(s.tokens),
        toolErrorStreak: s.streak,
        windowSeconds: Math.round(this.cfg.windowMs / 1000),
      };
    } catch {
      // Observation must never affect the request.
      return undefined;
    }
  }

  /** Sessions over a limit now. A session that stops sending leaves the count when its buckets age out of the window. */
  runawaySessions(): number {
    const nowMs = this.now();
    this.expire(nowMs);
    let n = 0;
    for (const s of this.sessions.values()) {
      this.advance(s, nowMs);
      if (this.reasons(s).length > 0) n += 1;
      else s.active = false;
    }
    return n;
  }

  /** Prometheus exposition lines. The series carry no session, app or identity label. */
  render(providers: readonly string[] = []): string[] {
    const running = this.runawaySessions();
    const names = new Set([...providers, ...this.events.keys()]);
    return [
      "# HELP ais_gateway_runaway_sessions Sessions over a runaway limit now (requests, tokens or tool error streak inside the window), this replica.",
      "# TYPE ais_gateway_runaway_sessions gauge",
      `ais_gateway_runaway_sessions ${running}`,
      "# HELP ais_gateway_runaway_events_total Sessions that started to run away, by provider. A session counts once until it falls back under the limits.",
      "# TYPE ais_gateway_runaway_events_total counter",
      ...[...names].sort().map((p) => `ais_gateway_runaway_events_total{provider="${p.replace(/[^A-Za-z0-9_.-]/g, "_")}"} ${this.events.get(p) ?? 0}`),
      "# HELP ais_gateway_runaway_tracked_sessions Sessions the runaway tracker holds now (bounded).",
      "# TYPE ais_gateway_runaway_tracked_sessions gauge",
      `ais_gateway_runaway_tracked_sessions ${this.sessions.size}`,
      "# HELP ais_gateway_runaway_evicted_total Tracked sessions dropped because the tracker was full.",
      "# TYPE ais_gateway_runaway_evicted_total counter",
      `ais_gateway_runaway_evicted_total ${this.evictedTotal}`,
    ];
  }

  private fresh(o: RunawayObservation, nowMs: number): State {
    return {
      provider: o.provider,
      app: o.app,
      identity: o.identity,
      head: Math.floor(nowMs / this.bucketMs),
      lastMs: nowMs,
      requests: new Array<number>(BUCKETS).fill(0),
      tokens: new Array<number>(BUCKETS).fill(0),
      streak: 0,
      active: false,
    };
  }

  /** Moves the newest bucket to `nowMs` and clears the buckets it passes. */
  private advance(s: State, nowMs: number): void {
    const idx = Math.floor(nowMs / this.bucketMs);
    const gap = idx - s.head;
    if (gap <= 0) return;
    if (gap >= BUCKETS) {
      s.requests.fill(0);
      s.tokens.fill(0);
    } else {
      for (let i = 1; i <= gap; i++) {
        const slot = (s.head + i) % BUCKETS;
        s.requests[slot] = 0;
        s.tokens[slot] = 0;
      }
    }
    s.head = idx;
  }

  private reasons(s: State): RunawayReason[] {
    const out: RunawayReason[] = [];
    if (this.cfg.requests > 0 && sum(s.requests) >= this.cfg.requests) out.push("requests");
    if (this.cfg.tokens > 0 && sum(s.tokens) >= this.cfg.tokens) out.push("tokens");
    if (this.cfg.toolErrorStreak > 0 && s.streak >= this.cfg.toolErrorStreak) out.push("tool_errors");
    return out;
  }

  /** Drops sessions idle for longer than the window, oldest first. They hold nothing the window still counts. */
  private expire(nowMs: number): void {
    for (const [k, s] of this.sessions) {
      if (nowMs - s.lastMs <= this.cfg.windowMs) break;
      this.sessions.delete(k);
    }
  }
}

const sum = (a: readonly number[]): number => a.reduce((x, y) => x + y, 0);
