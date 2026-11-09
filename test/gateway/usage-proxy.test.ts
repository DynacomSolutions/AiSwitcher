import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { caCertPath, ensureLocalCa, issueLeaf, type LocalCa } from "../../src/gateway/local-ca.ts";
import { secretsTokenResolver, startUsageProxy, type RunningUsageProxy } from "../../src/gateway/usage-proxy.ts";

const APP_TOKEN = "aisg_abcdefgh_" + "x".repeat(43);
const OTHER_BEARER = ["Bearer", "not-an-app-token"].join(" ");

let dir: string;
let ca: LocalCa;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ais-usage-proxy-"));
  ca = await ensureLocalCa(join(dir, "ca"));
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
    remoteBase: "https://gw.test/gateway",
    appForToken: async (t) => (t === APP_TOKEN ? "t3-claude-x" : undefined),
    ca,
    fetch: fakeFetch(calls, (url) => (url.startsWith("https://gw.test/") ? Response.json({ seven_day: { utilization: 62 } }) : new Response("upstream", { status: 401 }))),
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
async function viaProxy(port: number, req: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: string }> {
  const { socket } = await connect(port, "api.anthropic.com:443");
  const secure = tls.connect({ socket, servername: "api.anthropic.com", ca: ca.certPem });
  await new Promise<void>((resolve, reject) => {
    secure.once("secureConnect", resolve);
    secure.once("error", reject);
  });
  const body = req.body ?? "";
  const headers = { host: "api.anthropic.com", connection: "close", "content-length": String(Buffer.byteLength(body)), ...req.headers };
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

describe("local CA", () => {
  test("creates a 0600 key and reuses the same CA on the next start", async () => {
    const d = join(dir, "ca2");
    const first = await ensureLocalCa(d);
    expect((await stat(join(d, "ca-key.pem"))).mode & 0o777).toBe(0o600);
    expect((await stat(d)).mode & 0o777).toBe(0o700);
    expect(first.certPath).toBe(caCertPath(d));
    const again = await ensureLocalCa(d);
    expect(again.certPem).toBe(first.certPem);
    expect(await readFile(first.certPath, "utf8")).toBe(first.certPem);
  });

  test("is a name-constrained CA and its leaf verifies for the intercepted host only", () => {
    const caCert = new X509Certificate(ca.certPem);
    expect(caCert.ca).toBe(true);
    const leaf = new X509Certificate(issueLeaf(ca, "api.anthropic.com").certPem);
    expect(leaf.verify(caCert.publicKey)).toBe(true);
    expect(leaf.checkIssued(caCert)).toBe(true);
    expect(leaf.checkHost("api.anthropic.com")).toBe("api.anthropic.com");
    expect(leaf.checkHost("example.com")).toBeUndefined();
    expect(leaf.ca).toBe(false);
  });

  test("two concurrent starts end with one matching key and certificate", async () => {
    const d = join(dir, "ca5");
    const [a, b] = await Promise.all([ensureLocalCa(d), ensureLocalCa(d)]);
    expect(a.certPem).toBe(b.certPem);
    const onDisk = new X509Certificate(await readFile(join(d, "ca.pem"), "utf8"));
    expect(onDisk.checkPrivateKey(createPrivateKey(await readFile(join(d, "ca-key.pem"), "utf8")))).toBe(true);
  });

  test("replaces a CA whose key does not match", async () => {
    const d = join(dir, "ca3");
    const first = await ensureLocalCa(d);
    const other = await ensureLocalCa(join(dir, "ca4"));
    await Bun.write(join(d, "ca-key.pem"), other.key.export({ type: "pkcs8", format: "pem" }) as string);
    const next = await ensureLocalCa(d);
    expect(next.certPem).not.toBe(first.certPem);
  });
});

describe("secretsTokenResolver", () => {
  test("maps a token to its app and re-reads after 5 s", async () => {
    let entries = new Map([["AIS_GATEWAY_APP_T3_CLAUDE_TEAM_TOKEN", APP_TOKEN], ["OTHER", "x"]]);
    let t = 0;
    const resolve = secretsTokenResolver(async () => entries, () => t);
    expect(await resolve(APP_TOKEN)).toBe("t3-claude-team");
    expect(await resolve("x")).toBeUndefined();
    entries = new Map();
    expect(await resolve(APP_TOKEN)).toBe("t3-claude-team");
    t = 5_000;
    expect(await resolve(APP_TOKEN)).toBeUndefined();
  });

  test("a miss re-reads once the copy is 1 s old, so a rotated token is found", async () => {
    let entries = new Map<string, string>();
    let t = 0;
    let reads = 0;
    const resolve = secretsTokenResolver(async () => (reads++, entries), () => t);
    expect(await resolve(APP_TOKEN)).toBeUndefined();
    entries = new Map([["AIS_GATEWAY_APP_T3_CLAUDE_TEAM_TOKEN", APP_TOKEN]]);
    expect(await resolve(APP_TOKEN)).toBeUndefined();
    expect(reads).toBe(1);
    t = 1_000;
    expect(await resolve(APP_TOKEN)).toBe("t3-claude-team");
    expect(reads).toBe(2);
  });
});

describe("usage proxy", () => {
  test("answers /api/oauth/usage for an app token from the gateway route of that app", async () => {
    const calls: Call[] = [];
    const p = await proxy(calls);
    const res = await viaProxy(p.port, { path: "/api/oauth/usage", headers: { authorization: `Bearer ${APP_TOKEN}`, "anthropic-beta": "oauth-2025-04-20" } });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ seven_day: { utilization: 62 } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://gw.test/gateway/t3-claude-x/api/oauth/usage");
    expect(calls[0]!.headers.get("authorization")).toBe(`Bearer ${APP_TOKEN}`);
    expect(calls[0]!.headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
  });

  test("answers /api/oauth/profile the same way", async () => {
    const calls: Call[] = [];
    const p = await proxy(calls);
    const res = await viaProxy(p.port, { path: "/api/oauth/profile", headers: { authorization: `Bearer ${APP_TOKEN}` } });
    expect(res.status).toBe(200);
    expect(calls[0]!.url).toBe("https://gw.test/gateway/t3-claude-x/api/oauth/profile");
  });

  test("passes a usage request with any other bearer to the real host unchanged", async () => {
    const calls: Call[] = [];
    const p = await proxy(calls);
    const res = await viaProxy(p.port, { path: "/api/oauth/usage?x=1", headers: { authorization: OTHER_BEARER } });
    expect(res.status).toBe(401);
    expect(calls[0]!.url).toBe("https://upstream.test/api/oauth/usage?x=1");
    expect(calls[0]!.headers.get("authorization")).toBe(OTHER_BEARER);
  });

  test("passes other paths and methods (with their body) to the real host", async () => {
    const calls: Call[] = [];
    const p = await proxy(calls);
    const res = await viaProxy(p.port, { method: "POST", path: "/api/event_logging/batch", headers: { authorization: `Bearer ${APP_TOKEN}`, "content-type": "application/json" }, body: '{"a":1}' });
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
    const res = await viaProxy(p.port, { path: "/api/oauth/usage", headers: { authorization: `Bearer ${APP_TOKEN}` } });
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  test("with no gateway URL an app usage request is refused, never sent upstream", async () => {
    const calls: Call[] = [];
    const p = await proxy(calls, { remoteBase: "" });
    const res = await viaProxy(p.port, { path: "/api/oauth/usage", headers: { authorization: `Bearer ${APP_TOKEN}` } });
    expect(res.status).toBe(503);
    expect(calls).toHaveLength(0);
  });

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

  test("refuses anything but CONNECT", async () => {
    const p = await proxy([]);
    const socket = net.connect(p.port, "127.0.0.1");
    socket.write("GET http://example.com/ HTTP/1.1\r\nhost: example.com\r\n\r\n");
    const first = await new Promise<string>((r) => socket.once("data", (d: Buffer) => r(d.toString())));
    expect(first.startsWith("HTTP/1.1 405")).toBe(true);
    // The proxy closes its side even when the client keeps the connection open.
    await new Promise<void>((r) => socket.once("close", () => r()));
  });
});

afterAll(() => rm(dir, { recursive: true, force: true }));
