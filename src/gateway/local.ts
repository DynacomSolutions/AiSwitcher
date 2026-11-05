import { loadIdentitiesFile } from "../identities/store.ts";
import { CLAUDE_CONFIG, CODEX_CONFIG } from "../identities/tool-configs.ts";
import { isRetired } from "../identities/retired.ts";
import { allowedAccounts, requirePool, findPool } from "../identities/pool/swap-pool.ts";
import { findIdentityByNameOrAlias } from "../identities/store.ts";
import { createHash, timingSafeEqual } from "node:crypto";
import { ERROR_PEEK_BYTES, GATEWAY_MARK_HEADER, isQuotaBody, peek, readBody, stripHopByHop, upstreamHeaders, type Body } from "./app.ts";
import { GatewayCredentialError, loginCommand, NotRefreshableError, RefreshCooldownError, type CredentialCache } from "./credentials.ts";
import { providerError } from "./errors.ts";
import { adapterFor } from "./providers/index.ts";
import type { ApiStyle, GatewayProvider } from "./types.ts";

export const LOCAL_GATEWAY_DEFAULT_PORT = 47140;
/** Once the request is with the cluster gateway there is no replay; this is how long to wait for its answer. */
export const LOCAL_IDLE_MS = 10 * 60_000;
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
  idleMs?: number;
  breakerMs?: number;
  /** The local agent token for an app (the one the key helpers print). A client key that differs is refused. */
  clientToken(app: string): Promise<string | undefined>;
  /** Host header values accepted (host:port); anything else is refused with 403. */
  allowedHosts(): string[];
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

/** The cluster gateway took longer than the idle ceiling: reported to the client, never replayed. */
class RemoteIdle extends Error {}

/** The fetch failed in a way that does not prove the request never arrived (reset, closed, unknown): 502 to the client, no replay, breaker untouched. */
class RemoteOther extends Error {}

/** Error codes that can only happen before any request byte reaches the gateway: connect refused or unreachable, DNS, TLS handshake and certificate failures, connect timeout. */
const PRE_SEND_CODES = new Set([
  "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "ConnectionRefused", "ConnectionTimedOut",
  "EPROTO", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_UNTRUSTED", "ERR_SSL_WRONG_VERSION_NUMBER",
]);

export function isPreSendError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && PRE_SEND_CODES.has(code);
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
  const idleMs = deps.idleMs ?? LOCAL_IDLE_MS;
  const reportedLoggedOut = new Set<string>();
  const breakerMs = deps.breakerMs ?? LOCAL_BREAKER_MS;
  const remoteBase = deps.remoteBase.replace(/\/+$/, "");
  // No cluster gateway URL known: direct-only, never a crash loop.
  let mode: "remote" | "direct" = remoteBase === "" ? "direct" : "remote";
  let since = deps.now();
  let probeAt = 0;
  let probing = false;

  const setMode = (next: "remote" | "direct", reason: string): void => {
    if (mode === next) return;
    mode = next;
    since = deps.now();
    deps.log(`gateway-local: ${next === "direct" ? "remote -> direct" : "direct -> remote"} (${reason})`);
  };
  /** Opens the breaker. Only the probe resets the probing flag; a late failure from an older request changes nothing. */
  const remoteFailed = (reason: string, isProbe: boolean): void => {
    if (isProbe) probing = false;
    else if (mode === "direct") return;
    probeAt = deps.now() + breakerMs;
    setMode("direct", reason);
  };
  /** Only the probe may close the breaker: a slow request that began before it opened and answers late proves nothing. */
  const remoteOk = (isProbe: boolean): void => {
    if (!isProbe) return;
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
    let idled = false;
    // The only timer: a very long ceiling on the wait for the answer. Slowness before it never replays.
    const timer = setTimeout(() => {
      idled = true;
      ctrl.abort();
    }, idleMs);
    const onAbort = (): void => ctrl.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    init.signal = ctrl.signal;
    // Bun's own fetch timeout must not end a long wait before the ceiling.
    (init as { timeout?: boolean }).timeout = false;
    let res: Response;
    try {
      res = await deps.fetch(`${remoteBase}/${app}${rest}${url.search}`, init);
    } catch (err) {
      if (signal.aborted) throw err;
      if (idled) throw new RemoteIdle();
      if (isPreSendError(err)) throw new RemoteFailure("unreachable");
      throw new RemoteOther();
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
    // A 502/503/504 the gateway app did not mark came from an edge in front of it ("no healthy upstream"): it never served the request.
    if ((res.status === 502 || res.status === 503 || res.status === 504) && res.headers.get(GATEWAY_MARK_HEADER) !== "1") throw new RemoteFailure(`http-${res.status}`, res);
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
    let lastQuota: Response | undefined;
    let lastDead: GatewayCredentialError | undefined;
    try {
      for (const name of names) {
        let up: Response;
        try {
          up = await attempt(name);
          reportedLoggedOut.delete(name);
        } catch (err) {
          if (signal.aborted) throw err;
          if (!(err instanceof GatewayCredentialError && err.loggedOut)) throw err;
          lastDead = err;
          if (!reportedLoggedOut.has(name)) {
            reportedLoggedOut.add(name);
            deps.log(`gateway-local: ${tool} member "${name}" is logged out, skipped (ais: ${loginCommand(tool, name)})`);
          }
          continue;
        }
        if (!replayable) return clean(up);
        const q = await isQuota(up);
        if (!q.quota) {
          if (lastQuota) await discard(lastQuota);
          return clean(q.res);
        }
        // Quota or unusable for this model: remember the answer, try the next member.
        if (lastQuota) await discard(lastQuota);
        lastQuota = q.res;
      }
      if (lastQuota) return clean(lastQuota);
      if (lastDead) throw lastDead;
      return providerError(style, 502, "direct upstream request failed");
    } catch (err) {
      if (lastQuota) await discard(lastQuota);
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

  function admitted(req: Request, url: URL): Response | undefined {
    const host = (req.headers.get("host") ?? url.host).toLowerCase();
    if (!deps.allowedHosts().includes(host)) return new Response("forbidden\n", { status: 403 });
    return undefined;
  }

  async function authorised(req: Request, app: string): Promise<boolean> {
    // The same places Claude Code and Codex put the key the helpers print.
    const bearer = /^bearer\s+(\S+)$/i.exec(req.headers.get("authorization")?.trim() ?? "")?.[1];
    const given = bearer ?? req.headers.get("x-api-key")?.trim() ?? req.headers.get("api-key")?.trim();
    const expected = await deps.clientToken(app).catch(() => undefined);
    if (!given || !expected) return false;
    // Equal-length digests, compared in constant time.
    return timingSafeEqual(createHash("sha256").update(given).digest(), createHash("sha256").update(expected).digest());
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const refused = admitted(req, url);
    if (refused) return refused;
    if (url.pathname === LOCAL_STATUS_PATH) return Response.json(status());
    const slash = url.pathname.indexOf("/", 1);
    const first = url.pathname.slice(1, slash === -1 ? undefined : slash);
    const route = ROUTES[first];
    if (!route) return providerError("openai", 404, "not found");
    const rest = slash === -1 ? "" : url.pathname.slice(slash);
    const { tool, app, style } = route;
    if (!(await authorised(req, app))) return providerError(style, 401, "invalid or missing local gateway key");

    let body: Body;
    try {
      body = await readBody(req);
    } catch {
      return req.signal.aborted ? new Response(null, { status: 499 }) : providerError(style, 400, "request body could not be read");
    }
    const replayable = body.kind !== "stream";

    // A request too big to replay always goes to the remote (and only there); the breaker state is not its business.
    let isProbe = false;
    let useRemote = remoteBase !== "" && (mode === "remote" || !replayable);
    if (!useRemote && remoteBase !== "" && deps.now() >= probeAt && !probing) {
      probing = true;
      isProbe = true;
      useRemote = true;
    }

    if (useRemote) {
      try {
        const res = await tryRemote(req, url, app, rest, body, req.signal);
        remoteOk(isProbe);
        return clean(res);
      } catch (err) {
        if (isProbe) probing = false;
        if (err instanceof RemoteIdle) return providerError(style, 504, "cluster gateway did not answer in time");
        if (err instanceof RemoteOther) return providerError(style, 502, "cluster gateway connection failed");
        if (!(err instanceof RemoteFailure)) return new Response(null, { status: 499 });
        remoteFailed(err.reason, isProbe);
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
  idleMs?: number;
  breakerMs?: number;
  clientToken?: LocalGatewayDeps["clientToken"];
}

/** Starts the loopback-only listener. It never binds anything but 127.0.0.1. */
export async function startLocalGateway(opts: StartLocalOptions = {}): Promise<{ host: string; port: number; gateway: LocalGateway; stop(): void }> {
  const { CredentialCache } = await import("./credentials.ts");
  const { appTokenKey, readSecretsKey } = await import("../cli/gateway/secrets-file.ts");
  const now = opts.now ?? Date.now;
  // The same ~/.secrets keys the claude and codex key helpers print; re-read at most every 5 s so a rotation is picked up.
  const cached = new Map<string, { at: number; value: string | undefined }>();
  const clientToken = opts.clientToken ?? (async (app: string): Promise<string | undefined> => {
    const hit = cached.get(app);
    if (hit && now() - hit.at < 5_000) return hit.value;
    const value = await readSecretsKey(appTokenKey(app));
    cached.set(app, { at: now(), value });
    return value;
  });
  let boundPort = 0;
  const gateway = createLocalGateway({
    remoteBase: opts.remoteBase ?? "",
    clientToken,
    allowedHosts: () => [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`],
    fetch: opts.fetch ?? fetch,
    now,
    creds: opts.creds ?? new CredentialCache(),
    members: opts.members ?? defaultLocalMembers,
    log: opts.log ?? ((line) => console.info(line)),
    ...(opts.idleMs !== undefined ? { idleMs: opts.idleMs } : {}),
    ...(opts.breakerMs !== undefined ? { breakerMs: opts.breakerMs } : {}),
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? LOCAL_GATEWAY_DEFAULT_PORT,
    idleTimeout: 0,
    fetch: (req) => gateway.handle(req).catch(() => providerError("openai", 500, "gateway error")),
  });
  boundPort = server.port as number;
  return { host: server.hostname as string, port: server.port as number, gateway, stop: () => void server.stop(true) };
}
