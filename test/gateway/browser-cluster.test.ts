import { afterEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { migrate } from "../../src/gateway/pg-store.ts";
import { BrowserHub } from "../../src/gateway/browser/hub.ts";
import { ClusterBrowserHub, relaySecret, RELAY_PATH } from "../../src/gateway/browser/cluster.ts";
import type { CallRequest } from "../../src/browser/protocol.ts";
import type { BrowserBinding } from "../../src/browser/types.ts";

const url = process.env.AIS_GATEWAY_TEST_DATABASE_URL;
const optOut = process.env.AIS_GATEWAY_TEST_NO_DATABASE === "1";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TOKEN = "SYNTHETIC_FIXTURE-admin-token";

if (!url && process.env.CI && !optOut) {
  test("browser cluster tests need AIS_GATEWAY_TEST_DATABASE_URL in CI", () => {
    throw new Error("AIS_GATEWAY_TEST_DATABASE_URL is unset in CI; provide a Postgres service or set AIS_GATEWAY_TEST_NO_DATABASE=1");
  });
} else if (!url) {
  test.skip("browser cluster tests need AIS_GATEWAY_TEST_DATABASE_URL", () => {});
} else {
  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (!dbName.includes("test")) throw new Error(`refusing to use database "${dbName}": its name must contain "test"`);

  const binding = (name: string): BrowserBinding => ({ name, target: { kind: "identity", identity: "acct-a" }, profileLabel: "Profile", state: "active", createdAt: "2026-01-01T00:00:00.000Z" });

  interface Replica {
    cluster: ClusterBrowserHub;
    hub: BrowserHub;
    server: ReturnType<typeof Bun.serve>;
  }
  const replicas: Replica[] = [];

  async function replica(id: string): Promise<Replica> {
    const hub = new BrowserHub({ authToken: async () => undefined });
    let cluster: ClusterBrowserHub | undefined;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => (new URL(req.url).pathname === RELAY_PATH && cluster ? cluster.handleRelay(req) : new Response("nope", { status: 404 })),
    });
    cluster = new ClusterBrowserHub({ hub, databaseUrl: url as string, replicaId: id, replicaUrl: `http://127.0.0.1:${server.port}`, adminToken: TOKEN, presenceMs: 200, staleMs: 1000 });
    await cluster.start();
    const r = { cluster, hub, server };
    replicas.push(r);
    return r;
  }

  /** Fake extension socket: answers `call` frames with a text result. */
  function fakeSocket(hub: BrowserHub) {
    const frames: Array<{ t: string; [k: string]: unknown }> = [];
    const closed: number[] = [];
    const ws = {
      send(data: string) {
        const f = JSON.parse(data);
        frames.push(f);
        if (f.t === "call") queueMicrotask(() => void hub.message(ws, JSON.stringify({ t: "result", result: { id: f.req.id, ok: true, content: [{ type: "text", text: `echo ${f.req.args.q}` }] } })));
        return 1;
      },
      close(code?: number) {
        closed.push(code ?? 1005);
      },
    };
    return { ws, frames, closed };
  }

  const req = (id: string): CallRequest => ({ id, session: { id: "sess-1", identity: "acct-a", label: "" }, tool: "tabs" as CallRequest["tool"], args: { q: "hi" } });

  async function until(cond: () => boolean, ms = 5000): Promise<void> {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error("condition not met in time");
      await sleep(25);
    }
  }

  afterEach(async () => {
    for (const r of replicas.splice(0)) {
      await r.cluster.stop();
      r.hub.closeAll(1001);
      r.server.stop(true);
    }
  });

  async function prepare(): Promise<void> {
    await migrate(url as string);
    const sql = new SQL(url as string);
    try {
      await sql`DELETE FROM gateway_browser_presence`;
      await sql`INSERT INTO browser_bindings (name, target, profile_label, state, created_at) VALUES ('work', '{"kind":"identity","identity":"acct-a"}'::jsonb, 'Profile', 'active', now())
        ON CONFLICT (name) DO UPDATE SET state = 'active'`;
    } finally {
      await sql.close();
    }
  }

  describe("ClusterBrowserHub", () => {
    test("a call on replica B reaches the extension on replica A", async () => {
      await prepare();
      const a = await replica("replica-a");
      const b = await replica("replica-b");
      const sock = fakeSocket(a.hub);
      a.cluster.open(sock.ws);
      a.hub.attach(sock.ws, binding("work"));
      await until(() => b.cluster.connected().some((x) => x.name === "work"));
      expect(a.cluster.connected().map((x) => x.name)).toEqual(["work"]);
      const res = await b.cluster.call("work", req("call-1"), 5000);
      expect(res).toEqual({ id: "call-1", ok: true, content: [{ type: "text", text: "echo hi" }] });
      expect(sock.frames.filter((f) => f.t === "call")).toHaveLength(1);
    });

    test("an unknown binding is no_browser", async () => {
      await prepare();
      const b = await replica("replica-b");
      const res = await b.cluster.call("ghost", req("call-2"), 1000);
      expect(res).toMatchObject({ ok: false, error: "no_browser" });
    });

    test("revoke on B closes the socket on A", async () => {
      await prepare();
      const a = await replica("replica-a");
      const b = await replica("replica-b");
      const sock = fakeSocket(a.hub);
      a.hub.attach(sock.ws, binding("work"));
      await until(() => b.cluster.connected().length === 1);
      b.cluster.revoke("work");
      await until(() => sock.closed.length > 0);
      expect(sock.closed).toEqual([4401]);
      await until(() => b.cluster.connected().length === 0);
    });

    test("a caller abort reaches the extension on the other replica", async () => {
      await prepare();
      const a = await replica("replica-a");
      const b = await replica("replica-b");
      const frames: Array<{ t: string }> = [];
      const ws = { send: (d: string) => (frames.push(JSON.parse(d)), 1), close() {} };
      a.hub.attach(ws, binding("work"));
      await until(() => b.cluster.connected().length === 1);
      const pending = b.cluster.call("work", req("call-3"), 10_000);
      await until(() => frames.some((f) => f.t === "call"));
      b.cluster.abort("call-3");
      expect(await pending).toMatchObject({ ok: false, error: "timeout" });
      await until(() => frames.some((f) => f.t === "abort"));
    });

    test("when replica A stops, B no longer sees the browser", async () => {
      await prepare();
      const a = await replica("replica-a");
      const b = await replica("replica-b");
      const sock = fakeSocket(a.hub);
      a.hub.attach(sock.ws, binding("work"));
      await until(() => b.cluster.connected().length === 1);
      await a.cluster.stop();
      await until(() => b.cluster.connected().length === 0);
      expect(await b.cluster.call("work", req("call-4"), 1000)).toMatchObject({ ok: false, error: "no_browser" });
    });

    test("a dead replica's row goes stale; an unreachable replica gives browser_disconnected", async () => {
      await prepare();
      const a = await replica("replica-a");
      const b = await replica("replica-b");
      const sock = fakeSocket(a.hub);
      a.hub.attach(sock.ws, binding("work"));
      await until(() => b.cluster.connected().length === 1);
      a.server.stop(true);
      expect(await b.cluster.call("work", req("call-5"), 1000)).toMatchObject({ ok: false, error: "browser_disconnected" });
    });

    test("the newer connection wins across replicas (4409)", async () => {
      await prepare();
      const a = await replica("replica-a");
      const b = await replica("replica-b");
      const old = fakeSocket(a.hub);
      a.hub.attach(old.ws, binding("work"));
      await until(() => b.cluster.connected().length === 1);
      await sleep(20);
      const fresh = fakeSocket(b.hub);
      b.hub.attach(fresh.ws, binding("work"));
      await until(() => old.closed.length > 0);
      expect(old.closed).toEqual([4409]);
      expect(fresh.closed).toEqual([]);
      await until(() => a.cluster.connected().length === 1);
      expect((await a.cluster.call("work", req("call-6"), 3000)).ok).toBe(true);
    });

    test("a binding revoked in SQL without a NOTIFY disappears and is refused by the relay", async () => {
      await prepare();
      const a = await replica("replica-a");
      const b = await replica("replica-b");
      const sock = fakeSocket(a.hub);
      a.hub.attach(sock.ws, binding("work"));
      await until(() => b.cluster.connected().length === 1);
      const sql = new SQL(url as string);
      try {
        await sql`UPDATE browser_bindings SET state = 'revoked' WHERE name = 'work'`;
      } finally {
        await sql.close();
      }
      // The next presence tick drops it from the other replica's view.
      await until(() => b.cluster.connected().length === 0);
      // A relay that still reaches A is refused and A drops its socket.
      const res = await fetch(`http://127.0.0.1:${a.server.port}${RELAY_PATH}`, {
        method: "POST",
        body: JSON.stringify({ binding: "work", req: req("call-8"), timeoutMs: 1000 }),
        headers: { authorization: `Bearer ${relaySecret(TOKEN)}` },
      });
      expect(await res.json()).toMatchObject({ ok: false, error: "no_browser" });
      expect(sock.frames.filter((f) => f.t === "call")).toHaveLength(0);
      expect(sock.closed).toEqual([4401]);
    });

    test("relay endpoint rejects a bad or missing admin token", async () => {
      await prepare();
      const a = await replica("replica-a");
      const body = JSON.stringify({ binding: "work", req: req("call-7"), timeoutMs: 1000 });
      const url = `http://127.0.0.1:${a.server.port}${RELAY_PATH}`;
      expect((await fetch(url, { method: "POST", body, headers: { authorization: "Bearer wrong" } })).status).toBe(401);
      expect((await fetch(url, { method: "POST", body })).status).toBe(401);
      expect((await fetch(url, { method: "POST", body: "{", headers: { authorization: `Bearer ${relaySecret(TOKEN)}` } })).status).toBe(400);
      // The admin token itself is not accepted: replicas only ever send the derived relay secret.
      expect((await fetch(url, { method: "POST", body, headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(401);
    });
  });
}
