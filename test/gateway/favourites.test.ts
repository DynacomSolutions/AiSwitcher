import { afterEach, expect, test } from "bun:test";
import type { FavKey } from "../../src/browser/chat-protocol.ts";
import { createAdminApp } from "../../src/gateway/admin.ts";
import { favouritesToken } from "../../src/gateway/favourites-token.ts";
import type { BrowserBinding } from "../../src/browser/types.ts";
import { BrowserHub, type HubSocket } from "../../src/gateway/browser/hub.ts";
import { MemoryChatBus, parseBusMsg } from "../../src/gateway/chat/bus.ts";
import { FavouritesService } from "../../src/gateway/chat/favourites.ts";
import { MemoryFavouriteStore } from "../../src/gateway/chat/favourites-store.ts";
import { ChatFrames } from "../../src/gateway/chat/frames.ts";
import { MemoryChatStore } from "../../src/gateway/chat/store.ts";
import { PrometheusMetrics } from "../../src/gateway/metrics.ts";
import { MemoryGatewayStore } from "../../src/gateway/store.ts";

class FakeWs implements HubSocket {
  sent: Array<Record<string, any>> = [];
  send(d: string) {
    this.sent.push(JSON.parse(d));
    return d.length;
  }
  close() {}
  of(t: string): Array<Record<string, any>> {
    return this.sent.filter((m) => m.t === t);
  }
}

const binding = (name: string): BrowserBinding => ({ name, target: { kind: "identity", identity: "id1" }, profileLabel: "p", state: "active", createdAt: "2026-11-04T00:00:00.000Z" });
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Bun.sleep(5);
};
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** One gateway replica: hub, service and frames over a shared store and bus. */
async function replica(shared: { store: MemoryFavouriteStore; bus: MemoryChatBus }, names: Record<string, string>, metrics?: PrometheusMetrics, extra: Pick<ConstructorParameters<typeof FavouritesService>[0], "maxWaiters" | "pools" | "migrateRetryMs"> = {}) {
  const bindings: Record<string, BrowserBinding> = Object.fromEntries(Object.entries(names).map(([tok, n]) => [tok, binding(n)]));
  let frames!: ChatFrames;
  const hub = new BrowserHub({ authToken: async (t) => bindings[t], onChat: (b, m, r) => frames.handle(b, m, r), onAttach: (b) => frames.onAttach(b) });
  const favourites = new FavouritesService({ store: shared.store, bus: shared.bus, hub, ...(metrics ? { metrics } : {}), fallbackPollMs: 50, ...extra });
  frames = new ChatFrames({
    broker: { create: async () => ({ code: "unavailable", message: "x" }) as never, dispatch: async () => undefined },
    store: new MemoryChatStore(),
    bus: shared.bus,
    catalog: { get: async () => [], check: async () => "ok" },
    hub,
    maxPerWindow: 6,
    favourites,
    ...(metrics ? { metrics } : {}),
  });
  await frames.start();
  await favourites.start();
  const sockets: FakeWs[] = [];
  const connect = async (token: string): Promise<FakeWs> => {
    const ws = new FakeWs();
    sockets.push(ws);
    hub.open(ws);
    await hub.message(ws, JSON.stringify({ t: "hello", token, version: "1", paused: false }));
    await settle();
    return ws;
  };
  cleanups.push(async () => {
    for (const ws of sockets) hub.detach(ws);
    await favourites.stop();
    await frames.stop();
  });
  return { hub, favourites, frames, connect, send: async (ws: FakeWs, f: unknown) => { await hub.message(ws, JSON.stringify(f)); await settle(); } };
}
const newShared = () => ({ store: new MemoryFavouriteStore(), bus: new MemoryChatBus() });
const star = (model: string, op: "add" | "remove" = "add", extra: object = {}) => ({ provider: "claude", identity: "work", model, op, ...extra });

test("a panel that attaches gets the list at once, and asks for it again", async () => {
  const shared = newShared();
  await shared.store.apply([{ provider: "claude", identity: "work", model: "m1", op: "add" }], "t3", Date.now());
  const r = await replica(shared, { a: "bind-a" });
  const ws = await r.connect("a");
  expect(ws.of("chat.fav.list")).toEqual([{ t: "chat.fav.list", seq: 1, epoch: (await shared.store.list()).epoch, items: [{ provider: "claude", identity: "work", model: "m1" }] }]);
  await r.send(ws, { t: "chat.fav.list" });
  expect(ws.of("chat.fav.list")).toHaveLength(2);
  expect(ws.of("chat.reject")).toEqual([]);
});

test("chat.fav.set answers with the list, and every other panel on every replica gets it pushed", async () => {
  const shared = newShared();
  const a = await replica(shared, { a: "bind-a", b: "bind-b" });
  const other = await replica(shared, { c: "bind-c" });
  const wa = await a.connect("a");
  const wb = await a.connect("b");
  const wc = await other.connect("c");
  await a.send(wa, { t: "chat.fav.set", changes: [star("m1"), star("m2")] });
  const last = (w: FakeWs) => w.of("chat.fav.list").at(-1)!;
  for (const w of [wa, wb, wc]) expect(last(w).items.map((i: any) => i.model)).toEqual(["m1", "m2"]);
  expect(last(wa).seq).toBe(2);
  // A remove from the second panel reaches the first.
  await a.send(wb, { t: "chat.fav.set", changes: [star("m1", "remove")] });
  for (const w of [wa, wb, wc]) expect(last(w).items.map((i: any) => i.model)).toEqual(["m2"]);
});

test("the reply to chat.fav.set names the refused changes with their reason, and a push to another panel does not", async () => {
  const shared = newShared();
  const metrics = new PrometheusMetrics({ ledgerDepth: () => 0, ledgerDropped: () => 0 });
  const r = await replica(shared, { a: "bind-a", b: "bind-b" }, metrics);
  const wa = await r.connect("a");
  const wb = await r.connect("b");
  await r.send(wa, { t: "chat.fav.set", changes: [star("m1", "add", { at: Date.now() - 3000 }), star("m1", "remove", { at: Date.now() - 1000 })] });
  // A late add loses to the newer removal.
  await r.send(wa, { t: "chat.fav.set", changes: [star("m1", "add", { at: Date.now() - 9000 })] });
  expect(wa.of("chat.fav.list").at(-1)!.refused).toEqual([{ provider: "claude", identity: "work", model: "m1", reason: "stale" }]);
  // Fill the list, then one more add is refused for the cap.
  await r.send(wa, { t: "chat.fav.set", changes: Array.from({ length: 200 }, (_, i) => star(`c${i}`)) });
  expect(wa.of("chat.fav.list").at(-1)!.refused).toBeUndefined();
  await r.send(wa, { t: "chat.fav.set", changes: [star("one-more")] });
  expect(wa.of("chat.fav.list").at(-1)!.refused).toEqual([{ provider: "claude", identity: "work", model: "one-more", reason: "cap" }]);
  expect(wb.of("chat.fav.list").every((m) => m.refused === undefined)).toBe(true);
  expect(metrics.render()).toMatch(/ais_gateway_favourites_total\{event="refused",reason="cap"\} 1/);
});

test("a frame that is not valid is dropped and the socket still works", async () => {
  const r = await replica(newShared(), { a: "bind-a" });
  const ws = await r.connect("a");
  await r.send(ws, { t: "chat.fav.set", changes: [{ provider: "bash", identity: "work", model: "m", op: "add" }] });
  await r.send(ws, { t: "chat.fav.set", changes: [star("m1")] });
  expect(ws.of("chat.fav.list").at(-1)!.items).toHaveLength(1);
});

test("without the service a favourites frame is refused as unavailable", async () => {
  const bindings = { a: binding("bind-a") };
  let frames!: ChatFrames;
  const hub = new BrowserHub({ authToken: async (t) => (bindings as Record<string, BrowserBinding>)[t], onChat: (b, m, r) => frames.handle(b, m, r) });
  frames = new ChatFrames({ broker: { create: async () => ({ code: "unavailable", message: "x" }) as never, dispatch: async () => undefined }, store: new MemoryChatStore(), bus: new MemoryChatBus(), catalog: { get: async () => [], check: async () => "ok" }, hub, maxPerWindow: 6 });
  const ws = new FakeWs();
  hub.open(ws);
  await hub.message(ws, JSON.stringify({ t: "hello", token: "a", version: "1", paused: false }));
  await hub.message(ws, JSON.stringify({ t: "chat.fav.list" }));
  await settle();
  expect(ws.of("chat.reject")).toMatchObject([{ code: "unavailable" }]);
  hub.detach(ws);
});

test("the bus carries a favourites notice and refuses a bad one", () => {
  expect(parseBusMsg('{"t":"favs","seq":4}')).toEqual({ t: "favs", seq: 4 });
  expect(parseBusMsg('{"t":"favs","seq":"4"}')).toBeUndefined();
  expect(parseBusMsg('{"t":"favs"}')).toBeUndefined();
});

// ---- HTTP routes ------------------------------------------------------------------------------------------------

const ADMIN = "adm-test-value-0001-0123456789abcdef";
async function http(over: { present?: boolean; maxWaiters?: number } = {}) {
  const shared = newShared();
  const metrics = new PrometheusMetrics({ ledgerDepth: () => 0, ledgerDropped: () => 0 });
  const r = await replica(shared, { a: "bind-a" }, metrics, over.maxWaiters !== undefined ? { maxWaiters: over.maxWaiters } : {});
  const app = createAdminApp({ store: new MemoryGatewayStore(), adminToken: ADMIN, now: () => new Date(), ...(over.present === false ? {} : { favourites: () => r.favourites }), metrics });
  const call = async (path: string, init: RequestInit & { token?: string | null } = {}): Promise<Response> => {
    const { token = ADMIN, ...rest } = init;
    return await app.request(`http://admin.test${path}`, { ...rest, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" } });
  };
  return { ...r, call, metrics, shared };
}
const post = (h: Awaited<ReturnType<typeof http>>, body: unknown) => h.call("/favourites", { method: "POST", body: JSON.stringify(body) });

test("GET and POST /favourites need the admin token", async () => {
  const h = await http();
  expect((await h.call("/favourites", { token: null })).status).toBe(401);
  expect((await h.call("/favourites", { token: "wrong" })).status).toBe(401);
  expect((await h.call("/favourites", { method: "POST", token: null, body: "{}" })).status).toBe(401);
});

test("the favourites token opens GET and POST /favourites and nothing else", async () => {
  const h = await http();
  const token = favouritesToken(ADMIN);
  expect(token).toMatch(/^[0-9a-f]{64}$/);
  expect(token).not.toBe(ADMIN);
  expect((await h.call("/favourites", { token })).status).toBe(200);
  const res = await h.call("/favourites", { method: "POST", token, body: JSON.stringify({ origin: "pod-1", changes: [star("m1")] }) });
  expect(res.status).toBe(200);
  expect(((await res.json()) as any).items).toHaveLength(1);
  // Every other route, including token minting and the credential store, refuses it.
  const others: Array<[string, string]> = [
    ["GET", "/apps"], ["PUT", "/apps/demo"], ["POST", "/apps/demo/tokens"], ["POST", "/apps/demo/revoke"], ["GET", "/usage"],
    ["GET", "/store/files"], ["POST", "/store/files"], ["POST", "/store/files/read"], ["GET", "/store/journal"], ["GET", "/store/wait"],
    ["GET", "/browser/bindings"], ["POST", "/browser/agents/x/tokens"], ["GET", "/limits"], ["GET", "/logins/renewal"],
    ["GET", "/favourites/"], ["PUT", "/favourites"], ["DELETE", "/favourites"],
  ];
  for (const [method, path] of others) {
    const r = await h.call(path, { method, token, ...(method === "GET" || method === "DELETE" ? {} : { body: "{}" }) });
    expect([method, path, r.status]).toEqual([method, path, 401]);
  }
  // A token derived from another admin token, and the right token with a change, are refused or kept apart.
  expect((await h.call("/favourites", { token: favouritesToken("other-admin-token-value") })).status).toBe(401);
  expect((await h.call("/favourites", { token: token.slice(0, -1) + (token.endsWith("0") ? "1" : "0") })).status).toBe(401);
  // The admin token still works everywhere it did.
  expect((await h.call("/favourites")).status).toBe(200);
});

test("POST applies changes and answers with the list, GET reads it", async () => {
  const h = await http();
  const res = await post(h, { origin: "host-1", changes: [star("m1"), star("m2")] });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ seq: 2, epoch: (await h.shared.store.list()).epoch, refused: [], items: [{ provider: "claude", identity: "work", model: "m1" }, { provider: "claude", identity: "work", model: "m2" }] });
  const got = (await (await h.call("/favourites")).json()) as any;
  expect(got).toMatchObject({ seq: 2, changed: true, epoch: (await h.shared.store.list()).epoch });
  expect(got.items).toHaveLength(2);
  // The panels hear of a change made over HTTP.
  const ws = await h.connect("a");
  await post(h, { changes: [star("m1", "remove")] });
  await settle();
  expect(ws.of("chat.fav.list").at(-1)!.items.map((i: any) => i.model)).toEqual(["m2"]);
});

test("a change with an old time does not undo a newer one made over the socket", async () => {
  const h = await http();
  const ws = await h.connect("a");
  await h.send(ws, { t: "chat.fav.set", changes: [star("m1", "add", { at: Date.now() - 100 })] });
  await post(h, { origin: "host-1", changes: [star("m1", "remove", { at: Date.now() - 60_000 })] });
  expect(((await (await h.call("/favourites")).json()) as any).items).toHaveLength(1);
});

test("POST names the changes the store refused, and the metrics count them", async () => {
  const h = await http();
  await post(h, { changes: [star("m1", "add", { at: Date.now() - 3000 }), star("m1", "remove", { at: Date.now() - 1000 })] });
  const res = (await (await post(h, { changes: [star("m1", "add", { at: Date.now() - 9000 }), star("m2")] })).json()) as any;
  expect(res.refused).toEqual([{ provider: "claude", identity: "work", model: "m1", reason: "stale" }]);
  expect(res.items.map((i: any) => i.model)).toEqual(["m2"]);
  expect(((await (await post(h, { changes: [] })).json()) as any).refused).toEqual([]);
  expect(h.metrics.render()).toMatch(/ais_gateway_favourites_total\{event="refused",reason="stale"\} 1/);
});

test("bad bodies are refused with 400", async () => {
  const h = await http();
  for (const body of [[], { changes: "x" }, { changes: [{ provider: "bash", identity: "a", model: "m", op: "add" }] }, { changes: [star("m", "toggle" as never)] }, { changes: [star("bad model")] }, { origin: "a b", changes: [] }, { changes: [star("m", "add", { at: -1 })] }]) {
    expect((await post(h, body)).status).toBe(400);
  }
  expect((await h.call("/favourites", { method: "POST", body: "not json" })).status).toBe(400);
  expect((await h.call("/favourites?since=x")).status).toBe(400);
  expect((await h.call("/favourites?since=1&ms=-5")).status).toBe(400);
  expect(((await (await h.call("/favourites")).json()) as any).items).toEqual([]);
});

test("the routes answer 404 until the favourites service is up", async () => {
  const h = await http({ present: false });
  expect((await h.call("/favourites")).status).toBe(404);
  expect((await post(h, { changes: [] })).status).toBe(404);
});

test("a long poll answers when the list changes, and a quiet one answers unchanged after its time", async () => {
  const h = await http();
  await post(h, { changes: [star("m1")] });
  const quiet = (await (await h.call("/favourites?since=1&ms=120")).json()) as any;
  expect(quiet).toMatchObject({ seq: 1, changed: false });
  const t0 = Date.now();
  const waiting = h.call("/favourites?since=1&ms=5000").then((r) => r.json() as Promise<any>);
  await Bun.sleep(40);
  await post(h, { changes: [star("m2")] });
  const woke = await waiting;
  expect(woke).toMatchObject({ seq: 2, changed: true });
  expect(Date.now() - t0).toBeLessThan(2000);
  // A caller that is behind gets the list at once.
  expect(((await (await h.call("/favourites?since=0&ms=5000")).json()) as any).changed).toBe(true);
});

test("a long poll still wakes when the bus loses the notice", async () => {
  const h = await http();
  h.shared.bus.drop = () => true;
  await post(h, { changes: [star("m1")] });
  const t0 = Date.now();
  const r = (await (await h.call("/favourites?since=0&ms=100")).json()) as any;
  expect(r.changed).toBe(true);
  h.shared.bus.drop = undefined;
  const missed = h.call("/favourites?since=1&ms=3000").then((x) => x.json() as Promise<any>);
  await Bun.sleep(20);
  h.shared.bus.drop = () => true;
  await h.shared.store.apply([{ provider: "claude", identity: "work", model: "m9", op: "add" }], "other", Date.now());
  // The store changed and no notice came: the 50 ms fallback read sees it.
  expect(((await missed) as any).changed).toBe(true);
  expect(Date.now() - t0).toBeLessThan(2500);
});

test("a gateway holds a few long polls at once and answers 429 above that, with a metric", async () => {
  const h = await http({ maxWaiters: 2 });
  await post(h, { changes: [star("m1")] });
  const held = [1, 2].map(() => h.call("/favourites?since=1&ms=3000").then((r) => r.status));
  await Bun.sleep(40);
  const refused = await h.call("/favourites?since=1&ms=3000");
  expect(refused.status).toBe(429);
  expect(refused.headers.get("retry-after")).toBeTruthy();
  expect(h.metrics.render()).toMatch(/ais_gateway_favourites_total\{event="rate_limited"\} 1/);
  // A call that needs no wait is not limited: the list version differs, or no wait was asked for.
  expect((await h.call("/favourites?since=0&ms=3000")).status).toBe(200);
  expect((await h.call("/favourites")).status).toBe(200);
  // The held ones end with a change, and the slots are free again.
  await post(h, { changes: [star("m2")] });
  expect(await Promise.all(held)).toEqual([200, 200]);
  const again = h.call("/favourites?since=2&ms=100");
  expect((await again).status).toBe(200);
});

test("a long poll that the caller aborts frees its slot", async () => {
  const h = await http({ maxWaiters: 1 });
  await post(h, { changes: [star("m1")] });
  const ctl = new AbortController();
  const held = h.favourites.wait(1, 3000, ctl.signal);
  await Bun.sleep(20);
  await expect(h.favourites.wait(1, 3000)).rejects.toThrow(/too many/i);
  ctl.abort();
  expect((await held).changed).toBe(false);
  expect((await h.favourites.wait(1, 30)).changed).toBe(false);
});

test("the metrics count the calls, the changes and the pushes", async () => {
  const h = await http();
  const ws = await h.connect("a");
  await h.send(ws, { t: "chat.fav.list" });
  await h.send(ws, { t: "chat.fav.set", changes: [star("m1")] });
  await post(h, { changes: [star("m2")] });
  await h.call("/favourites");
  await settle();
  const text = h.metrics.render();
  for (const ev of ["socket_list", "socket_set", "http_post", "http_get", "change", "push"]) expect(text).toMatch(new RegExp(`ais_gateway_favourites_total\\{event="${ev}"\\} [1-9]`));
});

// ---- pool stars: the old form under a pool's real name moves to the pool key ---------------------------------------

const POOLS = [{ provider: "claude" as const, name: "swap-a" }, { provider: "grok" as const, name: "swap-g" }];
const KEY = (provider: FavKey["provider"], identity: string, model: string): FavKey => ({ provider, identity, model });
const items = async (store: MemoryFavouriteStore) => (await store.list()).items.map((i) => `${i.provider}/${i.identity}/${i.model}`).sort();

test("the migration moves a star under a pool's name to the pool key in one step, loses none and keeps other stars", async () => {
  const shared = newShared();
  const before = Date.now() - 5000;
  await shared.store.apply([{ ...KEY("claude", "swap-a", "m1"), op: "add", at: before }, { ...KEY("grok", "swap-g", "g1"), op: "add", at: before + 1 }, { ...KEY("claude", "work", "m2"), op: "add", at: before + 2 }, { ...KEY("codex", "swap-a", "x"), op: "add", at: before + 3 }], "t3", Date.now());
  const seqBefore = (await shared.store.list()).seq;
  const r = await replica(shared, { a: "bind-a" }, undefined, { pools: async () => POOLS });
  const ws = await r.connect("a");
  await settle();
  // A star of another provider under the same name is not a pool star of that provider.
  expect(await items(shared.store)).toEqual(["claude/@pool/m1", "claude/work/m2", "codex/swap-a/x", "grok/@pool/g1"]);
  // The new keys keep the time of the old stars, so the order of the list is the same.
  expect((await shared.store.list()).items.map((i) => i.model)).toEqual(["m1", "g1", "m2", "x"]);
  expect((await shared.store.list()).seq).toBeGreaterThan(seqBefore);
  // The panel that was attached got the new list pushed.
  expect(ws.of("chat.fav.list").at(-1)!.items.map((i: any) => `${i.identity}/${i.model}`).sort()).toEqual(["@pool/g1", "@pool/m1", "swap-a/x", "work/m2"]);
  // A second run changes nothing.
  const seq = (await shared.store.list()).seq;
  await r.favourites.migratePools();
  expect((await shared.store.list()).seq).toBe(seq);
});

test("the migration is idempotent across replicas and keeps a pool key that already exists", async () => {
  const shared = newShared();
  await shared.store.apply([{ ...KEY("claude", "swap-a", "m1"), op: "add" }, { ...KEY("claude", "@pool", "m1"), op: "add" }], "t3", Date.now());
  const a = await replica(shared, {}, undefined, { pools: async () => POOLS });
  const b = await replica(shared, {}, undefined, { pools: async () => POOLS });
  await Promise.all([a.favourites.migratePools(), b.favourites.migratePools()]);
  expect(await items(shared.store)).toEqual(["claude/@pool/m1"]);
});

test("a change under a pool's name from an older host or panel is stored under the pool key", async () => {
  const shared = newShared();
  const r = await replica(shared, { a: "bind-a" }, undefined, { pools: async () => POOLS });
  const ws = await r.connect("a");
  await r.send(ws, { t: "chat.fav.set", changes: [{ ...KEY("claude", "swap-a", "m1"), op: "add" }, { ...KEY("claude", "work", "m2"), op: "add" }] });
  expect(await items(shared.store)).toEqual(["claude/@pool/m1", "claude/work/m2"]);
  await r.send(ws, { t: "chat.fav.set", changes: [{ ...KEY("claude", "swap-a", "m1"), op: "remove", at: Date.now() + 10 }] });
  expect(await items(shared.store)).toEqual(["claude/work/m2"]);
});

test("when the pool names are not known the stars stay as they are, and the migration runs again until it works", async () => {
  const shared = newShared();
  await shared.store.apply([{ ...KEY("claude", "swap-a", "m1"), op: "add" }], "t3", Date.now());
  let up = false;
  const r = await replica(shared, { a: "bind-a" }, undefined, { pools: async () => { if (!up) throw new Error("no catalogue"); return POOLS; }, migrateRetryMs: 20 });
  await r.connect("a");
  expect(await items(shared.store)).toEqual(["claude/swap-a/m1"]);
  up = true;
  for (let i = 0; i < 40 && (await items(shared.store))[0] !== "claude/@pool/m1"; i += 1) await Bun.sleep(20);
  expect(await items(shared.store)).toEqual(["claude/@pool/m1"]);
});
