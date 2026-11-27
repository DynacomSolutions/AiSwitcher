import { readFile, stat, writeFile, rename } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import { queryCarriesToken } from "./app.ts";
import { GATEWAY_ERROR_HEADER, GATEWAY_MESSAGE_PREFIX } from "./errors.ts";
import { collapseSlashes } from "./routes.ts";
import type { ApiStyle, GatewayProvider } from "./types.ts";
import { GATEWAY_TOKEN_PREFIX } from "../identities/claude-gateway-entry.ts";

/**
 * The gateway's CONNECT proxy, for gateway-routed clients (they set HTTPS_PROXY and NODE_EXTRA_CA_CERTS).
 *
 * Some clients ask for their limits at a fixed host, never at their configurable base URL, so with a gateway login they
 * get a refusal and show no limits. This proxy:
 * - tunnels every CONNECT untouched (plain TCP pipe, no TLS termination), except
 * - CONNECT to one of three hosts on port 443 (INTERCEPTED_HOSTS), whose TLS it terminates with the certificate the
 *   cluster issues (cert-manager, mounted as `tls.crt`/`tls.key`/`ca.crt`; the proxy makes no certificates). A host is
 *   only intercepted when the loaded certificate covers its name. Otherwise it stays a plain tunnel, so a certificate
 *   that lags behind a rollout never breaks plain traffic.
 *   - api.anthropic.com (Claude Code): every request that carries a gateway app token (`aisg_...`), whatever its method
 *     or path, is handed to the gateway's own route for that claude app (`/<app>/<path>`): usage, profile, reset credits
 *     and the rest of Anthropic's account API, with the login of the member the app maps to. A kimi or zai app token
 *     (Claude Code on an Anthropic-style gateway app) may only `GET /api/oauth/usage` and `GET /api/oauth/profile`, which
 *     the gateway answers itself; any other request gets a JSON 404 and is never forwarded.
 *   - opencode.ai (opencode): only `GET /zen/go/v1/usage`, served as `/v1/usage` for an opencode app.
 *   - cli-chat-proxy.grok.com (grok): only `GET /v1/billing` (query kept), served for a grok app.
 *   On opencode.ai and cli-chat-proxy.grok.com a gateway token on any other method or path is answered 403 and never
 *   sent on. A gateway token that is not valid for the host's provider is answered 401 and never sent on.
 *   A request with any other bearer, or none, is forwarded to the real host unchanged (headers, body, compressed answer).
 *   A request for a host that is not intercepted is answered 421.
 * No pool member login is read or sent by this file; the gateway route adds it.
 */
export interface InterceptedHost {
  /** The providers whose app tokens are accepted on this host. */
  providers: GatewayProvider[];
  /** The gateway path to serve this request as, or undefined when a gateway token of that provider may not use it here. */
  servePath(method: string, path: string, provider: GatewayProvider): string | undefined;
}

/**
 * kimi and zai apps (Claude Code pointed at their Anthropic-style gateway apps) may only read limits and the account on
 * api.anthropic.com. Everything else is refused, never sent to Anthropic and never to the kimi or zai upstream.
 */
const LIMITS_ONLY = new Set(["/api/oauth/usage", "/api/oauth/profile"]);

export const INTERCEPTED_HOSTS: Readonly<Record<string, InterceptedHost>> = {
  "api.anthropic.com": {
    providers: ["claude", "kimi", "zai"],
    servePath: (method, path, provider) => (provider === "claude" || (method === "GET" && LIMITS_ONLY.has(path)) ? path : undefined),
  },
  "opencode.ai": { providers: ["opencode"], servePath: (method, path) => (method === "GET" && path === "/zen/go/v1/usage" ? "/v1/usage" : undefined) },
  "cli-chat-proxy.grok.com": { providers: ["grok"], servePath: (method, path) => (method === "GET" && path === "/v1/billing" ? "/v1/billing" : undefined) },
};
/** Why a plain HTTP request was refused: almost always a client with HTTPS_PROXY set and no NO_PROXY for its own (loopback) base URL. */
export const NOT_CONNECT_BODY =
  "ais gateway CONNECT proxy: only CONNECT tunnels are accepted here, and this was a plain HTTP request. " +
  "A client with HTTPS_PROXY set is sending a request through the proxy that should go direct: add its host to NO_PROXY " +
  "(for a loopback ANTHROPIC_BASE_URL such as the ais gateway local proxy: NO_PROXY=127.0.0.1,localhost,::1).\n";

const MAX_HEAD = 16 * 1024;
const HEAD_TIMEOUT_MS = 30_000;
/** A tunnel that moved no bytes for this long is idle, not in flight (see RunningUsageProxy.tunnels). */
export const TUNNEL_BUSY_MS = 5_000;
/** How often the mounted certificate is checked for a renewal. */
const TLS_RECHECK_MS = 5 * 60_000;

export interface UsageProxyOptions {
  port: number;
  host?: string;
  /** Directory holding `tls.crt`, `tls.key` and (optionally) `ca.crt`: a cert-manager secret mount. */
  tlsDir: string;
  /** Where to copy `ca.crt` for clients (NODE_EXTRA_CA_CERTS), if anywhere. */
  publishCaTo?: string;
  /** The app a gateway token belongs to (an active app of one of those providers whose token verifies), with its provider, else undefined. */
  appForToken(token: string, providers: GatewayProvider[]): Promise<{ name: string; provider: GatewayProvider; style: ApiStyle } | undefined>;
  /** Answers a request for an app (the gateway's own handler; the request carries the same token, method and body). */
  serve(app: string, path: string, req: Request): Promise<Response>;
  fetch?: typeof fetch;
  /** Where intercepted requests that are not served go (tests point it elsewhere). */
  passthroughOrigin?: string | ((host: string) => string);
  /** Test hook: where a plain CONNECT goes instead of the requested host:port. */
  connectTarget?(host: string, port: number): { host: string; port: number };
  /**
   * True for a CONNECT that is the gateway's own pod-local probe (its readiness and liveness checks tunnel to the proxy
   * port on loopback). Such a tunnel is not counted as client traffic and is still served while the proxy refuses new
   * tunnels, so a draining pod answers /healthz and /readyz to the kubelet until it exits.
   */
  isProbeTarget?(host: string, port: number): boolean;
  /** Tests: how long a silent tunnel counts as busy (default TUNNEL_BUSY_MS). */
  tunnelBusyMs?: number;
  log?(line: string): void;
  tlsRecheckMs?: number;
  /**
   * Called once when the listener is gone without a call to `stop`: a server error or an unexpected close. The caller
   * closes this proxy and starts a new one. Never called after `stop`.
   */
  onDown?(reason: string): void;
}

export interface RunningUsageProxy {
  port: number;
  /** Stops listening; `force` also ends open intercepted connections (plain tunnels end with their sockets). */
  stop(force?: boolean): Promise<void>;
  /**
   * Tunnels carrying client traffic (probe tunnels excluded): `open` is every one, `busy` those that moved bytes in the last
   * `TUNNEL_BUSY_MS`. `lastArrivalAt` is when the last client CONNECT arrived (ms since the epoch, 0 when none did). A drain
   * waits for `busy` to reach 0: a plain tunnel is a TCP pipe, so ending the process would cut it. A tunnel that stays
   * silent for longer is idle, and its client reconnects.
   */
  tunnels?(): { open: number; busy: number; lastArrivalAt: number };
  /**
   * From now on a client CONNECT is refused with 503 and `retry-after`, a status that clients retry on another replica.
   * Open tunnels and probe tunnels carry on. The listener stays open, so a drain can still be observed.
   */
  refuseNew?(): void;
}

const HOP_BY_HOP = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"];

function hopClean(headers: Headers): Headers {
  const out = new Headers(headers);
  for (const name of (out.get("connection") ?? "").split(",")) if (name.trim()) out.delete(name.trim());
  for (const h of HOP_BY_HOP) out.delete(h);
  return out;
}

function bearerOf(headers: Headers): string | undefined {
  return /^bearer\s+(\S+)$/i.exec(headers.get("authorization")?.trim() ?? "")?.[1];
}

/** The gateway token the request carries in any header the gateway accepts it in (Bearer, Basic password, x-api-key, api-key), else the bearer. */
function tokenOf(headers: Headers): string | undefined {
  const basic = /^basic\s+(\S+)$/i.exec(headers.get("authorization")?.trim() ?? "")?.[1];
  let basicPassword: string | undefined;
  if (basic) {
    try {
      const decoded = Buffer.from(basic, "base64").toString("utf8");
      basicPassword = decoded.slice(decoded.indexOf(":") + 1);
    } catch {
      basicPassword = undefined;
    }
  }
  const candidates = [bearerOf(headers), basicPassword, headers.get("x-api-key")?.trim(), headers.get("api-key")?.trim()];
  return candidates.find((c): c is string => c !== undefined && c.startsWith(GATEWAY_TOKEN_PREFIX)) ?? bearerOf(headers);
}

async function readTls(dir: string): Promise<{ cert: string; key: string; ca?: string; mtime: number }> {
  const [cert, key, st] = await Promise.all([readFile(join(dir, "tls.crt"), "utf8"), readFile(join(dir, "tls.key"), "utf8"), stat(join(dir, "tls.crt"))]);
  const ca = await readFile(join(dir, "ca.crt"), "utf8").catch(() => undefined);
  return { cert, key, ...(ca ? { ca } : {}), mtime: st.mtimeMs };
}

async function publish(ca: string | undefined, to: string | undefined): Promise<void> {
  if (!ca || !to) return;
  const current = await readFile(to, "utf8").catch(() => undefined);
  if (current === ca) return;
  const tmp = `${to}.${process.pid}.tmp`;
  await writeFile(tmp, ca, { mode: 0o644 });
  await rename(tmp, to);
}

/** Starts the proxy. Throws when the certificate cannot be read (the caller decides whether that is fatal). */
export async function startUsageProxy(opts: UsageProxyOptions): Promise<RunningUsageProxy> {
  const log = opts.log ?? ((line: string) => console.info(line));
  const doFetch = opts.fetch ?? fetch;
  const originFor = (host: string): string => {
    const o = typeof opts.passthroughOrigin === "function" ? opts.passthroughOrigin(host) : (opts.passthroughOrigin ?? `https://${host}`);
    return o.replace(/\/+$/, "");
  };
  const denied = (status: number, type: string, message: string, reason: string): Response => Response.json({ type: "error", error: { type, message: `${GATEWAY_MESSAGE_PREFIX}${message}` } }, { status, headers: { [GATEWAY_ERROR_HEADER]: reason } });

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const host = url.hostname.toLowerCase();
    const target = Object.hasOwn(INTERCEPTED_HOSTS, host) ? INTERCEPTED_HOSTS[host] : undefined;
    // Not one of ours: never forwarded.
    if (!target) return new Response(`${GATEWAY_MESSAGE_PREFIX}misdirected request, this host is not intercepted\n`, { status: 421, headers: { [GATEWAY_ERROR_HEADER]: "misdirected_host" } });
    const path = collapseSlashes(url.pathname);
    const token = tokenOf(req.headers);
    if (token?.startsWith(GATEWAY_TOKEN_PREFIX)) {
      // A gateway token is never handed to the real host, known or not.
      const app = await opts.appForToken(token, target.providers).catch(() => undefined);
      if (!app) return denied(401, "authentication_error", "invalid gateway token", "bad_token");
      const servePath = (app.provider === "kimi" || app.provider === "zai") && app.style !== "anthropic" ? undefined : target.servePath(req.method, path, app.provider);
      if (servePath === undefined) {
        // On api.anthropic.com a kimi or zai app gets an Anthropic-shaped 404; the other hosts keep their 403.
        return target.providers.length > 1 ? denied(404, "not_found_error", "this path is not served for a gateway token on this host", "path_not_served") : denied(403, "permission_error", "this request is not available with a gateway token", "path_not_served");
      }
      const res = await opts.serve(app.name, servePath, req).catch(() => Response.json({ type: "error", error: { type: "api_error", message: `${GATEWAY_MESSAGE_PREFIX}the gateway could not answer this request` } }, { status: 502, headers: { [GATEWAY_ERROR_HEADER]: "internal_error" } }));
      log(`gateway: connect-proxy ${host} ${req.method} ${servePath.split("/").slice(0, 3).join("/")} for app ${app.name}: ${res.status}`);
      return res;
    }
    // A gateway token in a place tokenOf did not read (query, extra text, doubled header) is never sent upstream.
    if (queryCarriesToken(url.search) || [...req.headers.values()].some((v) => v.toLowerCase().includes(GATEWAY_TOKEN_PREFIX))) {
      return denied(401, "authentication_error", "invalid gateway token", "bad_token");
    }
    const headers = hopClean(req.headers);
    headers.delete("host");
    const init: RequestInit & { duplex?: "half"; decompress?: boolean } = { method: req.method, headers, redirect: "manual", decompress: false };
    if (req.body && req.method !== "GET" && req.method !== "HEAD") {
      init.body = req.body;
      init.duplex = "half";
    }
    try {
      const res = await doFetch(`${originFor(host)}${url.pathname}${url.search}`, init);
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: hopClean(res.headers) });
    } catch {
      return new Response(`${GATEWAY_MESSAGE_PREFIX}could not reach the upstream host\n`, { status: 502, headers: { [GATEWAY_ERROR_HEADER]: "upstream_unreachable" } });
    }
  }

  // The TLS end of intercepted tunnels: loopback only. A renewed certificate starts a new one; the old one drains.
  const startTls = (t: { cert: string; key: string }): ReturnType<typeof Bun.serve> =>
    Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, tls: { cert: t.cert, key: t.key }, fetch: handle });
  let tls = await readTls(opts.tlsDir);
  await publish(tls.ca, opts.publishCaTo).catch((err: Error) => log(`gateway: connect-proxy could not publish ca.crt (${err.message})`));
  let tlsServer = startTls(tls);
  /** The intercepted hosts the loaded certificate covers; the rest stay plain tunnels. */
  const coveredHosts = (cert: string): Set<string> => {
    let x: X509Certificate | undefined;
    try {
      x = new X509Certificate(cert);
    } catch {
      return new Set();
    }
    return new Set(Object.keys(INTERCEPTED_HOSTS).filter((h) => x!.checkHost(h) !== undefined));
  };
  let covered = coveredHosts(tls.cert);
  const logCovered = (): void => log(`gateway: connect-proxy intercepts ${[...covered].join(", ") || "no host"} (certificate names)`);
  logCovered();
  /** Set by stop(): nothing may start after it (a certificate reload that finishes late starts no loopback TLS server). */
  let stopped = false;
  const recheck = setInterval(() => {
    void (async () => {
      const st = await stat(join(opts.tlsDir, "tls.crt")).catch(() => undefined);
      if (!st || st.mtimeMs === tls.mtime) return;
      const next = await readTls(opts.tlsDir);
      if (stopped) return;
      const old = tlsServer;
      tlsServer = startTls(next);
      tls = next;
      covered = coveredHosts(next.cert);
      void old.stop(false);
      await publish(next.ca, opts.publishCaTo).catch(() => undefined);
      log("gateway: connect-proxy loaded a renewed certificate");
      logCovered();
    })().catch((err: Error) => log(`gateway: connect-proxy certificate reload failed (${err.message})`));
  }, opts.tlsRecheckMs ?? TLS_RECHECK_MS);
  recheck.unref?.();

  /** Counted tunnels (client traffic, no probes) and the time each last moved bytes. */
  const tunnelActivity = new Map<net.Socket, number>();
  let lastArrivalAt = 0;
  let refusing = false;
  const server = net.createServer((client) => {
    let head = Buffer.alloc(0);
    // The CONNECT head must arrive promptly; an open tunnel has no timeout.
    client.setTimeout(HEAD_TIMEOUT_MS, () => client.destroy());
    const fail = (status: string, body = ""): void => {
      const extra = status.startsWith("405") ? "allow: CONNECT\r\ncontent-type: text/plain; charset=utf-8\r\n" : status.startsWith("503") ? "retry-after: 1\r\ncontent-type: text/plain; charset=utf-8\r\n" : body ? "content-type: text/plain; charset=utf-8\r\n" : "";
      client.end(`HTTP/1.1 ${status}\r\nconnection: close\r\n${extra}content-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, () => client.destroy());
    };
    const onData = (chunk: Buffer): void => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) {
        if (head.length > MAX_HEAD) {
          client.off("data", onData);
          fail("431 Request Header Fields Too Large");
        }
        return;
      }
      client.off("data", onData);
      client.setTimeout(0);
      client.pause();
      const rest = head.subarray(end + 4);
      const line = head.subarray(0, head.indexOf("\r\n")).toString("latin1");
      const m = /^CONNECT\s+(\[[^\]]+\]|[^\s:]+):(\d{1,5})\s+HTTP\/1\.[01]$/i.exec(line);
      if (!m) return fail("405 Method Not Allowed", NOT_CONNECT_BODY);
      const host = m[1]!.replace(/^\[|\]$/g, "").toLowerCase();
      const port = Number(m[2]);
      if (port < 1 || port > 65535) return fail("400 Bad Request");
      const probe = opts.isProbeTarget?.(host, port) === true;
      if (!probe) {
        lastArrivalAt = Date.now();
        // A draining gateway: the client retries on another replica (the Service no longer lists this pod).
        if (refusing) return fail("503 Service Unavailable", "ais gateway is draining; retry\n");
      }
      const intercept = port === 443 && covered.has(host);
      const target = intercept ? { host: "127.0.0.1", port: tlsServer.port as number } : (opts.connectTarget?.(host, port) ?? { host, port });
      const upstream = net.connect(target.port, target.host);
      let open = false;
      const uncount = (): void => void tunnelActivity.delete(client);
      const touch = (): void => {
        if (tunnelActivity.has(client)) tunnelActivity.set(client, Date.now());
      };
      upstream.once("connect", () => {
        open = true;
        if (!probe) {
          tunnelActivity.set(client, Date.now());
          client.on("data", touch);
          upstream.on("data", touch);
        }
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (rest.length > 0) upstream.write(rest);
        client.pipe(upstream);
        upstream.pipe(client);
        client.resume();
      });
      upstream.on("error", () => {
        if (!open) fail("502 Bad Gateway");
        else client.destroy();
      });
      client.on("error", () => upstream.destroy());
      client.on("close", () => {
        uncount();
        upstream.destroy();
      });
      upstream.on("close", () => {
        uncount();
        client.destroy();
      });
    };
    client.on("data", onData);
    client.on("error", () => client.destroy());
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: opts.host ?? "0.0.0.0", port: opts.port }, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (err) {
    // The port is held or refused: release the loopback TLS listener and the renewal timer, so a retry starts clean and leaks nothing.
    clearInterval(recheck);
    await tlsServer.stop(true).catch(() => undefined);
    throw err;
  }
  // An error or an unexpected close after the listener is up is logged and reported once, never thrown as an unhandled event that ends the process.
  let reportedDown = false;
  const down = (reason: string): void => {
    if (stopped || reportedDown) return;
    reportedDown = true;
    log(`gateway: connect-proxy listener down (${reason})`);
    opts.onDown?.(reason);
  };
  server.on("error", (err: Error) => down(err.message));
  server.on("close", () => down("closed"));
  return {
    port: (server.address() as net.AddressInfo).port,
    tunnels: () => {
      const t = Date.now();
      let busy = 0;
      for (const at of tunnelActivity.values()) if (t - at < (opts.tunnelBusyMs ?? TUNNEL_BUSY_MS)) busy += 1;
      return { open: tunnelActivity.size, busy, lastArrivalAt };
    },
    refuseNew: () => {
      refusing = true;
    },
    stop: async (force = true) => {
      stopped = true;
      clearInterval(recheck);
      try {
        server.close();
      } catch {
        // Already closed.
      }
      await tlsServer.stop(force);
    },
  };
}
