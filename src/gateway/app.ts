import { Hono } from "hono";
import type { PoolUsage } from "../identities/pool/adapter.ts";
import { extractToken } from "./auth.ts";
import { BodyBudget } from "./body-budget.ts";
import type { BrowserHub } from "./browser/hub.ts";
import { createPairRoutes } from "./browser/pair.ts";
import { createCallRoutes } from "./browser/routing.ts";
import { checkCaps, dayStartIct } from "./caps.ts";
import { GatewayCredentialError, NotRefreshableError, RefreshCooldownError, type CredentialCache } from "./credentials.ts";
import { providerError } from "./errors.ts";
import type { LedgerBuffer } from "./ledger-buffer.ts";
import type { GatewayMetrics } from "./metrics.ts";
import { adapterFor } from "./providers/index.ts";
import type { ProviderAdapter, ProviderCredential } from "./providers/index.ts";
import { nativeLimitResponse } from "./native-limit.ts";
import { bounded } from "./refresh-guard.ts";
import { fallbackCount, Gate } from "./side-count.ts";
import { ACCOUNT_BODY_LIMIT, forwardAccount, readCapped, newAccountState, type AccountState } from "./account.ts";
import { poolModels } from "./models-union.ts";
import { collapseSlashes, PIN_FORWARD, routeFor, serveRoute, sideDailyLimitFromEnv, type AccountOp, type ResetCreditsCache } from "./routes.ts";
import { DEFAULT_RESERVE_PERCENT, memberUsages, pickIdentity, usageForModel, utilisationOf } from "./select.ts";
import type { GatewayStore } from "./store.ts";
import { verifyToken } from "./tokens.ts";
import type { ApiStyle, GatewayApp, GatewayProvider, UsageRow } from "./types.ts";
import { estimateCostWarn, UsageTap } from "./usage.ts";
import type { UsageCounts } from "./usage.ts";

export interface GatewayDeps {
  store: GatewayStore;
  ledger: LedgerBuffer;
  creds: Pick<CredentialCache, "get" | "refreshAfter401"> & Partial<Pick<CredentialCache, "signature">>;
  usageFor(provider: GatewayProvider, identity: string): Promise<PoolUsage | undefined>;
  /** Reads one member's usage from the source now and waits (single-flight); `usageFor` answers with it afterwards. */
  refreshUsage?(provider: GatewayProvider, identity: string): Promise<void>;
  poolMembers(provider: GatewayProvider): Promise<string[]>;
  /** Resolves an alias to the identity's canonical name. Ledger rows, metrics and alerts use the canonical name. */
  canonical?(provider: GatewayProvider, identity: string): Promise<string>;
  fetch: typeof fetch;
  now(): Date;
  metrics: GatewayMetrics;
  /** One JSON line per request (app, provider, identity, status, tap status). Never carries tokens, bodies or query strings. Defaults to console.info. */
  log?: (line: string) => void;
  /** Member accounts of a swap pool, or undefined for an unknown pool. */
  browserPoolMembers?(pool: string): Promise<string[] | undefined>;
  browserIdentityExists?(identity: string): Promise<string | undefined>;
  /** Browser relay; the agent call routes are only mounted when present. */
  browserHub?: BrowserHub;
  /** Most request-body bytes held for replay at once across all requests. Defaults to AIS_GATEWAY_BODY_BUDGET_MB, else BODY_BUDGET_BYTES. */
  bodyBudgetBytes?: number;
  /** Side and served requests (lists, search, speech, pool-served routes) an app may make per day. Defaults to AIS_GATEWAY_SIDE_DAILY_LIMIT, else 5000. */
  sideDailyLimit?: number;
  /** Longest a side-count database call may take before the replica counts from memory (default 5 s). */
  sideCountTimeoutMs?: number;
  /** Told after each side-count store call whether it worked (the server turns a failure into an owner alert). */
  sideCountHealth?(ok: boolean): void;
  /** Waits `ms` or until `signal` aborts; tests inject a fake clock. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Side-count database calls in flight at once for the whole gateway process (all apps share one gate); the rest queue for a slot. */
const SIDE_COUNT_MAX_INFLIGHT = 4;

/** Default cap on request-body bytes buffered at one time (the rest wait, holding no memory). */
export const BODY_BUDGET_BYTES = 512 * 1024 * 1024;

/** The budget in bytes: `AIS_GATEWAY_BODY_BUDGET_MB` when it is a positive number, else the default. */
export function bodyBudgetFromEnv(env: Record<string, string | undefined> = process.env): number {
  const mb = Number(env.AIS_GATEWAY_BODY_BUDGET_MB ?? "");
  return Number.isFinite(mb) && mb > 0 ? Math.floor(mb * 1024 * 1024) : BODY_BUDGET_BYTES;
}

/** Request bodies up to this size are buffered so they can be replayed (401 retry, failover). */
export const REPLAY_LIMIT_BYTES = 8 * 1024 * 1024;
/** Quota errors (403) are only inspected up to this size. */
export const ERROR_PEEK_BYTES = 64 * 1024;

/** Headers a front proxy adds that identify the client or the path to it. */
const PROXY_METADATA = new Set(["cdn-loop", "forwarded", "x-real-ip", "x-request-id", "x-client-ip", "true-client-ip"]);

const HOP_BY_HOP = ["connection", "proxy-connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "trailers", "transfer-encoding", "upgrade"];
/** Error types or codes that mean "this login is out of quota". A bare 403 (for example "insufficient permissions") is not one. */
const QUOTA_CODES = /^(insufficient_quota|rate_limit_error|rate_limit_exceeded|usage_limit_reached|quota_exceeded|billing_hard_limit_reached)$/i;

export type Body = { kind: "none" } | { kind: "buffered"; bytes: Uint8Array } | { kind: "stream"; stream: ReadableStream<Uint8Array>; /** The first bytes, for sniffing the model. */ head?: Uint8Array };

/** How much of a streamed body is read up front to find its model. */
const STREAM_HEAD_BYTES = 64 * 1024;

/** The declared Content-Length, or NaN when absent or malformed (`Number("")` would be a misleading 0). */
export function declaredLength(req: Request): number {
  const h = req.headers.get("content-length");
  return h !== null && /^\d+$/.test(h.trim()) ? Number(h) : Number.NaN;
}

export async function readBody(req: Request): Promise<Body> {
  if (!req.body) return { kind: "none" };
  const declared = declaredLength(req);
  // A declared length within the limit: let the runtime read the body natively into one buffer. Reading it chunk by
  // chunk in JS made 64 KiB garbage chunks plus a large copy per request, and under 50 concurrent 2 MB bodies the
  // collector fell behind (RSS above 1 GiB). The runtime refuses a body longer than its declared length.
  if (Number.isFinite(declared) && declared >= 0 && declared <= REPLAY_LIMIT_BYTES) {
    return { kind: "buffered", bytes: new Uint8Array(await req.arrayBuffer()) };
  }
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let overflow = Number.isFinite(declared) && declared > REPLAY_LIMIT_BYTES;
  while (!overflow) {
    const r = await reader.read();
    if (r.done) {
      const bytes = new Uint8Array(size);
      let at = 0;
      for (const c of chunks) {
        bytes.set(c, at);
        at += c.length;
      }
      return { kind: "buffered", bytes };
    }
    chunks.push(r.value);
    size += r.value.length;
    overflow = size > REPLAY_LIMIT_BYTES;
  }
  // Too big to replay. Read a little first (when nothing is read yet) so the model can be sniffed: a quota answer for
  // a streamed body still holds the member for that model. The bytes go on unchanged.
  while (size < STREAM_HEAD_BYTES) {
    const r = await reader.read();
    if (r.done) break;
    chunks.push(r.value);
    size += r.value.length;
  }
  const headLen = Math.min(size, STREAM_HEAD_BYTES);
  const head = new Uint8Array(headLen);
  let at = 0;
  for (const c of chunks) {
    if (at >= headLen) break;
    const take = c.subarray(0, Math.min(c.length, headLen - at));
    head.set(take, at);
    at += take.length;
  }
  // Hand the read part and the rest on, byte for byte.
  return { kind: "stream", stream: chainStream(chunks, reader), head };
}

/** The already-read chunks followed by the rest of the reader, unmodified. */
export function chainStream(chunks: Uint8Array[], reader: { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(reason?: unknown): Promise<void> }): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(c) {
      if (i < chunks.length) {
        c.enqueue(chunks[i++] as Uint8Array);
        return;
      }
      const r = await reader.read();
      if (r.done) c.close();
      else c.enqueue(r.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/** True when the query string carries a gateway token in any spelling (raw, percent-encoded, in a name or a value). */
export function queryCarriesToken(search: string): boolean {
  const needle = "aisg_";
  const lower = search.toLowerCase();
  if (lower.includes(needle) || lower.includes("aisg%5f")) return true;
  try {
    for (const [k, v] of new URLSearchParams(search)) {
      if (k.toLowerCase().includes(needle) || v.toLowerCase().includes(needle)) return true;
    }
  } catch {
    // fall through to the lenient checks below
  }
  try {
    if (decodeURIComponent(lower).includes(needle)) return true;
  } catch {
    // A bare % is legal in practice (`?q=100%`). The raw and URLSearchParams forms above already decode leniently, so nothing is hidden.
  }
  return false;
}

/** Removes the headers a `Connection` header names, plus the fixed hop-by-hop set. */
export function stripHopByHop(headers: Headers): void {
  for (const name of (headers.get("connection") ?? "").split(",")) {
    const n = name.trim().toLowerCase();
    if (n) headers.delete(n);
  }
  for (const h of HOP_BY_HOP) headers.delete(h);
}

/** The request headers for the provider: hop-by-hop and gateway-auth headers removed, the adapter's credential headers set. */
export function upstreamHeaders(adapter: ProviderAdapter, cred: ProviderCredential, incoming: Headers): Headers {
  const headers = new Headers(incoming);
  stripHopByHop(headers);
  for (const h of [...adapter.stripRequestHeaders, "host", "content-length", "accept-encoding"]) headers.delete(h);
  // Cloudflare (tunnel, Access) adds its own headers, including Access JWTs and client ids/secrets: none of them goes to a provider.
  // Proxy metadata (client and pod addresses, request ids, envoy/forwarding headers) stays inside too.
  for (const name of [...headers.keys()]) if (name.startsWith("cf-") || name.startsWith("x-envoy-") || name.startsWith("x-forwarded-") || PROXY_METADATA.has(name)) headers.delete(name);
  headers.set("accept-encoding", "identity");
  for (const [k, v] of Object.entries(adapter.authHeaders(cred, incoming))) headers.set(k, v);
  return headers;
}

/** Reads at most `cap` bytes of a response body; the response is re-created unchanged. */
export async function peek(res: Response, cap: number): Promise<{ bytes: Uint8Array; whole: boolean; res: Response }> {
  if (!res.body) return { bytes: new Uint8Array(0), whole: true, res };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let whole = false;
  while (size <= cap) {
    const r = await reader.read();
    if (r.done) {
      whole = true;
      break;
    }
    chunks.push(r.value);
    size += r.value.length;
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  const out = whole ? new Response(bytes, { status: res.status, statusText: res.statusText, headers: res.headers }) : new Response(chainStream(chunks, reader), { status: res.status, statusText: res.statusText, headers: res.headers });
  return { bytes, whole: whole && size <= cap, res: out };
}

export function isQuotaBody(bytes: Uint8Array): boolean {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});
    const top = obj(parsed);
    const err = obj(top.error);
    return [top.type, top.code, err.type, err.code].some((v) => typeof v === "string" && QUOTA_CODES.test(v));
  } catch {
    return false;
  }
}

/**
 * Allocation-free scan for the top-level `model` string of a JSON object. The last duplicate wins, as in
 * JSON.parse, so an allowlist cannot be dodged with `{"model":"ok","model":"other"}`. Returns `ok: false` when the
 * bytes are not a well-formed object (the caller then falls back to JSON.parse).
 */
export function scanModel(b: Uint8Array): { ok: boolean; model?: string } {
  const n = b.length;
  let i = 0;
  const ws = (): void => {
    while (i < n && (b[i] === 0x20 || b[i] === 0x0a || b[i] === 0x0d || b[i] === 0x09)) i++;
  };
  /** Skips a string starting at the opening quote; returns the index of the closing quote or -1. */
  const str = (from: number): number => {
    let j = from + 1;
    while (j < n) {
      const c = b[j];
      if (c === 0x5c) j += 2;
      else if (c === 0x22) return j;
      else j++;
    }
    return -1;
  };
  const value = (): boolean => {
    ws();
    const c = b[i];
    if (c === 0x22) {
      const e = str(i);
      if (e < 0) return false;
      i = e + 1;
      return true;
    }
    if (c === 0x7b || c === 0x5b) {
      const stack: number[] = [];
      while (i < n) {
        const d = b[i];
        if (d === 0x22) {
          const e = str(i);
          if (e < 0) return false;
          i = e + 1;
          continue;
        }
        if (d === 0x7b) stack.push(0x7d);
        else if (d === 0x5b) stack.push(0x5d);
        else if (d === 0x7d || d === 0x5d) {
          if (stack.pop() !== d) return false; // bracket mismatch: not JSON
          if (stack.length === 0) {
            i++;
            return true;
          }
        }
        i++;
      }
      return false;
    }
    // Only the JSON literals and numbers are accepted; anything else is left to JSON.parse (which will reject it).
    const start = i;
    while (i < n && b[i] !== 0x2c && b[i] !== 0x7d && b[i] !== 0x20 && b[i] !== 0x0a && b[i] !== 0x0d && b[i] !== 0x09) i++;
    const lit = new TextDecoder().decode(b.subarray(start, i));
    return lit === "true" || lit === "false" || lit === "null" || /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(lit);
  };
  ws();
  if (b[i] !== 0x7b) return { ok: false };
  i++;
  let model: string | undefined;
  ws();
  if (b[i] === 0x7d) {
    i++;
    ws();
    return i === n ? { ok: true } : { ok: false };
  }
  for (;;) {
    ws();
    if (b[i] !== 0x22) return { ok: false };
    const ke = str(i);
    if (ke < 0) return { ok: false };
    const keyStart = i;
    for (let k = keyStart + 1; k < ke; k++) if (b[k] === 0x5c) return { ok: false }; // An escaped key can spell "model" in a way no byte compare sees: leave it to JSON.parse.
    i = ke + 1;
    ws();
    if (b[i] !== 0x3a) return { ok: false };
    i++;
    ws();
    const isModel = ke - keyStart === 6 && b[keyStart + 1] === 0x6d && b[keyStart + 2] === 0x6f && b[keyStart + 3] === 0x64 && b[keyStart + 4] === 0x65 && b[keyStart + 5] === 0x6c;
    const vStart = i;
    if (!value()) return { ok: false };
    if (isModel) {
      if (b[vStart] === 0x22) {
        try {
          const m: unknown = JSON.parse(new TextDecoder().decode(b.subarray(vStart, i)));
          model = typeof m === "string" ? m : undefined;
        } catch {
          return { ok: false };
        }
      } else model = undefined;
    }
    ws();
    if (b[i] === 0x2c) {
      i++;
      continue;
    }
    if (b[i] === 0x7d) {
      i++;
      ws();
      if (i !== n) return { ok: false };
      return model === undefined ? { ok: true } : { ok: true, model };
    }
    return { ok: false };
  }
}

/** A streamed body's model, when its JSON names `model` before the head ends (Claude Code sends it first). */
const HEAD_MODEL = /^\s*\{\s*"model"\s*:\s*"([A-Za-z0-9._:\[\]\/-]{1,200})"/;

function requestModel(body: Body): string | undefined {
  if (body.kind === "stream") {
    if (!body.head) return undefined;
    return HEAD_MODEL.exec(new TextDecoder().decode(body.head))?.[1];
  }
  if (body.kind !== "buffered" || body.bytes.length === 0 || body.bytes[0] !== 0x7b) return undefined; // only a JSON object has a model
  const scanned = scanModel(body.bytes);
  if (scanned.ok) return scanned.model;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body.bytes));
    const m = typeof parsed === "object" && parsed !== null ? (parsed as { model?: unknown }).model : undefined;
    return typeof m === "string" ? m : undefined;
  } catch {
    return undefined;
  }
}

function guessStyle(path: string): ApiStyle {
  return /\/messages(\/|$)/.test(path) ? "anthropic" : "openai";
}

/** The error shape for a request before auth: the app's own style when the path names a known app, else a guess from the path (OpenAI by default). */
export async function styleForPath(deps: Pick<GatewayDeps, "store">, pathname: string): Promise<ApiStyle> {
  const slash = pathname.indexOf("/", 1);
  const name = decodeSegment(pathname.slice(1, slash === -1 ? undefined : slash));
  try {
    const found = name ? await deps.store.getApp(name) : undefined;
    if (found) return found.style;
  } catch {
    // fall through to the guess
  }
  return guessStyle(pathname);
}

function defaultLog(line: string): void {
  console.info(line);
}

async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // already closed
  }
}

/** Set on every response the gateway app itself produces. A 5xx without it came from an edge in front (for example "no healthy upstream" during a restart). */
export const GATEWAY_MARK_HEADER = "x-ais-gateway";

/** Marks `res` as gateway-made; returns a copy when the headers are immutable. */
export function markGatewayResponse(res: Response): Response {
  try {
    res.headers.set(GATEWAY_MARK_HEADER, "1");
    return res;
  } catch {
    const headers = new Headers(res.headers);
    headers.set(GATEWAY_MARK_HEADER, "1");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
}

export function createGatewayApp(deps: GatewayDeps): Hono {
  const hono = new Hono();
  hono.use("*", async (c, next) => {
    await next();
    c.res = markGatewayResponse(c.res);
  });
  const log = deps.log ?? defaultLog;
  const budget = new BodyBudget(deps.bodyBudgetBytes ?? bodyBudgetFromEnv(), (n) => deps.metrics.bodyBudgetWaiting?.(n));
  const exhausted = new Map<string, number>();
  const resetCredits: ResetCreditsCache = {};
  const accountState = newAccountState();
  const sideGate = new Gate(SIDE_COUNT_MAX_INFLIGHT);
  const sideCounts = new Map<string, number>(); // fallback only, while the store is down
  /** Short holds (burst 429, credential failures) by member key; quota exhaustion has no entry. */
  const holds = new Map<string, Hold>();
  const handle = (req: Request): Promise<Response> =>
    proxy(req, deps, log, budget, exhausted, holds, resetCredits, sideCounts, sideGate, accountState).catch(async () => providerError(await styleForPath(deps, new URL(req.url).pathname), 500, "gateway error"));
  // Before the catch-all proxy routes: "browser" is not an app name.
  const browserDeps = { store: deps.store, now: deps.now, metrics: deps.metrics, ...(deps.browserPoolMembers ? { browserPoolMembers: deps.browserPoolMembers } : {}), ...(deps.browserIdentityExists ? { browserIdentityExists: deps.browserIdentityExists } : {}) };
  hono.route("/browser", createPairRoutes(browserDeps));
  if (deps.browserHub) hono.route("/browser", createCallRoutes({ ...browserDeps, hub: deps.browserHub }));
  hono.all("/:app", (c) => handle(c.req.raw));
  hono.all("/:app/*", (c) => handle(c.req.raw));
  return hono;
}

async function proxy(req: Request, deps: GatewayDeps, log: (line: string) => void, budget: BodyBudget, exhausted: Map<string, number>, holds: Map<string, Hold>, resetCredits: ResetCreditsCache, sideCounts: Map<string, number>, sideGate: Gate, accountState: AccountState): Promise<Response> {
  const started = performance.now();
  const url = new URL(req.url);
  const slash = url.pathname.indexOf("/", 1);
  const appName = decodeSegment(url.pathname.slice(1, slash === -1 ? undefined : slash));
  // Repeated slashes are collapsed once, here: every rule below and the path sent upstream see the same path.
  const rest = slash === -1 ? "" : collapseSlashes(url.pathname.slice(slash));

  let found: GatewayApp | undefined;
  try {
    found = appName ? await deps.store.getApp(appName) : undefined;
  } catch {
    deps.metrics.authFailure("auth-error");
    return providerError(guessStyle(url.pathname), 502, "gateway store unavailable");
  }
  if (!found) {
    deps.metrics.authFailure("unknown-app");
    return providerError(guessStyle(url.pathname), 404, "not found");
  }
  const app: GatewayApp = found;
  const style = app.style;
  const adapter = adapterFor(app.provider);

  const token = queryCarriesToken(url.search) ? undefined : extractToken(req, app.name);
  let valid = false;
  if (token) {
    try {
      valid = await verifyToken(deps.store, app.name, token, deps.now());
    } catch {
      deps.metrics.authFailure("auth-error", app.name);
      return providerError(style, 502, "gateway store unavailable");
    }
  }
  if (!valid) {
    deps.metrics.authFailure("bad-token", app.name);
    return providerError(style, 401, "invalid or missing gateway token");
  }

  const canon = async (name: string): Promise<string> => {
    try {
      return (await deps.canonical?.(app.provider, name)) ?? name;
    } catch {
      return name;
    }
  };
  const identityForRow = app.target.kind === "pin" ? await canon(app.target.identity) : "-";
  let recorded = false;
  const record = (identity: string, status: string, httpStatus: number, counts: UsageCounts | undefined, streamed: boolean, tap?: string, model?: string, reason?: string): void => {
    if (recorded) return;
    recorded = true;
    const latencyMs = Math.round(performance.now() - started);
    const c = counts ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const cost = counts ? estimateCostWarn(app.provider, { ...counts, model: counts.model ?? model }, log) : undefined;
    const row: UsageRow = {
      ts: deps.now().toISOString(),
      app: app.name,
      provider: app.provider,
      identity,
      ...(c.model ?? model ? { model: c.model ?? model } : {}),
      inputTokens: c.inputTokens,
      outputTokens: c.outputTokens,
      cacheReadTokens: c.cacheReadTokens,
      cacheWriteTokens: c.cacheWriteTokens,
      ...(cost !== undefined ? { estCostUsd: cost } : {}),
      status,
      httpStatus,
      latencyMs,
      streamed,
    };
    try {
      deps.ledger.push(row);
      deps.metrics.request({ app: app.name, provider: app.provider, identity, status, httpStatus, latencyMs, ...(counts ? { tokens: c } : {}) });
      log(JSON.stringify({ event: "request", app: app.name, provider: app.provider, identity, status, http: httpStatus, ...(tap ? { tap } : {}), ...(reason ? { reason } : {}) }));
    } catch {
      // Observation must never affect the response.
    }
  };
  const reject = (status: number, message: string, identity = identityForRow, model?: string, reason?: string): Response => {
    record(identity, "rejected", status, undefined, false, undefined, model, reason);
    return providerError(style, status, message);
  };

  let identity = identityForRow;
  let model: string | undefined;
  const ctrl = new AbortController();
  const onAbort = (): void => ctrl.abort();
  req.signal.addEventListener("abort", onAbort, { once: true });
  if (req.signal.aborted) ctrl.abort(); // already gone: the listener will never fire
  let releaseBody: (() => void) | undefined;
  try {
    return await run();
  } catch {
    // Anything unexpected after auth: one ledger row and the app's own error shape, never the cause.
    req.signal.removeEventListener("abort", onAbort);
    if (req.signal.aborted || ctrl.signal.aborted) {
      record(identity, "client_aborted", 499, undefined, false, undefined, model);
      return new Response(null, { status: 499 });
    }
    record(identity, "error", 500, undefined, false, undefined, model);
    return providerError(style, 500, "gateway error");
  } finally {
    releaseBody?.();
  }

  async function run(): Promise<Response> {
  if (!pathAllowed(rest, style)) return reject(400, "encoded slashes and dot segments are not allowed in the path");
  let route = routeFor(app.provider, style, req.method, rest);
  // ChatGPT account paths a codex client asks for under /backend-api (plugins and the like): never forwarded with a login.
  if (route?.kind === "deny") return reject(route.status, "this path is not available through the gateway");
  // A pinned app has one identity, so a pool-served answer (usage, reset credits) is replaced by the provider's own for that identity.
  if (route?.kind === "serve" && app.target.kind === "pin" && PIN_FORWARD[route.name]) route = { kind: "account", op: "forward", url: PIN_FORWARD[route.name] as string };
  /** A list, search or speech call is not a model call: no model allowlist, and its upstream errors never touch logins or the pool. */
  const side = route?.kind === "upstream" && route.side;
  /**
   * Side and served calls are counted per app and day, apart from tokens, in the gateway's shared store (so the limit holds across
   * replicas and restarts). If the store cannot answer in time the count falls back to this replica's memory, the failure is
   * counted and raised as an owner alert, and the request goes on.
   */
  if (side || route?.kind === "serve" || (route?.kind === "account" && route.count !== false)) {
    const day = new Date(dayStartIct(deps.now()).getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
    let n: number | undefined;
    // At most SIDE_COUNT_MAX_INFLIGHT store calls run at once. The others queue for a slot inside the same time limit as the call itself:
    // waiting for the gate is normal load, not a failure. Only a database error or running out of time falls back to memory (and alerts).
    const limitMs = deps.sideCountTimeoutMs ?? 5_000;
    const deadline = Date.now() + limitMs;
    const release = await sideGate.acquire(limitMs, ctrl.signal);
    // A client that left while waiting is neither counted nor given a slot.
    if (ctrl.signal.aborted || req.signal.aborted) {
      release?.(); // the abort may have landed after a slot was granted: hand it on, never leak it
      throw new DOMException("aborted", "AbortError");
    }
    if (release) {
      const abort = new AbortController();
      const query = deps.store.bumpSideCount(app.name, day, abort.signal);
      // The slot is freed when the call ends, however late; a write that lands after the timeout is not used for the limit.
      query.then(release, release);
      try {
        n = await bounded(query, Math.max(1, deadline - Date.now()), "side count");
        deps.sideCountHealth?.(true);
      } catch {
        abort.abort();
        n = undefined;
      }
    }
    if (n === undefined) {
      deps.metrics.failOpen(app.name, "side_count_failed");
      deps.sideCountHealth?.(false);
      n = fallbackCount(sideCounts, app.name, day);
    }
    if (n > (deps.sideDailyLimit ?? sideDailyLimitFromEnv())) {
      deps.metrics.rejection(app.name, "daily_cap");
      return reject(429, "daily limit for list, search and speech calls reached", identityForRow, undefined, "side_daily_cap");
    }
  }
  /** A pool app's model list: the union of its members' lists (or the first member that has the one model), see models-union.ts. */
  const poolList = route?.kind === "upstream" && route.models !== undefined && app.target.kind === "pool" ? route : undefined;
  if (route?.kind === "serve" || route?.kind === "account" || poolList) {
    // Answered from the gateway's own pool state, or forwarded to the provider's account API with the member's login (no token rows). The daily cap still applies.
    if (app.dailyTokens !== undefined) {
      let usedNow = 0;
      try {
        usedNow = await deps.store.usageSince(app.name, dayStartIct(deps.now()));
      } catch {
        deps.metrics.failOpen(app.name, "cap_check_failed");
      }
      if (usedNow >= app.dailyTokens) {
        deps.metrics.rejection(app.name, "daily_cap");
        return reject(429, "daily token cap reached", identityForRow, undefined, "daily_cap");
      }
    }
    if (route?.kind === "account") {
      let bytes: Uint8Array | undefined;
      if (req.body) {
        // Bounded: a declared length over the limit is refused unread; otherwise the body is read in chunks inside the body budget and cut off at the limit.
        const declared = declaredLength(req);
        if (Number.isFinite(declared) && declared > ACCOUNT_BODY_LIMIT) return reject(413, "request body too large for an account call");
        releaseBody = await budget.reserve(Number.isFinite(declared) ? declared : ACCOUNT_BODY_LIMIT, ctrl.signal);
        bytes = await readCapped(req.body, ACCOUNT_BODY_LIMIT);
        if (!bytes) return reject(413, "request body too large for an account call");
      }
      const out = await forwardAccount({ app, deps, state: accountState, op: route.op as AccountOp, method: req.method, url: route.url, search: url.search, headers: req.headers, body: bytes, style, signal: ctrl.signal });
      req.signal.removeEventListener("abort", onAbort);
      const who = out.identity ? await canon(out.identity) : identityForRow;
      record(who, out.res.status >= 400 ? "rejected" : "ok", out.res.status, undefined, false, undefined, undefined, out.cls);
      return out.res;
    }
    if (poolList) {
      const listed = await poolModels({ app, deps, style, url: poolList.url + url.search, incoming: req.headers, signal: ctrl.signal, single: poolList.models === "one" });
      req.signal.removeEventListener("abort", onAbort);
      record(identityForRow, listed.status >= 400 ? "upstream_error" : "ok", listed.status, undefined, false);
      return listed;
    }
    if (route?.kind !== "serve") throw new Error("unreachable: not a served route");
    const served = await serveRoute(route.name, { app, style, deps, signal: ctrl.signal, cache: resetCredits });
    req.signal.removeEventListener("abort", onAbort);
    record(identityForRow, served.status >= 400 ? "rejected" : "ok", served.status, undefined, false);
    return served;
  }
  let body: Body;
  try {
    // Reserve the declared size first; a request that does not fit waits without reading its body.
    const declared = declaredLength(req);
    const reserve = !req.body ? 0 : Number.isFinite(declared) ? (declared > REPLAY_LIMIT_BYTES ? 0 : declared) : REPLAY_LIMIT_BYTES; // unknown length (chunked): up to the replay cap may be buffered
    // A queued request waits until it fits or its client leaves (the abort rejects here and is recorded below). The gateway never answers 503 for capacity.
    // Nothing buffered (no body, empty, or streamed past the replay cap) means nothing to reserve: it never queues behind others.
    if (reserve > 0) {
      const queuedAt = performance.now();
      releaseBody = await budget.reserve(reserve, ctrl.signal);
      deps.metrics.bodyBudgetWait?.((performance.now() - queuedAt) / 1000);
    }
    body = await readBody(req);
  } catch {
    // An abort can land a tick after the read error it caused: look again before calling it a bad body.
    if (!req.signal.aborted && !ctrl.signal.aborted) await new Promise((r) => setTimeout(r, 0));
    if (req.signal.aborted || ctrl.signal.aborted) {
      record(identity, "client_aborted", 499, undefined, false, undefined, undefined);
      return new Response(null, { status: 499 });
    }
    return reject(400, "request body could not be read");
  }
  model = requestModel(body);
  if (!side && app.models && app.models.length > 0 && body.kind === "stream") {
    deps.metrics.rejection(app.name, "model");
    return reject(413, "request too large to verify the model allowlist", identityForRow, model);
  }
  let used = 0;
  if (app.dailyTokens !== undefined) {
    try {
      used = await deps.store.usageSince(app.name, dayStartIct(deps.now()));
    } catch {
      used = 0; // Database lost after warm: keep serving, and count it.
      deps.metrics.failOpen(app.name, "cap_check_failed");
    }
  }
  const caps = checkCaps(side ? { ...app, models: undefined } : app, model, used);
  if (!("ok" in caps)) {
    deps.metrics.rejection(app.name, caps.status === 403 ? "model" : "daily_cap");
  }
  if (!("ok" in caps)) return reject(caps.status, caps.reason, identityForRow, model, caps.status === 403 ? "model" : "daily_cap");

  const nowMs = deps.now().getTime();
  const exKey = (name: string): string => `${app.provider}\u0000${name}`;
  /** Pool members still marked exhausted (their reset has not passed). */
  const exhaustedNames = async (): Promise<Set<string>> => {
    const out = new Set<string>();
    for (const [k, until] of [...exhausted]) {
      if (until <= deps.now().getTime()) {
        exhausted.delete(k);
        holds.delete(k);
      } else if (k.startsWith(`${app.provider}\u0000`)) {
        const rest = k.slice(app.provider.length + 1);
        const scoped = rest.indexOf(MODEL_HOLD_SEP);
        if (scoped >= 0) {
          // A model-scoped hold (a Fable-only limit, say) keeps the member out for that model only.
          if (model !== undefined && rest.slice(scoped + MODEL_HOLD_SEP.length) === model) out.add(rest.slice(0, scoped));
          continue;
        }
        const name = rest;
        // A member held for a credential failure (short or long) is released as soon as its credential file changes:
        // a fresh login must not wait out the hold.
        const h = holds.get(k);
        if (h?.kind === "cred" && (await credentialSignature(deps, app.provider, name)) !== h.sig) {
          exhausted.delete(k);
          holds.delete(k);
        } else out.add(name);
      }
    }
    return out;
  };
  /** Hold a member whose credential failed: ten minutes (or until its credential file changes) when only a person can fix it, else briefly. */
  const holdCredentialFailure = async (name: string, err: unknown): Promise<void> => {
    const long = err instanceof GatewayCredentialError && (err.loggedOut || err.code === "retired" || err.code === "unknown-identity");
    const message = err instanceof GatewayCredentialError ? err.clientMessage : "upstream credential unavailable";
    exhausted.set(exKey(name), deps.now().getTime() + (long ? CREDENTIAL_HOLD_MS : BURST_HOLD_DEFAULT_MS));
    holds.set(exKey(name), { kind: "cred", long, message, sig: await credentialSignature(deps, app.provider, name) });
  };
  /** Hold a member after a quota-type answer: until reset when exhaustion is proven (or 402/403), else briefly. */
  const holdQuota = (name: string, res: Response): void => {
    const nowMs = deps.now().getTime();
    if (res.status === 429 && isModelScopedRejection(res.headers)) {
      // Only one model's own window is full (Anthropic's per-model weekly limits): the account still serves every other
      // model, so it is held for this model only, until that window's own reset. Without a model to scope it to, it is a
      // brief burst hold.
      if (model !== undefined) bridgeUntilReading(name, `${exKey(name)}${MODEL_HOLD_SEP}${model}`, scopedResetUntil(res.headers, nowMs));
      else {
        exhausted.set(exKey(name), burstHoldUntil(res.headers, nowMs));
        holds.set(exKey(name), { kind: "burst", long: false });
        void refreshFromSource(name);
      }
    } else if (res.status === 402 || res.status === 403 || (res.status === 429 && provesSubscriptionExhaustion(res.headers))) {
      holds.delete(exKey(name));
      bridgeUntilReading(name, exKey(name), exhaustedUntil(res.headers, nowMs));
    } else if (res.status === 429) {
      // A burst 429 (no window rejected) is not about usage: its hold is the provider's retry-after. The source is still
      // read again so the next pick sees current figures.
      exhausted.set(exKey(name), burstHoldUntil(res.headers, nowMs));
      holds.set(exKey(name), { kind: "burst", long: false });
      void refreshFromSource(name);
    }
  };
  /** Reads the member's usage from the source now (single-flight per member), so the next pick decides on real data. */
  const refreshFromSource = (name: string): Promise<void> =>
    deps.refreshUsage ? deps.refreshUsage(app.provider, name).catch(() => undefined) : Promise.resolve();
  /**
   * A quota hold only bridges until the source has been read again: when the fresh reading (live, not stale) shows the
   * windows that apply to this request's model below 100%, the hold ends; otherwise it stands until the provider's reset.
   */
  const bridgeUntilReading = (name: string, key: string, until: number): void => {
    exhausted.set(key, until);
    if (!deps.refreshUsage) return; // no source to read again: the provider's reset decides alone
    const forModel = model;
    void refreshFromSource(name).then(async () => {
      if (exhausted.get(key) !== until) return; // a newer answer replaced this hold
      const reading = await deps.usageFor(app.provider, name).catch(() => undefined);
      if (!reading || reading.stale || reading.status !== "live") return;
      const util = utilisationOf(usageForModel(reading, forModel));
      if (util !== undefined && util < 100 && exhausted.get(key) === until) exhausted.delete(key);
    });
  };
  // While the pool still has headroom and only short holds (burst 429s, brief credential retries) stand in the way,
  // the gateway waits for the first hold to end instead of answering 429: a client CLI treats a 429 as a hard limit.
  const waitStart = deps.now().getTime();
  let waits = 0;
  const waitForShortHold = async (): Promise<boolean> => {
    if (app.target.kind !== "pool" || waits >= SHORT_HOLD_MAX_WAITS || req.signal.aborted) return false;
    const now = deps.now().getTime();
    const left = waitStart + SHORT_HOLD_WAIT_BUDGET_MS - now;
    if (left <= 0) return false;
    const held = await exhaustedNames();
    const shortHeld = [...held].filter((n) => { const h = holds.get(exKey(n)); return h !== undefined && !h.long; });
    if (shortHeld.length === 0) return false;
    // Only worth waiting when some member would be picked once the short holds are gone.
    const quotaOut = new Set([...held].filter((n) => !shortHeld.includes(n)));
    if (!("identity" in (await pickIdentity(app, deps, quotaOut, model)))) return false;
    const soonest = Math.min(...shortHeld.map((n) => exhausted.get(exKey(n)) ?? now));
    waits++;
    await (deps.sleep ?? defaultSleep)(Math.min(Math.max(soonest - now, SHORT_HOLD_MIN_SLEEP_MS), left), req.signal);
    return !req.signal.aborted;
  };
  let picked = await pickIdentity(app, deps, app.target.kind === "pool" ? await exhaustedNames() : undefined, model);
  while ("reject" in picked && picked.reject === "no-headroom" && (await waitForShortHold())) picked = await pickIdentity(app, deps, await exhaustedNames(), model);
  const pick = picked;
  if ("reject" in pick) {
    deps.metrics.rejection(app.name, pick.reject === "reserve" ? "reserve" : pick.reject === "no-identities" ? "no_identities" : "no_headroom");
    const why = pick.reject === "reserve" ? "identity is at its usage reserve" : pick.reject === "no-identities" ? `no identities configured for ${app.provider}` : "no pool member has headroom below the reserve";
    const reason = pick.reject === "no-headroom" && app.target.kind === "pool" && (await exhaustedNames()).size > 0 ? "no-headroom:exhausted" : pick.reject;
    // Out of capacity (or at the reserve): answer in the provider's own limit shape so its CLI shows its built-in limit handling.
    // When a member would be free without the short holds, the answer is about the hold, not about usage.
    if (pick.reject === "no-headroom" && app.target.kind === "pool") {
      // Only the short holds are ignored: members out for proven quota exhaustion stay excluded.
      const quotaOut = new Set([...(await exhaustedNames())].filter((n) => !holds.has(exKey(n))));
      let free = await pickIdentity(app, deps, quotaOut, model);
      let h = "identity" in free ? holds.get(exKey(free.identity)) : undefined;
      if (h?.kind === "cred") {
        // A burst-held member frees sooner than a credential-held one, so it decides the answer.
        const noCred = new Set([...quotaOut, ...[...holds].filter(([k, v]) => v.kind === "cred" && k.startsWith(exKey(""))).map(([k]) => k.slice(exKey("").length))]);
        const alt = await pickIdentity(app, deps, noCred, model);
        if ("identity" in alt && holds.get(exKey(alt.identity))?.kind === "burst") {
          free = alt;
          h = holds.get(exKey(alt.identity));
        }
      }
      if (h?.kind === "burst" && "identity" in free) {
        const secs = Math.min(60, Math.max(1, Math.ceil(((exhausted.get(exKey(free.identity)) ?? 0) - deps.now().getTime()) / 1000)));
        record(identityForRow, "rejected", 429, undefined, false, undefined, model, reason);
        const res = providerError(style, 429, "upstream rate limit: retry shortly");
        res.headers.set("retry-after", String(secs));
        return res;
      }
      if (h?.kind === "cred") {
        record(identityForRow, "credential_error", 502, undefined, false, undefined, model, reason);
        return providerError(style, 502, h.message ?? "upstream credential unavailable");
      }
    }
    if (pick.reject !== "no-identities") {
      const native = nativeLimitResponse(app.provider, await memberUsages(app, deps, model), app.reservePercent ?? DEFAULT_RESERVE_PERCENT, deps.now());
      if (native) {
        record(identityForRow, "rejected", 429, undefined, false, undefined, model, reason);
        return native;
      }
    }
    return reject(429, why, identityForRow, model, reason);
  }

  const upstreamUrl = (route?.kind === "upstream" ? route.url : adapter.upstreamBase(style) + rest) + url.search;
  const replayable = body.kind !== "stream";

  const send = (cred: ProviderCredential): Promise<Response> => {
    // A client that is already gone gets no upstream call.
    if (req.signal.aborted || ctrl.signal.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
    const headers = upstreamHeaders(adapter, cred, req.headers);
    const init: RequestInit & { duplex?: "half" } = { method: req.method, headers, signal: ctrl.signal, redirect: "manual" };
    if (body.kind === "buffered" && body.bytes.length > 0) init.body = body.bytes;
    else if (body.kind === "stream") {
      init.body = body.stream;
      init.duplex = "half";
    }
    return deps.fetch(upstreamUrl, init);
  };

  /** One attempt for `identity`, including at most one 401 refresh and retry. */
  const attempt = async (ident: string): Promise<Response> => {
    let cred = await deps.creds.get(app.provider, ident);
    let res = await send(cred);
    if (res.status === 401 && adapter.refreshable && !side) {
      try {
        cred = await deps.creds.refreshAfter401(app.provider, ident, cred.accessToken);
      } catch (err) {
        if (err instanceof RefreshCooldownError || err instanceof NotRefreshableError) {
          if (app.target.kind === "pool" && replayable) {
            // A pool member whose refresh cannot run is held back and the next member tries the request.
            await discard(res);
            throw err;
          }
          return res; // pass the upstream 401 through
        }
        if (!replayable) return res; // The body cannot be replayed anyway: the client sees the 401.
        await discard(res);
        throw err;
      }
      // The credential is refreshed for the next request; a streamed body cannot be sent again.
      if (!replayable) return res;
      await discard(res);
      res = await send(cred);
    }
    return res;
  };

  /** 429 is quota or rate limit. 402 is a payment-required signal some providers use for exhausted credit. A 403 counts only when its (bounded) JSON body names a quota error type or code. */
  const isQuota = async (res: Response): Promise<{ quota: boolean; res: Response }> => {
    if (side) return { quota: false, res }; // a side route's 402/403/429 is its own, not a sign this login is out of quota
    if (res.status === 402) return { quota: true, res };
    if (res.status === 429) {
      // Only Codex states exhaustion in the body (the (bounded) peek); elsewhere the headers decide and the body is not read.
      if (app.provider !== "codex") return { quota: true, res };
      const p = await peek(res, ERROR_PEEK_BYTES);
      if (!(p.whole && /usage_limit_reached/.test(new TextDecoder().decode(p.bytes)))) return { quota: true, res: p.res };
      const h = new Headers(p.res.headers);
      h.set(SUBSCRIPTION_EXHAUSTED_HEADER, "1");
      return { quota: true, res: new Response(p.res.body, { status: p.res.status, statusText: p.res.statusText, headers: h }) };
    }
    if (res.status !== 403) return { quota: false, res };
    const p = await peek(res, ERROR_PEEK_BYTES);
    return { quota: p.whole && isQuotaBody(p.bytes), res: p.res };
  };

  identity = await canon(pick.identity);
  let up: Response;
  try {
    const poolReplay = app.target.kind === "pool" && replayable;
    let first: Response | undefined;
    let credErr: unknown;
    try {
      first = await attempt(identity);
    } catch (err) {
      if (!poolReplay || ctrl.signal.aborted || req.signal.aborted || !isCredentialFailure(err)) throw err;
      credErr = err;
      await holdCredentialFailure(pick.identity, err);
    }
    let cur: Response | undefined = first;
    if (!poolReplay && app.target.kind === "pool" && cur) {
      // A body that cannot be replayed (streamed, over the replay cap) gets no failover, but its quota answer still holds
      // the member back, so the next request does not land on the same full member.
      const q = await isQuota(cur);
      cur = q.res;
      if (q.quota) holdQuota(pick.identity, cur);
    }
    if (poolReplay) {
      let quota = false;
      if (cur) {
        const q = await isQuota(cur);
        cur = q.res;
        quota = q.quota;
        if (quota) holdQuota(pick.identity, cur);
      }
      // Every quota answer before the first byte marks that member exhausted until its reset (or briefly for a burst
      // 429), and a credential failure holds the member back; then the next eligible member gets the replayed body,
      // until one answers or none is left (the last answer then stands, or the credential error if there was none).
      const tried = new Set<string>();
      let name = pick.identity;
      while (quota || !cur) {
        tried.add(name);
        const next = await pickIdentity(app, deps, new Set([...(await exhaustedNames()), ...tried]), model);
        if (!("identity" in next)) {
          // Everyone left is only briefly held: wait for the first to free, then try the pool again from the top.
          if (quota && cur && !provesSubscriptionExhaustion(cur.headers) && (await waitForShortHold())) {
            tried.clear();
            name = "";
            continue;
          }
          break;
        }
        name = next.identity;
        // If the next identity cannot even be tried, it is skipped; the client keeps the last upstream answer.
        let second: Response;
        try {
          second = await attempt(next.identity);
        } catch (err) {
          if (req.signal.aborted || ctrl.signal.aborted) {
            if (cur) await discard(cur);
            throw new DOMException("aborted", "AbortError");
          }
          if (isCredentialFailure(err)) {
            credErr = err;
            await holdCredentialFailure(name, err);
          }
          tried.add(name);
          continue;
        }
        const sq = await isQuota(second);
        if (cur) await discard(cur);
        deps.metrics.failover(app.name);
        cur = sq.res;
        identity = await canon(next.identity);
        quota = sq.quota;
        if (quota) holdQuota(name, cur);
      }
      if (!cur) throw credErr;
    }
    if (!cur) throw credErr;
    up = cur;
  } catch (err) {
    req.signal.removeEventListener("abort", onAbort);
    if (ctrl.signal.aborted) {
      record(identity, "client_aborted", 499, undefined, false, undefined, model);
      return new Response(null, { status: 499 });
    }
    if (err instanceof GatewayCredentialError) {
      record(identity, "credential_error", 502, undefined, false, undefined, model);
      return providerError(style, 502, err.clientMessage);
    }
    // Never echo the error: it may carry paths or provider text.
    const credential = err instanceof RefreshCooldownError || err instanceof NotRefreshableError || (err as { name?: string } | null)?.name === "SwapLockError";
    record(identity, credential ? "credential_error" : "upstream_error", 502, undefined, false, undefined, model);
    return providerError(style, 502, credential ? "upstream credential unavailable" : "upstream request failed");
  }

  // The upstream has answered: no replay is possible or needed any more, so the request bytes can go.
  body = { kind: "none" };
  releaseBody?.();
  const headers = new Headers(up.headers);
  headers.delete(SUBSCRIPTION_EXHAUSTED_HEADER);
  stripHopByHop(headers);
  if (headers.has("content-encoding")) {
    headers.delete("content-encoding");
    headers.delete("content-length");
  }
  const contentType = up.headers.get("content-type") ?? "";
  const tap = new UsageTap(adapter.usageStyle(style), contentType);
  const httpStatus = up.status;
  const okStatus = httpStatus >= 400 ? "upstream_error" : "ok";
  const finish = (status: string): void => {
    req.signal.removeEventListener("abort", onAbort);
    const counts = tap.result();
    record(identity, status, httpStatus, counts, tap.isSse(), tap.status(), model);
  };

  if (!up.body) {
    finish(okStatus);
    return new Response(null, { status: httpStatus, statusText: up.statusText, headers });
  }
  const reader = up.body.getReader();
  const out = new ReadableStream<Uint8Array>({
    async pull(c) {
      try {
        const r = await reader.read();
        if (r.done) {
          finish(okStatus);
          c.close();
          return;
        }
        tap.write(r.value);
        c.enqueue(r.value);
      } catch {
        finish(ctrl.signal.aborted ? "client_aborted" : "stream_error");
        try {
          c.error(new Error("upstream stream failed"));
        } catch {
          // already closed
        }
      }
    },
    cancel() {
      ctrl.abort();
      finish("client_aborted");
      return reader.cancel().catch(() => undefined);
    },
  });
  // A client that vanishes before pulling again: the request signal ends the upstream read.
  req.signal.addEventListener("abort", () => finish("client_aborted"), { once: true });
  return new Response(out, { status: httpStatus, statusText: up.statusText, headers });
  }
}

interface Hold {
  kind: "burst" | "cred";
  /** Held for the long credential period and released early when the credential signature changes. */
  long: boolean;
  sig?: string | undefined;
  /** Client message for a credential hold. */
  message?: string;
}

const CREDENTIAL_HOLD_MS = 10 * 60_000;

function isCredentialFailure(err: unknown): boolean {
  return err instanceof GatewayCredentialError || err instanceof RefreshCooldownError || err instanceof NotRefreshableError || (err as { name?: string } | null)?.name === "SwapLockError";
}

async function credentialSignature(deps: GatewayDeps, provider: GatewayProvider, name: string): Promise<string | undefined> {
  try {
    return await deps.creds.signature?.(provider, name);
  } catch {
    return undefined;
  }
}

const BURST_HOLD_DEFAULT_MS = 15_000;
/** Longest a request waits in total for short member holds to end before the client gets the 429. */
const SHORT_HOLD_WAIT_BUDGET_MS = 90_000;
const SHORT_HOLD_MAX_WAITS = 8;
const SHORT_HOLD_MIN_SLEEP_MS = 250;
const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
const BURST_HOLD_MAX_MS = 60_000;
/** Internal marker set on a 429 whose body proved Codex subscription exhaustion; stripped before the client sees it. */
const SUBSCRIPTION_EXHAUSTED_HEADER = "x-ais-subscription-exhausted";

/** True when a 429 proves subscription exhaustion (unified status or a 5h/7d window `rejected`, or Codex `usage_limit_reached`), not a transient rate limit. */
export function provesSubscriptionExhaustion(headers: Headers): boolean {
  if (headers.get(SUBSCRIPTION_EXHAUSTED_HEADER) === "1") return true;
  for (const k of ["status", "5h-status", "7d-status"]) if (headers.get(`anthropic-ratelimit-unified-${k}`)?.trim().toLowerCase() === "rejected") return true;
  return false;
}

/** Separates a member from the model its hold is scoped to, inside an `exhausted` key. */
const MODEL_HOLD_SEP = "\u0000model\u0000";
const ACCOUNT_WINDOW_STATUS = /^anthropic-ratelimit-unified-(5h|7d)-status$/;
const SCOPED_WINDOW_STATUS = /^anthropic-ratelimit-unified-([a-z0-9]+_[a-z0-9_]+)-status$/;

/**
 * True when a 429 rejects one model-scoped window only (for example `7d_oi`, a model's own weekly limit), while the
 * account-wide 5h and 7d windows still allow: the account is out of that model, not out of capacity. Observed live:
 * a Fable request on an account at 100% of its Fable weekly answered `7d-status: allowed`, `7d_oi-status: rejected`,
 * `representative-claim: seven_day_overage_included`, and the same account served Opus normally.
 */
export function isModelScopedRejection(headers: Headers): boolean {
  if (headers.get(SUBSCRIPTION_EXHAUSTED_HEADER) === "1") return false;
  let scopedRejected = false;
  for (const [k, v] of headers) {
    const rejected = v.trim().toLowerCase() === "rejected";
    if (!rejected) continue;
    if (ACCOUNT_WINDOW_STATUS.test(k)) return false; // an account-wide window is full: the whole account is out
    if (SCOPED_WINDOW_STATUS.test(k)) scopedRejected = true;
  }
  return scopedRejected;
}

/** Epoch ms until which a member that answered a burst 429 is held back: its retry-after (seconds or HTTP date), capped at 60 s, default 15 s. */
export function burstHoldUntil(headers: Headers, nowMs: number): number {
  const retry = headers.get("retry-after");
  let ms = BURST_HOLD_DEFAULT_MS;
  if (retry !== null && retry.trim() !== "") {
    const secs = Number(retry);
    if (Number.isFinite(secs) && secs >= 0) ms = secs * 1000;
    else if (Number.isFinite(Date.parse(retry))) ms = Math.max(0, Date.parse(retry) - nowMs);
  }
  return nowMs + Math.min(ms, BURST_HOLD_MAX_MS);
}

/**
 * Epoch ms until which a member stays held for one model after a model-scoped 429: the rejected scoped window's own
 * reset header (for example `anthropic-ratelimit-unified-7d_oi-reset`), else the general reset (exhaustedUntil).
 */
export function scopedResetUntil(headers: Headers, nowMs: number): number {
  const resets: number[] = [];
  for (const [k, v] of headers) {
    const m = SCOPED_WINDOW_STATUS.exec(k);
    if (!m || v.trim().toLowerCase() !== "rejected") continue;
    const raw = headers.get(`anthropic-ratelimit-unified-${m[1]}-reset`) ?? "";
    const n = Number(raw);
    const at = raw.trim() !== "" && Number.isFinite(n) && n > 0 ? (n < 1e11 ? n * 1000 : n) : Date.parse(raw);
    if (Number.isFinite(at) && at > nowMs && at <= nowMs + EXHAUSTED_MAX_MS) resets.push(at);
  }
  return resets.length > 0 ? Math.max(...resets) : exhaustedUntil(headers, nowMs);
}

const EXHAUSTED_DEFAULT_MS = 5 * 60_000;
const EXHAUSTED_MAX_MS = 7 * 24 * 3_600_000;

/** Epoch ms until which a member that answered a quota error counts as exhausted: its reset header, else five minutes. */
export function exhaustedUntil(headers: Headers, nowMs: number): number {
  const candidates: number[] = [];
  const unified = Number(headers.get("anthropic-ratelimit-unified-reset") ?? "");
  const iso = Date.parse(headers.get("anthropic-ratelimit-unified-reset") ?? "");
  if (Number.isFinite(unified) && unified > 0) candidates.push(unified < 1e11 ? unified * 1000 : unified);
  else if (Number.isFinite(iso)) candidates.push(iso);
  const retry = headers.get("retry-after");
  if (retry !== null) {
    const secs = Number(retry);
    if (retry.trim() !== "" && Number.isFinite(secs) && secs >= 0) candidates.push(nowMs + secs * 1000);
    else if (Number.isFinite(Date.parse(retry))) candidates.push(Date.parse(retry));
  }
  const valid = candidates.filter((t) => t > nowMs && t <= nowMs + EXHAUSTED_MAX_MS);
  return valid.length > 0 ? Math.max(...valid) : nowMs + EXHAUSTED_DEFAULT_MS;
}

/**
 * Encoded slashes, backslashes and dots are refused, with one exception: `%2F` in the id of an OpenAI-style
 * `[/v1]/models/<id>` route (model ids such as `org/model`). The id is split on `%2F` and no piece may be empty, `.` or `..`.
 */
function pathAllowed(rest: string, style: ApiStyle): boolean {
  const m = style === "openai" ? /^(?:\/v1)?\/models\/([^/]+)$/.exec(rest) : null;
  if (m) {
    const id = m[1] as string;
    if (/%5c|%2e/i.test(id)) return false;
    return id.split(/%2f/i).every((piece) => piece !== "" && piece !== "." && piece !== "..");
  }
  return !/%2f|%5c|%2e/i.test(rest);
}

function decodeSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return "";
  }
}
