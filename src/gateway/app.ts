import { Hono } from "hono";
import type { PoolUsage } from "../identities/pool/adapter.ts";
import { extractToken } from "./auth.ts";
import { checkCaps, dayStartIct } from "./caps.ts";
import { GatewayCredentialError, NotRefreshableError, RefreshCooldownError, type CredentialCache } from "./credentials.ts";
import { providerError } from "./errors.ts";
import type { LedgerBuffer } from "./ledger-buffer.ts";
import type { GatewayMetrics } from "./metrics.ts";
import { adapterFor } from "./providers/index.ts";
import type { ProviderCredential } from "./providers/index.ts";
import { pickIdentity } from "./select.ts";
import type { GatewayStore } from "./store.ts";
import { verifyToken } from "./tokens.ts";
import type { ApiStyle, GatewayApp, GatewayProvider, UsageRow } from "./types.ts";
import { estimateCost, UsageTap } from "./usage.ts";
import type { UsageCounts } from "./usage.ts";

export interface GatewayDeps {
  store: GatewayStore;
  ledger: LedgerBuffer;
  creds: Pick<CredentialCache, "get" | "refreshAfter401">;
  usageFor(provider: GatewayProvider, identity: string): Promise<PoolUsage | undefined>;
  poolMembers(provider: GatewayProvider): Promise<string[]>;
  fetch: typeof fetch;
  now(): Date;
  metrics: GatewayMetrics;
  /** One JSON line per request (app, provider, identity, status, tap status). Never carries tokens, bodies or query strings. Defaults to console.info. */
  log?: (line: string) => void;
}

/** Request bodies up to this size are buffered so they can be replayed (401 retry, failover). */
export const REPLAY_LIMIT_BYTES = 8 * 1024 * 1024;
/** Quota errors (403) are only inspected up to this size. */
const ERROR_PEEK_BYTES = 64 * 1024;

const HOP_BY_HOP = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "trailers", "transfer-encoding", "upgrade"];
const QUOTA_RE = /quota|insufficient|credit|billing|exceeded your/i;

type Body = { kind: "none" } | { kind: "buffered"; bytes: Uint8Array } | { kind: "stream"; stream: ReadableStream<Uint8Array> };

async function readBody(req: Request): Promise<Body> {
  if (!req.body) return { kind: "none" };
  const declared = Number(req.headers.get("content-length") ?? "");
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
  // Too big to replay: hand the buffered part and the rest on, byte for byte.
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
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
  return { kind: "stream", stream };
}

function requestModel(body: Body): string | undefined {
  if (body.kind !== "buffered" || body.bytes.length === 0 || body.bytes[0] !== 0x7b) return undefined; // only a JSON object has a model
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

export function createGatewayApp(deps: GatewayDeps): Hono {
  const hono = new Hono();
  const log = deps.log ?? defaultLog;
  const handle = (req: Request): Promise<Response> => proxy(req, deps, log).catch(() => providerError("openai", 500, "gateway error"));
  hono.all("/:app", (c) => handle(c.req.raw));
  hono.all("/:app/*", (c) => handle(c.req.raw));
  return hono;
}

async function proxy(req: Request, deps: GatewayDeps, log: (line: string) => void): Promise<Response> {
  const started = performance.now();
  const url = new URL(req.url);
  const slash = url.pathname.indexOf("/", 1);
  const appName = decodeSegment(url.pathname.slice(1, slash === -1 ? undefined : slash));
  const rest = slash === -1 ? "" : url.pathname.slice(slash);

  const app = appName ? await deps.store.getApp(appName) : undefined;
  if (!app) {
    deps.metrics.authFailure("unknown-app");
    return providerError(guessStyle(url.pathname), 404, "not found");
  }
  const style = app.style;
  const adapter = adapterFor(app.provider);

  const token = url.search.includes("aisg_") ? undefined : extractToken(req, app.name);
  if (!token || !(await verifyToken(deps.store, app.name, token, deps.now()))) {
    deps.metrics.authFailure("bad-token");
    return providerError(style, 401, "invalid or missing gateway token");
  }

  const identityForRow = app.target.kind === "pin" ? app.target.identity : "-";
  let recorded = false;
  const record = (identity: string, status: string, httpStatus: number, counts: UsageCounts | undefined, streamed: boolean, tap?: string, model?: string): void => {
    if (recorded) return;
    recorded = true;
    const latencyMs = Math.round(performance.now() - started);
    const c = counts ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const cost = counts ? estimateCost(app.provider, counts) : undefined;
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
      deps.metrics.request({ app: app.name, provider: app.provider, identity, status, httpStatus, latencyMs });
      log(JSON.stringify({ event: "request", app: app.name, provider: app.provider, identity, status, http: httpStatus, ...(tap ? { tap } : {}) }));
    } catch {
      // Observation must never affect the response.
    }
  };
  const reject = (status: number, message: string, identity = identityForRow, model?: string): Response => {
    record(identity, "rejected", status, undefined, false, undefined, model);
    return providerError(style, status, message);
  };

  const body = await readBody(req);
  const model = requestModel(body);
  if (app.models && app.models.length > 0 && body.kind === "stream") {
    return reject(413, "request too large to verify the model allowlist", identityForRow, model);
  }
  let used = 0;
  if (app.dailyTokens !== undefined) {
    try {
      used = await deps.store.usageSince(app.name, dayStartIct(deps.now()));
    } catch {
      used = 0; // Database lost after warm: keep serving.
    }
  }
  const caps = checkCaps(app, model, used);
  if (!("ok" in caps)) return reject(caps.status, caps.reason, identityForRow, model);

  const pick = await pickIdentity(app, deps);
  if ("reject" in pick) {
    return reject(429, pick.reject === "reserve" ? "identity is at its usage reserve" : "no pool member has headroom below the reserve", identityForRow, model);
  }

  const upstreamUrl = adapter.upstreamBase(style) + rest + url.search;
  const ctrl = new AbortController();
  const onAbort = (): void => ctrl.abort();
  req.signal.addEventListener("abort", onAbort, { once: true });
  const replayable = body.kind !== "stream";

  const send = (cred: ProviderCredential): Promise<Response> => {
    const headers = new Headers(req.headers);
    for (const h of [...HOP_BY_HOP, ...adapter.stripRequestHeaders, "host", "content-length", "accept-encoding"]) headers.delete(h);
    headers.set("accept-encoding", "identity");
    for (const [k, v] of Object.entries(adapter.authHeaders(cred, req.headers))) headers.set(k, v);
    const init: RequestInit & { duplex?: "half" } = { method: req.method, headers, signal: ctrl.signal, redirect: "manual" };
    if (body.kind === "buffered" && body.bytes.length > 0) init.body = body.bytes;
    else if (body.kind === "stream") {
      init.body = body.stream;
      init.duplex = "half";
    }
    return deps.fetch(upstreamUrl, init);
  };

  /** One attempt for `identity`, including at most one 401 refresh and retry. */
  const attempt = async (identity: string): Promise<Response> => {
    let cred = await deps.creds.get(app.provider, identity);
    let res = await send(cred);
    if (res.status === 401 && replayable && adapter.refreshable) {
      try {
        cred = await deps.creds.refreshAfter401(app.provider, identity, cred.accessToken);
      } catch (err) {
        if (err instanceof RefreshCooldownError || err instanceof NotRefreshableError) return res; // pass the upstream 401 through
        await discard(res);
        throw err;
      }
      await discard(res);
      res = await send(cred);
    }
    return res;
  };

  const isQuota = async (res: Response): Promise<{ quota: boolean; res: Response }> => {
    if (res.status === 429 || res.status === 402) return { quota: true, res };
    if (res.status !== 403) return { quota: false, res };
    const declared = Number(res.headers.get("content-length") ?? "");
    if (!res.body || (Number.isFinite(declared) && declared > ERROR_PEEK_BYTES)) return { quota: false, res };
    const bytes = new Uint8Array(await res.arrayBuffer());
    const copy = new Response(bytes, { status: res.status, statusText: res.statusText, headers: res.headers });
    return { quota: bytes.length <= ERROR_PEEK_BYTES && QUOTA_RE.test(new TextDecoder().decode(bytes)), res: copy };
  };

  let identity = pick.identity;
  let up: Response;
  try {
    up = await attempt(identity);
    if (app.target.kind === "pool" && replayable) {
      const q = await isQuota(up);
      up = q.res;
      if (q.quota) {
        const next = await pickIdentity(app, deps, identity);
        if ("identity" in next) {
          await discard(up);
          deps.metrics.failover(app.name);
          identity = next.identity;
          up = await attempt(identity);
        }
      }
    }
  } catch (err) {
    req.signal.removeEventListener("abort", onAbort);
    if (ctrl.signal.aborted) {
      record(identity, "client_aborted", 499, undefined, false, undefined, model);
      return new Response(null, { status: 499 });
    }
    if (err instanceof GatewayCredentialError) {
      record(identity, "credential_error", 502, undefined, false, undefined, model);
      return providerError(style, 502, `upstream credential unavailable (${err.code})`);
    }
    // Never echo the error: it may carry paths or provider text.
    const credential = err instanceof RefreshCooldownError || err instanceof NotRefreshableError || (err as { name?: string } | null)?.name === "SwapLockError";
    record(identity, credential ? "credential_error" : "upstream_error", 502, undefined, false, undefined, model);
    return providerError(style, 502, credential ? "upstream credential unavailable" : "upstream request failed");
  }

  const headers = new Headers(up.headers);
  for (const h of HOP_BY_HOP) headers.delete(h);
  if (headers.has("content-encoding")) {
    headers.delete("content-encoding");
    headers.delete("content-length");
  }
  const contentType = up.headers.get("content-type") ?? "";
  const streamed = contentType.toLowerCase().includes("text/event-stream");
  const tap = new UsageTap(adapter.usageStyle(style), contentType);
  const httpStatus = up.status;
  const okStatus = httpStatus >= 400 ? "upstream_error" : "ok";
  const finish = (status: string): void => {
    req.signal.removeEventListener("abort", onAbort);
    const counts = tap.result();
    record(identity, status, httpStatus, counts, streamed, tap.status(), model);
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

function decodeSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return "";
  }
}
