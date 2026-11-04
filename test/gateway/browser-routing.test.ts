import { beforeEach, describe, expect, test } from "bun:test";
import type { BrowserBinding } from "../../src/browser/types.ts";
import { createGatewayApp } from "../../src/gateway/app.ts";
import { BrowserHub, type HubSocket } from "../../src/gateway/browser/hub.ts";
import { allowedBindings } from "../../src/gateway/browser/routing.ts";
import { MemoryGatewayStore } from "../../src/gateway/store.ts";
import { generateToken, hashSecret, parseToken } from "../../src/gateway/tokens.ts";

const b = (name: string, target: BrowserBinding["target"]): BrowserBinding => ({ name, target, profileLabel: name, state: "active", createdAt: "2026-11-04T00:00:00.000Z" });
let members: Record<string, string[]>;
const pools = async (p: string) => members[p] ?? [];

describe("allowedBindings", () => {
  beforeEach(() => {
    members = { main: ["id1", "id2"] };
  });
  test("identity pin matches only that identity", async () => {
    const list = [b("w", { kind: "identity", identity: "id1" })];
    expect(await allowedBindings("id1", list, pools)).toHaveLength(1);
    expect(await allowedBindings("id2", list, pools)).toHaveLength(0);
  });
  test("pool binding matches members", async () => {
    const list = [b("w", { kind: "pool", pool: "main" })];
    expect(await allowedBindings("id2", list, pools)).toHaveLength(1);
    expect(await allowedBindings("zzz", list, pools)).toHaveLength(0);
  });
  test("identity removed from the pool loses access on the next call", async () => {
    const list = [b("w", { kind: "pool", pool: "main" })];
    expect(await allowedBindings("id2", list, pools)).toHaveLength(1);
    members.main = ["id1"];
    expect(await allowedBindings("id2", list, pools)).toHaveLength(0);
  });
});

class Ws implements HubSocket {
  sent: Array<{ t: string; req?: { id: string; session: { identity: string } } }> = [];
  send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  close() {}
}

describe("POST /browser/call", () => {
  let store: MemoryGatewayStore;
  let hub: BrowserHub;
  let app: ReturnType<typeof createGatewayApp>;
  let agent: string;

  const call = (body: unknown, token = agent) =>
    app.request("http://gw.test/browser/call", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const session = { id: "s1", identity: "spoofed", label: "L" };
  /** Answers the next call on a socket. */
  function answer(ws: Ws, text = "ok") {
    const t = setInterval(() => {
      const c = ws.sent.find((m) => m.t === "call");
      if (!c?.req) return;
      clearInterval(t);
      ws.sent = [];
      void hub.message(ws, JSON.stringify({ t: "result", result: { id: c.req.id, ok: true, content: [{ type: "text", text }] } }));
    }, 2);
  }
  async function connect(binding: BrowserBinding): Promise<Ws> {
    const ws = new Ws();
    hub.open(ws);
    hub.attach(ws, binding);
    return ws;
  }

  beforeEach(async () => {
    members = { main: ["id1", "id2"] };
    store = new MemoryGatewayStore();
    hub = new BrowserHub({ authToken: async () => undefined });
    app = createGatewayApp({ store, now: () => new Date(), browserPoolMembers: async (p: string) => members[p], metrics: undefined, browserHub: hub } as never);
    const t = generateToken();
    const parsed = parseToken(t.token);
    expect(parsed && hashSecret(parsed.secret)).toBe(t.hash);
    await store.addAgentToken({ identity: "id1", prefix: t.prefix, hash: t.hash, createdAt: "2026-11-04T00:00:00.000Z" });
    agent = t.token;
  });

  test("rejects a missing or wrong agent token", async () => {
    expect((await call({ session, tool: "navigate" }, "aisg_nope_nope")).status).toBe(401);
  });

  test("routes to the identity-pinned binding and overwrites session.identity from the token", async () => {
    const ws = await connect(b("w", { kind: "identity", identity: "id1" }));
    const seen: string[] = [];
    const orig = ws.send.bind(ws);
    ws.send = (d: string) => {
      seen.push((JSON.parse(d) as { req: { session: { identity: string } } }).req.session.identity);
      orig(d);
    };
    answer(ws);
    const res = await call({ session, tool: "navigate", args: { url: "https://example.test" } });
    expect(await res.json()).toMatchObject({ ok: true });
    expect(seen).toEqual(["id1"]);
  });

  test("routes through a pool binding", async () => {
    const ws = await connect(b("w", { kind: "pool", pool: "main" }));
    answer(ws);
    expect(await (await call({ session, tool: "screenshot" })).json()).toMatchObject({ ok: true });
  });

  test("identity removed from the pool gets no_browser", async () => {
    await connect(b("w", { kind: "pool", pool: "main" }));
    members.main = ["id2"];
    expect(await (await call({ session, tool: "screenshot" })).json()).toMatchObject({ ok: false, error: "no_browser" });
  });

  test("two bindings are ambiguous without browser, and work with it", async () => {
    await connect(b("w1", { kind: "identity", identity: "id1" }));
    const ws2 = await connect(b("w2", { kind: "pool", pool: "main" }));
    expect(await (await call({ session, tool: "screenshot" })).json()).toMatchObject({ ok: false, error: "ambiguous_browser" });
    answer(ws2);
    expect(await (await call({ session, tool: "screenshot", browser: "w2" })).json()).toMatchObject({ ok: true });
  });

  test("a connected binding outside the allowed set is 403", async () => {
    await connect(b("other", { kind: "identity", identity: "id9" }));
    expect((await call({ session, tool: "screenshot", browser: "other" })).status).toBe(403);
  });

  test("an unconnected named browser is no_browser", async () => {
    expect(await (await call({ session, tool: "screenshot", browser: "ghost" })).json()).toMatchObject({ error: "no_browser" });
  });

  test("list_browsers and GET /browser/list show only allowed bindings", async () => {
    await connect(b("w1", { kind: "identity", identity: "id1" }));
    await connect(b("other", { kind: "identity", identity: "id9" }));
    const r = (await (await call({ session, tool: "list_browsers" })).json()) as { content: Array<{ text: string }> };
    expect((JSON.parse(r.content[0]?.text ?? "[]") as Array<{ name: string }>).map((x) => x.name)).toEqual(["w1"]);
    const l = await app.request("http://gw.test/browser/list", { headers: { authorization: `Bearer ${agent}` } });
    expect(((await l.json()) as { browsers: Array<{ name: string }> }).browsers.map((x) => x.name)).toEqual(["w1"]);
  });

  test("bad bodies are 400", async () => {
    expect((await call({ session, tool: "nope" })).status).toBe(400);
    expect((await call({ tool: "navigate" })).status).toBe(400);
  });
});
