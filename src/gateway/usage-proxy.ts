import { readFile, stat, writeFile, rename } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";
import { collapseSlashes } from "./routes.ts";
import { GATEWAY_TOKEN_PREFIX } from "../identities/claude-gateway-entry.ts";

/**
 * The gateway's CONNECT proxy, for gateway-routed Claude Code (clients set HTTPS_PROXY and NODE_EXTRA_CA_CERTS).
 *
 * Claude Code asks for its limits at a fixed host (`https://api.anthropic.com/api/oauth/usage`), never at
 * ANTHROPIC_BASE_URL, so with a gateway login it gets a refusal and shows no limits. This proxy:
 * - tunnels every CONNECT untouched (plain TCP pipe, no TLS termination), except
 * - CONNECT to api.anthropic.com:443, whose TLS it terminates with the certificate the cluster issues for that name
 *   (cert-manager, mounted as `tls.crt`/`tls.key`/`ca.crt`; the proxy makes no certificates). On that connection
 *   `GET /api/oauth/usage` and `GET /api/oauth/profile` with a gateway app token are answered by the gateway itself
 *   (the app's served route). A gateway token the gateway does not accept is answered 401 and never sent on. Every
 *   other request is forwarded to the real host unchanged (headers, body, compressed answer).
 * No pool member login is ever read or sent here.
 */
export const INTERCEPTED_HOST = "api.anthropic.com";
const SERVED_PATHS = new Set(["/api/oauth/usage", "/api/oauth/profile"]);
const MAX_HEAD = 16 * 1024;
const HEAD_TIMEOUT_MS = 30_000;
/** How often the mounted certificate is checked for a renewal. */
const TLS_RECHECK_MS = 5 * 60_000;

export interface UsageProxyOptions {
  port: number;
  host?: string;
  /** Directory holding `tls.crt`, `tls.key` and (optionally) `ca.crt`: a cert-manager secret mount. */
  tlsDir: string;
  /** Where to copy `ca.crt` for clients (NODE_EXTRA_CA_CERTS), if anywhere. */
  publishCaTo?: string;
  /** The app a gateway token belongs to (an active app whose token verifies), else undefined. */
  appForToken(token: string): Promise<string | undefined>;
  /** Answers a served path for an app (the gateway's own handler; the request carries the same token). */
  serve(app: string, path: string, req: Request): Promise<Response>;
  fetch?: typeof fetch;
  /** Where intercepted requests that are not served go (tests point it elsewhere). */
  passthroughOrigin?: string;
  /** Test hook: where a plain CONNECT goes instead of the requested host:port. */
  connectTarget?(host: string, port: number): { host: string; port: number };
  log?(line: string): void;
  tlsRecheckMs?: number;
}

export interface RunningUsageProxy {
  port: number;
  /** Stops listening; `force` also ends open intercepted connections (plain tunnels end with their sockets). */
  stop(force?: boolean): Promise<void>;
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
  const origin = (opts.passthroughOrigin ?? `https://${INTERCEPTED_HOST}`).replace(/\/+$/, "");

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = collapseSlashes(url.pathname);
    const token = bearerOf(req.headers);
    if (req.method === "GET" && SERVED_PATHS.has(path) && token?.startsWith(GATEWAY_TOKEN_PREFIX)) {
      const app = await opts.appForToken(token).catch(() => undefined);
      // A gateway token is never handed to the real host, known or not.
      if (!app) return Response.json({ type: "error", error: { type: "authentication_error", message: "invalid AIS gateway token" } }, { status: 401 });
      const res = await opts.serve(app, path, req).catch(() => Response.json({ type: "error", error: { type: "api_error", message: "gateway error" } }, { status: 502 }));
      log(`gateway: connect-proxy ${path} for app ${app}: ${res.status}`);
      return res;
    }
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

  // The TLS end of intercepted tunnels: loopback only. A renewed certificate starts a new one; the old one drains.
  const startTls = (t: { cert: string; key: string }): ReturnType<typeof Bun.serve> =>
    Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, tls: { cert: t.cert, key: t.key }, fetch: handle });
  let tls = await readTls(opts.tlsDir);
  await publish(tls.ca, opts.publishCaTo).catch((err: Error) => log(`gateway: connect-proxy could not publish ca.crt (${err.message})`));
  let tlsServer = startTls(tls);
  const recheck = setInterval(() => {
    void (async () => {
      const st = await stat(join(opts.tlsDir, "tls.crt")).catch(() => undefined);
      if (!st || st.mtimeMs === tls.mtime) return;
      const next = await readTls(opts.tlsDir);
      const old = tlsServer;
      tlsServer = startTls(next);
      tls = next;
      void old.stop(false);
      await publish(next.ca, opts.publishCaTo).catch(() => undefined);
      log("gateway: connect-proxy loaded a renewed certificate");
    })().catch((err: Error) => log(`gateway: connect-proxy certificate reload failed (${err.message})`));
  }, opts.tlsRecheckMs ?? TLS_RECHECK_MS);
  recheck.unref?.();

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
      const target = intercept ? { host: "127.0.0.1", port: tlsServer.port as number } : (opts.connectTarget?.(host, port) ?? { host, port });
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
    server.listen({ host: opts.host ?? "0.0.0.0", port: opts.port }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    port: (server.address() as net.AddressInfo).port,
    stop: async (force = true) => {
      clearInterval(recheck);
      server.close();
      await tlsServer.stop(force);
    },
  };
}
