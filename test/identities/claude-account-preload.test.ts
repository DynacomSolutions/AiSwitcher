import { afterEach, expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installClaudeAccountPreload, isClusterInternalHost } from "../../src/identities/claude-account-preload.ts";

// The preload prefers ANTHROPIC_BASE_URL from the environment: agent shells set it, so tests must start without it.
delete process.env.ANTHROPIC_BASE_URL;

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("routes exact native account calls and fetch calls to the configured gateway", async () => {
  const requests: { method: string; url: string; auth?: string }[] = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method ?? "", url: request.url ?? "", auth: request.headers.authorization });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not expose a port");
    const root = await mkdtemp(join(tmpdir(), "ais-claude-preload-"));
    roots.push(root);
    const config = join(root, "claude");
    await mkdir(config, { recursive: true });
    await writeFile(join(config, "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}/gateway/claude` } }));
    await writeFile(join(config, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "aisg_SYNTHETIC_FIXTURE" } }));
    const preload = await installClaudeAccountPreload(root);
    const script = [
      "const https = require('node:https');",
      "const http = require('node:http');",
      "const native = (options) => new Promise((resolve, reject) => { const req = https.request(options, (res) => { let body = ''; res.on('data', (chunk) => body += chunk); res.on('end', () => resolve({ status: res.statusCode, body })); }); req.on('error', reject); req.end(); });",
      "const local = (options) => new Promise((resolve, reject) => { const req = http.request(options, (res) => { let body = ''; res.on('data', (chunk) => body += chunk); res.on('end', () => resolve({ status: res.statusCode, body })); }); req.on('error', reject); req.end(); });",
      `Promise.all([native({ hostname: 'api.anthropic.com', path: '/api/oauth/profile?x=1', method: 'GET', headers: { authorization: 'Bearer aisg_SYNTHETIC_FIXTURE' } }), fetch('https://api.anthropic.com/api/oauth/usage?y=2', { headers: { authorization: 'Bearer aisg_SYNTHETIC_FIXTURE' } }), local({ hostname: '127.0.0.1', port: ${address.port}, path: '/untouched', method: 'GET' })]).then((values) => console.log(JSON.stringify(values))).catch((error) => { console.error(error); process.exitCode = 1; });`,
    ].join("\n");
    const child = Bun.spawn([process.execPath, "--preload", preload, "-e", script], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: config, AIS_CLAUDE_ACCOUNT_PRELOAD: "1", BUN_OPTIONS: `--preload ${preload}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([child.stdout.text(), child.stderr.text(), child.exited]);
    expect(exitCode, `${stderr}\n${stdout}`).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toHaveLength(3);
    expect(requests.toSorted((a, b) => a.url.localeCompare(b.url))).toEqual([
      { method: "GET", url: "/gateway/claude/api/oauth/profile?x=1", auth: "Bearer aisg_SYNTHETIC_FIXTURE" },
      { method: "GET", url: "/gateway/claude/api/oauth/usage?y=2", auth: "Bearer aisg_SYNTHETIC_FIXTURE" },
      { method: "GET", url: "/untouched", auth: undefined },
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("patches named node:https exports, keeps user Bun flags, and leaves child processes clean", async () => {
  const requests: { method: string; url: string; auth?: string }[] = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method ?? "", url: request.url ?? "", auth: request.headers.authorization });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not expose a port");
    const root = await mkdtemp(join(tmpdir(), "ais-claude-preload-"));
    roots.push(root);
    const config = join(root, "claude");
    await mkdir(config, { recursive: true });
    await writeFile(join(config, "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}/gateway/claude` } }));
    await writeFile(join(config, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "aisg_SYNTHETIC_FIXTURE" } }));
    const preload = await installClaudeAccountPreload(root);
    const script = [
      "const { request, get } = await import('node:https');",
      "const requestCall = (method, path) => new Promise((resolve, reject) => { const req = request({ hostname: 'api.anthropic.com', path, method, headers: { authorization: 'Bearer aisg_SYNTHETIC_FIXTURE' } }, (res) => { let body = ''; res.on('data', (chunk) => body += chunk); res.on('end', () => resolve({ status: res.statusCode, body })); }); req.on('error', reject); req.end(); });",
      "const getCall = new Promise((resolve, reject) => { const req = get({ hostname: 'api.anthropic.com', path: '/api/oauth/usage?named=1', headers: { authorization: 'Bearer aisg_SYNTHETIC_FIXTURE' } }, (res) => { let body = ''; res.on('data', (chunk) => body += chunk); res.on('end', () => resolve({ status: res.statusCode, body })); }); req.on('error', reject); });",
      "const child = Bun.spawn([process.execPath, '-e', \"console.log(JSON.stringify({ marker: process.env.AIS_CLAUDE_ACCOUNT_PRELOAD, options: process.env.BUN_OPTIONS }))\"], { env: process.env, stdout: 'pipe', stderr: 'pipe' });",
      "Promise.all([requestCall('GET', '/api/oauth/profile?named=1'), getCall, child.stdout.text(), child.stderr.text(), child.exited]).then(([requestResult, getResult, childOut, childErr, exitCode]) => { if (childErr || exitCode !== 0) throw new Error(childErr || `child exit ${exitCode}`); console.log(JSON.stringify({ requestResult, getResult, marker: process.env.AIS_CLAUDE_ACCOUNT_PRELOAD, options: process.env.BUN_OPTIONS, child: JSON.parse(childOut) })); }).catch((error) => { console.error(error); process.exitCode = 1; });",
    ].join("\n");
    const child = Bun.spawn([process.execPath, "--preload", preload, "-e", script], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: config, AIS_CLAUDE_ACCOUNT_PRELOAD: "1", BUN_OPTIONS: `--smol --preload ${preload}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([child.stdout.text(), child.stderr.text(), child.exited]);
    expect(exitCode, `${stderr}\n${stdout}`).toBe(0);
    expect(stderr).toBe("");
    const result = JSON.parse(stdout) as { marker?: string; options?: string; child: { marker?: string; options?: string } };
    expect(result.marker).toBeUndefined();
    expect(result.options).toBe("--smol");
    expect(result.child).toEqual({ options: "--smol" });
    expect(requests.map((request) => request.url).toSorted()).toEqual([
      "/gateway/claude/api/oauth/profile?named=1",
      "/gateway/claude/api/oauth/usage?named=1",
    ]);
    expect(requests.every((request) => request.auth === "Bearer aisg_SYNTHETIC_FIXTURE")).toBe(true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("leaves wrong hosts, methods, paths, and tokens untouched", async () => {
  const requests: { method: string; url: string; auth?: string }[] = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method ?? "", url: request.url ?? "", auth: request.headers.authorization });
    response.writeHead(200);
    response.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not expose a port");
    const root = await mkdtemp(join(tmpdir(), "ais-claude-preload-"));
    roots.push(root);
    const config = join(root, "claude");
    await mkdir(config, { recursive: true });
    await writeFile(join(config, "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}/gateway/claude` } }));
    await writeFile(join(config, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "aisg_SYNTHETIC_FIXTURE" } }));
    const preload = await installClaudeAccountPreload(root);
    const script = [
      "const http = require('node:http'); const net = require('node:net');",
      `const port = ${address.port}; const createConnection = () => net.connect(port, '127.0.0.1');`,
      "const call = (options) => new Promise((resolve, reject) => { const req = http.request({ ...options, port, createConnection }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); req.on('error', reject); req.end(); });",
      "Promise.all([call({ hostname: 'not-api.invalid', path: '/wrong-host', method: 'GET' }), call({ hostname: 'api.anthropic.com', path: '/api/oauth/profile', method: 'POST', headers: { authorization: 'Bearer aisg_SYNTHETIC_FIXTURE' } }), call({ hostname: 'api.anthropic.com', path: '/api/oauth/other', method: 'GET', headers: { authorization: 'Bearer aisg_SYNTHETIC_FIXTURE' } }), call({ hostname: 'api.anthropic.com', path: '/api/oauth/profile', method: 'GET', headers: { authorization: 'Bearer other-SYNTHETIC_FIXTURE' } })]).then((values) => console.log(JSON.stringify(values))).catch((error) => { console.error(error); process.exitCode = 1; });",
    ].join("\n");
    const child = Bun.spawn([process.execPath, "--preload", preload, "-e", script], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: config, AIS_CLAUDE_ACCOUNT_PRELOAD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([child.stdout.text(), child.stderr.text(), child.exited]);
    expect(exitCode, `${stderr}\n${stdout}`).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual([200, 200, 200, 200]);
    expect(requests).toEqual([
      { method: "GET", url: "/wrong-host", auth: undefined },
      { method: "POST", url: "/api/oauth/profile", auth: "Bearer aisg_SYNTHETIC_FIXTURE" },
      { method: "GET", url: "/api/oauth/other", auth: "Bearer aisg_SYNTHETIC_FIXTURE" },
      { method: "GET", url: "/api/oauth/profile", auth: "Bearer other-SYNTHETIC_FIXTURE" },
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("does not consume an unrelated POST body while checking fetch scope", async () => {
  let received = "";
  const server = createServer((request, response) => {
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { received += chunk; });
    request.on("end", () => { response.writeHead(200); response.end("ok"); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not expose a port");
    const root = await mkdtemp(join(tmpdir(), "ais-claude-preload-"));
    roots.push(root);
    const config = join(root, "claude");
    await mkdir(config, { recursive: true });
    await writeFile(config + "/settings.json", JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://gateway.invalid" } }));
    await writeFile(config + "/.credentials.json", JSON.stringify({ claudeAiOauth: { accessToken: "aisg_SYNTHETIC_FIXTURE" } }));
    const preload = await installClaudeAccountPreload(root);
    const script = `const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("unrelated-body")); controller.close(); } }); fetch("http://127.0.0.1:${address.port}/unrelated", { method: "POST", body, duplex: "half" }).then((response) => response.text()).then(console.log).catch((error) => { console.error(error); process.exitCode = 1; });`;
    const child = Bun.spawn([process.execPath, "--preload", preload, "-e", script], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: config, AIS_CLAUDE_ACCOUNT_PRELOAD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([child.stdout.text(), child.stderr.text(), child.exited]);
    expect(exitCode, `${stderr}\n${stdout}`).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.trim()).toBe("ok");
    expect(received).toBe("unrelated-body");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("removes the AIS bearer before a cross-origin fetch redirect", async () => {
  const gatewayRequests: { url: string; auth?: string }[] = [];
  const redirectRequests: { url: string; auth?: string }[] = [];
  const redirectServer = createServer((request, response) => {
    redirectRequests.push({ url: request.url ?? "", auth: request.headers.authorization });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ redirected: true }));
  });
  await new Promise<void>((resolve) => redirectServer.listen(0, "127.0.0.1", resolve));
  const redirectAddress = redirectServer.address();
  if (!redirectAddress || typeof redirectAddress === "string") throw new Error("redirect server did not expose a port");
  const gatewayServer = createServer((request, response) => {
    gatewayRequests.push({ url: request.url ?? "", auth: request.headers.authorization });
    response.writeHead(302, { location: `http://127.0.0.1:${redirectAddress.port}/cross-origin` });
    response.end();
  });
  await new Promise<void>((resolve) => gatewayServer.listen(0, "127.0.0.1", resolve));
  try {
    const gatewayAddress = gatewayServer.address();
    if (!gatewayAddress || typeof gatewayAddress === "string") throw new Error("gateway server did not expose a port");
    const root = await mkdtemp(join(tmpdir(), "ais-claude-preload-"));
    roots.push(root);
    const config = join(root, "claude");
    await mkdir(config, { recursive: true });
    await writeFile(join(config, "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${gatewayAddress.port}/gateway/claude` } }));
    await writeFile(join(config, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "aisg_SYNTHETIC_FIXTURE" } }));
    const preload = await installClaudeAccountPreload(root);
    const script = "fetch('https://api.anthropic.com/api/oauth/profile?redirect=1', { headers: { authorization: 'Bearer aisg_SYNTHETIC_FIXTURE' } }).then((response) => response.json()).then((body) => console.log(JSON.stringify(body))).catch((error) => { console.error(error); process.exitCode = 1; });";
    const child = Bun.spawn([process.execPath, "--preload", preload, "-e", script], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: config, AIS_CLAUDE_ACCOUNT_PRELOAD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([child.stdout.text(), child.stderr.text(), child.exited]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({ redirected: true });
    expect(gatewayRequests).toEqual([{ url: "/gateway/claude/api/oauth/profile?redirect=1", auth: "Bearer aisg_SYNTHETIC_FIXTURE" }]);
    expect(redirectRequests).toEqual([{ url: "/cross-origin", auth: undefined }]);
  } finally {
    await new Promise<void>((resolve) => gatewayServer.close(() => resolve()));
    await new Promise<void>((resolve) => redirectServer.close(() => resolve()));
  }
});

interface SeenRequest { method: string; url: string; host?: string; auth?: string }

/**
 * Runs account, model and other calls through the preload with the given base URL.
 * Every request is wired to one local server (createConnection), so the Host header shows where the call was aimed.
 */
async function runBaseCase(baseUrl: string): Promise<SeenRequest[]> {
  const requests: SeenRequest[] = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method ?? "", url: request.url ?? "", host: request.headers.host?.replace(/:80$/, ""), auth: request.headers.authorization });
    response.writeHead(200);
    response.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not expose a port");
    const root = await mkdtemp(join(tmpdir(), "ais-claude-preload-"));
    roots.push(root);
    const config = join(root, "claude");
    await mkdir(config, { recursive: true });
    await writeFile(join(config, "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: baseUrl } }));
    await writeFile(join(config, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "aisg_SYNTHETIC_FIXTURE" } }));
    const preload = await installClaudeAccountPreload(root);
    const script = [
      "const http = require('node:http'); const net = require('node:net');",
      `const createConnection = () => net.connect(${address.port}, '127.0.0.1');`,
      "const call = (transport, options) => new Promise((resolve) => { const req = transport.request({ ...options, createConnection, method: 'GET' }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); req.on('error', () => resolve(0)); req.end(); });",
      "const auth = { authorization: 'Bearer aisg_SYNTHETIC_FIXTURE' };",
      "(async () => {",
      "  await call(http, { hostname: 'api.anthropic.com', path: '/api/oauth/profile?x=1', headers: auth });",
      "  await call(http, { hostname: 'api.anthropic.com', path: '/api/oauth/usage', headers: auth });",
      "  await call(http, { hostname: 'api.anthropic.com', path: '/v1/messages', headers: auth });",
      "  await call(http, { hostname: 'other.example.test', path: '/api/oauth/profile', headers: auth });",
      "})().catch((error) => { console.error(error); process.exitCode = 1; });",
    ].join("\n");
    const child = Bun.spawn([process.execPath, "--preload", preload, "-e", script], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: config, AIS_CLAUDE_ACCOUNT_PRELOAD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([child.stdout.text(), child.stderr.text(), child.exited]);
    expect(exitCode, `${stderr}\n${stdout}`).toBe(0);
    return requests;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("accepts plain HTTP on a cluster service host and redirects only the account paths", async () => {
  for (const [base, host] of [
    ["http://ais-gateway.dev.svc.cluster.local:47130/agent-app", "ais-gateway.dev.svc.cluster.local:47130"],
    ["http://ais-gateway.dev.svc:47130/agent-app", "ais-gateway.dev.svc:47130"],
  ] as const) {
    const requests = await runBaseCase(base);
    expect(requests).toEqual([
      { method: "GET", url: "/agent-app/api/oauth/profile?x=1", host, auth: "Bearer aisg_SYNTHETIC_FIXTURE" },
      { method: "GET", url: "/agent-app/api/oauth/usage", host, auth: "Bearer aisg_SYNTHETIC_FIXTURE" },
      { method: "GET", url: "/v1/messages", host: "api.anthropic.com", auth: "Bearer aisg_SYNTHETIC_FIXTURE" },
      { method: "GET", url: "/api/oauth/profile", host: "other.example.test", auth: "Bearer aisg_SYNTHETIC_FIXTURE" },
    ]);
  }
});

test("rejects plain HTTP on any other host, so the account calls stay native", async () => {
  for (const base of [
    "http://gateway.example.test:47130/app",
    "http://svc.cluster.local.example.test/app",
    "http://ais-gateway.dev.svc.example.test/app",
    "http://evil-svc.cluster.local/app",
  ]) {
    const requests = await runBaseCase(base);
    expect(requests.map((request) => request.host), base).toEqual(["api.anthropic.com", "api.anthropic.com", "api.anthropic.com", "other.example.test"]);
    expect(requests.map((request) => request.url), base).toEqual(["/api/oauth/profile?x=1", "/api/oauth/usage", "/v1/messages", "/api/oauth/profile"]);
  }
});

test("keeps https gateways working", async () => {
  // The test wires every socket to the plain local server, so the Host header shows the aimed origin.
  const requests = await runBaseCase("https://gateway.invalid/app");
  expect(requests.map((request) => `${request.host}${request.url}`)).toEqual([
    "gateway.invalid:443/app/api/oauth/profile?x=1",
    "gateway.invalid:443/app/api/oauth/usage",
    "api.anthropic.com/v1/messages",
    "other.example.test/api/oauth/profile",
  ]);
});

test("keeps loopback http gateways working", async () => {
  const requests = await runBaseCase("http://127.0.0.1:47140/app");
  expect(requests.map((request) => request.url)).toEqual(["/app/api/oauth/profile?x=1", "/app/api/oauth/usage", "/v1/messages", "/api/oauth/profile"]);
  expect(requests.map((request) => request.host)).toEqual(["127.0.0.1:47140", "127.0.0.1:47140", "api.anthropic.com", "other.example.test"]);
});

test("isClusterInternalHost matches only Kubernetes service names", () => {
  expect(isClusterInternalHost("ais-gateway.dev.svc.cluster.local")).toBe(true);
  expect(isClusterInternalHost("ais-gateway.dev.svc")).toBe(true);
  expect(isClusterInternalHost("AIS-Gateway.Dev.SVC.cluster.local.")).toBe(true);
  expect(isClusterInternalHost("svc.cluster.local")).toBe(false);
  expect(isClusterInternalHost("x.svc.cluster.local.evil.test")).toBe(false);
  expect(isClusterInternalHost("x.svc.evil.test")).toBe(false);
  expect(isClusterInternalHost("localhost")).toBe(false);
  expect(isClusterInternalHost("a b.svc")).toBe(false);
});
