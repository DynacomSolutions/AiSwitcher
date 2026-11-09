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
const ca = { certPem: "" };

/** A CA and an api.anthropic.com leaf, as the cluster's cert-manager secret would hold them (tls.crt, tls.key, ca.crt). */
function makeTls(out: string): void {
  const run = (...args: string[]): void => {
    const r = Bun.spawnSync(["openssl", ...args], { cwd: out, stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`openssl ${args[0]}: ${r.stderr.toString()}`);
  };
  run("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "2", "-subj", "/CN=test ca", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign");
  run("req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "tls.key", "-out", "leaf.csr", "-subj", "/CN=api.anthropic.com");
  Bun.spawnSync(["sh", "-c", "printf 'subjectAltName=DNS:api.anthropic.com\\n' > ext"], { cwd: out });
  run("x509", "-req", "-in", "leaf.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-days", "2", "-extfile", "ext", "-out", "tls.crt");
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ais-usage-proxy-"));
  tlsDir = join(dir, "tls");
  await mkdir(tlsDir);
  makeTls(tlsDir);
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
    appForToken: async (t) => (t === APP_TOKEN ? "t3-claude-x" : undefined),
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
    // The proxy closes its side even when the client keeps the connection open.
    await new Promise<void>((r) => socket.once("close", () => r()));
  });
});

afterAll(() => rm(dir, { recursive: true, force: true }));
