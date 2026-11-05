import { loadIdentitiesFile } from "../identities/store.ts";
import { CLAUDE_CONFIG, CODEX_CONFIG } from "../identities/tool-configs.ts";
import { isRetired } from "../identities/retired.ts";
import { allowedAccounts, requirePool, findPool } from "../identities/pool/swap-pool.ts";
import { findIdentityByNameOrAlias } from "../identities/store.ts";
import { ERROR_PEEK_BYTES, isQuotaBody, peek, readBody, stripHopByHop, upstreamHeaders, type Body } from "./app.ts";
import { GatewayCredentialError, NotRefreshableError, RefreshCooldownError, type CredentialCache } from "./credentials.ts";
import { providerError } from "./errors.ts";
import { adapterFor } from "./providers/index.ts";
import type { ApiStyle, GatewayProvider } from "./types.ts";

export const LOCAL_GATEWAY_DEFAULT_PORT = 47140;
export const LOCAL_FIRST_BYTE_MS = 5_000;
export const LOCAL_BREAKER_MS = 30_000;
export const LOCAL_STATUS_PATH = "/__ais/status";

const MODEL_NOT_FOUND = /"code"\s*:\s*"model_not_found"/;

type Tool = "claude" | "codex";

const ROUTES: Record<string, { tool: Tool; app: string; style: ApiStyle }> = {
  claude: { tool: "claude", app: "agents-claude", style: "anthropic" },
  codex: { tool: "codex", app: "agents-codex", style: "openai" },
};

export interface LocalGatewayDeps {
  /** Cluster gateway origin, no trailing path. */
  remoteBase: string;
  fetch: typeof fetch;
  /** Clock in ms (injected in tests). */
  now(): number;
  creds: Pick<CredentialCache, "get" | "refreshAfter401">;
  /** Pool members for the direct path, the active one first. */
  members(tool: Tool): Promise<string[]>;
  /** One line per state change; never carries tokens or bodies. */
  log(line: string): void;
  firstByteMs?: number;
  breakerMs?: number;
}

export interface LocalGatewayStatus {
  mode: "remote" | "direct";
  sinceMs: number;
  /** Epoch ms when the next remote probe is allowed; only set in direct mode. */
  probeAtMs?: number;
  remote: string;
}

export interface LocalGateway {
  handle(req: Request): Promise<Response>;
  status(): LocalGatewayStatus;
}

class RemoteFailure extends Error {
  constructor(readonly reason: string, readonly response?: Response) {
    super(reason);
  }
}

async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // already closed
  }
}

export function createLocalGateway(deps: LocalGatewayDeps): LocalGateway {
  const firstByteMs = deps.firstByteMs ?? LOCAL_FIRST_BYTE_MS;
  const breakerMs = deps.breakerMs ?? LOCAL_BREAKER_MS;
  const remoteBase = deps.remoteBase.replace(/\/+$/, "");
  let mode: "remote" | "direct" = "remote";
  let since = deps.now();
  let probeAt = 0;
  let probing = false;

  const setMode = (next: "remote" | "direct", reason: string): void => {
    if (mode === next) return;
    mode = next;
    since = deps.now();
    deps.log(`gateway-local: ${next === "direct" ? "remote -> direct" : "direct -> remote"} (${reason})`);
  };
  const remoteFailed = (reason: string): void => {
    probing = false;
    probeAt = deps.now() + breakerMs;
    setMode("direct", reason);
  };
  /** Only the probe may close the breaker: a slow request that began before it opened and answers late proves nothing. */
  const remoteOk = (wasProbe: boolean): void => {
    if (!wasProbe) return;
    probing = false;
    setMode("remote", "remote answered");
  };

  const status = (): LocalGatewayStatus => ({ mode, sinceMs: since, ...(mode === "direct" ? { probeAtMs: probeAt } : {}), remote: remoteBase });

  /** The remote answer, or a RemoteFailure for a pre-byte failure (the response rides along for pass-through). */
  async function tryRemote(req: Request, url: URL, app: string, rest: string, body: Body, signal: AbortSignal): Promise<Response> {
    const headers = new Headers(req.headers);
    stripHopByHop(headers);
    headers.delete("host");
    headers.delete("content-length");
    headers.set("accept-encoding", "identity");
    const init: RequestInit & { duplex?: "half" } = { method: req.method, headers, redirect: "manual" };
    if (body.kind === "buffered" && body.bytes.length > 0) init.body = body.bytes;
    else if (body.kind === "stream") {
      init.body = body.stream;
      init.duplex = "half";
    }
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, firstByteMs);
    const onAbort = (): void => ctrl.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    init.signal = ctrl.signal;
    let res: Response;
    try {
      res = await deps.fetch(`${remoteBase}/${app}${rest}${url.search}`, init);
    } catch (err) {
      if (signal.aborted) throw err;
      throw new RemoteFailure(timedOut ? "timeout" : "unreachable");
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
    // Headers are the first byte. Only the gateway-is-down statuses count.
    if (res.status === 502 || res.status === 503 || res.status === 504) throw new RemoteFailure(`http-${res.status}`, res);
    return res;
  }

  async function direct(req: Request, url: URL, tool: Tool, style: ApiStyle, rest: string, body: Body, signal: AbortSignal): Promise<Response> {
    const provider: GatewayProvider = tool;
    const adapter = adapterFor(provider);
    const upstreamUrl = adapter.upstreamBase(style) + rest + url.search;
    const replayable = body.kind !== "stream";
    const send = (cred: Awaited<ReturnType<typeof deps.creds.get>>): Promise<Response> => {
      const init: RequestInit & { duplex?: "half" } = { method: req.method, headers: upstreamHeaders(adapter, cred, req.headers), signal, redirect: "manual" };
      if (body.kind === "buffered" && body.bytes.length > 0) init.body = body.bytes;
      else if (body.kind === "stream") {
        init.body = body.stream;
        init.duplex = "half";
      }
      return deps.fetch(upstreamUrl, init);
    };
    const attempt = async (identity: string): Promise<Response> => {
      let cred = await deps.creds.get(provider, identity);
      // An access token already past its expiry is refreshed (AIS's locked refresh) before the first send.
      if (cred.expiresAtMs !== undefined && cred.expiresAtMs <= deps.now() + 30_000 && adapter.refreshable) {
        try {
          cred = await deps.creds.refreshAfter401(provider, identity, cred.accessToken);
        } catch (err) {
          if (err instanceof GatewayCredentialError && err.loggedOut) throw err;
          // Anything else: the old token may still work, and a 401 refresh below gets another go.
        }
      }
      let res = await send(cred);
      if (res.status === 401 && adapter.refreshable && replayable) {
        try {
          cred = await deps.creds.refreshAfter401(provider, identity, cred.accessToken);
        } catch (err) {
          if (err instanceof RefreshCooldownError || err instanceof NotRefreshableError) return res;
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
      if (res.status !== 403 && res.status !== 400 && res.status !== 404) return { quota: false, res };
      const p = await peek(res, ERROR_PEEK_BYTES);
      // A login whose plan lacks the model ("model_not_found") cannot serve the request either: the next member may.
      const unusable = res.status === 403 ? isQuotaBody(p.bytes) : MODEL_NOT_FOUND.test(new TextDecoder().decode(p.bytes));
      return { quota: p.whole && unusable, res: p.res };
    };

    let names: string[];
    try {
      names = await deps.members(tool);
    } catch {
      names = [];
    }
    if (names.length === 0) return providerError(style, 502, "no local login available for direct mode");
    try {
      let up: Response;
      try {
        up = await attempt(names[0] as string);
      } catch (err) {
        // A logged-out first member: the next one gets the request (its own error stands if it fails too).
        if (!(err instanceof GatewayCredentialError && err.loggedOut) || names.length < 2) throw err;
        up = await attempt(names[1] as string);
        return clean(up);
      }
      if (replayable && names.length > 1) {
        const q = await isQuota(up);
        up = q.res;
        if (q.quota) {
          try {
            const second = await attempt(names[1] as string);
            await discard(up);
            up = second;
          } catch {
            if (signal.aborted) throw new DOMException("aborted", "AbortError");
            // The second member could not be tried: the client gets the first answer.
          }
        }
      }
      return clean(up);
    } catch (err) {
      if (signal.aborted) return new Response(null, { status: 499 });
      if (err instanceof GatewayCredentialError) {
        deps.log(`gateway-local: direct ${tool} credential problem (${err.code})`);
        return providerError(style, err.loggedOut ? 401 : 502, err.clientMessage);
      }
      return providerError(style, 502, "direct upstream request failed");
    }
  }

  /** Response headers fit for the client: hop-by-hop removed, decoded bodies lose their encoding header. */
  function clean(up: Response): Response {
    const headers = new Headers(up.headers);
    stripHopByHop(headers);
    if (headers.has("content-encoding")) {
      headers.delete("content-encoding");
      headers.delete("content-length");
    }
    return new Response(up.body, { status: up.status, statusText: up.statusText, headers });
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === LOCAL_STATUS_PATH) return Response.json(status());
    const slash = url.pathname.indexOf("/", 1);
    const first = url.pathname.slice(1, slash === -1 ? undefined : slash);
    const route = ROUTES[first];
    if (!route) return providerError("openai", 404, "not found");
    const rest = slash === -1 ? "" : url.pathname.slice(slash);
    const { tool, app, style } = route;

    let body: Body;
    try {
      body = await readBody(req);
    } catch {
      return req.signal.aborted ? new Response(null, { status: 499 }) : providerError(style, 400, "request body could not be read");
    }
    const replayable = body.kind !== "stream";

    let useRemote = mode === "remote";
    let isProbe = false;
    if (!useRemote && replayable && deps.now() >= probeAt && !probing) {
      probing = true;
      isProbe = true;
      useRemote = true;
    } else if (!useRemote && !replayable) {
      useRemote = true; // Too big to replay: remote only, its answer passes through.
    }

    if (useRemote) {
      try {
        const res = await tryRemote(req, url, app, rest, body, req.signal);
        remoteOk(isProbe || (!replayable && mode === "direct"));
        return clean(res);
      } catch (err) {
        if (!(err instanceof RemoteFailure)) {
          if (isProbe) probing = false;
          return new Response(null, { status: 499 });
        }
        if (mode === "direct" && !isProbe && replayable) {
          // Began before the breaker opened: it is already open, nothing to change.
        } else remoteFailed(err.reason);
        if (!replayable) return err.response ? clean(err.response) : providerError(style, 502, "cluster gateway unreachable");
        if (err.response) await discard(err.response);
      }
    }
    return direct(req, url, tool, style, rest, body, req.signal);
  }

  return { handle, status };
}

/** Pool members of `tool` for the direct path, the pool's active member first. Honours AIS_GATEWAY_LOCAL_<TOOL>_POOL. */
export async function defaultLocalMembers(tool: Tool): Promise<string[]> {
  const cfg = tool === "claude" ? CLAUDE_CONFIG : CODEX_CONFIG;
  const file = await loadIdentitiesFile(cfg.identitiesJsonPath);
  const named = process.env[`AIS_GATEWAY_LOCAL_${tool.toUpperCase()}_POOL`];
  const pool = named ? findPool(file, named) : requirePool(file, undefined, tool);
  if (!pool) return [];
  const live = allowedAccounts(pool).filter((n) => {
    const m = findIdentityByNameOrAlias(file.identities, n);
    return m !== undefined && !isRetired(m);
  });
  const active = pool.swapPool.active;
  return active && live.includes(active) ? [active, ...live.filter((n) => n !== active)] : live;
}

export interface StartLocalOptions {
  port?: number;
  remoteBase?: string;
  log?: (line: string) => void;
  /** Test hooks. */
  fetch?: typeof fetch;
  now?: () => number;
  creds?: LocalGatewayDeps["creds"];
  members?: LocalGatewayDeps["members"];
  firstByteMs?: number;
  breakerMs?: number;
}

/** Starts the loopback-only listener. It never binds anything but 127.0.0.1. */
export async function startLocalGateway(opts: StartLocalOptions = {}): Promise<{ host: string; port: number; gateway: LocalGateway; stop(): void }> {
  const { CredentialCache } = await import("./credentials.ts");
  const gateway = createLocalGateway({
    remoteBase: opts.remoteBase ?? "",
    fetch: opts.fetch ?? fetch,
    now: opts.now ?? Date.now,
    creds: opts.creds ?? new CredentialCache(),
    members: opts.members ?? defaultLocalMembers,
    log: opts.log ?? ((line) => console.info(line)),
    ...(opts.firstByteMs !== undefined ? { firstByteMs: opts.firstByteMs } : {}),
    ...(opts.breakerMs !== undefined ? { breakerMs: opts.breakerMs } : {}),
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? LOCAL_GATEWAY_DEFAULT_PORT,
    idleTimeout: 0,
    fetch: (req) => gateway.handle(req).catch(() => providerError("openai", 500, "gateway error")),
  });
  return { host: server.hostname as string, port: server.port as number, gateway, stop: () => void server.stop(true) };
}
