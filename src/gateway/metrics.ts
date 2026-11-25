import { BROWSER_ERROR_CODES, BROWSER_TOOLS } from "../browser/protocol.ts";

/** Fixed label sets of ais_gateway_browser_mcp_requests_total. */
export const MCP_METHOD_LABELS = ["initialize", "ping", "tools/list", "tools/call", "notification", "delete", "get", "other"] as const;
export const MCP_OUTCOME_LABELS = ["ok", "tool_error", "unauthorised", "bad_request", "forbidden", "unavailable", "error"] as const;
/** Fixed label sets of the chat metrics. */
/** Event labels. `other` is the overflow label for unknown values. */
export const CHAT_EVENT_LABELS = ["session_created", "session_closed", "session_resumed", "idle_closed"] as const;
/** Outcome labels. `other` is the overflow label for unknown values. */
export const CHAT_OUTCOME_LABELS = ["ok", "cancelled", "error"] as const;
export const CHAT_ERROR_KINDS = ["pod_start", "attach", "agent_exit", "acp", "timeout", "limit", "rate_limit", "close_binding", "resume_failed", "store", "owner_unreachable", "limit", "other"] as const;
/** Event labels of ais_gateway_favourites_total. `other` is the overflow label. */
export const FAVOURITE_EVENTS = ["socket_list", "socket_set", "http_get", "http_post", "change", "push", "refused", "rate_limited", "error", "pool_migrated"] as const;
/** Fixed label sets of the session ingest metrics (admin-sessions.ts). `other` is the overflow label. */
export const SESSIONS_ROUTES = ["ping", "cursors", "ingest"] as const;
export const SESSIONS_REQUEST_OUTCOMES = ["ok", "bad_request", "too_large", "unavailable", "error"] as const;
export const SESSIONS_RECORD_OUTCOMES = ["committed", "duplicate", "conflict", "invalid", "object_missing"] as const;
export const SESSIONS_ERROR_KINDS = ["store", "auth", "body", "object_check"] as const;
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
  /** A chat session event. Unknown values are counted as "other". */
  chatSession(event: string): void;
  /** A chat turn ended. Unknown values are counted as "other". */
  chatTurn(outcome: string): void;
  /** A chat error. Unknown kinds are counted as "other". */
  chatError(kind: string): void;
  /** Seconds a chat pod took to start. */
  chatPodStart(seconds: number): void;
  /** A starred-model event: a socket or HTTP call, a change that flipped a star, a frame pushed to a panel, or an error. Unknown values are counted as "other". */
  /** `reason` is set for `refused`: `stale` or `cap`. */
  favourite?(event: string, reason?: string): void;
  /** One request to a session ingest route. `route` and `outcome` come from fixed sets (SESSIONS_ROUTES, SESSIONS_REQUEST_OUTCOMES). */
  sessionsRequest?(route: string, outcome: string, seconds: number): void;
  /** The result of one file record of an ingest request (SESSIONS_RECORD_OUTCOMES). */
  sessionsRecord?(outcome: string): void;
  /** Parts stored by one ingest request, with their plain and object bytes. */
  sessionsParts?(parts: number, plainBytes: number, objectBytes: number): void;
  /** Seconds from the host modification time of a file to the commit of its new parts. */
  sessionsLag?(seconds: number): void;
  /** An ingest error that is not a refusal of the writer (SESSIONS_ERROR_KINDS). */
  sessionsError?(kind: string): void;
  /** Media parts replaced by a text note because the provider refused the file they name (media-recovery.ts). */
  mediaRemoved?(app: string, parts: number): void;
  /** An error event inside a response that began with HTTP 200 (stream or body). Labels are bounded by the implementation. */
  streamError?(e: { app: string; provider: string; event: string; errorType?: string | undefined }): void;
  /** Requests currently queued for request-body budget. */
  bodyBudgetWaiting?(n: number): void;
  /** A request held open for a full pool: it started (held), got served after the wait, failed, ran out of time, ended by a shutdown, or its client left. */
  poolHold?(app: string, event: "held" | "served" | "failed" | "timeout" | "drained" | "cancelled"): void;
  /** Members of a provider's pool with a weekly figure, and how many of them are below `threshold` percent weekly use. No member names. */
  poolHeadroom?(provider: string, threshold: number, withHeadroom: number, withReading: number): void;
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
  chatSession() {},
  chatTurn() {},
  chatError() {},
  chatPodStart() {},
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

class Histogram {
  private readonly counts: number[];
  private count = 0;
  private sum = 0;
  constructor(readonly name: string, readonly help: string, private readonly buckets: readonly number[]) {
    this.counts = buckets.map(() => 0);
  }
  observe(v: number): void {
    this.count += 1;
    this.sum += v;
    this.buckets.forEach((b, i) => {
      if (v <= b) this.counts[i] = (this.counts[i] ?? 0) + 1;
    });
  }
  render(): string[] {
    return [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} histogram`,
      ...this.buckets.map((b, i) => `${this.name}_bucket{le="${b}"} ${this.counts[i]}`),
      `${this.name}_bucket{le="+Inf"} ${this.count}`,
      `${this.name}_sum ${this.sum}`,
      `${this.name}_count ${this.count}`,
    ];
  }
}

/** Seconds buckets for the ingest lag: from a quick flush to a long backfill. */
const LAG_BUCKETS = [1, 5, 15, 30, 60, 120, 300, 900, 3600, 21600, 86400];

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
  private readonly poolHolds = new Counter("ais_gateway_pool_holds_total", "Requests held open for a full pool, by app and event (held, served, failed, timeout, drained, cancelled).");
  private readonly poolHeadroomGauge = new Gauge("ais_gateway_pool_members_with_headroom", "Pool members whose weekly use is below the threshold percent, by provider. Members without a reading are not counted.");
  private readonly poolReadingsGauge = new Gauge("ais_gateway_pool_members_with_reading", "Pool members with a weekly usage reading, by provider.");
  private readonly rejections = new Counter("ais_gateway_rejections_total", "Requests rejected before reaching a provider.");
  private readonly failovers = new Counter("ais_gateway_failovers_total", "Requests retried on another pool member.");
  private readonly failOpens = new Counter("ais_gateway_fail_open_total", "Safety checks skipped so the request could proceed.");
  private readonly mediaRemovals = new Counter("ais_gateway_media_removed_total", "Media parts replaced by a text note because the provider refused the file they name.");
  private readonly unreadable = new Counter("ais_gateway_credential_unreadable_total", "Credential reads that failed at warm-up, per app identity.");
  private readonly streamErrors = new Counter("ais_gateway_stream_errors_total", "Error events inside a response that began with HTTP 200, by app, provider, event and error type.");
  private readonly streamErrorTypes = new Set<string>();
  private readonly browserCalls = new Counter("ais_gateway_browser_calls_total", "Browser tool calls by tool and outcome.");
  private readonly browserMcpRequests = new Counter("ais_gateway_browser_mcp_requests_total", "Browser MCP endpoint requests by JSON-RPC method and outcome.");
  private readonly browserPairings = new Counter("ais_gateway_browser_pairings_total", "Browser pairings completed.");
  private readonly chatSessions = new Counter("ais_gateway_chat_sessions_total", "Chat session events by event.");
  private readonly chatTurns = new Counter("ais_gateway_chat_turns_total", "Chat turns by outcome.");
  private readonly chatErrors = new Counter("ais_gateway_chat_errors_total", "Chat errors by kind.");
  private readonly favourites = new Counter("ais_gateway_favourites_total", "Starred-model events by event.");
  private readonly sessionsRequests = new Counter("ais_sessions_ingest_requests_total", "Session ingest requests by route and outcome.");
  private readonly sessionsRecords = new Counter("ais_sessions_ingest_total", "Session file records by outcome (committed, duplicate, conflict, invalid, object_missing).");
  private readonly sessionsPartsTotal = new Counter("ais_sessions_ingest_parts_total", "Session parts stored.");
  private readonly sessionsBytes = new Counter("ais_sessions_ingest_bytes_total", "Bytes of stored session parts, by kind (plain or object).");
  private readonly sessionsErrors = new Counter("ais_sessions_ingest_errors_total", "Session ingest errors by kind (store, auth, body, object_check).");
  private readonly sessionsSeconds = new Histogram("ais_sessions_ingest_seconds", "Time to answer a session ingest request.", BUCKETS);
  private readonly sessionsLagSeconds = new Histogram("ais_sessions_ingest_lag_seconds", "Seconds from the host modification time of a session file to the commit of its new parts.", LAG_BUCKETS);
  private readonly podBucketCounts = BUCKETS.map(() => 0);
  private podCount = 0;
  private podSum = 0;
  /** Set once the chat broker exists. */
  chatGauges: { active(): number } = { active: () => 0 };
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
  /** Extra text sections of other components (the session enrichment). Each returns finished exposition lines. */
  readonly sections: Array<() => string[]> = [];
  private publicHostCount = 0;
  private budgetWaiting = 0;
  private readonly budgetBucketCounts = BUCKETS.map(() => 0);
  private budgetCount = 0;
  private budgetSum = 0;
  private readonly bucketCounts = BUCKETS.map(() => 0);
  private durationCount = 0;
  private durationSum = 0;

  constructor(private readonly gauges: { ledgerDepth(): number; ledgerDropped(): number }) {
    // A zero sample, so the series exists (and its first real increase is visible to rate()) before any stream fails.
    this.streamErrors.inc({ app: "-", provider: "-", event: "none", error_type: "none" }, 0);
  }

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
  /** `event` and `errorType` come from the provider; both are cut to a safe label, and past 40 distinct error types the rest count as "other". */
  streamError(e: { app: string; provider: string; event: string; errorType?: string | undefined }): void {
    const safe = (v: string | undefined, fallback: string): string => (v && /^[A-Za-z0-9_.-]{1,40}$/.test(v) ? v.toLowerCase() : fallback);
    const event = safe(e.event, "other");
    let errorType = safe(e.errorType, e.errorType ? "other" : "none");
    if (!this.streamErrorTypes.has(errorType)) {
      if (this.streamErrorTypes.size >= 40) errorType = "other";
      else this.streamErrorTypes.add(errorType);
    }
    this.streamErrors.inc({ app: e.app, provider: e.provider, event, error_type: errorType });
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

  chatSession(event: string): void {
    this.chatSessions.inc({ event: (CHAT_EVENT_LABELS as readonly string[]).includes(event) ? event : "other" });
  }

  chatTurn(outcome: string): void {
    this.chatTurns.inc({ outcome: (CHAT_OUTCOME_LABELS as readonly string[]).includes(outcome) ? outcome : "other" });
  }

  chatError(kind: string): void {
    this.chatErrors.inc({ kind: (CHAT_ERROR_KINDS as readonly string[]).includes(kind) ? kind : "other" });
  }

  favourite(event: string, reason?: string): void {
    const e = (FAVOURITE_EVENTS as readonly string[]).includes(event) ? event : "other";
    this.favourites.inc(e === "refused" ? { event: e, reason: reason === "stale" || reason === "cap" ? reason : "other" } : { event: e });
  }

  sessionsRequest(route: string, outcome: string, seconds: number): void {
    this.sessionsRequests.inc({
      route: (SESSIONS_ROUTES as readonly string[]).includes(route) ? route : "other",
      outcome: (SESSIONS_REQUEST_OUTCOMES as readonly string[]).includes(outcome) ? outcome : "other",
    });
    this.sessionsSeconds.observe(seconds);
  }

  sessionsRecord(outcome: string): void {
    this.sessionsRecords.inc({ outcome: (SESSIONS_RECORD_OUTCOMES as readonly string[]).includes(outcome) ? outcome : "other" });
  }

  sessionsParts(parts: number, plainBytes: number, objectBytes: number): void {
    this.sessionsPartsTotal.inc({}, parts);
    this.sessionsBytes.inc({ kind: "plain" }, plainBytes);
    this.sessionsBytes.inc({ kind: "object" }, objectBytes);
  }

  sessionsLag(seconds: number): void {
    this.sessionsLagSeconds.observe(Math.max(0, seconds));
  }

  sessionsError(kind: string): void {
    this.sessionsErrors.inc({ kind: (SESSIONS_ERROR_KINDS as readonly string[]).includes(kind) ? kind : "other" });
  }

  chatPodStart(seconds: number): void {
    this.podCount += 1;
    this.podSum += seconds;
    BUCKETS.forEach((b, i) => {
      if (seconds <= b) this.podBucketCounts[i] = (this.podBucketCounts[i] ?? 0) + 1;
    });
  }

  bodyBudgetWaiting(n: number): void {
    this.budgetWaiting = n;
  }

  poolHold(app: string, event: "held" | "served" | "failed" | "timeout" | "drained" | "cancelled"): void {
    this.poolHolds.inc({ app, event });
  }

  poolHeadroom(provider: string, threshold: number, withHeadroom: number, withReading: number): void {
    this.poolHeadroomGauge.set({ provider, threshold: String(threshold / 100) }, withHeadroom);
    this.poolReadingsGauge.set({ provider }, withReading);
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
    for (const c of [this.requests, this.tokens, this.refreshes, this.keepAlives, this.usageReads, this.usageSharedErrors, this.heartbeatWrites, this.refreshAttempts, this.refreshSuccesses, this.refreshFailures, this.refreshDegraded, this.refreshLockWaits, this.refreshLockWaitSeconds, this.deadGrants, this.rejections, this.poolHolds, this.failovers, this.failOpens, this.mediaRemovals, this.streamErrors, this.unreadable, this.browserCalls, this.browserMcpRequests, this.browserPairings, this.chatSessions, this.chatTurns, this.chatErrors, this.favourites, this.sessionsRequests, this.sessionsRecords, this.sessionsPartsTotal, this.sessionsBytes, this.sessionsErrors]) out.push(...c.render());
    out.push(...this.sessionsSeconds.render(), ...this.sessionsLagSeconds.render());
    for (const g of [this.lastSuccess, this.loginExpiry, this.loginLifetime, this.loginRevokedGauge, this.poolHeadroomGauge, this.poolReadingsGauge]) out.push(...g.render());
    out.push("# HELP ais_gateway_upstream_seconds Time from request to completion of the response.", "# TYPE ais_gateway_upstream_seconds histogram");
    BUCKETS.forEach((b, i) => out.push(`ais_gateway_upstream_seconds_bucket{le="${b}"} ${this.bucketCounts[i]}`));
    out.push(`ais_gateway_upstream_seconds_bucket{le="+Inf"} ${this.durationCount}`, `ais_gateway_upstream_seconds_sum ${this.durationSum}`, `ais_gateway_upstream_seconds_count ${this.durationCount}`);
    out.push("# HELP ais_gateway_browser_call_seconds Browser tool call duration.", "# TYPE ais_gateway_browser_call_seconds histogram");
    BUCKETS.forEach((b, i) => out.push(`ais_gateway_browser_call_seconds_bucket{le="${b}"} ${this.callBucketCounts[i]}`));
    out.push(`ais_gateway_browser_call_seconds_bucket{le="+Inf"} ${this.callCount}`, `ais_gateway_browser_call_seconds_sum ${this.callSum}`, `ais_gateway_browser_call_seconds_count ${this.callCount}`);
    out.push("# HELP ais_gateway_chat_pod_start_seconds Time a chat pod took to start.", "# TYPE ais_gateway_chat_pod_start_seconds histogram");
    BUCKETS.forEach((b, i) => out.push(`ais_gateway_chat_pod_start_seconds_bucket{le="${b}"} ${this.podBucketCounts[i]}`));
    out.push(`ais_gateway_chat_pod_start_seconds_bucket{le="+Inf"} ${this.podCount}`, `ais_gateway_chat_pod_start_seconds_sum ${this.podSum}`, `ais_gateway_chat_pod_start_seconds_count ${this.podCount}`);
    out.push("# HELP ais_gateway_chats_active Chat sessions active now.", "# TYPE ais_gateway_chats_active gauge", `ais_gateway_chats_active ${this.chatGauges.active()}`);
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
    for (const section of this.sections) out.push(...section());
    return `${out.join("\n")}\n`;
  }
}
