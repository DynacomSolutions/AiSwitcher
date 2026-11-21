import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createAdminApp } from "../../src/gateway/admin.ts";
import { createGatewayApp, type GatewayDeps } from "../../src/gateway/app.ts";
import { CachedGatewayStore } from "../../src/gateway/cache-store.ts";
import { LedgerBuffer } from "../../src/gateway/ledger-buffer.ts";
import { clientFamily, sessionKeyFromBodyTail, sessionKeyFromHeaders } from "../../src/gateway/session-key.ts";
import { foldSessionUsage } from "../../src/gateway/session-usage.ts";
import { MemoryGatewayStore } from "../../src/gateway/store.ts";
import { generateToken } from "../../src/gateway/tokens.ts";
import { mapGatewaySessions } from "../../src/gateway/usage-view.ts";
import { noopMetrics } from "../../src/gateway/metrics.ts";

const SID = "6cc07c23-4501-42cb-ba6e-3c14d864219e";
const CODEX_SID = "01a1ff70-ad7f-7a20-9516-b226a8f39380";

describe("session key", () => {
  test("Claude Code header, Codex header and a plain request", () => {
    expect(sessionKeyFromHeaders(new Headers({ "x-claude-code-session-id": SID }))).toBe(SID);
    expect(sessionKeyFromHeaders(new Headers({ "session-id": CODEX_SID, "thread-id": CODEX_SID }))).toBe(CODEX_SID);
    expect(sessionKeyFromHeaders(new Headers({ "user-agent": "x" }))).toBeUndefined();
  });

  test("a value that is not shaped like an id never reaches the ledger", () => {
    expect(sessionKeyFromHeaders(new Headers({ "x-claude-code-session-id": "short" }))).toBeUndefined();
    expect(sessionKeyFromHeaders(new Headers({ "x-claude-code-session-id": "a b c d e f g h i" }))).toBeUndefined();
    expect(sessionKeyFromHeaders(new Headers({ "x-claude-code-session-id": "x".repeat(200) }))).toBeUndefined();
  });

  test("the body tail holds metadata.user_id with the session id, current and older shape", () => {
    const enc = new TextEncoder();
    const current = JSON.stringify({ model: "m", metadata: { user_id: JSON.stringify({ device_id: "d", account_uuid: "", session_id: SID }) }, max_tokens: 1 });
    expect(sessionKeyFromBodyTail(enc.encode(current))).toBe(SID);
    const older = JSON.stringify({ model: "m", metadata: { user_id: `user_abc_account_${CODEX_SID}_session_${SID}` } });
    expect(sessionKeyFromBodyTail(enc.encode(older))).toBe(SID);
    expect(sessionKeyFromBodyTail(enc.encode(JSON.stringify({ model: "m" })))).toBeUndefined();
    expect(sessionKeyFromBodyTail(new Uint8Array())).toBeUndefined();
  });

  test("client family from the user agent", () => {
    expect(clientFamily("claude-cli/2.1.321 (external, sdk-cli)")).toBe("claude-cli");
    expect(clientFamily("codex_exec/0.167.0 (Linux)")).toBe("codex_exec");
    expect(clientFamily(null)).toBeUndefined();
  });
});

const at = (min: number): string => new Date(Date.UTC(2026, 10, 22, 3, min)).toISOString();
const base = { app: "pool-app", provider: "claude" as const, cacheReadTokens: 0, cacheWriteTokens: 0, httpStatus: 200, latencyMs: 1, streamed: false, status: "ok", model: "m", client: "claude-cli" };

describe("session ledger: the split over accounts", () => {
  let store: MemoryGatewayStore;
  beforeEach(() => {
    store = new MemoryGatewayStore();
  });
  const sessions = async () => foldSessionUsage(await store.usageBySession(new Date(Date.UTC(2026, 10, 22)), undefined, {}));

  test("one session on one member", async () => {
    await store.appendUsage([
      { ...base, ts: at(1), identity: "alice", sessionKey: SID, inputTokens: 10, outputTokens: 5, cacheReadTokens: 100 },
      { ...base, ts: at(2), identity: "alice", sessionKey: SID, inputTokens: 20, outputTokens: 7, cacheWriteTokens: 3 },
    ]);
    const [s] = await sessions();
    expect(s).toMatchObject({ sessionKey: SID, provider: "claude", client: "claude-cli", activeIdentity: "alice", turns: 2, firstTs: at(1), lastTs: at(2) });
    expect(s!.identities).toEqual([{ identity: "alice", turns: 2, inputTokens: 30, outputTokens: 12, cacheReadTokens: 100, cacheWriteTokens: 3, firstTs: at(1), lastTs: at(2) }]);
  });

  test("a swap in mid-session: two accounts, each with its own share, the latest one active", async () => {
    await store.appendUsage([
      { ...base, ts: at(1), identity: "alice", sessionKey: SID, inputTokens: 10, outputTokens: 1 },
      { ...base, ts: at(2), identity: "alice", sessionKey: SID, inputTokens: 10, outputTokens: 1 },
      { ...base, ts: at(3), identity: "bob", sessionKey: SID, inputTokens: 5, outputTokens: 2, cacheReadTokens: 50 },
      // another session, never mixed in
      { ...base, ts: at(4), identity: "carol", sessionKey: CODEX_SID, inputTokens: 99, outputTokens: 99 },
    ]);
    const list = await sessions();
    const s = list.find((x) => x.sessionKey === SID)!;
    expect(s.activeIdentity).toBe("bob");
    expect(s.turns).toBe(3);
    expect(s.identities.map((i) => [i.identity, i.turns, i.inputTokens, i.outputTokens, i.cacheReadTokens])).toEqual([
      ["bob", 1, 5, 2, 50],
      ["alice", 2, 20, 2, 0],
    ]);
    expect(list.find((x) => x.sessionKey === CODEX_SID)!.activeIdentity).toBe("carol");
  });

  test("swapping back: the account of the latest request is active, and keeps one entry with all its turns", async () => {
    await store.appendUsage([
      { ...base, ts: at(1), identity: "alice", sessionKey: SID, inputTokens: 1, outputTokens: 1 },
      { ...base, ts: at(2), identity: "bob", sessionKey: SID, inputTokens: 1, outputTokens: 1 },
      { ...base, ts: at(3), identity: "alice", sessionKey: SID, inputTokens: 1, outputTokens: 1 },
    ]);
    const [s] = await sessions();
    expect(s!.activeIdentity).toBe("alice");
    expect(s!.identities.map((i) => [i.identity, i.turns, i.firstTs, i.lastTs])).toEqual([
      ["alice", 2, at(1), at(3)],
      ["bob", 1, at(2), at(2)],
    ]);
  });

  test("rows without a key, rejected rows and the '-' identity never count; a key filter narrows", async () => {
    await store.appendUsage([
      { ...base, ts: at(1), identity: "alice", inputTokens: 1, outputTokens: 1 },
      { ...base, ts: at(2), identity: "-", sessionKey: SID, status: "rejected", inputTokens: 0, outputTokens: 0 },
      { ...base, ts: at(3), identity: "alice", sessionKey: SID, status: "rejected", inputTokens: 0, outputTokens: 0 },
      { ...base, ts: at(4), identity: "bob", sessionKey: CODEX_SID, inputTokens: 1, outputTokens: 1 },
    ]);
    expect((await sessions()).map((s) => s.sessionKey)).toEqual([CODEX_SID]);
    expect(await store.usageBySession(new Date(0), undefined, { sessionKeys: [SID] })).toEqual([]);
    expect((await store.usageBySession(new Date(0), undefined, { sessionKeys: [CODEX_SID] })).length).toBe(1);
  });

  test("a session with no gateway traffic is simply absent", async () => {
    expect(await sessions()).toEqual([]);
  });
});

describe("admin GET /usage/sessions", () => {
  const ADMIN = "adm-test-value-0001-0123456789abcdef";
  let inner: MemoryGatewayStore;
  let store: CachedGatewayStore;
  let admin: ReturnType<typeof createAdminApp>;
  const now = new Date("2026-11-22T04:00:00.000Z");
  const call = (path: string, token: string | null = ADMIN) => admin.request(`http://admin.test${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  beforeEach(async () => {
    inner = new MemoryGatewayStore();
    store = new CachedGatewayStore(inner);
    await store.warm();
    admin = createAdminApp({ store, adminToken: ADMIN, now: () => now });
    await inner.appendUsage([
      { ...base, ts: at(1), identity: "alice", sessionKey: SID, inputTokens: 10, outputTokens: 1 },
      { ...base, ts: at(2), identity: "bob", sessionKey: SID, inputTokens: 4, outputTokens: 2 },
      { ...base, ts: at(3), identity: "carol", provider: "codex", sessionKey: CODEX_SID, inputTokens: 1, outputTokens: 1 },
    ]);
  });
  afterEach(() => store.stop());

  test("401 without the admin token", async () => {
    expect((await call("/usage/sessions", null)).status).toBe(401);
  });

  test("answers each session with its active account and the split", async () => {
    const body = (await (await call("/usage/sessions?days=1")).json()) as { sessions: Array<Record<string, any>> };
    expect(body.sessions.map((s) => s.sessionKey)).toEqual([CODEX_SID, SID]);
    const s = body.sessions.find((x) => x.sessionKey === SID)!;
    expect(s.activeIdentity).toBe("bob");
    expect(s.identities.map((i: any) => i.identity)).toEqual(["bob", "alice"]);
    expect(Object.keys(s.identities[0]).sort()).toEqual(["cacheReadTokens", "cacheWriteTokens", "firstTs", "identity", "inputTokens", "lastTs", "outputTokens", "turns"]);
  });

  test("filters by provider and by session id", async () => {
    const byProvider = (await (await call("/usage/sessions?days=1&provider=codex")).json()) as any;
    expect(byProvider.sessions.map((s: any) => s.sessionKey)).toEqual([CODEX_SID]);
    const byKey = (await (await call(`/usage/sessions?days=1&session=${SID}`)).json()) as any;
    expect(byKey.sessions.map((s: any) => s.sessionKey)).toEqual([SID]);
    expect((await call("/usage/sessions?provider=nope")).status).toBe(400);
  });

  test("the console mapper keeps the shape and drops malformed entries", async () => {
    const body = await (await call("/usage/sessions?days=1")).json();
    const mapped = mapGatewaySessions(body);
    expect(mapped.find((s) => s.sessionKey === SID)!.activeIdentity).toBe("bob");
    expect(mapGatewaySessions({ sessions: [{ sessionKey: "", provider: "claude", identities: [] }, null, { sessionKey: SID, provider: "claude", identities: [] }] })).toEqual([]);
    expect(mapGatewaySessions(null)).toEqual([]);
  });
});

describe("the proxy writes the session key to the ledger", () => {
  async function run(headers: Record<string, string>, body: unknown = { model: "claude-x" }) {
    const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) { await req.arrayBuffer(); return new Response('{"model":"claude-x","usage":{"input_tokens":3,"output_tokens":2}}', { headers: { "content-type": "application/json" } }); } });
    const store = new MemoryGatewayStore();
    const ledger = new LedgerBuffer(store, { max: 1000, flushMs: 3_600_000 });
    const t = generateToken();
    await store.putApp({ name: "a", owner: "o", namespace: "ns", provider: "claude", style: "anthropic", target: { kind: "pool" }, state: "active", createdAt: "2026-11-01T00:00:00.000Z" });
    await store.addToken({ app: "a", prefix: t.prefix, hash: t.hash, createdAt: new Date().toISOString() });
    const deps: GatewayDeps = {
      store,
      ledger,
      creds: { get: async (_p: string, identity: string) => ({ identity, accessToken: "x" }), refreshAfter401: async () => ({ identity: "alice", accessToken: "y" }) } as unknown as GatewayDeps["creds"],
      usageFor: async () => undefined,
      poolMembers: async () => ["alice"],
      fetch: ((input: string | URL | Request, init?: RequestInit) => fetch(`http://127.0.0.1:${upstream.port}${new URL(String(input)).pathname}`, init)) as typeof fetch,
      now: () => new Date(),
      metrics: noopMetrics,
      log: () => {},
    };
    const res = await createGatewayApp(deps).fetch(new Request("http://gw/a/v1/messages", { method: "POST", headers: { authorization: `Bearer ${t.token}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
    await res.arrayBuffer();
    await ledger.flush();
    upstream.stop(true);
    const rows = await store.usageBySession(new Date(0), undefined, {});
    await ledger.close();
    return rows;
  }

  test("from the Claude Code header, with the tool family", async () => {
    const rows = await run({ "x-claude-code-session-id": SID, "user-agent": "claude-cli/2.1.321 (external, sdk-cli)" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sessionKey: SID, provider: "claude", app: "a", client: "claude-cli", identity: "alice", turns: 1, inputTokens: 3, outputTokens: 2 });
  });

  test("from metadata.user_id in the body when no header names it", async () => {
    const rows = await run({}, { model: "claude-x", metadata: { user_id: JSON.stringify({ session_id: SID }) } });
    expect(rows[0]).toMatchObject({ sessionKey: SID, identity: "alice" });
  });

  test("a request with no session id leaves the row out of the session view", async () => {
    expect(await run({})).toEqual([]);
  });
});
