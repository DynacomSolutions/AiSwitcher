import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { startUsageProxy, type RunningUsageProxy } from "../../src/gateway/usage-proxy.ts";

const APP_TOKEN = "aisg_abcdefgh_" + "x".repeat(43);
const OTHER_BEARER = ["Bearer", "not-an-app-token"].join(" ");

let dir: string;
let tlsDir: string;
let narrowTlsDir: string;
const ca = { certPem: "" };

/** A CA and an api.anthropic.com leaf, as the cluster's cert-manager secret would hold them (tls.crt, tls.key, ca.crt). */
function makeTls(out: string, sans = "DNS:api.anthropic.com,DNS:opencode.ai,DNS:cli-chat-proxy.grok.com"): void {
  const run = (...args: string[]): void => {
    const r = Bun.spawnSync(["openssl", ...args], { cwd: out, stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`openssl ${args[0]}: ${r.stderr.toString()}`);
  };
  run("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "2", "-subj", "/CN=test ca", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign");
  run("req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "tls.key", "-out", "leaf.csr", "-subj", "/CN=api.anthropic.com");
  Bun.spawnSync(["sh", "-c", `printf 'subjectAltName=${sans}\\n' > ext`], { cwd: out });
  run("x509", "-req", "-in", "leaf.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-days", "2", "-extfile", "ext", "-out", "tls.crt");
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ais-usage-proxy-"));
  tlsDir = join(dir, "tls");
  await mkdir(tlsDir);
  makeTls(tlsDir);
  narrowTlsDir = join(dir, "tls-narrow");
  await mkdir(narrowTlsDir);
  makeTls(narrowTlsDir, "DNS:api.anthropic.com");
  ca.certPem = await readFile(join(tlsDir, "ca.crt"), "utf8");
});

const running: Array<{ stop(): void }> = [];
afterEach(() => {
  for (const r of running.splice(0)) r.stop();
});

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

function fakeFetch(calls: Call[], answer: (url: string) => Response = () => Response.json({ ok: true })): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? await new Response(init.body as ConstructorParameters<typeof Response>[0]).text() : "";
    calls.push({ url, method: init?.method ?? "GET", headers: new Headers(init?.headers), body });
    return answer(url);
  }) as typeof fetch;
}

async function proxy(calls: Call[], extra: Partial<Parameters<typeof startUsageProxy>[0]> = {}): Promise<RunningUsageProxy> {
  const p = await startUsageProxy({
    port: 0,
    host: "127.0.0.1",
    tlsDir,
    appForToken: async (t, providers) => (t === APP_TOKEN ? { name: `t3-${providers[0]}-x`, provider: providers[0]!, style: "anthropic" } : undefined),
    serve: async (app, path, req) => {
      calls.push({ url: `gateway:${app}${path}${new URL(req.url).search}`, method: req.method, headers: req.headers, body: "" });
      return Response.json({ seven_day: { utilization: 62 } });
    },
    fetch: fakeFetch(calls, () => new Response("upstream", { status: 401 })),
    passthroughOrigin: "https://upstream.test",
    log: () => {},
    ...extra,
  });
  running.push(p);
  return p;
}

/** Opens a CONNECT tunnel and returns the raw socket plus the proxy's status line. */
function connect(port: number, target: string): Promise<{ socket: net.Socket; status: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nhost: ${target}\r\n\r\n`));
    let buf = Buffer.alloc(0);
    const onData = (d: Buffer): void => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf("\r\n\r\n");
      if (end === -1) return;
      socket.off("data", onData);
      resolve({ socket, status: buf.subarray(0, buf.indexOf("\r\n")).toString() });
    };
    socket.on("data", onData);
    socket.on("error", reject);
  });
}

/** One HTTP/1.1 request over TLS through the tunnel, trusting only the AIS CA. */
async function viaProxy(port: number, req: { ca?: string; host?: string; method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: string }> {
  const host = req.host ?? "api.anthropic.com";
  const { socket } = await connect(port, `${host}:443`);
  const secure = tls.connect({ socket, servername: host, ca: req.ca ?? ca.certPem });
  await new Promise<void>((resolve, reject) => {
    secure.once("secureConnect", resolve);
    secure.once("error", reject);
  });
  const body = req.body ?? "";
  const headers = { host, connection: "close", "content-length": String(Buffer.byteLength(body)), ...req.headers };
  secure.write(`${req.method ?? "GET"} ${req.path} HTTP/1.1\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n${body}`);
  const raw = await new Promise<string>((resolve) => {
    let out = "";
    secure.on("data", (d: Buffer) => (out += d.toString()));
    secure.on("end", () => resolve(out));
    secure.on("close", () => resolve(out));
  });
  const status = Number(/^HTTP\/1\.1 (\d+)/.exec(raw)?.[1]);
  const text = raw.slice(raw.indexOf("\r\n\r\n") + 4);
  // Chunked bodies: keep only the payload lines.
  const chunked = /transfer-encoding: chunked/i.test(raw.slice(0, raw.indexOf("\r\n\r\n")));
  return { status, body: chunked ? text.split("\r\n").filter((_, i) => i % 2 === 1).join("") : text };
}

describe("usage proxy", () => {
  test("answers /api/oauth/usage for an app token from the gateway route of that app", async () => {
    const calls: Call[] = [];
    const p = await proxy(calls);
    const res = await viaProxy(p.port, { path: "/api/oauth/usage", headers: { authorization: `Bearer ${APP_TOKEN}`, "anthropic-beta": "oauth-2025-04-20" } });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ seven_day: { utilization: 62 } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("gateway:t3-claude-x/api/oauth/usage");
    expect(calls[0]!.headers.get("authorization")).toBe(`Bearer ${APP_TOKEN}`);
    expect(calls[0]!.headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
  });

  test("hands any method, path and body for an app token to the gateway route of that app", async () => {
    const calls: Call[] = [];
    const p = await proxy(calls);
    const res = await viaProxy(p.port, { method: "POST", path: "/api/organizations/org-1/reset_rate_limits", headers: { authorization: `Bearer ${APP_TOKEN}`, "content-type": "application/json" }, body: '{"grant_id":"g"}' });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("gateway:t3-claude-x/api/organizations/org-1/reset_rate_limits");
    expect(calls[0]!.method).toBe("POST");
  });

  test("answers /api/oauth/profile the same way", async () => {
    const calls: Call[] = [];
    const p = await proxy(calls);
    const res = await viaProxy(p.port, { path: "/api/oauth/profile", headers: { authorization: `Bearer ${APP_TOKEN}` } });
    expect(res.status).toBe(200);
    expect(calls[0]!.url).toBe("gateway:t3-claude-x/api/oauth/profile");
  });

  test("passes a usage request with any other bearer to the real host unchanged", async () => {
    const calls: Call[] = [];
    const p = await proxy(calls);
    const res = await viaProxy(p.port, { path: "/api/oauth/usage?x=1", headers: { authorization: OTHER_BEARER } });
    expect(res.status).toBe(401);
    expect(calls[0]!.url).toBe("https://upstream.test/api/oauth/usage?x=1");
    expect(calls[0]!.headers.get("authorization")).toBe(OTHER_BEARER);
  });

  test("passes other paths and methods (with their body) to the real host when the bearer is not an app token", async () => {
    const calls: Call[] = [];
    const p = await proxy(calls);
    const res = await viaProxy(p.port, { method: "POST", path: "/api/event_logging/batch", headers: { authorization: OTHER_BEARER, "content-type": "application/json" }, body: '{"a":1}' });
    expect(res.status).toBe(401);
    expect(res.body).toBe("upstream");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://upstream.test/api/event_logging/batch");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toBe('{"a":1}');
    expect(calls[0]!.headers.has("host")).toBe(false);
  });

  test("a gateway token the lookup does not know is refused, never sent to the real host", async () => {
    const calls: Call[] = [];
    const p = await proxy(calls, { appForToken: async () => undefined });
    for (const [method, path] of [["GET", "/api/oauth/usage"], ["POST", "/api/organizations/o/reset_rate_limits"], ["GET", "/api/event_logging/batch"]] as const) {
      const res = await viaProxy(p.port, { method, path, headers: { authorization: `Bearer ${APP_TOKEN}` } });
      expect(res.status).toBe(401);
    }
    expect(calls).toHaveLength(0);
  });

  for (const header of ["x-api-key", "api-key"]) {
    test(`an app token in ${header} is routed to the app like a bearer, never sent to the real host`, async () => {
      const calls: Call[] = [];
      const p = await proxy(calls);
      const res = await viaProxy(p.port, { path: "/api/oauth/usage", headers: { [header]: APP_TOKEN } });
      expect(res.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe("gateway:t3-claude-x/api/oauth/usage");
    });
    test(`an unknown gateway token in ${header} is 401 and never sent to the real host`, async () => {
      const calls: Call[] = [];
      const p = await proxy(calls, { appForToken: async () => undefined });
      const res = await viaProxy(p.port, { method: "POST", path: "/api/event_logging/batch", headers: { [header]: APP_TOKEN } });
      expect(res.status).toBe(401);
      expect(calls).toHaveLength(0);
    });
  }

  test("tunnels any other host untouched, with no TLS termination", async () => {
    const echo = net.createServer((s) => s.pipe(s));
    await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
    running.push({ stop: () => echo.close() });
    const echoPort = (echo.address() as net.AddressInfo).port;
    const targets: string[] = [];
    const calls: Call[] = [];
    const p = await proxy(calls, {
      connectTarget: (host, port) => {
        targets.push(`${host}:${port}`);
        return { host: "127.0.0.1", port: echoPort };
      },
    });
    const { socket, status } = await connect(p.port, "example.com:443");
    expect(status).toBe("HTTP/1.1 200 Connection Established");
    const bytes = Buffer.from([0x16, 0x03, 0x01, 0x00, 0xff, 0x00]);
    socket.write(bytes);
    const back = await new Promise<Buffer>((r) => socket.once("data", r));
    socket.destroy();
    expect(Buffer.compare(back, bytes)).toBe(0);
    expect(targets).toEqual(["example.com:443"]);
    expect(calls).toHaveLength(0);
  });

  test("api.anthropic.com on a port other than 443 is a plain tunnel", async () => {
    const targets: string[] = [];
    const p = await proxy([], { connectTarget: (host, port) => (targets.push(`${host}:${port}`), { host: "127.0.0.1", port: 1 }) });
    const { status } = await connect(p.port, "api.anthropic.com:8443");
    expect(status).toBe("HTTP/1.1 502 Bad Gateway");
    expect(targets).toEqual(["api.anthropic.com:8443"]);
  });

  test("publishes ca.crt for clients", async () => {
    const to = join(dir, "published-ca.pem");
    await proxy([], { publishCaTo: to });
    expect(await readFile(to, "utf8")).toBe(ca.certPem);
  });

  test("refuses anything but CONNECT", async () => {
    const p = await proxy([]);
    const socket = net.connect(p.port, "127.0.0.1");
    socket.write("GET http://example.com/ HTTP/1.1\r\nhost: example.com\r\n\r\n");
    const first = await new Promise<string>((r) => socket.once("data", (d: Buffer) => r(d.toString())));
    expect(first.startsWith("HTTP/1.1 405")).toBe(true);
    // The body says what went wrong, so a client with no loopback NO_PROXY can be fixed from the error alone.
    expect(first.toLowerCase()).toContain("allow: connect");
    expect(first).toContain("NO_PROXY=127.0.0.1,localhost,::1");
    // The proxy closes its side even when the client keeps the connection open.
    await new Promise<void>((r) => socket.once("close", () => r()));
  });
});

describe("usage proxy: opencode and grok hosts", () => {
  test("serves GET /zen/go/v1/usage on opencode.ai for an opencode app token", async () => {
    const calls: Call[] = [];
    const p = await proxy(calls);
    const res = await viaProxy(p.port, { host: "opencode.ai", path: "/zen/go/v1/usage", headers: { authorization: `Bearer ${APP_TOKEN}` } });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("gateway:t3-opencode-x/v1/usage");
  });

  test("serves GET /v1/billing with its query on cli-chat-proxy.grok.com for a grok app token", async () => {
    const calls: Call[] = [];
    const p = await proxy(calls);
    const res = await viaProxy(p.port, { host: "cli-chat-proxy.grok.com", path: "/v1/billing?format=credits", headers: { authorization: `Bearer ${APP_TOKEN}` } });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("gateway:t3-grok-x/v1/billing?format=credits");
  });

  test("a gateway token on any other opencode.ai or grok path or method is 403 and never sent on", async () => {
    const calls: Call[] = [];
    const p = await proxy(calls);
    for (const [host, method, path] of [
      ["opencode.ai", "GET", "/zen/go/v1/chat/completions"],
      ["opencode.ai", "POST", "/zen/go/v1/usage"],
      ["cli-chat-proxy.grok.com", "POST", "/v1/billing"],
      ["cli-chat-proxy.grok.com", "GET", "/v1/responses"],
    ] as const) {
      const res = await viaProxy(p.port, { host, method, path, headers: { authorization: `Bearer ${APP_TOKEN}` } });
      expect(res.status).toBe(403);
    }
    expect(calls).toHaveLength(0);
  });

  for (const provider of ["kimi", "zai"] as const) {
    test(`a ${provider} app token on api.anthropic.com: usage and profile are served, every other request is 404 and never sent on`, async () => {
      const calls: Call[] = [];
      const p = await proxy(calls, { appForToken: async (t) => (t === APP_TOKEN ? { name: `t3-${provider}`, provider, style: "anthropic" as const } : undefined) });
      const auth = { authorization: `Bearer ${APP_TOKEN}` };
      for (const path of ["/api/oauth/usage", "/api/oauth/profile"]) {
        const res = await viaProxy(p.port, { path, headers: auth });
        expect(res.status).toBe(200);
      }
      expect(calls.map((c) => c.url)).toEqual([`gateway:t3-${provider}/api/oauth/usage`, `gateway:t3-${provider}/api/oauth/profile`]);
      calls.length = 0;
      for (const [method, path] of [["POST", "/v1/messages"], ["POST", "/api/event_logging/batch"], ["GET", "/api/oauth/account"], ["POST", "/api/oauth/usage"], ["GET", "/api/oauth/usage/x"], ["GET", "/v1/models"]] as const) {
        const res = await viaProxy(p.port, { method, path, headers: auth, body: method === "POST" ? "{}" : undefined });
        expect(res.status).toBe(404);
        expect(JSON.parse(res.body)).toMatchObject({ type: "error", error: { type: "not_found_error" } });
      }
      expect(calls).toHaveLength(0);
    });
  }

  for (const provider of ["kimi", "zai"] as const) {
    test(`an openai-style ${provider} app on api.anthropic.com gets 404 for usage and profile, never sent on`, async () => {
      const calls: Call[] = [];
      const p = await proxy(calls, { appForToken: async (t) => (t === APP_TOKEN ? { name: `t3-${provider}`, provider, style: "openai" as const } : undefined) });
      for (const path of ["/api/oauth/usage", "/api/oauth/profile"]) {
        const res = await viaProxy(p.port, { path, headers: { authorization: `Bearer ${APP_TOKEN}` } });
        expect(res.status).toBe(404);
      }
      expect(calls).toHaveLength(0);
    });
  }

  test("a gateway token in a place the proxy does not read is 401 and never sent on", async () => {
    const calls: Call[] = [];
    const p = await proxy(calls);
    const cases: Array<{ path: string; headers: Record<string, string> }> = [
      { path: `/v1/messages?key=${APP_TOKEN}`, headers: {} },
      { path: "/v1/messages", headers: { authorization: `Bearer ${APP_TOKEN} extra` } },
      { path: "/v1/messages", headers: { authorization: `Bearer ${APP_TOKEN}, Bearer ${APP_TOKEN}` } },
      { path: "/v1/messages", headers: { "x-custom": `see ${APP_TOKEN}` } },
    ];
    for (const c of cases) {
      const res = await viaProxy(p.port, { method: "GET", ...c });
      expect(res.status).toBe(401);
    }
    expect(calls).toHaveLength(0);
  });

  test("a claude app token on api.anthropic.com is still served for every method and path", async () => {
    const calls: Call[] = [];
    const p = await proxy(calls, { appForToken: async (t) => (t === APP_TOKEN ? { name: "t3-claude-x", provider: "claude", style: "anthropic" } : undefined) });
    await viaProxy(p.port, { method: "POST", path: "/api/event_logging/batch", headers: { authorization: `Bearer ${APP_TOKEN}` }, body: "{}" });
    expect(calls.map((c) => c.url)).toEqual(["gateway:t3-claude-x/api/event_logging/batch"]);
  });

  test("a token that is not valid for the host's provider is 401 and never sent on", async () => {
    const calls: Call[] = [];
    const p = await proxy(calls, { appForToken: async (t, providers) => (t === APP_TOKEN && providers.includes("claude") ? { name: "t3-claude-x", provider: "claude", style: "anthropic" } : undefined) });
    for (const [host, path] of [["opencode.ai", "/zen/go/v1/usage"], ["cli-chat-proxy.grok.com", "/v1/billing"]] as const) {
      const res = await viaProxy(p.port, { host, path, headers: { authorization: `Bearer ${APP_TOKEN}` } });
      expect(res.status).toBe(401);
    }
    expect(calls).toHaveLength(0);
  });

  test("a request without a gateway token goes to that host's origin unchanged", async () => {
    const calls: Call[] = [];
    const p = await proxy(calls, { passthroughOrigin: (host) => `https://${host}.origin.invalid` });
    const res = await viaProxy(p.port, { host: "opencode.ai", method: "POST", path: "/zen/go/v1/chat/completions", headers: { authorization: OTHER_BEARER }, body: '{"a":1}' });
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://opencode.ai.origin.invalid/zen/go/v1/chat/completions");
    expect(calls[0]!.headers.get("authorization")).toBe(OTHER_BEARER);
    expect(calls[0]!.body).toBe('{"a":1}');
    const g = await viaProxy(p.port, { host: "cli-chat-proxy.grok.com", path: "/v1/billing" });
    expect(g.status).toBe(401);
    expect(calls[1]!.url).toBe("https://cli-chat-proxy.grok.com.origin.invalid/v1/billing");
  });

  test("a Host that is not intercepted is 421 and not forwarded", async () => {
    const calls: Call[] = [];
    const p = await proxy(calls);
    const { socket } = await connect(p.port, "api.anthropic.com:443");
    const secure = tls.connect({ socket, servername: "api.anthropic.com", ca: ca.certPem });
    await new Promise<void>((resolve, reject) => (secure.once("secureConnect", resolve), secure.once("error", reject)));
    secure.write("GET / HTTP/1.1\r\nhost: example.com\r\nconnection: close\r\n\r\n");
    const raw = await new Promise<string>((resolve) => {
      let out = "";
      secure.on("data", (d: Buffer) => (out += d.toString()));
      secure.on("close", () => resolve(out));
    });
    expect(raw.startsWith("HTTP/1.1 421")).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("a certificate without the opencode.ai name leaves CONNECT opencode.ai:443 a plain tunnel", async () => {
    const targets: string[] = [];
    const p = await proxy([], { tlsDir: narrowTlsDir, connectTarget: (host, port) => (targets.push(`${host}:${port}`), { host: "127.0.0.1", port: 1 }) });
    const { status } = await connect(p.port, "opencode.ai:443");
    expect(status).toBe("HTTP/1.1 502 Bad Gateway");
    expect(targets).toEqual(["opencode.ai:443"]);
    // api.anthropic.com is still intercepted with that certificate.
    const res = await viaProxy(p.port, { ca: await readFile(join(narrowTlsDir, "ca.crt"), "utf8"), path: "/api/oauth/usage", headers: { authorization: `Bearer ${APP_TOKEN}` } });
    expect(res.status).toBe(200);
    expect(targets).toEqual(["opencode.ai:443"]);
  });

  test("a start refused by a held port rejects, leaks no timer, and succeeds once the port is free", async () => {
    const holder = net.createServer();
    await new Promise<void>((r) => holder.listen({ host: "127.0.0.1", port: 0 }, () => r()));
    const heldPort = (holder.address() as net.AddressInfo).port;
    await expect(proxy([], { port: heldPort })).rejects.toThrow();
    await new Promise<void>((r) => holder.close(() => r()));
    const p = await proxy([], { port: heldPort });
    expect(p.port).toBe(heldPort);
  });

  test("a missing certificate rejects the start", async () => {
    await expect(proxy([], { tlsDir: join(dir, "missing") })).rejects.toThrow();
  });
});

afterAll(() => rm(dir, { recursive: true, force: true }));
