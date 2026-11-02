/** Counters the proxy reports. `PrometheusMetrics` is the production implementation. */
export interface GatewayMetrics {
  request(e: {
    app: string;
    provider: string;
    identity: string;
    status: string;
    httpStatus: number;
    latencyMs: number;
    tokens?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  }): void;
  /** `app` is only given when the app exists (bounded); unknown apps are counted under "-". */
  authFailure(reason: "unknown-app" | "bad-token", app?: string): void;
  /** A request refused by a policy of the gateway itself. */
  rejection(app: string, reason: "daily_cap" | "model" | "reserve" | "no_headroom" | "no_identities"): void;
  failover(app: string): void;
  /** A safety check could not run and the request was let through (for example the daily cap while the database is down). */
  failOpen(app: string, reason: "cap_check_failed"): void;
}

export const noopMetrics: GatewayMetrics = {
  request() {},
  authFailure() {},
  rejection() {},
  failover() {},
  failOpen() {},
};

const BUCKETS = [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300];

const esc = (v: string): string => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
const labels = (l: Record<string, string>): string =>
  Object.keys(l).length === 0 ? "" : `{${Object.entries(l).map(([k, v]) => `${k}="${esc(v)}"`).join(",")}}`;

class Counter {
  private readonly values = new Map<string, { l: Record<string, string>; n: number }>();
  constructor(readonly name: string, readonly help: string) {}
  inc(l: Record<string, string>, by = 1): void {
    const key = JSON.stringify(l);
    const cur = this.values.get(key);
    if (cur) cur.n += by;
    else this.values.set(key, { l, n: by });
  }
  render(): string[] {
    return [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`, ...[...this.values.values()].map((v) => `${this.name}${labels(v.l)} ${v.n}`)];
  }
}

/**
 * Prometheus text exposition. Labels are limited to app, provider, identity,
 * status, reason, kind and outcome, all drawn from configuration or fixed
 * sets; no token, credential, prompt or body content is ever recorded.
 */
export class PrometheusMetrics implements GatewayMetrics {
  private readonly requests = new Counter("ais_gateway_requests_total", "Proxied requests by outcome.");
  private readonly tokens = new Counter("ais_gateway_tokens_total", "Tokens used by proxied requests.");
  private readonly refreshes = new Counter("ais_gateway_refresh_total", "Login refresh attempts by outcome.");
  private readonly rejections = new Counter("ais_gateway_rejections_total", "Requests rejected before reaching a provider.");
  private readonly failovers = new Counter("ais_gateway_failovers_total", "Requests retried on another pool member.");
  private readonly failOpens = new Counter("ais_gateway_fail_open_total", "Safety checks skipped so the request could proceed.");
  private readonly unreadable = new Counter("ais_gateway_credential_unreadable_total", "Credential reads that failed at warm-up, per app identity.");
  private readonly bucketCounts = BUCKETS.map(() => 0);
  private durationCount = 0;
  private durationSum = 0;

  constructor(private readonly gauges: { ledgerDepth(): number; ledgerDropped(): number }) {}

  request(e: Parameters<GatewayMetrics["request"]>[0]): void {
    const base = { app: e.app, provider: e.provider, identity: e.identity };
    this.requests.inc({ ...base, status: e.status });
    if (e.tokens) {
      this.tokens.inc({ ...base, kind: "input" }, e.tokens.inputTokens);
      this.tokens.inc({ ...base, kind: "output" }, e.tokens.outputTokens);
      this.tokens.inc({ ...base, kind: "cache_read" }, e.tokens.cacheReadTokens);
      this.tokens.inc({ ...base, kind: "cache_write" }, e.tokens.cacheWriteTokens);
    }
    const s = e.latencyMs / 1000;
    this.durationCount += 1;
    this.durationSum += s;
    BUCKETS.forEach((b, i) => {
      if (s <= b) this.bucketCounts[i] = (this.bucketCounts[i] ?? 0) + 1;
    });
  }

  authFailure(reason: "unknown-app" | "bad-token", app?: string): void {
    this.rejections.inc({ app: app ?? "-", reason });
  }

  rejection(app: string, reason: "daily_cap" | "model" | "reserve" | "no_headroom" | "no_identities"): void {
    this.rejections.inc({ app, reason });
  }

  failover(app: string): void {
    this.failovers.inc({ app });
  }

  failOpen(app: string, reason: "cap_check_failed"): void {
    this.failOpens.inc({ app, reason });
  }

  credentialUnreadable(app: string, provider: string, identity: string): void {
    this.unreadable.inc({ app, provider, identity });
  }

  refresh(provider: string, outcome: string): void {
    this.refreshes.inc({ provider, outcome });
  }

  render(): string {
    const out: string[] = [];
    for (const c of [this.requests, this.tokens, this.refreshes, this.rejections, this.failovers, this.failOpens, this.unreadable]) out.push(...c.render());
    out.push("# HELP ais_gateway_upstream_seconds Time from request to completion of the response.", "# TYPE ais_gateway_upstream_seconds histogram");
    BUCKETS.forEach((b, i) => out.push(`ais_gateway_upstream_seconds_bucket{le="${b}"} ${this.bucketCounts[i]}`));
    out.push(`ais_gateway_upstream_seconds_bucket{le="+Inf"} ${this.durationCount}`, `ais_gateway_upstream_seconds_sum ${this.durationSum}`, `ais_gateway_upstream_seconds_count ${this.durationCount}`);
    out.push("# HELP ais_gateway_ledger_buffer_depth Usage rows waiting to be written.", "# TYPE ais_gateway_ledger_buffer_depth gauge", `ais_gateway_ledger_buffer_depth ${this.gauges.ledgerDepth()}`);
    out.push("# HELP ais_gateway_ledger_dropped_total Usage rows lost.", "# TYPE ais_gateway_ledger_dropped_total counter", `ais_gateway_ledger_dropped_total ${this.gauges.ledgerDropped()}`);
    return `${out.join("\n")}\n`;
  }
}
