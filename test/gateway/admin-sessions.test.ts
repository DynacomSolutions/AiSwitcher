import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { SQL } from "bun";
import { sessionsFromEnv } from "../../src/cli/gateway/dispatch.ts";
import { createAdminApp } from "../../src/gateway/admin.ts";
import {
  SESSIONS_MAX_BODY_BYTES,
  SESSIONS_MAX_CURSOR_FILES,
  SESSIONS_MAX_INGEST_FILES,
  SESSIONS_MAX_PARTS_PER_FILE,
  type SessionsIngestStore,
} from "../../src/gateway/admin-sessions.ts";
import { favouritesToken } from "../../src/gateway/favourites-token.ts";
import { PrometheusMetrics } from "../../src/gateway/metrics.ts";
import { migrate } from "../../src/gateway/pg-store.ts";
import { startGateway, type GatewayHooks } from "../../src/gateway/serve.ts";
import { MemoryRefreshBackend } from "../../src/gateway/refresh-guard.ts";
import { MemoryGatewayStore } from "../../src/gateway/store.ts";
import { partObjectPrefix, SessionStore, type IngestResult, type SessionFileKey } from "../../src/gateway/sessions/session-store.ts";

const ADMIN = "adm-test-value-0001-0123456789abcdef";
const INGEST = "ing-test-value-0002-0123456789abcdef";
const NOW = new Date("2026-11-24T10:00:00.000Z");

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

function part(start: number, len: number, tag = "a") {
  return {
    startOffset: start,
    endOffset: start + len,
    lines: Math.max(1, Math.round(len / 100)),
    plainBytes: len,
    objectBytes: Math.round(len / 6),
    plainSha256: sha(`${start}:${len}:${tag}`),
    objectKey: AUTO_KEY,
  };
}

/** `part()` leaves the object key to `record()`, which builds the key of the record's own session and generation. */
const AUTO_KEY = "auto";
const anchorOf = (start: number, len: number, tag = "a") => ({ startOffset: start, endOffset: start + len, plainSha256: part(start, len, tag).plainSha256 });

function record(parts: ReturnType<typeof part>[], over: Record<string, unknown> = {}) {
  const kind = typeof over.kind === "string" ? over.kind : "claude";
  const sessionRef = typeof over.sessionRef === "string" ? over.sessionRef : "s1";
  const generation = typeof over.generation === "number" && Number.isSafeInteger(over.generation) && over.generation >= 0 ? over.generation : 0;
  return {
    kind: "claude",
    sessionRef: "s1",
    node: "node-a",
    root: "/data/pool",
    relPath: "projects/p/s1.jsonl",
    origin: "t3-pool",
    pool: "main",
    generation: 0,
    headSha256: sha("head"),
    mtimeMs: NOW.getTime() - 30_000,
    parts: parts.map((p) => (p.objectKey === AUTO_KEY ? { ...p, objectKey: `${partObjectPrefix(kind, sessionRef, generation)}${p.startOffset}-${p.endOffset}.gz.age` } : p)),
    ...over,
  };
}

/** A store that answers from a script and records what it was asked. */
class FakeStore implements SessionsIngestStore {
  calls: Array<{ op: string; arg: unknown }> = [];
  failWith: Error | undefined;
  result: IngestResult = { status: "committed", cursor: { fileId: 1, generation: 0, committedBytes: 1000, committedLines: 10, headSha256: sha("head") }, created: true, partsAdded: 1 };
  async cursors(keys: SessionFileKey[]) {
    this.calls.push({ op: "cursors", arg: keys });
    if (this.failWith) throw this.failWith;
    return keys.map(() => null);
  }
  async ingest(req: unknown) {
    this.calls.push({ op: "ingest", arg: req });
    if (this.failWith) throw this.failWith;
    return this.result;
  }
  async hold(req: unknown) {
    this.calls.push({ op: "hold", arg: req });
    if (this.failWith) throw this.failWith;
    return this.result;
  }
  async ping() {
    if (this.failWith) throw this.failWith;
  }
}

function build(over: { store?: SessionsIngestStore; metrics?: PrometheusMetrics; flushGapSeconds?: number; objectExists?: (k: string) => Promise<boolean>; enabled?: boolean } = {}) {
  const metrics = over.metrics ?? new PrometheusMetrics({ ledgerDepth: () => 0, ledgerDropped: () => 0 });
  const store = over.store ?? new FakeStore();
  const app = createAdminApp({
    store: new MemoryGatewayStore(),
    adminToken: ADMIN,
    now: () => NOW,
    metrics,
    ...(over.enabled === false
      ? {}
      : { sessions: { token: INGEST, store, now: () => NOW, metrics, ...(over.flushGapSeconds !== undefined ? { flushGapSeconds: over.flushGapSeconds } : {}), ...(over.objectExists ? { objectExists: over.objectExists } : {}) } }),
  });
  const call = (path: string, init: RequestInit & { token?: string | null } = {}) => {
    const { token = INGEST, ...rest } = init;
    return app.request(`http://admin.test${path}`, {
      ...rest,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", ...(rest.headers as Record<string, string>) },
    });
  };
  const post = (path: string, body: unknown, token?: string | null) => call(path, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), ...(token !== undefined ? { token } : {}) });
  return { app, call, post, metrics, store };
}

describe("session ingest routes: feature flag", () => {
  test("the routes do not exist while the feature is off, for the admin token too", async () => {
    const h = build({ enabled: false });
    for (const [method, path] of [["GET", "/sessions/v1/ping"], ["POST", "/sessions/v1/cursors"], ["POST", "/sessions/v1/ingest"], ["GET", "/sessions/v1/anything"]] as const) {
      const res = await h.call(path, { method, token: ADMIN, ...(method === "POST" ? { body: "{}" } : {}) });
      expect(res.status).toBe(404);
    }
  });

  test("with the feature off the ingest token opens nothing", async () => {
    const h = build({ enabled: false });
    expect((await h.call("/sessions/v1/ping")).status).toBe(401);
  });

  test("sessionsFromEnv: off unless the flag is 1 or true, and then the token is required", () => {
    expect(sessionsFromEnv({})).toBeUndefined();
    expect(sessionsFromEnv({ AIS_GATEWAY_SESSIONS_TOKEN: INGEST })).toBeUndefined();
    expect(sessionsFromEnv({ AIS_GATEWAY_SESSIONS_INGEST: "0", AIS_GATEWAY_SESSIONS_TOKEN: INGEST })).toBeUndefined();
    expect(() => sessionsFromEnv({ AIS_GATEWAY_SESSIONS_INGEST: "1" })).toThrow("AIS_GATEWAY_SESSIONS_TOKEN");
    expect(sessionsFromEnv({ AIS_GATEWAY_SESSIONS_INGEST: "true", AIS_GATEWAY_SESSIONS_TOKEN: ` ${INGEST} ` })).toEqual({ token: INGEST });
    expect(sessionsFromEnv({ AIS_GATEWAY_SESSIONS_INGEST: "1", AIS_GATEWAY_SESSIONS_TOKEN: INGEST, AIS_GATEWAY_SESSIONS_FLUSH_GAP_SECONDS: "90" })).toEqual({ token: INGEST, flushGapSeconds: 90 });
    for (const bad of ["0", "x", "1.5", "99999"]) {
      expect(() => sessionsFromEnv({ AIS_GATEWAY_SESSIONS_INGEST: "1", AIS_GATEWAY_SESSIONS_TOKEN: INGEST, AIS_GATEWAY_SESSIONS_FLUSH_GAP_SECONDS: bad })).toThrow("FLUSH_GAP");
    }
  });
});

describe("session ingest routes: token scope", () => {
  test("no token, a wrong token and a near miss are refused on every ingest route", async () => {
    const h = build();
    for (const token of [null, "wrong", `${INGEST}x`, INGEST.slice(0, -1)]) {
      expect((await h.call("/sessions/v1/ping", { token })).status).toBe(401);
      expect((await h.post("/sessions/v1/cursors", { files: [] }, token)).status).toBe(401);
      expect((await h.post("/sessions/v1/ingest", { files: [] }, token)).status).toBe(401);
    }
    expect((h.store as FakeStore).calls).toHaveLength(0);
    expect(h.metrics.render()).toMatch(/ais_sessions_ingest_errors_total\{kind="auth"\} 12/);
  });

  test("the ingest token opens the ingest routes and no other admin route", async () => {
    const h = build();
    expect((await h.call("/sessions/v1/ping")).status).toBe(200);
    for (const [method, path] of [
      ["GET", "/apps"],
      ["PUT", "/apps/web"],
      ["POST", "/apps/web/tokens"],
      ["GET", "/limits"],
      ["GET", "/favourites"],
      ["POST", "/favourites"],
      ["GET", "/store/files"],
      ["GET", "/logins/renewal"],
      ["GET", "/usage/identities"],
      ["GET", "/sessions"],
      ["GET", "/sessionsx/v1/ping"],
    ] as const) {
      const res = await h.call(path, { method, ...(method !== "GET" ? { body: "{}" } : {}) });
      expect({ path, status: res.status }).toEqual({ path, status: 401 });
    }
  });

  test("the favourites token opens no ingest route", async () => {
    const h = build();
    expect((await h.call("/sessions/v1/ping", { token: favouritesToken(ADMIN) })).status).toBe(401);
  });

  test("the admin token still opens everything, the ingest routes too", async () => {
    const h = build();
    expect((await h.call("/sessions/v1/ping", { token: ADMIN })).status).toBe(200);
    expect((await h.call("/apps", { token: ADMIN })).status).toBe(200);
  });

  test("the gateway refuses to start with a short ingest token or one equal to the admin token", async () => {
    const start = (token: string) => startGateway({ port: 0, adminPort: 0, databaseUrl: "postgres://unused", adminToken: ADMIN, sessions: { token } }, {});
    expect(await start("short").then(() => undefined, (e: Error) => e.message)).toContain("AIS_GATEWAY_SESSIONS_TOKEN");
    expect(await start(ADMIN).then(() => undefined, (e: Error) => e.message)).toContain("must differ from the admin token");
  });
});

describe("session ingest routes: ping and cursors", () => {
  test("ping answers the flush gap (default 120 s) and the limits", async () => {
    const h = build();
    const body = (await (await h.call("/sessions/v1/ping")).json()) as { ok: boolean; flushGapSeconds: number; limits: Record<string, number> };
    expect(body).toMatchObject({ ok: true, flushGapSeconds: 120, limits: { cursors: SESSIONS_MAX_CURSOR_FILES, files: SESSIONS_MAX_INGEST_FILES, parts: SESSIONS_MAX_PARTS_PER_FILE, bodyBytes: SESSIONS_MAX_BODY_BYTES } });
    const custom = build({ flushGapSeconds: 45 });
    expect(((await (await custom.call("/sessions/v1/ping")).json()) as { flushGapSeconds: number }).flushGapSeconds).toBe(45);
  });

  test("ping reads the store: a database that is down answers 503 with retry-after", async () => {
    const store = new FakeStore();
    store.failWith = new Error("connection refused");
    const h = build({ store });
    const res = await h.call("/sessions/v1/ping");
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(h.metrics.render()).toMatch(/ais_sessions_ingest_errors_total\{kind="store"\} 1/);
    expect(h.metrics.render()).toMatch(/ais_sessions_ingest_requests_total\{route="ping",outcome="unavailable"\} 1/);
  });

  test("cursors passes the keys in order and answers one entry per key", async () => {
    const h = build();
    const files = [
      { kind: "claude", sessionRef: "a", node: "n", root: "/r", relPath: "a.jsonl" },
      { kind: "codex", sessionRef: "b", node: "n", root: "/r", relPath: "b.jsonl" },
    ];
    const res = await h.post("/sessions/v1/cursors", { files });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ flushGapSeconds: 120, cursors: [null, null] });
    expect((h.store as FakeStore).calls[0]).toEqual({ op: "cursors", arg: files });
  });

  test("cursors refuses bad input with 400 and names the entry", async () => {
    const h = build();
    const ok = { kind: "claude", sessionRef: "a", node: "n", root: "/r", relPath: "a.jsonl" };
    const bad = async (body: unknown) => (await h.post("/sessions/v1/cursors", body)).status;
    expect(await bad("{")).toBe(400);
    expect(await bad("[]")).toBe(400);
    expect(await bad({})).toBe(400);
    expect(await bad({ files: [] })).toBe(400);
    expect(await bad({ files: Array.from({ length: SESSIONS_MAX_CURSOR_FILES + 1 }, () => ok) })).toBe(400);
    expect(await bad({ files: [{ ...ok, kind: "Claude" }] })).toBe(400);
    expect(await bad({ files: [{ ...ok, sessionRef: "" }] })).toBe(400);
    expect(await bad({ files: [{ ...ok, relPath: 5 }] })).toBe(400);
    expect(await bad({ files: [{ ...ok, sessionRef: "a\u0000b" }] })).toBe(400);
    expect(await bad({ files: [{ ...ok, root: "/r\nx" }] })).toBe(400);
    const msg = (await (await h.post("/sessions/v1/cursors", { files: [ok, { ...ok, node: "" }] })).json()) as { error: string };
    expect(msg.error).toContain("files[1]");
    expect(await bad({ files: Array.from({ length: SESSIONS_MAX_CURSOR_FILES }, () => ok) })).toBe(200);
  });

  test("a body over the limit is refused with 413, by header and by streamed size", async () => {
    const h = build();
    const big = JSON.stringify({ files: [], pad: "x".repeat(SESSIONS_MAX_BODY_BYTES + 10) });
    expect((await h.post("/sessions/v1/ingest", big)).status).toBe(413);
    const streamed = await h.app.request("http://admin.test/sessions/v1/ingest", {
      method: "POST",
      headers: { authorization: `Bearer ${INGEST}` },
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(big));
          c.close();
        },
      }),
    });
    expect(streamed.status).toBe(413);
    expect(h.metrics.render()).toMatch(/ais_sessions_ingest_errors_total\{kind="body"\} 2/);
    expect((h.store as FakeStore).calls).toHaveLength(0);
  });
});

describe("session ingest routes: ingest records", () => {
  test("a record with parts goes to ingest, one with no parts goes to hold", async () => {
    const h = build();
    const res = await h.post("/sessions/v1/ingest", { files: [record([part(0, 1000)]), record([], { sessionRef: "s2" })] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { flushGapSeconds: number; results: Array<{ status: string }> };
    expect(body.flushGapSeconds).toBe(120);
    expect(body.results.map((r) => r.status)).toEqual(["committed", "committed"]);
    expect((h.store as FakeStore).calls.map((c) => c.op)).toEqual(["ingest", "hold"]);
    const sent = (h.store as FakeStore).calls[0]!.arg as Record<string, unknown>;
    expect(sent).toMatchObject({ kind: "claude", sessionRef: "s1", node: "node-a", root: "/data/pool", relPath: "projects/p/s1.jsonl", origin: "t3-pool", pool: "main", generation: 0 });
  });

  test("results keep the order, each record stands alone, and a conflict carries its reason and cursor", async () => {
    const store = new FakeStore();
    const answers: IngestResult[] = [
      { status: "conflict", reason: "gap", cursor: { fileId: 1, generation: 0, committedBytes: 500, committedLines: 5, headSha256: sha("head") } },
      { status: "duplicate", cursor: { fileId: 2, generation: 1, committedBytes: 900, committedLines: 9, headSha256: sha("h2") } },
      { status: "conflict", reason: "other_copy", cursor: null },
    ];
    store.ingest = async (req) => {
      store.calls.push({ op: "ingest", arg: req });
      return answers.shift()!;
    };
    const h = build({ store });
    const res = await h.post("/sessions/v1/ingest", { files: [record([part(900, 100)]), record([part(0, 900)], { sessionRef: "s2" }), record([part(0, 10)], { sessionRef: "s3" })] });
    const body = (await res.json()) as { results: unknown[] };
    expect(body.results).toEqual([
      { status: "conflict", reason: "gap", cursor: { generation: 0, committedBytes: 500, committedLines: 5, headSha256: sha("head") } },
      { status: "duplicate", cursor: { generation: 1, committedBytes: 900, committedLines: 9, headSha256: sha("h2") } },
      { status: "conflict", reason: "other_copy", cursor: null },
    ]);
  });

  test("a bad record is invalid and the others still run", async () => {
    const h = build();
    const res = await h.post("/sessions/v1/ingest", {
      files: [
        record([part(0, 100)], { headSha256: 5 }),
        record([{ ...part(0, 100), objectKey: "elsewhere/x" }]),
        record([{ ...part(0, 100), objectKey: "objects/v1/../../x" }]),
        record(Array.from({ length: SESSIONS_MAX_PARTS_PER_FILE + 1 }, (_, i) => part(i * 10, 10))),
        record([part(0, 100)], { generation: 1.5 }),
        record([part(0, 100)], { origin: "" }),
        record([part(0, 100)]),
      ],
    });
    const body = (await res.json()) as { results: Array<{ status: string; error?: string }> };
    expect(body.results.map((r) => r.status)).toEqual(["invalid", "invalid", "invalid", "invalid", "invalid", "invalid", "committed"]);
    expect(body.results[1]!.error).toContain("objects/v1/");
    expect((h.store as FakeStore).calls).toHaveLength(1);
  });

  test("values that Postgres refuses are invalid results of their own record, and the rest of the batch goes on", async () => {
    const h = build();
    const res = await h.post("/sessions/v1/ingest", {
      files: [
        record([part(0, 100)], { generation: 2_147_483_648 }),
        record([{ ...part(0, 100), lines: 2_147_483_648 }]),
        record([part(0, 100)], { mtimeMs: -5 }),
        record([part(0, 100)], { mtimeMs: 1e18 }),
        record([part(0, 100)], { sessionRef: "a\u0000b" }),
        record([part(0, 100)], { origin: "t3\u0000pool" }),
        record([part(0, 100)], { pool: "p\nq" }),
        record([part(0, 100)], { parentRef: "p\u0001" }),
        record([part(0, 100)], { relPath: "a\u0000" }),
        record([], { sessionRef: "a\u0000b" }),
        record([part(0, 100)], { anchor: { startOffset: 0, endOffset: 0, plainSha256: sha("x") } }),
        record([part(0, 100)], { anchor: "nope" }),
        record([part(0, 100)], { sessionRef: "ok", generation: 2_147_483_647 }),
        record([part(0, 100)], { sessionRef: "ok2", mtimeMs: 0 }),
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Array<{ status: string; error?: string }> };
    expect(body.results.map((r) => r.status)).toEqual([...Array.from({ length: 12 }, () => "invalid"), "committed", "committed"]);
    expect(body.results[0]!.error).toContain("generation");
    expect(body.results[1]!.error).toContain("lines");
    expect(body.results[2]!.error).toContain("mtimeMs");
    expect(body.results[4]!.error).toContain("control");
    expect((h.store as FakeStore).calls).toHaveLength(2);
  });

  test("an object key must belong to the record's own session and generation", async () => {
    const h = build();
    const own = (ref: string, gen: number) => partObjectPrefix("claude", ref, gen);
    const res = await h.post("/sessions/v1/ingest", {
      files: [
        record([{ ...part(0, 100), objectKey: `${own("other", 0)}0-100.gz.age` }]),
        record([{ ...part(0, 100), objectKey: `${own("s1", 1)}0-100.gz.age` }]),
        record([{ ...part(0, 100), objectKey: "objects/v1/claude/abc/g0/0-100.gz.age" }]),
        record([{ ...part(0, 100), objectKey: `${own("s1", 0)}x/0-100.gz.age` }]),
        record([part(0, 100)], { generation: 4 }),
        record([{ ...part(0, 100), objectKey: `${own("s1", 4)}0-100.gz.age` }], { generation: 4 }),
      ],
    });
    const body = (await res.json()) as { results: Array<{ status: string; error?: string }> };
    expect(body.results.map((r) => r.status)).toEqual(["invalid", "invalid", "invalid", "invalid", "committed", "committed"]);
    expect(body.results[0]!.error).toContain("objectKey");
    expect((h.store as FakeStore).calls).toHaveLength(2);
  });

  test("the anchor goes to the store as sent", async () => {
    const h = build();
    await h.post("/sessions/v1/ingest", { files: [record([part(1000, 100)], { anchor: anchorOf(0, 1000) }), record([], { anchor: anchorOf(0, 1000), sessionRef: "s2" })] });
    const calls = (h.store as FakeStore).calls;
    expect(calls.map((c) => (c.arg as { anchor?: unknown }).anchor)).toEqual([anchorOf(0, 1000), anchorOf(0, 1000)]);
  });

  test("a request the store refuses as invalid (bad hash) is an invalid result, not a failed request", async () => {
    const real = await import("../../src/gateway/sessions/session-store.ts");
    const store = new FakeStore();
    store.ingest = async () => {
      throw new real.SessionIngestInvalid("plainSha256 must be 64 lower-case hex characters");
    };
    const h = build({ store });
    const res = await h.post("/sessions/v1/ingest", { files: [record([part(0, 100)])] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { results: Array<{ status: string; error: string }> }).results[0]).toEqual({ status: "invalid", error: "plainSha256 must be 64 lower-case hex characters" });
  });

  test("ingest refuses a bad envelope with 400", async () => {
    const h = build();
    const bad = async (body: unknown) => (await h.post("/sessions/v1/ingest", body)).status;
    expect(await bad("nope")).toBe(400);
    expect(await bad({})).toBe(400);
    expect(await bad({ files: [] })).toBe(400);
    expect(await bad({ files: Array.from({ length: SESSIONS_MAX_INGEST_FILES + 1 }, () => record([part(0, 10)])) })).toBe(400);
  });

  test("a store failure answers 503 with retry-after, so the shipper backs off", async () => {
    const store = new FakeStore();
    store.failWith = new Error("the database is down");
    const h = build({ store });
    const res = await h.post("/sessions/v1/ingest", { files: [record([part(0, 10)])] });
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(await res.json()).toEqual({ error: "the session store is unavailable" });
  });

  test("with an object check, a part whose object is missing is not committed", async () => {
    const store = new FakeStore();
    const seen: string[] = [];
    const h = build({ store, objectExists: async (k) => (seen.push(k), !k.includes("500-")) });
    const res = await h.post("/sessions/v1/ingest", { files: [record([part(0, 500), part(500, 100)]), record([part(0, 400)], { sessionRef: "s2" })] });
    const body = (await res.json()) as { results: Array<{ status: string; reason?: string; cursor?: unknown }> };
    expect(body.results[0]).toEqual({ status: "conflict", reason: "object_missing", cursor: null });
    expect(body.results[1]!.status).toBe("committed");
    expect(store.calls).toHaveLength(1);
    expect(h.metrics.render()).toMatch(/ais_sessions_ingest_total\{outcome="object_missing"\} 1/);
  });

  test("an object check that fails answers 503, not a commit", async () => {
    const h = build({ objectExists: async () => { throw new Error("s3 down"); } });
    expect((await h.post("/sessions/v1/ingest", { files: [record([part(0, 10)])] })).status).toBe(503);
    expect(h.metrics.render()).toMatch(/ais_sessions_ingest_errors_total\{kind="object_check"\} 1/);
  });
});

describe("session ingest routes: metrics", () => {
  test("counts requests, records, parts, bytes and lag, and the series stay bounded", async () => {
    const store = new FakeStore();
    store.result = { status: "committed", cursor: { fileId: 1, generation: 0, committedBytes: 1600, committedLines: 16, headSha256: sha("head") }, created: false, partsAdded: 1 };
    const h = build({ store });
    // Two parts sent, one was a repeat: only the last one counts as stored.
    await h.post("/sessions/v1/ingest", { files: [record([part(0, 1000), part(1000, 600)])] });
    await h.post("/sessions/v1/ingest", { files: [record([part(0, 10)], { headSha256: 5 }), record([part(0, 10)], { kind: "BAD" })] });
    await h.post("/sessions/v1/cursors", { files: [] });
    await h.call("/sessions/v1/ping");
    const text = h.metrics.render();
    expect(text).toMatch(/ais_sessions_ingest_requests_total\{route="ingest",outcome="ok"\} 2/);
    expect(text).toMatch(/ais_sessions_ingest_requests_total\{route="cursors",outcome="bad_request"\} 1/);
    expect(text).toMatch(/ais_sessions_ingest_requests_total\{route="ping",outcome="ok"\} 1/);
    expect(text).toMatch(/ais_sessions_ingest_total\{outcome="committed"\} 1/);
    expect(text).toMatch(/ais_sessions_ingest_total\{outcome="invalid"\} 2/);
    expect(text).toMatch(/ais_sessions_ingest_parts_total 1/);
    expect(text).toMatch(/ais_sessions_ingest_bytes_total\{kind="plain"\} 600/);
    expect(text).toMatch(/ais_sessions_ingest_bytes_total\{kind="object"\} 100/);
    // The host file was 30 s old when the parts were committed: 30 s falls in the 30 s bucket and not in the 15 s one.
    expect(text).toMatch(/ais_sessions_ingest_lag_seconds_bucket\{le="15"\} 0/);
    expect(text).toMatch(/ais_sessions_ingest_lag_seconds_bucket\{le="30"\} 1/);
    expect(text).toMatch(/ais_sessions_ingest_lag_seconds_count 1/);
    expect(text).toMatch(/ais_sessions_ingest_seconds_count 4/);
    // No path, session id or token ever becomes a label.
    expect(text).not.toContain("/data/pool");
    expect(text).not.toContain("s1.jsonl");
    expect(text).not.toContain(INGEST);
  });
});

describe("the gateway wires the ingest routes behind the flag", () => {
  let started: Array<{ stop(): Promise<void> }> = [];
  afterEach(async () => {
    for (const g of started.splice(0)) await g.stop();
  });
  const hooks = (over: Partial<GatewayHooks> = {}): GatewayHooks => ({
    host: "127.0.0.1",
    refreshBackend: new MemoryRefreshBackend(),
    migrate: async () => undefined,
    openStore: () => new MemoryGatewayStore(),
    usageFor: async () => undefined,
    poolMembers: async () => [],
    notify: () => undefined,
    warmBackoff: { initialMs: 10, maxMs: 20 },
    ledger: { max: 1000, flushMs: 3_600_000 },
    refreshIntervalMs: 3_600_000,
    exit: () => undefined,
    noHeartbeat: true,
    ...over,
  });
  const boot = async (sessions: boolean, over: Partial<GatewayHooks> = {}) => {
    const g = await startGateway({ port: 0, adminPort: 0, databaseUrl: "postgres://unused", adminToken: ADMIN, ...(sessions ? { sessions: { token: INGEST, flushGapSeconds: 90 } } : {}) }, hooks(over));
    started.push(g);
    return g;
  };
  const admin = (g: { adminPort: number }, path: string, token: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${g.adminPort}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });

  test("flag on: the ingest token reaches the ingest routes and the metrics show them", async () => {
    const store = new FakeStore();
    const g = await boot(true, { sessionStore: store });
    const ping = await admin(g, "/sessions/v1/ping", INGEST);
    expect(ping.status).toBe(200);
    expect(((await ping.json()) as { flushGapSeconds: number }).flushGapSeconds).toBe(90);
    expect((await admin(g, "/apps", INGEST)).status).toBe(401);
    const res = await admin(g, "/sessions/v1/ingest", INGEST, { method: "POST", body: JSON.stringify({ files: [record([part(0, 100)])] }) });
    expect(res.status).toBe(200);
    const metrics = await (await fetch(`http://127.0.0.1:${g.port}/metrics`)).text();
    expect(metrics).toMatch(/ais_sessions_ingest_total\{outcome="committed"\} 1/);
  });

  test("flag off: the routes are 404 and the ingest token is not known", async () => {
    const g = await boot(false);
    expect((await admin(g, "/sessions/v1/ping", ADMIN)).status).toBe(404);
    expect((await admin(g, "/sessions/v1/ping", INGEST)).status).toBe(401);
  });
});

// Real database: the routes with the real SessionStore. CI provides the database; a laptop skips these.
const url = process.env.AIS_GATEWAY_TEST_DATABASE_URL;
const optOut = process.env.AIS_GATEWAY_TEST_NO_DATABASE === "1";

if (!url && process.env.CI && !optOut) {
  test("session ingest route tests need AIS_GATEWAY_TEST_DATABASE_URL in CI", () => {
    throw new Error("AIS_GATEWAY_TEST_DATABASE_URL is unset in CI; provide a Postgres service or set AIS_GATEWAY_TEST_NO_DATABASE=1");
  });
} else if (!url) {
  console.warn("SKIP session ingest database tests: AIS_GATEWAY_TEST_DATABASE_URL is not set");
  test.skip("session ingest database tests need AIS_GATEWAY_TEST_DATABASE_URL", () => {});
} else {
  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (!dbName.includes("test")) throw new Error(`refusing to use database "${dbName}": its name must contain "test"`);
  const admin = new SQL(url);
  let sessionStore: SessionStore;
  let h: ReturnType<typeof build>;
  type Result = { status: string; reason?: string; partsAdded?: number; created?: boolean; cursor?: { committedBytes: number; committedLines?: number; headSha256?: string; generation: number; held?: boolean; anchor?: { startOffset: number; endOffset: number; plainSha256: string } | null } | null };
  const ingest = async (files: unknown[]): Promise<Result[]> => {
    const res = await h.post("/sessions/v1/ingest", { files });
    expect(res.status).toBe(200);
    return ((await res.json()) as { results: Result[] }).results;
  };
  const cursors = async (files: unknown[]) => ((await (await h.post("/sessions/v1/cursors", { files })).json()) as { cursors: Array<Result["cursor"]> }).cursors;
  const key = (over: Record<string, unknown> = {}) => ({ kind: "claude", sessionRef: "s1", node: "node-a", root: "/data/pool", relPath: "projects/p/s1.jsonl", ...over });
  const rows = async (table: string): Promise<number> => Number((await admin.unsafe(`SELECT count(*)::int AS n FROM ${table}`))[0]!.n);

  beforeEach(async () => {
    await migrate(url);
    await admin`TRUNCATE ais_session_file RESTART IDENTITY CASCADE`;
    sessionStore = new SessionStore(url, { poolMax: 3 });
    h = build({ store: sessionStore });
  });
  afterEach(async () => {
    await sessionStore.close();
  });
  afterAll(async () => {
    await admin.close();
  });

  describe("session ingest routes on the real store", () => {
    test("an unknown session has no cursor, ingest creates it, and the cursor follows", async () => {
      expect(await cursors([key()])).toEqual([null]);
      const [first] = await ingest([record([part(0, 1000), part(1000, 500)])]);
      expect(first).toMatchObject({ status: "committed", created: true, partsAdded: 2, cursor: { generation: 0, committedBytes: 1500 } });
      expect(await cursors([key()])).toEqual([{ generation: 0, committedBytes: 1500, committedLines: part(0, 1000).lines + part(1000, 500).lines, headSha256: sha("head"), held: true, anchor: anchorOf(1000, 500) }]);
      const [next] = await ingest([record([part(1500, 200)])]);
      expect(next).toMatchObject({ status: "committed", created: false, cursor: { committedBytes: 1700 } });
    });

    test("idempotent: the same request twice stores each part once, and the second answer says duplicate", async () => {
      const rec = record([part(0, 1000), part(1000, 1000)]);
      const [a] = await ingest([rec]);
      const [b] = await ingest([rec]);
      expect(a!.status).toBe("committed");
      expect(b).toMatchObject({ status: "duplicate", cursor: { committedBytes: 2000 } });
      expect(await rows("ais_session_part")).toBe(2);
      expect(await rows("ais_session_file")).toBe(1);
    });

    test("offset checks: a gap and an overlap are conflicts that carry the cursor, and change nothing", async () => {
      await ingest([record([part(0, 1000)])]);
      const [gap, overlap, ok] = await ingest([record([part(1100, 100)]), record([part(0, 1000, "other")]), record([part(1000, 100)])]);
      expect(gap).toMatchObject({ status: "conflict", reason: "gap", cursor: { committedBytes: 1000 } });
      expect(overlap).toMatchObject({ status: "conflict", reason: "overlap", cursor: { committedBytes: 1000 } });
      expect(ok).toMatchObject({ status: "committed", cursor: { committedBytes: 1100 } });
      expect(await rows("ais_session_part")).toBe(2);
    });

    test("version checks: a rewrite is refused, a newer generation starts at byte 0, an older one is stale", async () => {
      await ingest([record([part(0, 5000)])]);
      const [rewritten] = await ingest([record([part(5000, 100)], { headSha256: sha("new") })]);
      expect(rewritten).toMatchObject({ status: "conflict", reason: "rewritten", cursor: { generation: 0 } });
      const [gen1, notStart, stale] = await ingest([
        record([part(0, 800, "v2")], { generation: 1, headSha256: sha("new") }),
        record([part(800, 100)], { generation: 2, headSha256: sha("new") }),
        record([part(5000, 100)], { generation: 0 }),
      ]);
      expect(gen1).toMatchObject({ status: "committed", created: true, cursor: { generation: 1, committedBytes: 800 } });
      expect(notStart).toMatchObject({ status: "conflict", reason: "generation_start", cursor: { generation: 1 } });
      expect(stale).toMatchObject({ status: "conflict", reason: "stale_generation", cursor: { generation: 1 } });
    });

    test("one copy: a second node continues the stored session, is recorded as a holder, and no byte is stored twice", async () => {
      await ingest([record([part(0, 5000)])]);
      const second = { node: "node-b", root: "/other", relPath: "pool2/s1.jsonl", origin: "agent-pod", pool: null };
      const [c] = await cursors([key(second)]);
      expect(c).toMatchObject({ committedBytes: 5000, held: false });
      expect(c).toMatchObject({ anchor: anchorOf(0, 5000) });
      const [noProof] = await ingest([record([part(5000, 700)], second)]);
      expect(noProof).toMatchObject({ status: "conflict", reason: "proof_required", cursor: { committedBytes: 5000 } });
      const [r] = await ingest([record([part(5000, 700)], { ...second, anchor: c!.anchor })]);
      expect(r).toMatchObject({ status: "committed", created: false, cursor: { committedBytes: 5700 } });
      // The same session again from both paths: nothing new, both are holders.
      const [d] = await ingest([record([], second)]);
      expect(d!.status).toBe("duplicate");
      expect((await cursors([key(second), key()])).map((x) => x?.held)).toEqual([true, true]);
      expect(await rows("ais_session_file")).toBe(1);
      expect(await rows("ais_session_part")).toBe(2);
      expect((await sessionStore.paths("claude", "s1")).map((p) => [p.node, p.origin])).toEqual([["node-a", "t3-pool"], ["node-b", "agent-pod"]]);
      expect(await sessionStore.tree()).toHaveLength(1);
    });

    test("one copy: a path with another head is refused as other_copy and is not recorded", async () => {
      await ingest([record([part(0, 5000)])]);
      const stranger = { node: "node-b", root: "/other", relPath: "x.jsonl", headSha256: sha("different") };
      const [r] = await ingest([record([part(5000, 100)], stranger)]);
      expect(r).toMatchObject({ status: "conflict", reason: "other_copy", cursor: { committedBytes: 5000 } });
      expect((await sessionStore.paths("claude", "s1")).map((p) => p.node)).toEqual(["node-a"]);
    });

    test("one copy: a copy that differs after the first 4 KiB is refused by its anchor, and a bad record does not fail the batch", async () => {
      await ingest([record([part(0, 3000), part(3000, 3000)])]);
      const stranger = { node: "node-b", root: "/other", relPath: "x.jsonl" };
      const results = await ingest([
        record([part(6000, 100)], { ...stranger, anchor: anchorOf(3000, 3000, "other") }),
        record([part(6000, 100)], { ...stranger, sessionRef: "bad\u0000ref", anchor: anchorOf(3000, 3000) }),
        record([part(6000, 100)], { ...stranger, anchor: anchorOf(3000, 3000) }),
      ]);
      expect(results.map((r) => r.status)).toEqual(["conflict", "invalid", "committed"]);
      expect(results[0]).toMatchObject({ reason: "other_copy", cursor: { committedBytes: 6000 } });
      expect(results[2]).toMatchObject({ cursor: { committedBytes: 6100 } });
    });

    test("the same session of two tools stays two sessions", async () => {
      await ingest([record([part(0, 100)]), record([part(0, 100)], { kind: "codex" })]);
      expect(await rows("ais_session_file")).toBe(2);
    });

    test("the route metrics match what the store did", async () => {
      await ingest([record([part(0, 1000)])]);
      await ingest([record([part(0, 1000)])]);
      await ingest([record([part(1100, 10)])]);
      const text = h.metrics.render();
      expect(text).toMatch(/ais_sessions_ingest_total\{outcome="committed"\} 1/);
      expect(text).toMatch(/ais_sessions_ingest_total\{outcome="duplicate"\} 1/);
      expect(text).toMatch(/ais_sessions_ingest_total\{outcome="conflict"\} 1/);
      expect(text).toMatch(/ais_sessions_ingest_bytes_total\{kind="plain"\} 1000/);
    });
  });
}
