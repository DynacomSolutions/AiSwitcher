import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createAdminApp } from "../../src/gateway/admin.ts";
import { withStoreWaitTimeout } from "../../src/gateway/admin-store.ts";
import { HttpHomeStore, HttpRefreshBackend } from "../../src/gateway/home-store-http.ts";
import { decryptFile, encryptFile, sha256Hex, type HomeCipherRow, type HomeFileKind, type HomeFileMeta, type HomeStoreServer, type PutResult } from "../../src/gateway/home-store.ts";
import { hostSyncOnce, startHostSync } from "../../src/gateway/host-sync.ts";
import type { JournalEntry } from "../../src/gateway/refresh-guard.ts";
import { MemoryGatewayStore } from "../../src/gateway/store.ts";

/** The host credential sync over the gateway admin API: the routes, the HTTP client and the host sync on top of them. No database. */

const ADMIN = "adm-test-value-0001-0123456789abcdef";
const KEY = Buffer.alloc(32, 7);
const grant = (refresh: string, expiresAtMs: number): string =>
  JSON.stringify({ claudeAiOauth: { accessToken: `SYNTHETIC_FIXTURE-a-${refresh}`, refreshToken: `SYNTHETIC_FIXTURE-${refresh}`, expiresAt: expiresAtMs, refreshTokenExpiresAt: 2_100_000_000_000 } });

/** In-memory stand-in for the gateway's PgHomeStore: encrypted rows, the same compare-and-swap rules. */
class FakeServerStore implements HomeStoreServer {
  rows = new Map<string, HomeCipherRow>();
  listeners = new Set<(p: string) => void>();
  version = 0;
  listCalls = 0;
  async list(since = 0): Promise<HomeFileMeta[]> {
    this.listCalls += 1;
    return [...this.rows.values()].filter((r) => r.version > since).map(({ cipher: _c, ...m }) => m);
  }
  async getCipher(q: { paths?: string[]; account?: string; extraPaths?: string[] }): Promise<HomeCipherRow[]> {
    return [...this.rows.values()].filter((r) => (q.account !== undefined ? r.account === q.account || (q.extraPaths ?? []).includes(r.path) : (q.paths ?? []).includes(r.path)));
  }
  async putCipher(path: string, cipher: Buffer, sha256: string, opts: { account: string | null; kind: HomeFileKind; expectedVersion?: number | null }): Promise<PutResult> {
    if (sha256Hex(decryptFile(KEY, path, cipher)) !== sha256) throw new Error("sha");
    const cur = this.rows.get(path);
    const exp = opts.expectedVersion;
    if ((exp === null && cur) || (typeof exp === "number" && cur?.version !== exp)) {
      return { ok: false, ...(cur ? { current: { path: cur.path, account: cur.account, kind: cur.kind, sha256: cur.sha256, version: cur.version } } : {}) };
    }
    this.version += 1;
    this.rows.set(path, { path, account: opts.account, kind: opts.kind, sha256, version: this.version, cipher });
    for (const cb of this.listeners) cb(path);
    return { ok: true, version: this.version };
  }
  decrypt(path: string, cipher: Buffer): Buffer {
    return decryptFile(KEY, path, cipher);
  }
  async listen(cb: (p: string) => void): Promise<() => Promise<void>> {
    this.listeners.add(cb);
    return async () => void this.listeners.delete(cb);
  }
  /** A refresh by another replica: written as the gateway would, with the store key. */
  gatewayWrite(path: string, text: string, account: string | null, kind: HomeFileKind = "login"): Promise<PutResult> {
    return this.putCipher(path, encryptFile(KEY, path, Buffer.from(text)), sha256Hex(text), { account, kind });
  }
}

function setup(over: { journal?: (provider: string, identity: string, fp: string) => Promise<JournalEntry[]>; noStore?: boolean } = {}) {
  const server = new FakeServerStore();
  const app = createAdminApp({
    store: new MemoryGatewayStore(),
    adminToken: ADMIN,
    now: () => new Date("2026-11-21T10:00:00.000Z"),
    ...(over.noStore ? {} : { storeAdmin: { homeStore: server, ...(over.journal ? { journal: over.journal } : {}) } }),
  });
  const calls: Array<{ method: string; path: string }> = [];
  const fetchFn = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(String(input));
    calls.push({ method: init?.method ?? "GET", path: url.pathname });
    return app.request(`http://admin.test${url.pathname}${url.search}`, init);
  }) as typeof fetch;
  const opts = { url: "http://admin.test", token: ADMIN, key: KEY, fetch: fetchFn, retryMs: 10 };
  return { server, app, fetchFn, opts, calls, store: new HttpHomeStore({ ...opts, warn: () => undefined }) };
}

const dirs: string[] = [];
const tmp = async (): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), "ais-store-api-"));
  dirs.push(d);
  return d;
};
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe("admin store routes", () => {
  test("every route needs the admin token, and answers 404 when the gateway has no credential store", async () => {
    const { app } = setup();
    for (const [method, path] of [["GET", "/store/files"], ["POST", "/store/files/read"], ["PUT", "/store/files"], ["GET", "/store/wait"], ["GET", "/store/journal"]] as const) {
      expect((await app.request(`http://admin.test${path}`, { method })).status).toBe(401);
      expect((await app.request(`http://admin.test${path}`, { method, headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    }
    const bare = setup({ noStore: true });
    const headers = { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" };
    expect((await bare.app.request("http://admin.test/store/files", { headers })).status).toBe(404);
    expect((await bare.app.request("http://admin.test/store/wait", { headers })).status).toBe(404);
    expect((await bare.app.request("http://admin.test/store/journal?provider=a&identity=b&oldFp=c", { headers })).status).toBe(404);
  });

  test("bad input is 400, and a row that does not decrypt or match its checksum is refused without echoing anything", async () => {
    const { app } = setup();
    const call = (method: string, path: string, body?: unknown) => app.request(`http://admin.test${path}`, { method, headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    expect((await call("GET", "/store/files?since=-1")).status).toBe(400);
    expect((await call("POST", "/store/files/read", { paths: ["../x"] })).status).toBe(400);
    expect((await call("POST", "/store/files/read", { paths: [] })).status).toBe(400);
    const good = { path: "a/b.json", account: null, kind: "registry", cipher: encryptFile(KEY, "a/b.json", Buffer.from("x")).toString("base64"), sha256: sha256Hex("x"), expectedVersion: null };
    const { expectedVersion: _omitted, ...unversioned } = good;
    expect((await call("PUT", "/store/files", unversioned)).status).toBe(400);
    expect((await call("PUT", "/store/files", { ...good, expectedVersion: -1 })).status).toBe(400);
    expect((await call("PUT", "/store/files", { ...good, expectedVersion: "1" })).status).toBe(400);
    expect((await call("PUT", "/store/files", { ...good, path: "/abs" })).status).toBe(400);
    expect((await call("PUT", "/store/files", { ...good, kind: "nope" })).status).toBe(400);
    expect((await call("PUT", "/store/files", { ...good, sha256: "zz" })).status).toBe(400);
    expect((await call("PUT", "/store/files", { ...good, cipher: "" })).status).toBe(400);
    const wrongKey = await call("PUT", "/store/files", { ...good, cipher: encryptFile(Buffer.alloc(32, 9), "a/b.json", Buffer.from("x")).toString("base64") });
    expect(wrongKey.status).toBe(400);
    expect(JSON.stringify(await wrongKey.json())).not.toContain("a/b.json");
    expect((await call("PUT", "/store/files", { ...good, sha256: sha256Hex("other") })).status).toBe(400);
    expect((await call("PUT", "/store/files", { ...good, cipher: encryptFile(KEY, "other/path", Buffer.from("x")).toString("base64") })).status).toBe(400);
    expect((await call("PUT", "/store/files", good)).status).toBe(200);
  });

  test("a long poll answers at once when a row is past the cursor, on a change, and with changed false on timeout", async () => {
    const { app, server } = setup();
    const wait = async (since: number, ms: number) => (await (await app.request(`http://admin.test/store/wait?since=${since}&ms=${ms}`, { headers: { authorization: `Bearer ${ADMIN}` } })).json()) as { changed: boolean };
    expect(await wait(0, 30)).toEqual({ changed: false });
    await server.gatewayWrite("a.json", "1", null, "registry");
    expect(await wait(0, 5_000)).toEqual({ changed: true });
    expect(await wait(1, 30)).toEqual({ changed: false });
    const pending = wait(1, 5_000);
    await Bun.sleep(20);
    await server.gatewayWrite("b.json", "2", null, "registry");
    expect(await pending).toEqual({ changed: true });
    expect(server.listeners.size).toBe(0); // every poll leaves its subscription
  });
});

describe("admin store routes: rotated refresh tokens and the real server", () => {
  const rotated: JournalEntry = { id: 1, ts: "2026-11-21T09:00:00.000Z", provider: "claude", identity: "alpha", holder: "gw-1", oldFp: "x", newFp: "y", outcome: "refreshed" };

  test("a login whose refresh token the journal shows rotated out is refused with 409 rotated; others pass", async () => {
    const { app, server } = setup({ journal: async () => [rotated] });
    const text = grant("r-old", 2_000_000_000_000);
    const r = await fetchPut(app, "x/.credentials.json", text, "claude/alpha", "login");
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "rotated" });
    expect(server.rows.size).toBe(0);
    // A registry holds no refresh token and is not checked; a login of an unchecked journal outcome passes.
    expect((await fetchPut(app, "r.json", "{}", null, "registry")).status).toBe(200);
    const ok = setup({ journal: async () => [{ ...rotated, outcome: "failed" as const }, { ...rotated, newFp: "x" }] });
    expect((await fetchPut(ok.app, "x/.credentials.json", text, "claude/alpha", "login")).status).toBe(200);
    // The journal is asked for the right account and a fingerprint, not for a token.
    const asked: string[][] = [];
    const spy = setup({ journal: async (p, i, fp) => (asked.push([p, i, fp]), []) });
    await fetchPut(spy.app, "x/.credentials.json", text, "claude/alpha", "login");
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every(([p, i, fp]) => p === "claude" && i === "alpha" && !fp!.includes("SYNTHETIC_FIXTURE"))).toBe(true);
  });

  test("a placeholder login over a refreshable login row is refused with 409 placeholder and the row is unchanged", async () => {
    const { app, server } = setup();
    const path = "x/.credentials.json";
    const real = grant("r-live", 1_795_635_411_000);
    expect((await fetchPut(app, path, real, "claude/alpha", "login")).status).toBe(200);
    const before = server.rows.get(path)!;
    const placeholder = JSON.stringify({ claudeAiOauth: { accessToken: "aisg_SYNTHETIC_FIXTURE_token", refreshToken: null, expiresAt: 4_102_444_800_000 } });
    const r = await fetchPut(app, path, placeholder, "claude/alpha", "login", before.version);
    // 422, not 409: an old host client reads 409 as a lost race and retries the same write for ever; it throws on 422.
    expect(r.status).toBe(422);
    expect(await r.json()).toEqual({ error: "placeholder" });
    expect(server.rows.get(path)).toBe(before);
    // A login without a refresh token is refused the same way; a placeholder for a new row, or a real login, passes.
    const blank = JSON.stringify({ claudeAiOauth: { accessToken: "SYNTHETIC_FIXTURE-a", expiresAt: 1 } });
    expect((await fetchPut(app, path, blank, "claude/alpha", "login", before.version)).status).toBe(422);
    expect((await fetchPut(app, "y/.credentials.json", placeholder, "claude/beta", "login")).status).toBe(200);
    expect((await fetchPut(app, path, grant("r-next", 1_795_999_999_000), "claude/alpha", "login", before.version)).status).toBe(200);
  });

  test("the refusal status is one an old host client throws on, and the new client throws too", async () => {
    const { app, opts, server } = setup();
    const path = "x/.credentials.json";
    await fetchPut(app, path, grant("r-live", 1_795_635_411_000), "claude/alpha", "login");
    const placeholder = JSON.stringify({ claudeAiOauth: { accessToken: "aisg_SYNTHETIC_FIXTURE_token", refreshToken: null, expiresAt: 4_102_444_800_000 } });
    const r = await fetchPut(app, path, placeholder, "claude/alpha", "login", server.rows.get(path)!.version);
    // Old client: api.ok("PUT", ..., [200, 409]) throws on any other status.
    expect([200, 409].includes(r.status)).toBe(false);
    await expect(new HttpHomeStore({ ...opts, warn: () => undefined }).put(path, Buffer.from(placeholder), { account: "claude/alpha", kind: "login", expectedVersion: server.rows.get(path)!.version })).rejects.toThrow(/placeholder/);
  });

  test("a host without the capability header gets 200 with the row's own version and nothing is written", async () => {
    const { app, server } = setup();
    const path = "x/.credentials.json";
    await fetchPut(app, path, grant("r-live", 1_795_635_411_000), "claude/alpha", "login");
    const before = server.rows.get(path)!;
    const placeholder = JSON.stringify({ claudeAiOauth: { accessToken: "aisg_SYNTHETIC_FIXTURE_token", refreshToken: null, expiresAt: 4_102_444_800_000 } });
    const r = await fetchPut(app, path, placeholder, "claude/alpha", "login", before.version, false);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ version: before.version });
    expect(server.rows.get(path)).toBe(before);
    const reg = ".claude/identities.json";
    await fetchPut(app, reg, JSON.stringify({ version: 1, identities: [{ name: "a" }, { name: "b" }] }), null, "registry");
    const rv = server.rows.get(reg)!;
    const r2 = await fetchPut(app, reg, JSON.stringify({ version: 1, identities: [{ name: "a" }] }), null, "registry", rv.version, false);
    expect(r2.status).toBe(200);
    expect(server.rows.get(reg)).toBe(rv);
  });

  test("a mixed login file whose real entry becomes a gateway entry is refused, and a rotated entry beside it passes", async () => {
    const { app, server } = setup();
    const path = ".pi/identities/alpha/auth.json";
    const real = (tag: string, exp: number) => ({ type: "oauth", access: `SYNTHETIC_FIXTURE-a-${tag}`, refresh: `SYNTHETIC_FIXTURE-r-${tag}`, expires: exp });
    const gw = { type: "oauth", access: "aisg_SYNTHETIC_FIXTURE_token", refresh: "", expires: 4_102_444_800_000 };
    await fetchPut(app, path, JSON.stringify({ anthropic: real("a", 1_795_000_000_000), "openai-codex": real("c", 1_795_000_000_000) }), "pi/alpha", "login");
    const v = server.rows.get(path)!.version;
    const bad = await fetchPut(app, path, JSON.stringify({ anthropic: gw, "openai-codex": real("c2", 1_796_000_000_000) }), "pi/alpha", "login", v);
    expect(bad.status).toBe(422);
    expect((await fetchPut(app, path, JSON.stringify({ anthropic: real("a2", 1_796_000_000_000), "openai-codex": real("c2", 1_796_000_000_000) }), "pi/alpha", "login", v)).status).toBe(200);
  });

  test("a stale expectedVersion gets the normal compare-and-swap conflict before any guard", async () => {
    const { app, server } = setup();
    const path = "x/.credentials.json";
    await fetchPut(app, path, grant("r-live", 1_795_635_411_000), "claude/alpha", "login");
    const placeholder = JSON.stringify({ claudeAiOauth: { accessToken: "aisg_SYNTHETIC_FIXTURE_token", refreshToken: null, expiresAt: 4_102_444_800_000 } });
    const r = await fetchPut(app, path, placeholder, "claude/alpha", "login", server.rows.get(path)!.version + 5);
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toBe("the row changed");
  });

  test("a registry push that is not a registry, or drops names, is refused; a tombstoned name may go", async () => {
    const { app, server } = setup();
    const path = ".claude/identities.json";
    const reg = (names: string[], deleted?: string[]): string => JSON.stringify({ version: 1, identities: names.map((name) => ({ name })), ...(deleted ? { deleted } : {}) });
    await fetchPut(app, path, reg(["a", "b"]), null, "registry");
    const v = server.rows.get(path)!.version;
    expect((await fetchPut(app, path, "{}", null, "registry", v)).status).toBe(422);
    expect((await fetchPut(app, path, "[]", null, "registry", v)).status).toBe(422);
    expect((await fetchPut(app, path, reg(["a"]), null, "registry", v)).status).toBe(422);
    expect((await fetchPut(app, path, reg(["a"], ["b"]), null, "registry", v)).status).toBe(200);
  });

  test("a registry push that drops an identity the store registry holds is refused with 409 drops-identities; retire and adds pass", async () => {
    const { app, server } = setup();
    const path = ".claude/identities.json";
    const reg = (...names: Array<string | [string, boolean]>): string =>
      JSON.stringify({ version: 1, identities: names.map((n) => (Array.isArray(n) ? { name: n[0], retired: n[1] } : { name: n })) });
    expect((await fetchPut(app, path, reg("a", "b"), null, "registry")).status).toBe(200);
    const v = server.rows.get(path)!.version;
    const before = server.rows.get(path)!;
    const r = await fetchPut(app, path, reg("a"), null, "registry", v);
    expect(r.status).toBe(422);
    expect(await r.json()).toEqual({ error: "drops-identities" });
    expect(server.rows.get(path)).toBe(before);
    expect((await fetchPut(app, path, reg("a", ["b", true]), null, "registry", v)).status).toBe(200);
    expect((await fetchPut(app, path, reg("a", ["b", true], "c"), null, "registry", v + 1)).status).toBe(200);
  });

  test("a real admin server holds /store/wait past Bun's 10 s idle timeout without a reset", async () => {
    const { app, server } = setup();
    const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: withStoreWaitTimeout((req) => app.fetch(req)) });
    try {
      const started = Date.now();
      const res = await fetch(`http://127.0.0.1:${srv.port}/store/wait?since=0&ms=13000`, { headers: { authorization: `Bearer ${ADMIN}` } });
      expect(Date.now() - started).toBeGreaterThanOrEqual(12_500); // it crossed the 10 s mark
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ changed: false });
      expect(server.listeners.size).toBe(0);
    } finally {
      await srv.stop(true);
    }
  }, 30_000);

  test("control: with a 2 s idle timeout a 5 s poll is reset without the wrapper and survives with it", async () => {
    const { app } = setup();
    const headers = { authorization: `Bearer ${ADMIN}` };
    const bare = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 2, fetch: (req) => app.fetch(req) });
    const wrapped = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 2, fetch: withStoreWaitTimeout((req) => app.fetch(req)) });
    try {
      const reset = await fetch(`http://127.0.0.1:${bare.port}/store/wait?since=0&ms=5000`, { headers }).then(() => undefined, (e: Error) => e);
      expect(reset?.message).toContain("ECONNRESET");
      const res = await fetch(`http://127.0.0.1:${wrapped.port}/store/wait?since=0&ms=5000`, { headers });
      expect(await res.json()).toEqual({ changed: false });
    } finally {
      await bare.stop(true);
      await wrapped.stop(true);
    }
  }, 30_000);

  test("withStoreWaitTimeout switches the request timeout off for the poll only", () => {
    const calls: Array<[string, number]> = [];
    const wrapped = withStoreWaitTimeout((_r) => new Response("ok"));
    const srv = { timeout: (r: Request, s: number) => void calls.push([new URL(r.url).pathname, s]) };
    wrapped(new Request("http://a.test/store/wait?since=0"), srv);
    wrapped(new Request("http://a.test/store/files"), srv);
    wrapped(new Request("http://a.test/apps"), srv);
    expect(calls).toEqual([["/store/wait", 0]]);
  });
});

/** A raw, correctly encrypted PUT with an expected version of null, to see the gateway's answer. */
async function fetchPut(app: ReturnType<typeof createAdminApp>, path: string, text: string, account: string | null, kind: string, expectedVersion: number | null = null, capable = true): Promise<Response> {
  return app.request("http://admin.test/store/files", {
    method: "PUT",
    headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json", ...(capable ? { "x-ais-store-refusals": "1" } : {}) },
    body: JSON.stringify({ path, account, kind, cipher: encryptFile(KEY, path, Buffer.from(text)).toString("base64"), sha256: sha256Hex(text), expectedVersion }),
  });
}

describe("HttpHomeStore", () => {
  test("put, list and get round-trip; the gateway only ever holds ciphertext", async () => {
    const { store, server } = setup();
    const plain = grant("r1", 2_000_000_000_000);
    const r = await store.put(".claude/.credentials.json", Buffer.from(plain), { account: "claude/alpha", kind: "login", expectedVersion: null });
    expect(r).toEqual({ ok: true, version: 1 });
    const row = server.rows.get(".claude/.credentials.json")!;
    expect(row.cipher.toString("utf8")).not.toContain("SYNTHETIC_FIXTURE");
    expect(row.cipher.equals(Buffer.from(plain))).toBe(false);
    expect((await store.list(0)).map((m) => [m.path, m.version, m.account, m.kind])).toEqual([[".claude/.credentials.json", 1, "claude/alpha", "login"]]);
    expect(await store.list(1)).toEqual([]);
    const [got] = await store.get([".claude/.credentials.json", "missing.json"]);
    expect(got?.content.toString("utf8")).toBe(plain);
    expect(got?.sha256).toBe(sha256Hex(plain));
    await store.put("other.json", Buffer.from("o"), { account: null, kind: "registry", expectedVersion: null });
    expect((await store.getAccount("claude/alpha", ["other.json"])).map((x) => x.path).sort()).toEqual([".claude/.credentials.json", "other.json"]);
    expect(await store.get([])).toEqual([]);
  });

  test("compare-and-swap: a stale version and an existing row for null are refused with the current metadata", async () => {
    const { store } = setup();
    await store.put("a.json", Buffer.from("1"), { account: null, kind: "registry", expectedVersion: null });
    const again = await store.put("a.json", Buffer.from("2"), { account: null, kind: "registry", expectedVersion: null });
    expect(again.ok).toBe(false);
    expect(!again.ok && again.current?.version).toBe(1);
    expect((await store.put("a.json", Buffer.from("2"), { account: null, kind: "registry", expectedVersion: 99 })).ok).toBe(false);
    expect(await store.put("a.json", Buffer.from("2"), { account: null, kind: "registry", expectedVersion: 1 })).toEqual({ ok: true, version: 2 });
    // An unconditional write is never sent: the gateway would refuse it, and it could roll a row back.
    await expect(store.put("a.json", Buffer.from("3"), { account: null, kind: "registry" })).rejects.toThrow("expected version");
    expect(await store.put("new.json", Buffer.from("3"), { account: null, kind: "registry", expectedVersion: 5 })).toEqual({ ok: false });
  });

  test("a row that does not decrypt with the host key is skipped with a path-only warning; the others still arrive", async () => {
    const { server, opts } = setup();
    await server.gatewayWrite("good.json", "ok", null, "registry");
    const bad = encryptFile(Buffer.alloc(32, 1), "bad.json", Buffer.from("x"));
    server.rows.set("bad.json", { path: "bad.json", account: null, kind: "registry", sha256: sha256Hex("x"), version: 9, cipher: bad });
    const warns: string[] = [];
    const store = new HttpHomeStore({ ...opts, warn: (m) => warns.push(m) });
    expect((await store.get(["good.json", "bad.json"])).map((r) => r.path)).toEqual(["good.json"]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("bad.json");
  });

  test("errors name the route and the status only, never the token or the body", async () => {
    const { opts } = setup();
    const store = new HttpHomeStore({ ...opts, token: "SYNTHETIC_FIXTURE-wrong-token" });
    const err = await store.list(0).then(() => undefined, (e: Error) => e);
    expect(err?.message).toContain("401");
    expect(err?.message).not.toContain("SYNTHETIC_FIXTURE");
    const down = new HttpHomeStore({ ...opts, url: "http://gw.example.test:1", fetch: (async () => { throw new Error("connect SYNTHETIC_FIXTURE-secret"); }) as unknown as typeof fetch });
    const e2 = await down.list(0).then(() => undefined, (e: Error) => e);
    expect(e2?.message).toContain("unreachable");
    expect(e2?.message).not.toContain("SYNTHETIC_FIXTURE");
  });

  test("listen replaces LISTEN with a long poll: a change by another writer wakes it, and unlisten ends the loop", async () => {
    const { store, server, calls } = setup();
    await store.list(0);
    const seen: string[] = [];
    const unlisten = await store.listen((p) => seen.push(p));
    await Bun.sleep(30);
    expect(seen).toHaveLength(0);
    await server.gatewayWrite("x.json", "1", null, "registry");
    for (let i = 0; i < 50 && seen.length === 0; i++) await Bun.sleep(20);
    expect(seen).toHaveLength(1);
    await unlisten();
    const polls = calls.filter((c) => c.path === "/store/wait").length;
    await Bun.sleep(80);
    expect(calls.filter((c) => c.path === "/store/wait").length).toBe(polls);
  });
});

describe("HttpRefreshBackend", () => {
  test("reads the journal by fingerprint through the gateway, holds no lock, and refuses the write operations", async () => {
    const seen: string[][] = [];
    const entry: JournalEntry = { id: 4, ts: "2026-11-21T09:00:00.000Z", provider: "claude", identity: "alpha", holder: "gw-1", oldFp: "fp-old", newFp: "fp-new", outcome: "refreshed" };
    const { fetchFn } = setup({ journal: async (p, i, fp) => (seen.push([p, i, fp]), [entry]) });
    const backend = new HttpRefreshBackend({ url: "http://admin.test", token: ADMIN, fetch: fetchFn });
    const lock = await backend.acquire({ provider: "claude", identity: "alpha" });
    expect(await lock.findByOldFp("fp-old")).toEqual([entry]);
    expect(seen).toEqual([["claude", "alpha", "fp-old"]]);
    await lock.release();
    await expect(lock.claim("fp", "me")).rejects.toThrow("read only");
  });
});

describe("host sync over the API", () => {
  const MEMBER = ".claude/identities/alpha/.credentials.json";

  test("a gateway refresh lands in the host file and a newer host file is pushed, with no database", async () => {
    const home = await tmp();
    const { server, opts } = setup();
    await server.gatewayWrite(MEMBER, grant("r2", 2_100_000_000_000), "claude/alpha");
    await mkdir(dirname(join(home, MEMBER)), { recursive: true });
    const store = new HttpHomeStore({ ...opts, warn: () => undefined });
    const lock = new HttpRefreshBackend(opts);
    const r = await hostSyncOnce(undefined, { home, store, lock, importEntries: async () => [] });
    expect(r.wrote).toBe(1);
    expect(await readFile(join(home, MEMBER), "utf8")).toBe(grant("r2", 2_100_000_000_000));
    // The host tool refreshes its own file: the next pass pushes it (newer grant), as a compare-and-swap.
    await writeFile(join(home, MEMBER), grant("r3", 2_200_000_000_000));
    const again = await hostSyncOnce(undefined, { home, store, lock, importEntries: async () => [] });
    expect(again.pushed).toBe(1);
    const row = server.rows.get(MEMBER)!;
    expect(decryptFile(KEY, MEMBER, row.cipher).toString("utf8")).toBe(grant("r3", 2_200_000_000_000));
  });

  test("the config path builds the API client: no database URL is needed, and the API is what is called", async () => {
    const home = await tmp();
    const { server, fetchFn, calls } = setup();
    await server.gatewayWrite(MEMBER, grant("r2", 2_100_000_000_000), "claude/alpha");
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchFn;
    try {
      const r = await hostSyncOnce({ key: KEY, admin: { url: "http://admin.test", token: ADMIN } }, { home, importEntries: async () => [] });
      expect(r.wrote).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(calls.some((c) => c.path === "/store/files")).toBe(true);
    expect(calls.every((c) => c.path.startsWith("/store/"))).toBe(true);
  });

  test("the running sync follows later gateway refreshes through the long poll, faster than the interval poll", async () => {
    const home = await tmp();
    const { server, opts } = setup();
    await server.gatewayWrite(MEMBER, grant("r2", 2_100_000_000_000), "claude/alpha");
    const store = new HttpHomeStore({ ...opts, warn: () => undefined });
    const sync = startHostSync(undefined, { home, store, lock: new HttpRefreshBackend(opts), importEntries: async () => [], pollMs: 60_000, importMs: 60_000, warn: () => undefined });
    try {
      await sync.ready;
      await server.gatewayWrite(MEMBER, grant("r4", 2_300_000_000_000), "claude/alpha");
      const want = grant("r4", 2_300_000_000_000);
      for (let i = 0; i < 100 && (await readFile(join(home, MEMBER), "utf8")) !== want; i++) await Bun.sleep(30);
      expect(await readFile(join(home, MEMBER), "utf8")).toBe(want);
    } finally {
      await sync.stop();
    }
  });
});
