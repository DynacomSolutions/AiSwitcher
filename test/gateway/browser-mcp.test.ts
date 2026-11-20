import { beforeEach, describe, expect, test } from "bun:test";
import { BROWSER_TOOLS } from "../../src/browser/protocol.ts";
import type { BrowserBinding } from "../../src/browser/types.ts";
import { createGatewayApp } from "../../src/gateway/app.ts";
import { BrowserHub, type HubSocket } from "../../src/gateway/browser/hub.ts";
import { cleanSessionLabel, parseMcpHeaders, uploadPathsError } from "../../src/gateway/browser/mcp.ts";
import { PrometheusMetrics } from "../../src/gateway/metrics.ts";
import { MemoryGatewayStore } from "../../src/gateway/store.ts";
import { generateToken } from "../../src/gateway/tokens.ts";

const binding = (name: string, target: BrowserBinding["target"]): BrowserBinding => ({ name, target, profileLabel: name, state: "active", createdAt: "2026-11-04T00:00:00.000Z" });

class Ws implements HubSocket {
  sent: Array<{ t: string; req?: { id: string; tool: string; session: { id: string; identity: string; label: string } } }> = [];
  send(d: string) { this.sent.push(JSON.parse(d)); }
  close() {}
}

let members: Record<string, string[]>;
let store: MemoryGatewayStore;
let storeCalls: string[];
let hub: BrowserHub;
let metrics: PrometheusMetrics;
let app: ReturnType<typeof createGatewayApp>;
let token: string;

/** Answers calls on a socket until `stop()`. */
function answerAll(ws: Ws, text = "done"): () => void {
  const timer = setInterval(() => {
    for (const m of ws.sent.splice(0)) {
      if (m.t === "call" && m.req) void hub.message(ws, JSON.stringify({ t: "result", result: { id: m.req.id, ok: true, content: [{ type: "text", text }] } }));
    }
  }, 2);
  return () => clearInterval(timer);
}

async function connect(b: BrowserBinding): Promise<Ws> {
  const ws = new Ws();
  hub.open(ws);
  hub.attach(ws, b);
  return ws;
}

const rpc = (body: unknown, headers: Record<string, string> = {}, auth: string | null = token, method = "POST") =>
  app.request("http://gw.test/browser/mcp", {
    method,
    headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...headers },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
const call = (name: string, args: unknown, headers: Record<string, string> = { "X-AIS-Session-Id": "sess-1" }) =>
  rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, headers);
const metricLine = async (needle: string): Promise<string | undefined> => (await metrics.render()).split("\n").find((l) => l.includes(needle));

beforeEach(async () => {
  members = { main: ["id1", "id2"] };
  storeCalls = [];
  const inner = new MemoryGatewayStore();
  store = new Proxy(inner, { get: (t, p, r) => { const v = Reflect.get(t, p, r); return typeof v === "function" ? (...a: unknown[]) => { storeCalls.push(String(p)); return (v as (...x: unknown[]) => unknown).apply(t, a); } : v; } });
  hub = new BrowserHub({ authToken: async () => undefined });
  metrics = new PrometheusMetrics({ ledgerDepth: () => 0, ledgerDropped: () => 0 });
  app = createGatewayApp({ store, now: () => new Date(), browserPoolMembers: async (p: string) => members[p], metrics, browserHub: hub } as never);
  const t = generateToken();
  await inner.addAgentToken({ identity: "id1", prefix: t.prefix, hash: t.hash, createdAt: "2026-11-04T00:00:00.000Z" });
  token = t.token;
});

describe("POST /browser/mcp auth", () => {
  test("rejects a missing, malformed and wrong token with 401", async () => {
    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, {}, null)).status).toBe(401);
    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, {}, "aisg_nope_nope")).status).toBe(401);
    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, {}, "garbage")).status).toBe(401);
    expect((await rpc({}, {}, null, "DELETE")).status).toBe(401);
  });

  test("accepts a valid agent token", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  });

  test("GET is 405", async () => {
    const res = await rpc(null, {}, token, "GET");
    expect(res.status).toBe(405);
  });
});

describe("stateless registration", () => {
  test("tools/list works without initialize and reads only the token record", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 7, method: "tools/list" });
    const body = (await res.json()) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map((t) => t.name)).toEqual([...BROWSER_TOOLS]);
    expect(new Set(storeCalls)).toEqual(new Set(["agentTokenByPrefix"]));
  });

  test("initialize and ping do the same, and initialize carries the instructions", async () => {
    storeCalls.length = 0;
    const init = (await (await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).json()) as { result: { instructions: string; protocolVersion: string } };
    expect(init.result.protocolVersion).toBe("2025-06-18");
    expect(init.result.instructions).toContain("close_tab");
    await rpc({ jsonrpc: "2.0", id: 2, method: "ping" });
    expect(new Set(storeCalls)).toEqual(new Set(["agentTokenByPrefix"]));
  });

  test("initialize without a session id issues Mcp-Session-Id, and keeps a given one", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(res.headers.get("mcp-session-id")).toMatch(/^[0-9a-f-]{36}$/);
    // A client that sends its own id (Claude) gets that same id back, so its DELETE ends the right session.
    const own = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize" }, { "X-AIS-Session-Id": "mine" });
    expect(own.headers.get("mcp-session-id")).toBe("mine");
    const ping = await rpc({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(ping.headers.get("mcp-session-id")).toBeNull();
  });

  test("a notification gets 202", async () => {
    expect((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
  });
});

describe("tools/call", () => {
  test("runs the call path in-process: identity from the token, session id and label from headers", async () => {
    const ws = await connect(binding("w", { kind: "identity", identity: "id1" }));
    const seen: Array<{ id: string; identity: string; label: string }> = [];
    const orig = ws.send.bind(ws);
    ws.send = (d: string) => { seen.push((JSON.parse(d) as { req: { session: { id: string; identity: string; label: string } } }).req.session); orig(d); };
    const stop = answerAll(ws, "navigated");
    const res = await call("navigate", { tabId: 1, url: "https://example.test" }, { "X-AIS-Session-Id": "sess-1", "X-AIS-Session-Label": encodeURIComponent("My thread") });
    stop();
    const body = (await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(body.result.content[0]!.text).toBe("navigated");
    expect(body.result.isError).toBeUndefined();
    expect(seen).toEqual([{ id: "sess-1", identity: "id1", label: "My thread" }]);
  });

  test("falls back to Mcp-Session-Id, and a call with no session id is a tool error", async () => {
    const ws = await connect(binding("w", { kind: "identity", identity: "id1" }));
    const ids: string[] = [];
    const orig = ws.send.bind(ws);
    ws.send = (d: string) => { ids.push((JSON.parse(d) as { req: { session: { id: string } } }).req.session.id); orig(d); };
    const stop = answerAll(ws);
    await call("screenshot", { tabId: 1 }, { "Mcp-Session-Id": "from-mcp" });
    stop();
    expect(ids).toEqual(["from-mcp"]);
    const none = (await (await call("screenshot", { tabId: 1 }, {})).json()) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(none.result.isError).toBe(true);
    expect(none.result.content[0]!.text).toContain("no session id");
  });

  test("an unknown tool is a tool error", async () => {
    const out = (await (await call("rm_rf", {})).json()) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(out.result.isError).toBe(true);
    expect(out.result.content[0]!.text).toContain("unknown tool");
  });

  test("no browser connected is a tool error naming the code", async () => {
    const out = (await (await call("tabs_context", {})).json()) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(out.result.isError).toBe(true);
    expect(out.result.content[0]!.text).toStartWith("no_browser:");
  });

  test("upload_file with paths answers the CLI command with the real session id", async () => {
    const out = (await (await call("upload_file", { tabId: 4, ref: "ref_9", paths: ["/tmp/a b.txt", "/x/c.png"], browser: "work" }, { "X-AIS-Session-Id": "sess-up" })).json()) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(out.result.isError).toBe(true);
    expect(out.result.content[0]!.text).toContain("ais browser upload --session sess-up --tab 4 --ref ref_9 --browser work '/tmp/a b.txt' /x/c.png");
  });

  test("upload_file with files content goes through", async () => {
    const ws = await connect(binding("w", { kind: "identity", identity: "id1" }));
    const stop = answerAll(ws, "uploaded");
    const out = (await (await call("upload_file", { tabId: 4, ref: "r", files: [{ name: "a.txt", mimeType: "text/plain", data: "aGk=" }] })).json()) as { result: { content: Array<{ text: string }> } };
    stop();
    expect(out.result.content[0]!.text).toBe("uploaded");
  });
});

describe("pool header", () => {
  test("a member of the pool is allowed and a non member is refused", async () => {
    const ws = await connect(binding("w", { kind: "pool", pool: "main" }));
    const stop = answerAll(ws);
    const ok = (await (await call("tabs_context", {}, { "X-AIS-Session-Id": "s", "X-AIS-Pool": "main" })).json()) as { result: { isError?: boolean } };
    stop();
    expect(ok.result.isError).toBeUndefined();
    const bad = (await (await call("tabs_context", {}, { "X-AIS-Session-Id": "s", "X-AIS-Pool": "other" })).json()) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(bad.result.isError).toBe(true);
    expect(bad.result.content[0]!.text).toStartWith("forbidden:");
    members.main = ["id2"];
    const left = (await (await call("tabs_context", {}, { "X-AIS-Session-Id": "s", "X-AIS-Pool": "main" })).json()) as { result: { isError: boolean } };
    expect(left.result.isError).toBe(true);
  });

  test("a pool binding owns tabs per pool: the extension sees pool:<name>", async () => {
    const ws = await connect(binding("w", { kind: "pool", pool: "main" }));
    const idents: string[] = [];
    const orig = ws.send.bind(ws);
    ws.send = (d: string) => { idents.push((JSON.parse(d) as { req: { session: { identity: string } } }).req.session.identity); orig(d); };
    const stop = answerAll(ws);
    await call("tabs_context", {}, { "X-AIS-Session-Id": "s", "X-AIS-Pool": "main" });
    stop();
    expect(idents).toEqual(["pool:main"]);
  });
});

describe("header validation", () => {
  test("rejects bad ids and pool names with 400", async () => {
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
    expect((await rpc(ping, { "X-AIS-Session-Id": "bad id!" })).status).toBe(400);
    expect((await rpc(ping, { "X-AIS-Session-Id": "x".repeat(129) })).status).toBe(400);
    expect((await rpc(ping, { "Mcp-Session-Id": "../x" })).status).toBe(400);
    expect((await rpc(ping, { "X-AIS-Pool": "a b" })).status).toBe(400);
    expect((await rpc(ping, { "X-AIS-Session-Label": "%E0%A4%A" })).status).toBe(400);
    expect((await rpc(ping, { "X-AIS-Session-Label": "a".repeat(1025) })).status).toBe(400);
  });

  test("the label is decoded, cleaned and capped at 80 characters", () => {
    expect(cleanSessionLabel("a\n\tb   c\u0000d")).toBe("a b c d");
    expect(cleanSessionLabel("x".repeat(500))).toHaveLength(80);
    const ok = parseMcpHeaders((n) => (n === "x-ais-session-label" ? encodeURIComponent("Fix the login page ".repeat(20)) : null));
    expect(ok.ok && ok.value.label.length).toBe(80);
  });

  test("session id: X-AIS-Session-Id wins over Mcp-Session-Id", () => {
    const h = parseMcpHeaders((n) => ({ "x-ais-session-id": "a", "mcp-session-id": "b" })[n] ?? null);
    expect(h.ok && h.value.sessionId).toBe("a");
    const m = parseMcpHeaders((n) => ({ "mcp-session-id": "b" })[n] ?? null);
    expect(m.ok && m.value.sessionId).toBe("b");
  });

  test("malformed bodies are refused", async () => {
    const bad = await app.request("http://gw.test/browser/mcp", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{nope" });
    expect(bad.status).toBe(400);
    expect((await rpc([])).status).toBe(400);
    expect((await rpc(5)).status).toBe(400);
  });
});

describe("DELETE ends the session", () => {
  test("sends session_end for that session id to the allowed browser", async () => {
    const ws = await connect(binding("w", { kind: "identity", identity: "id1" }));
    const seen: Array<{ tool: string; id: string }> = [];
    const orig = ws.send.bind(ws);
    ws.send = (d: string) => { const r = (JSON.parse(d) as { req: { tool: string; session: { id: string } } }).req; seen.push({ tool: r.tool, id: r.session.id }); orig(d); };
    const stop = answerAll(ws);
    const res = await rpc(null, { "X-AIS-Session-Id": "sess-end" }, token, "DELETE");
    stop();
    expect(res.status).toBe(204);
    expect(seen).toEqual([{ tool: "session_end", id: "sess-end" }]);
  });

  test("Claude style: initialize with X-AIS-Session-Id returns it, and a DELETE with only that Mcp-Session-Id ends the session", async () => {
    const ws = await connect(binding("w", { kind: "identity", identity: "id1" }));
    const seen: Array<{ tool: string; id: string }> = [];
    const orig = ws.send.bind(ws);
    ws.send = (d: string) => { const r = (JSON.parse(d) as { req: { tool: string; session: { id: string } } }).req; seen.push({ tool: r.tool, id: r.session.id }); orig(d); };
    const stop = answerAll(ws);
    const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize" }, { "X-AIS-Session-Id": "claude-sess" });
    const sid = init.headers.get("mcp-session-id")!;
    expect(sid).toBe("claude-sess");
    expect((await rpc(null, { "Mcp-Session-Id": sid }, token, "DELETE")).status).toBe(204);
    stop();
    expect(seen).toEqual([{ tool: "session_end", id: "claude-sess" }]);
  });

  test("needs a session id and, with a pool header, pool membership", async () => {
    expect((await rpc(null, {}, token, "DELETE")).status).toBe(400);
    expect((await rpc(null, { "X-AIS-Session-Id": "s", "X-AIS-Pool": "nope" }, token, "DELETE")).status).toBe(403);
  });
});

describe("metrics", () => {
  test("counts requests by method and outcome", async () => {
    await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, {}, "aisg_nope_nope");
    await call("tabs_context", {});
    await rpc(null, { "X-AIS-Session-Id": "s" }, token, "DELETE");
    const text = await metrics.render();
    expect(text).toContain('ais_gateway_browser_mcp_requests_total{method="tools/list",outcome="ok"} 1');
    expect(text).toContain('ais_gateway_browser_mcp_requests_total{method="other",outcome="unauthorised"} 1');
    expect(text).toContain('ais_gateway_browser_mcp_requests_total{method="tools/call",outcome="tool_error"} 1');
    expect(text).toContain('ais_gateway_browser_mcp_requests_total{method="delete",outcome="ok"} 1');
  });

  test("unknown labels collapse to fixed values", () => {
    metrics.browserMcpRequest("evil/method", "weird");
    return expect(metricLine('method="other",outcome="error"')).resolves.toContain("1");
  });
});

describe("cancel", () => {
  /** A fake replica: its hub holds a call until it is aborted. Cancels fan out over a shared bus, as the cluster hub does with NOTIFY. */
  function replica(bus: Set<(key: string) => void>, innerStore: MemoryGatewayStore) {
    const aborted: string[] = [];
    const waiting = new Map<string, (r: unknown) => void>();
    let handler: ((key: string) => void) | undefined;
    const fakeHub = {
      connected: () => [binding("w", { kind: "identity", identity: "id1" }), binding("w2", { kind: "identity", identity: "id2" })],
      call: (_name: string, req: { id: string }) => new Promise((resolve) => { waiting.set(req.id, resolve); }),
      abort: (id: string) => { aborted.push(id); waiting.get(id)?.({ id, ok: false, error: "internal", message: "cancelled" }); },
      revoke() {},
      extensionVersion: () => undefined,
      onCancel: (h: (key: string) => void) => { handler = h; bus.add(h); },
      broadcastCancel: (key: string) => { for (const h of bus) if (h !== handler) h(key); },
    };
    const a = createGatewayApp({ store: innerStore, now: () => new Date(), browserPoolMembers: async (p: string) => members[p], metrics, browserHub: fakeHub } as never);
    return { app: a, aborted };
  }
  const post = (a: ReturnType<typeof createGatewayApp>, tok: string, body: unknown) =>
    a.request("http://gw.test/browser/mcp", { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json", "X-AIS-Session-Id": "sess-c" }, body: JSON.stringify(body) });
  const callMsg = { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "tabs_context", arguments: {} } };
  const cancelMsg = { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 9 } };
  const tick = () => new Promise((r) => setTimeout(r, 20));

  async function tokenFor(identity: string): Promise<string> {
    const t = generateToken();
    await (store as unknown as MemoryGatewayStore).addAgentToken({ identity, prefix: t.prefix, hash: t.hash, createdAt: "2026-11-04T00:00:00.000Z" });
    return t.token;
  }

  test("a cancel on the same replica aborts the running call", async () => {
    const bus = new Set<(k: string) => void>();
    const r = replica(bus, store as unknown as MemoryGatewayStore);
    const running = post(r.app, token, callMsg);
    await tick();
    expect((await post(r.app, token, cancelMsg)).status).toBe(202);
    const body = (await (await running).json()) as { result: { isError: boolean } };
    expect(r.aborted).toHaveLength(1);
    expect(body.result.isError).toBe(true);
  });

  test("a cancel that lands on another replica aborts the call there", async () => {
    const bus = new Set<(k: string) => void>();
    const a = replica(bus, store as unknown as MemoryGatewayStore);
    const b = replica(bus, store as unknown as MemoryGatewayStore);
    const running = post(a.app, token, callMsg);
    await tick();
    await post(b.app, token, cancelMsg);
    await running;
    expect(a.aborted).toHaveLength(1);
    expect(b.aborted).toHaveLength(0);
  });

  test("a cancel from another identity never aborts the call", async () => {
    const bus = new Set<(k: string) => void>();
    const a = replica(bus, store as unknown as MemoryGatewayStore);
    const b = replica(bus, store as unknown as MemoryGatewayStore);
    const other = await tokenFor("id2");
    const running = post(a.app, token, callMsg);
    await tick();
    await post(a.app, other, cancelMsg);
    await post(b.app, other, cancelMsg);
    await tick();
    expect(a.aborted).toHaveLength(0);
    await post(a.app, token, cancelMsg);
    await running;
    expect(a.aborted).toHaveLength(1);
  });
});

describe("hardening", () => {
  test("a 401 and a pool refusal tell the agent to restart the session", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, {}, "aisg_nope_nope");
    expect(((await res.json()) as { error: string }).error).toContain("Restart the session");
    const out = (await (await call("tabs_context", {}, { "X-AIS-Session-Id": "s", "X-AIS-Pool": "other" })).json()) as { result: { content: Array<{ text: string }> } };
    expect(out.result.content[0]!.text).toContain("restart the session to pick up the new token");
  });

  test("a declared body over the limit is refused before reading, and bytes are counted", async () => {
    const big = await app.request("http://gw.test/browser/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-length": String(17 * 1024 * 1024) }, body: "{}" });
    expect(big.status).toBe(413);
  });

  test("the upload error carries the session label", async () => {
    const out = (await (await call("upload_file", { tabId: 1, ref: "r", paths: ["/a"] }, { "X-AIS-Session-Id": "s9", "X-AIS-Session-Label": encodeURIComponent("My chat") })).json()) as { result: { content: Array<{ text: string }> } };
    expect(out.result.content[0]!.text).toContain("--session s9 --label 'My chat' --tab 1");
  });
});

describe("uploadPathsError", () => {
  test("names the coordinate form and a placeholder when the target is missing", () => {
    expect(uploadPathsError("s1", { tabId: 2, coordinate: [10, 20], paths: ["/a"] })).toContain("--session s1 --tab 2 --coordinate 10,20 /a");
    expect(uploadPathsError("s1", { paths: 5 })).toContain("--tab <tabId> (--ref <ref> | --coordinate <x,y>)");
  });
});
