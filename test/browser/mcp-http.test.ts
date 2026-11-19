import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpDaemon, isLoopbackRequest, keyMatches, type DaemonDeps } from "../../src/browser/mcp-http.ts";
import { claudeSessionIdFromArgv, ensureMcpKey, launchHeaders, parseSessionHeaders, readMcpKey } from "../../src/browser/mcp-http-config.ts";
import { BROWSER_TOOLS } from "../../src/browser/protocol.ts";

const KEY = "a".repeat(64);
let dir: string;
let calls: Array<{ url: string; auth: string | null; body: any }>;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ais-mcp-http-"));
  await writeFile(join(dir, "ais-browser-token"), "tok\n");
  calls = [];
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

/** Stands in for the gateway: records each relay call and answers ok. */
const gatewayFetch = (async (url: string, init: RequestInit) => {
  calls.push({ url, auth: new Headers(init.headers).get("authorization"), body: JSON.parse(String(init.body)) });
  return new Response(JSON.stringify({ id: "x", ok: true, content: [{ type: "text", text: "done" }] }), { headers: { "content-type": "application/json" } });
}) as unknown as typeof fetch;

const daemon = (extra: Partial<DaemonDeps> = {}) =>
  createMcpDaemon({ key: KEY, fetch: gatewayFetch, readClaudeSessionId: () => undefined, pidAlive: () => true, ...extra });

const base = () => ({ "X-AIS-Tool": "claude", "X-AIS-Identity": "work", "X-AIS-Config-Dir": encodeURIComponent(dir), "X-AIS-Gateway": "http://gw.test", "X-AIS-Cwd": encodeURIComponent("/work/proj") });
const post = (body: unknown, headers: Record<string, string> = {}, key = KEY) =>
  new Request("http://127.0.0.1:47150/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}`, ...base(), ...headers }, body: JSON.stringify(body) });
const toolCall = (id: number, name = "list_browsers") => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} } });

test("header parsing accepts a full launch description and decodes paths", () => {
  const h = launchHeaders({ tool: "codex", identity: "work", configDir: "/cfg/my dir", home: "/h/.codex", gateway: "https://gw.test", t3Thread: "thread-1", t3Home: "/t3", cwd: "/w/é", ownerPid: 4242 });
  const r = parseSessionHeaders((n) => new Headers(h).get(n));
  expect(r).toEqual({ ok: true, value: { tool: "codex", identity: "work", configDir: "/cfg/my dir", home: "/h/.codex", gateway: "https://gw.test", t3Thread: "thread-1", t3Home: "/t3", cwd: "/w/é", ownerPid: 4242 } });
});

test("header validation rejects traversal, relative dirs, bad pids, bad tools, bad urls and missing target", () => {
  const ok = { "x-ais-tool": "claude", "x-ais-pool": "p" };
  const parse = (h: Record<string, string>) => parseSessionHeaders((n) => h[n]);
  expect(parse(ok).ok).toBe(true);
  expect(parse({ ...ok, "x-ais-config-dir": "/a/../etc" }).ok).toBe(false);
  expect(parse({ ...ok, "x-ais-config-dir": "relative/dir" }).ok).toBe(false);
  expect(parse({ ...ok, "x-ais-cwd": "%2Fa%2F..%2Fb" }).ok).toBe(false);
  expect(parse({ ...ok, "x-ais-owner-pid": "12ab" }).ok).toBe(false);
  expect(parse({ ...ok, "x-ais-owner-pid": "1" }).ok).toBe(false);
  expect(parse({ ...ok, "x-ais-tool": "kimi" }).ok).toBe(false);
  expect(parse({ ...ok, "x-ais-gateway": "file:///etc/passwd" }).ok).toBe(false);
  expect(parse({ ...ok, "x-ais-gateway": "https://user:pw@gw.test" }).ok).toBe(false);
  expect(parse({ ...ok, "x-ais-pool": "../x" }).ok).toBe(false);
  expect(parse({ ...ok, "x-ais-session-id": "a/b" }).ok).toBe(false);
  expect(parse({ "x-ais-tool": "claude" }).ok).toBe(false);
  expect(parse({ "x-ais-tool": "claude", "x-ais-identity": "work" }).ok).toBe(false);
});

test("claude session id comes from --session-id or --resume when it is a uuid", () => {
  const id = "0b3b1a52-3c1e-4f7e-9d54-3a0f6d2a9c11";
  expect(claudeSessionIdFromArgv(["--session-id", id])).toBe(id);
  expect(claudeSessionIdFromArgv([`--resume=${id}`])).toBe(id);
  expect(claudeSessionIdFromArgv(["-r", id, "hello"])).toBe(id);
  expect(claudeSessionIdFromArgv(["--resume", "search words"])).toBeUndefined();
  expect(claudeSessionIdFromArgv(["--", "--session-id", id])).toBeUndefined();
});

test("auth: no key, a wrong key and a malformed header are rejected; the right key passes", async () => {
  const d = daemon();
  const noAuth = new Request("http://127.0.0.1:47150/mcp", { method: "POST", headers: base(), body: "{}" });
  expect((await d.handle(noAuth)).status).toBe(401);
  expect((await d.handle(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, {}, "b".repeat(64)))).status).toBe(401);
  expect((await d.handle(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { authorization: KEY }))).status).toBe(401);
  expect((await d.handle(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }))).status).toBe(200);
  expect(keyMatches(`Bearer ${KEY}`, KEY)).toBe(true);
  expect(keyMatches(`Bearer ${KEY}x`, KEY)).toBe(false);
  expect(keyMatches(null, KEY)).toBe(false);
});

test("rebinding guard: only loopback Host and Origin pass, before the key is looked at", async () => {
  expect(isLoopbackRequest("127.0.0.1:47150", null)).toBe(true);
  expect(isLoopbackRequest("localhost:1", "http://localhost:3000")).toBe(true);
  expect(isLoopbackRequest("[::1]:1", null)).toBe(true);
  expect(isLoopbackRequest("evil.test", null)).toBe(false);
  expect(isLoopbackRequest("127.0.0.1:1", "https://evil.test")).toBe(false);
  expect(isLoopbackRequest(null, null)).toBe(false);
  const d = daemon();
  expect((await d.handle(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { host: "evil.test" }))).status).toBe(403);
  expect((await d.handle(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { origin: "https://evil.test" }))).status).toBe(403);
});

test("tools/list works with no initialize and an unknown Mcp-Session-Id; notifications get 202; GET is 405; healthz is 200", async () => {
  const d = daemon();
  const res = await d.handle(post({ jsonrpc: "2.0", id: 7, method: "tools/list" }, { "mcp-session-id": "never-issued" }));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/json");
  const body: any = await res.json();
  expect(body.id).toBe(7);
  expect(body.result.tools.map((t: any) => t.name)).toEqual([...BROWSER_TOOLS]);
  expect((await d.handle(post({ jsonrpc: "2.0", method: "notifications/initialized" }))).status).toBe(202);
  expect((await d.handle(new Request("http://127.0.0.1:47150/mcp", { method: "GET", headers: { authorization: `Bearer ${KEY}` } }))).status).toBe(405);
  expect((await d.handle(new Request("http://127.0.0.1:47150/healthz"))).status).toBe(200);
  expect((await d.handle(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { "x-ais-tool": "nope" }))).status).toBe(400);
  expect((await d.handle(new Request("http://127.0.0.1:47150/mcp", { method: "POST", headers: { authorization: `Bearer ${KEY}`, ...base() }, body: "{oops" }))).status).toBe(400);
});

test("tools/call relays to the gateway with the session of the headers", async () => {
  const d = daemon();
  const res = await d.handle(post(toolCall(3), { "x-ais-owner-pid": "4242", "x-ais-session-id": "sess-1" }));
  const body: any = await res.json();
  expect(body.result.content).toEqual([{ type: "text", text: "done" }]);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe("http://gw.test/browser/call");
  expect(calls[0]!.auth).toBe("Bearer tok");
  expect(calls[0]!.body.session.id).toBe("sess-1");
  expect(calls[0]!.body.session.identity).toBe("work");
  expect(calls[0]!.body.tool).toBe("list_browsers");
});

test("two sessions in parallel get separate contexts and separate session ids", async () => {
  const d = daemon();
  await Promise.all([
    d.handle(post(toolCall(1), { "x-ais-session-id": "s-a", "x-ais-owner-pid": "100" })),
    d.handle(post(toolCall(1), { "x-ais-session-id": "s-b", "x-ais-owner-pid": "200" })),
  ]);
  await d.handle(post(toolCall(2), { "x-ais-session-id": "s-a", "x-ais-owner-pid": "100" }));
  expect(d.sessions.size).toBe(2);
  expect(calls.map((c) => c.body.session.id).sort()).toEqual(["s-a", "s-a", "s-b"]);
});

test("a launch without a session id is keyed on the agent pid; claude's own record of the process wins over the header", async () => {
  const d = daemon({ readClaudeSessionId: (_home, pid) => (pid === 300 ? "from-process" : undefined) });
  await d.handle(post(toolCall(1), { "x-ais-owner-pid": "100" }));
  await d.handle(post(toolCall(1), { "x-ais-owner-pid": "300", "x-ais-home": encodeURIComponent(dir), "x-ais-session-id": "from-launch" }));
  expect(calls.map((c) => c.body.session.id)).toEqual(["agent-100", "from-process"]);
});

test("the reaper sends session end once when the owner pid is gone, then drops the context", async () => {
  let alive = true;
  const d = daemon({ pidAlive: () => alive });
  await d.handle(post(toolCall(1), { "x-ais-session-id": "s-a", "x-ais-owner-pid": "100" }));
  expect(await d.reap()).toBe(0);
  alive = false;
  expect(await d.reap()).toBe(1);
  expect(await d.reap()).toBe(0);
  expect(d.sessions.size).toBe(0);
  expect(calls.filter((c) => c.body.tool === "session_end")).toHaveLength(1);
  expect(calls.at(-1)!.body.session.id).toBe("s-a");
});

test("a session that never called a tool sends no end notice; an idle session without a pid expires", async () => {
  let t = 1_000;
  const d = daemon({ now: () => t, idleMs: 60_000 });
  await d.handle(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { "x-ais-session-id": "quiet", "x-ais-owner-pid": "100" }));
  await d.handle(post(toolCall(1), { "x-ais-session-id": "nopid" }));
  expect(await d.reap()).toBe(0);
  t += 61_000;
  expect(await d.reap()).toBe(1);
  expect(calls.filter((c) => c.body.tool === "session_end")).toHaveLength(1);
});

test("DELETE ends that session once", async () => {
  const d = daemon();
  await d.handle(post(toolCall(1), { "x-ais-session-id": "s-a" }));
  const del = () => d.handle(new Request("http://127.0.0.1:47150/mcp", { method: "DELETE", headers: { authorization: `Bearer ${KEY}`, ...base(), "x-ais-session-id": "s-a" } }));
  expect((await del()).status).toBe(204);
  expect((await del()).status).toBe(204);
  expect(calls.filter((c) => c.body.tool === "session_end")).toHaveLength(1);
  expect(d.sessions.size).toBe(0);
});

test("a daemon restart is invisible: a fresh daemon serves a known session, and a stopped one never ends live sessions", async () => {
  const first = daemon();
  await first.handle(post(toolCall(1), { "x-ais-session-id": "s-a", "x-ais-owner-pid": "100", "mcp-session-id": "old-id" }));
  await first.drain();
  const before = calls.length;
  const second = daemon();
  const res = await second.handle(post(toolCall(2), { "x-ais-session-id": "s-a", "x-ais-owner-pid": "100", "mcp-session-id": "old-id" }));
  expect(((await res.json()) as any).result.content[0].text).toBe("done");
  expect(calls.slice(before).map((c) => c.body.tool)).toEqual(["list_browsers"]);
  expect(calls.slice(before)[0]!.body.session.id).toBe("s-a");
  expect(calls.filter((c) => c.body.tool === "session_end")).toHaveLength(0);
});

test("drain refuses new requests, reports not ready and waits for in-flight calls", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const d = daemon({ rpc: async (msg) => { await gate; return { jsonrpc: "2.0", id: msg.id ?? null, result: {} }; } });
  const inflight = d.handle(post(toolCall(1)));
  await Promise.resolve();
  let drained = false;
  const drain = d.drain().then(() => { drained = true; });
  await Promise.resolve();
  expect(drained).toBe(false);
  expect((await d.handle(post(toolCall(2)))).status).toBe(503);
  expect((await d.handle(new Request("http://127.0.0.1:47150/healthz"))).status).toBe(503);
  release();
  expect((await inflight).status).toBe(200);
  await drain;
  expect(drained).toBe(true);
});

test("the key file: created 0600 in a 0700 folder, reused, and a loose mode is tightened", async () => {
  const keyDir = join(dir, "browser-mcp");
  const key = ensureMcpKey(keyDir);
  expect(key).toMatch(/^[0-9a-f]{64}$/);
  expect((await stat(join(keyDir, "key"))).mode & 0o777).toBe(0o600);
  expect((await stat(keyDir)).mode & 0o777).toBe(0o700);
  expect(ensureMcpKey(keyDir)).toBe(key);
  expect(readMcpKey(keyDir)).toBe(key);
  expect(readMcpKey(join(dir, "none"))).toBeUndefined();
  await Bun.$`chmod 644 ${join(keyDir, "key")}`;
  ensureMcpKey(keyDir);
  expect((await stat(join(keyDir, "key"))).mode & 0o777).toBe(0o600);
});
