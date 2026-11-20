import { BROWSER_ERROR_CODES, BROWSER_TOOLS } from "../browser/protocol.ts";

/** Fixed label sets of ais_gateway_browser_mcp_requests_total. */
export const MCP_METHOD_LABELS = ["initialize", "ping", "tools/list", "tools/call", "notification", "delete", "get", "other"] as const;
export const MCP_OUTCOME_LABELS = ["ok", "tool_error", "unauthorised", "bad_request", "forbidden", "error"] as const;
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
  authFailure(reason: "unknown-app" | "bad-token" | "auth-error", app?: string): void;
  /** A request refused by a policy of the gateway itself. */
  rejection(app: string, reason: "daily_cap" | "model" | "reserve" | "no_headroom" | "no_identities"): void;
  failover(app: string): void;
  /** A safety check could not run and the request was let through (for example the daily cap while the database is down). */
  failOpen(app: string, reason: "cap_check_failed" | "side_count_failed"): void;
  /** One browser tool call: `outcome` is "ok" or a browser error code. Tool is from a fixed set. */
  browserCall(tool: string, outcome: string, seconds: number): void;
  /** One request to the browser MCP endpoint. Both labels come from fixed sets (see MCP_METHOD_LABELS and MCP_OUTCOME_LABELS). */
  browserMcpRequest(method: string, outcome: string): void;
  /** A browser pairing completed (token delivered). */
  browserPairing(): void;
  /** Media parts replaced by a text note because the provider refused the file they name (media-recovery.ts). */
  mediaRemoved?(app: string, parts: number): void;
  /** Requests currently queued for request-body budget. */
  bodyBudgetWaiting?(n: number): void;
  /** Seconds a request waited for body budget (0 when it did not have to wait). */
  bodyBudgetWait?(seconds: number): void;
}

export const noopMetrics: GatewayMetrics = {
  request() {},
  authFailure() {},
  rejection() {},
  failover() {},
  failOpen() {},
  browserCall() {},
  browserMcpRequest() {},
  browserPairing() {},
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

class Gauge {
  private readonly values = new Map<string, { l: Record<string, string>; n: number }>();
  constructor(readonly name: string, readonly help: string) {}
  set(l: Record<string, string>, n: number): void {
    this.values.set(JSON.stringify(l), { l, n });
  }
  get(l: Record<string, string>): number | undefined {
    return this.values.get(JSON.stringify(l))?.n;
  }
  render(): string[] {
    return [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`, ...[...this.values.values()].map((v) => `${this.name}${labels(v.l)} ${v.n}`)];
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
  private readonly usageReads = new Counter("ais_gateway_usage_reads_total", "Usage readings taken, by provider and source (upstream or the shared database row).");
  private readonly usageSharedErrors = new Counter("ais_gateway_usage_shared_errors_total", "Shared usage reading database calls that failed.");
  private readonly heartbeatWrites = new Counter("ais_gateway_heartbeat_writes_total", "Gateway ownership heartbeat writes, by outcome.");
  private readonly keepAlives = new Counter("ais_gateway_keepalive_total", "Idle keep-alive refresh passes over managed logins, by outcome.");
  private readonly refreshAttempts = new Counter("ais_gateway_refresh_attempts_total", "Login refresh attempts reaching the refresh guard, per account.");
  private readonly refreshSuccesses = new Counter("ais_gateway_refresh_successes_total", "Login refreshes that renewed or adopted a fresh grant, per account.");
  private readonly refreshFailures = new Counter("ais_gateway_refresh_failures_total", "Login refreshes that failed or were refused, per account.");
  private readonly refreshDegraded = new Counter("ais_gateway_refresh_guard_degraded_total", "Refreshes run without the guard (database unavailable), under the file lock and compare-and-swap only, per account.");
  private readonly refreshLockWaits = new Counter("ais_gateway_refresh_lock_waits_total", "Refreshes that had to wait for another holder's account lock, per account.");
  private readonly refreshLockWaitSeconds = new Counter("ais_gateway_refresh_lock_wait_seconds_total", "Seconds spent waiting for account refresh locks, per account.");
  private readonly deadGrants = new Counter("ais_gateway_refresh_dead_grant_total", "Refresh answers that proved the login dead (the token endpoint sent a dead-grant code), per account and OAuth code.");
  private readonly lastSuccess = new Gauge("ais_gateway_refresh_last_success_timestamp_seconds", "Unix time of the newest successful refresh of the login, seeded from the shared journal at start.");
  private readonly loginExpiry = new Gauge("ais_gateway_login_expiry_timestamp_seconds", "Unix time the stored login's access token expires.");
  private readonly loginLifetime = new Gauge("ais_gateway_login_lifetime_seconds", "Access-token lifetime of the stored login (expiry minus mint time, or the provider default when the mint time is unknown).");
  private readonly loginRevokedGauge = new Gauge("ais_gateway_login_revoked", "1 while the stored login is diagnosed dead (only a new login helps), else 0.");
  private readonly rejections = new Counter("ais_gateway_rejections_total", "Requests rejected before reaching a provider.");
  private readonly failovers = new Counter("ais_gateway_failovers_total", "Requests retried on another pool member.");
  private readonly failOpens = new Counter("ais_gateway_fail_open_total", "Safety checks skipped so the request could proceed.");
  private readonly mediaRemovals = new Counter("ais_gateway_media_removed_total", "Media parts replaced by a text note because the provider refused the file they name.");
  private readonly unreadable = new Counter("ais_gateway_credential_unreadable_total", "Credential reads that failed at warm-up, per app identity.");
  private readonly browserCalls = new Counter("ais_gateway_browser_calls_total", "Browser tool calls by tool and outcome.");
  private readonly browserMcpRequests = new Counter("ais_gateway_browser_mcp_requests_total", "Browser MCP endpoint requests by JSON-RPC method and outcome.");
  private readonly browserPairings = new Counter("ais_gateway_browser_pairings_total", "Browser pairings completed.");
  private readonly callBucketCounts = BUCKETS.map(() => 0);
  private callCount = 0;
  private callSum = 0;
  /** Set once the relay hub exists. */
  browserGauges: { connected(): number; sessions(): number } = { connected: () => 0, sessions: () => 0 };
  /** 1 while this replica's app-change notice subscription is up. Set in serve.ts. */
  appNoticesUp: () => number = () => 0;
  /** Readiness and usage warm-up state, set in serve.ts. */
  readiness: () => { ready: boolean; state: string } = () => ({ ready: false, state: "cold" });
  usageWarmup: () => { seconds: number; timeouts: number; cold: number } = () => ({ seconds: 0, timeouts: 0, cold: 0 });
  private publicHostCount = 0;
  private budgetWaiting = 0;
  private readonly budgetBucketCounts = BUCKETS.map(() => 0);
  private budgetCount = 0;
  private budgetSum = 0;
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

  authFailure(reason: "unknown-app" | "bad-token" | "auth-error", app?: string): void {
    this.rejections.inc({ app: app ?? "-", reason });
  }

  rejection(app: string, reason: "daily_cap" | "model" | "reserve" | "no_headroom" | "no_identities"): void {
    this.rejections.inc({ app, reason });
  }

  failover(app: string): void {
    this.failovers.inc({ app });
  }

  failOpen(app: string, reason: "cap_check_failed" | "side_count_failed"): void {
    this.failOpens.inc({ app, reason });
  }
  mediaRemoved(app: string, parts: number): void {
    this.mediaRemovals.inc({ app }, parts);
  }

  browserCall(tool: string, outcome: string, seconds: number): void {
    // Labels come from fixed sets only, whatever the caller passed.
    const t = (BROWSER_TOOLS as readonly string[]).includes(tool) ? tool : "unknown";
    const o = outcome === "ok" || (BROWSER_ERROR_CODES as readonly string[]).includes(outcome) ? outcome : "internal";
    this.browserCalls.inc({ tool: t, outcome: o });
    this.callCount += 1;
    this.callSum += seconds;
    BUCKETS.forEach((b, i) => {
      if (seconds <= b) this.callBucketCounts[i] = (this.callBucketCounts[i] ?? 0) + 1;
    });
  }

  bodyBudgetWaiting(n: number): void {
    this.budgetWaiting = n;
  }

  bodyBudgetWait(seconds: number): void {
    this.budgetCount += 1;
    this.budgetSum += seconds;
    BUCKETS.forEach((b, i) => {
      if (seconds <= b) this.budgetBucketCounts[i] = (this.budgetBucketCounts[i] ?? 0) + 1;
    });
  }

  browserMcpRequest(method: string, outcome: string): void {
    const m = (MCP_METHOD_LABELS as readonly string[]).includes(method) ? method : "other";
    const o = (MCP_OUTCOME_LABELS as readonly string[]).includes(outcome) ? outcome : "error";
    this.browserMcpRequests.inc({ method: m, outcome: o });
  }
  browserPairing(): void {
    this.browserPairings.inc({});
  }

  credentialUnreadable(app: string, provider: string, identity: string): void {
    this.unreadable.inc({ app, provider, identity });
  }

  publicHostsConfigured(n: number): void {
    this.publicHostCount = n;
  }

  usageRead(provider: string, source: "upstream" | "shared"): void {
    this.usageReads.inc({ provider, source });
  }

  usageSharedError(): void {
    this.usageSharedErrors.inc({});
  }

  heartbeatWrite(outcome: string): void {
    this.heartbeatWrites.inc({ outcome });
  }

  keepAlive(provider: string, outcome: string): void {
    this.keepAlives.inc({ provider, outcome });
  }

  refresh(provider: string, outcome: string): void {
    this.refreshes.inc({ provider, outcome });
  }

  /** A dead-grant answer was seen for this login (once per answer actually sent to the token endpoint). */
  deadGrant(provider: string, identity: string, code: string): void {
    this.deadGrants.inc({ provider, identity, code });
  }

  /** Keeps the newest value: a replica that restarts reports the cluster-wide last success, never an older one. */
  refreshSucceededAt(provider: string, identity: string, epochSeconds: number): void {
    const l = { provider, identity };
    const have = this.lastSuccess.get(l);
    if (have === undefined || epochSeconds > have) this.lastSuccess.set(l, epochSeconds);
  }

  loginState(provider: string, identity: string, state: { expiresAtSeconds?: number; lifetimeSeconds?: number; revoked?: boolean }): void {
    const l = { provider, identity };
    if (state.expiresAtSeconds !== undefined) this.loginExpiry.set(l, state.expiresAtSeconds);
    if (state.lifetimeSeconds !== undefined) this.loginLifetime.set(l, state.lifetimeSeconds);
    if (state.revoked !== undefined) this.loginRevokedGauge.set(l, state.revoked ? 1 : 0);
  }

  refreshGuard(event: "attempt" | "success" | "failure" | "lock_wait" | "degraded", provider: string, identity: string, seconds = 0): void {
    const l = { provider, identity };
    if (event === "attempt") this.refreshAttempts.inc(l);
    else if (event === "success") this.refreshSuccesses.inc(l);
    else if (event === "failure") this.refreshFailures.inc(l);
    else if (event === "degraded") this.refreshDegraded.inc(l);
    else {
      this.refreshLockWaits.inc(l);
      this.refreshLockWaitSeconds.inc(l, seconds);
    }
  }

  render(): string {
    const out: string[] = [];
    for (const c of [this.requests, this.tokens, this.refreshes, this.keepAlives, this.usageReads, this.usageSharedErrors, this.heartbeatWrites, this.refreshAttempts, this.refreshSuccesses, this.refreshFailures, this.refreshDegraded, this.refreshLockWaits, this.refreshLockWaitSeconds, this.deadGrants, this.rejections, this.failovers, this.failOpens, this.mediaRemovals, this.unreadable, this.browserCalls, this.browserMcpRequests, this.browserPairings]) out.push(...c.render());
    for (const g of [this.lastSuccess, this.loginExpiry, this.loginLifetime, this.loginRevokedGauge]) out.push(...g.render());
    out.push("# HELP ais_gateway_upstream_seconds Time from request to completion of the response.", "# TYPE ais_gateway_upstream_seconds histogram");
    BUCKETS.forEach((b, i) => out.push(`ais_gateway_upstream_seconds_bucket{le="${b}"} ${this.bucketCounts[i]}`));
    out.push(`ais_gateway_upstream_seconds_bucket{le="+Inf"} ${this.durationCount}`, `ais_gateway_upstream_seconds_sum ${this.durationSum}`, `ais_gateway_upstream_seconds_count ${this.durationCount}`);
    out.push("# HELP ais_gateway_browser_call_seconds Browser tool call duration.", "# TYPE ais_gateway_browser_call_seconds histogram");
    BUCKETS.forEach((b, i) => out.push(`ais_gateway_browser_call_seconds_bucket{le="${b}"} ${this.callBucketCounts[i]}`));
    out.push(`ais_gateway_browser_call_seconds_bucket{le="+Inf"} ${this.callCount}`, `ais_gateway_browser_call_seconds_sum ${this.callSum}`, `ais_gateway_browser_call_seconds_count ${this.callCount}`);
    out.push("# HELP ais_gateway_body_budget_waiting Requests queued for request-body memory budget.", "# TYPE ais_gateway_body_budget_waiting gauge", `ais_gateway_body_budget_waiting ${this.budgetWaiting}`);
    out.push("# HELP ais_gateway_body_budget_wait_seconds Time requests waited for request-body memory budget.", "# TYPE ais_gateway_body_budget_wait_seconds histogram");
    BUCKETS.forEach((b, i) => out.push(`ais_gateway_body_budget_wait_seconds_bucket{le="${b}"} ${this.budgetBucketCounts[i]}`));
    out.push(`ais_gateway_body_budget_wait_seconds_bucket{le="+Inf"} ${this.budgetCount}`, `ais_gateway_body_budget_wait_seconds_sum ${this.budgetSum}`, `ais_gateway_body_budget_wait_seconds_count ${this.budgetCount}`);
    out.push("# HELP ais_gateway_browsers_connected Browser extensions connected.", "# TYPE ais_gateway_browsers_connected gauge", `ais_gateway_browsers_connected ${this.browserGauges.connected()}`);
    out.push("# HELP ais_gateway_browser_sessions_active Agent browser sessions active in the last ten minutes.", "# TYPE ais_gateway_browser_sessions_active gauge", `ais_gateway_browser_sessions_active ${this.browserGauges.sessions()}`);
    out.push("# HELP ais_gateway_public_hosts_configured Public host names configured (AIS_GATEWAY_PUBLIC_HOSTS); 0 means operational endpoints answer on every host.", "# TYPE ais_gateway_public_hosts_configured gauge", `ais_gateway_public_hosts_configured ${this.publicHostCount}`);
    out.push("# HELP ais_gateway_app_notices_up 1 while this replica receives app change notices (revokes reach it at once), 0 while it relies on the timed refresh.", "# TYPE ais_gateway_app_notices_up gauge", `ais_gateway_app_notices_up ${this.appNoticesUp()}`);
    const rd = this.readiness();
    out.push("# HELP ais_gateway_ready 1 while /readyz answers 200, else 0.", "# TYPE ais_gateway_ready gauge", `ais_gateway_ready ${rd.ready ? 1 : 0}`);
    out.push("# HELP ais_gateway_readiness_state 1 for the current readiness state (cold, warm, timeout, draining), 0 for the others.", "# TYPE ais_gateway_readiness_state gauge");
    for (const st of ["cold", "warm", "timeout", "draining"]) out.push(`ais_gateway_readiness_state{state="${st}"} ${rd.state === st ? 1 : 0}`);
    const uw = this.usageWarmup();
    out.push("# HELP ais_gateway_usage_warmup_seconds Duration of the usage cache warm-up (0 until it ends).", "# TYPE ais_gateway_usage_warmup_seconds gauge", `ais_gateway_usage_warmup_seconds ${uw.seconds}`);
    out.push("# HELP ais_gateway_usage_warmup_timeouts_total Usage warm-ups that hit the timeout with identities still cold.", "# TYPE ais_gateway_usage_warmup_timeouts_total counter", `ais_gateway_usage_warmup_timeouts_total ${uw.timeouts}`);
    out.push("# HELP ais_gateway_usage_warmup_cold_identities Identities still cold when the warm-up timeout fired (0 otherwise).", "# TYPE ais_gateway_usage_warmup_cold_identities gauge", `ais_gateway_usage_warmup_cold_identities ${uw.cold}`);
    out.push("# HELP ais_gateway_ledger_buffer_depth Usage rows waiting to be written.", "# TYPE ais_gateway_ledger_buffer_depth gauge", `ais_gateway_ledger_buffer_depth ${this.gauges.ledgerDepth()}`);
    out.push("# HELP ais_gateway_ledger_dropped_total Usage rows lost.", "# TYPE ais_gateway_ledger_dropped_total counter", `ais_gateway_ledger_dropped_total ${this.gauges.ledgerDropped()}`);
    return `${out.join("\n")}\n`;
  }
}
