import { createHash, timingSafeEqual } from "node:crypto";
import net from "node:net";
import { stripHopByHop } from "./app.ts";
import { collapseSlashes } from "./routes.ts";
import { GATEWAY_TOKEN_PREFIX } from "../identities/claude-gateway-entry.ts";
import { ensureLocalCa, issueLeaf, type LocalCa } from "./local-ca.ts";

/**
 * The usage proxy: an HTTP CONNECT proxy for gateway-routed Claude Code (HTTPS_PROXY plus NODE_EXTRA_CA_CERTS).
 *
 * Claude Code asks for its limits at a fixed host (`https://api.anthropic.com/api/oauth/usage`), never at
 * ANTHROPIC_BASE_URL, so with a gateway login it gets a refusal and shows no limits. This proxy:
 * - tunnels every CONNECT untouched (plain TCP pipe, no TLS termination), except
 * - CONNECT to api.anthropic.com:443, whose TLS it terminates with a certificate from the AIS local CA. On that
 *   connection `GET /api/oauth/usage` and `GET /api/oauth/profile` carrying a gateway app token (one of the
 *   AIS_GATEWAY_APP_*_TOKEN values in ~/.secrets) are answered by the cluster gateway's served route for that app,
 *   with that same token. Every other request (other paths, other methods, any other bearer) is forwarded to the real
 *   host byte for byte (headers, body, compressed answer). No pool member's login is ever read or sent here.
 */
export const USAGE_PROXY_DEFAULT_PORT = 47141;
export const INTERCEPTED_HOST = "api.anthropic.com";
const SERVED_PATHS = new Set(["/api/oauth/usage", "/api/oauth/profile"]);
const MAX_HEAD = 16 * 1024;
const REMOTE_TIMEOUT_MS = 15_000;
const HEAD_TIMEOUT_MS = 30_000;

export interface UsageProxyOptions {
  port?: number;
  /** Cluster gateway base (`https://host/gateway`); empty: usage requests with an app token answer 503. */
  remoteBase: string;
  /** The gateway app a bearer token belongs to, or undefined when it is not an app token. */
  appForToken(token: string): Promise<string | undefined>;
  ca?: LocalCa;
  caDir?: string;
  fetch?: typeof fetch;
  /** Where intercepted requests that are not served go (tests point it elsewhere). */
  passthroughOrigin?: string;
  /** Test hook: where a plain CONNECT goes instead of the requested host:port. */
  connectTarget?(host: string, port: number): { host: string; port: number };
  log?(line: string): void;
}

export interface RunningUsageProxy {
  port: number;
  caCertPath: string;
  /** Stops listening; `force` also ends open intercepted connections (plain tunnels end with their sockets). */
  stop(force?: boolean): void;
}

function bearerOf(headers: Headers): string | undefined {
  return /^bearer\s+(\S+)$/i.exec(headers.get("authorization")?.trim() ?? "")?.[1];
}

/** `appForToken` backed by the ~/.secrets app tokens (re-read at most every 5 s, so a rotation is picked up). */
export function secretsTokenResolver(read: () => Promise<Map<string, string>>, now: () => number = Date.now): (token: string) => Promise<string | undefined> {
  let cache: { at: number; entries: Array<{ app: string; digest: Buffer }> } | undefined;
  const digest = (s: string): Buffer => createHash("sha256").update(s).digest();
  return async (token) => {
    const given = digest(token);
    const hit = (): string | undefined => {
      let found: string | undefined;
      for (const e of cache?.entries ?? []) if (timingSafeEqual(e.digest, given)) found ??= e.app;
      return found;
    };
    // Re-read every 5 s, and on a miss once the copy is 1 s old (a token rotated a moment ago).
    if (cache && now() - cache.at < 5_000) {
      const found = hit();
      if (found || now() - cache.at < 1_000) return found;
    }
    const entries: Array<{ app: string; digest: Buffer }> = [];
    for (const [key, value] of await read().catch(() => new Map<string, string>())) {
      const m = /^AIS_GATEWAY_APP_([A-Z0-9_]+)_TOKEN$/.exec(key);
      if (m && value) entries.push({ app: m[1]!.toLowerCase().replace(/_/g, "-"), digest: digest(value) });
    }
    cache = { at: now(), entries };
    return hit();
  };
}

function hopClean(headers: Headers): Headers {
  const out = new Headers(headers);
  stripHopByHop(out);
  return out;
}

/** Starts the proxy on 127.0.0.1 (shared port, so two service slots can overlap during a restart). */
export async function startUsageProxy(opts: UsageProxyOptions): Promise<RunningUsageProxy> {
  const log = opts.log ?? ((line: string) => console.info(line));
  const doFetch = opts.fetch ?? fetch;
  const ca = opts.ca ?? (await ensureLocalCa(opts.caDir));
  const leaf = issueLeaf(ca, INTERCEPTED_HOST);
  const remoteBase = opts.remoteBase.replace(/\/+$/, "");
  const origin = (opts.passthroughOrigin ?? `https://${INTERCEPTED_HOST}`).replace(/\/+$/, "");

  async function served(req: Request, url: URL, path: string, token: string): Promise<Response | undefined> {
    const app = await opts.appForToken(token);
    if (!app) return undefined;
    if (!remoteBase) return Response.json({ type: "error", error: { type: "api_error", message: "AIS gateway URL not configured" } }, { status: 503 });
    const headers = new Headers({ authorization: `Bearer ${token}`, accept: "application/json" });
    for (const h of ["anthropic-beta", "anthropic-version", "user-agent"]) {
      const v = req.headers.get(h);
      if (v) headers.set(h, v);
    }
    try {
      const res = await doFetch(`${remoteBase}/${encodeURIComponent(app)}${path}${url.search}`, { headers, redirect: "manual", signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS) });
      const body = await res.arrayBuffer();
      log(`gateway-local: usage-proxy ${path} for app ${app}: ${res.status}`);
      return new Response(body, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json" } });
    } catch {
      log(`gateway-local: usage-proxy ${path} for app ${app}: gateway unreachable`);
      return Response.json({ type: "error", error: { type: "api_error", message: "AIS gateway unreachable" } }, { status: 502 });
    }
  }

  async function passthrough(req: Request, url: URL): Promise<Response> {
    const headers = hopClean(req.headers);
    headers.delete("host");
    const init: RequestInit & { duplex?: "half"; decompress?: boolean } = { method: req.method, headers, redirect: "manual", decompress: false };
    if (req.body && req.method !== "GET" && req.method !== "HEAD") {
      init.body = req.body;
      init.duplex = "half";
    }
    try {
      const res = await doFetch(`${origin}${url.pathname}${url.search}`, init);
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: hopClean(res.headers) });
    } catch {
      return new Response("bad gateway\n", { status: 502 });
    }
  }

  // The TLS end of intercepted tunnels: loopback only, on a port of its own choosing.
  const tlsServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    tls: { cert: leaf.certPem, key: leaf.keyPem },
    fetch: async (req) => {
      const url = new URL(req.url);
      const path = collapseSlashes(url.pathname);
      const token = bearerOf(req.headers);
      if (req.method === "GET" && SERVED_PATHS.has(path) && token) {
        const answer = await served(req, url, path, token);
        if (answer) return answer;
        // A gateway token the lookup does not know (rotated, ~/.secrets missing) is never handed to the real host.
        if (token.startsWith(GATEWAY_TOKEN_PREFIX)) return Response.json({ type: "error", error: { type: "authentication_error", message: "unknown AIS gateway token" } }, { status: 401 });
      }
      return passthrough(req, url);
    },
  });
  const tlsPort = tlsServer.port as number;

  const server = net.createServer((client) => {
    let head = Buffer.alloc(0);
    // The CONNECT head must arrive promptly; an open tunnel has no timeout.
    client.setTimeout(HEAD_TIMEOUT_MS, () => client.destroy());
    const fail = (status: string): void => {
      client.end(`HTTP/1.1 ${status}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`, () => client.destroy());
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
      if (!m) return fail("405 Method Not Allowed");
      const host = m[1]!.replace(/^\[|\]$/g, "").toLowerCase();
      const port = Number(m[2]);
      if (port < 1 || port > 65535) return fail("400 Bad Request");
      const intercept = host === INTERCEPTED_HOST && port === 443;
      const target = intercept ? { host: "127.0.0.1", port: tlsPort } : (opts.connectTarget?.(host, port) ?? { host, port });
      const upstream = net.connect(target.port, target.host);
      let open = false;
      upstream.once("connect", () => {
        open = true;
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
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.destroy());
    };
    client.on("data", onData);
    client.on("error", () => client.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: opts.port ?? USAGE_PROXY_DEFAULT_PORT, reusePort: true }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address() as net.AddressInfo;
  return {
    port: addr.port,
    caCertPath: ca.certPath,
    stop: (force = true) => {
      server.close();
      void tlsServer.stop(force);
    },
  };
}
