import { describe, expect, test } from "bun:test";
import { createApp, type ConsoleAppDeps } from "../../src/server/app.ts";
import { addGatewayIdentity, parseGatewayIdentityInput, type GatewayIdentitiesDeps } from "../../src/server/gateway-identities.ts";
import { StoreApiError } from "../../src/gateway/home-store-http.ts";
import type { HomeFileMeta, PutResult } from "../../src/gateway/home-store.ts";
import { HttpError } from "../../src/server/types.ts";

const CLAUDE_PATH = ".claude/identities.json";
const CODEX_PATH = ".codex/identities.json";

const claudeRegistry = () => ({
  version: 1,
  identities: [
    { name: "pool-a", label: "Agent pool", configDir: "/profiles/u/.claude/identities/pool-a", swapPool: { accounts: ["member-a", "member-b"], active: "member-a" } },
    { name: "member-a", label: "Member A", configDir: "/profiles/u/.claude/identities/member-a" },
    { name: "member-b", label: "Member B", configDir: "/profiles/u/.claude/identities/member-b", aliases: ["mb"] },
    { name: "solo", label: "Solo", configDir: "/profiles/u/.claude/identities/solo" },
  ],
});
const codexRegistry = () => ({
  version: 1,
  identities: [{ name: "cx-a", label: "Codex A", configDir: "/profiles/u/.codex/identities/cx-a", codexLoginMethod: "browser" }],
});

interface Put {
  path: string;
  json: ReturnType<typeof claudeRegistry>;
  opts: { account: string | null; kind: string; expectedVersion?: number | null };
}

function fakeStore(files: Record<string, { content: unknown; version: number }>, over: { put?: () => PutResult | Promise<PutResult>; list?: () => Promise<HomeFileMeta[]> } = {}) {
  const puts: Put[] = [];
  let closed = 0;
  const metas = (): HomeFileMeta[] => Object.entries(files).map(([path, f]) => ({ path, account: null, kind: "registry", sha256: "x", version: f.version }));
  const store: NonNullable<GatewayIdentitiesDeps["store"]> = {
    list: over.list ?? (async () => [...metas(), { path: ".claude/other.json", account: "claude/x", kind: "login", sha256: "x", version: 9 }]),
    get: async (paths) => paths.map((p) => ({ ...metas().find((m) => m.path === p)!, content: Buffer.from(JSON.stringify(files[p]!.content)) })),
    put: async (path, content, opts) => {
      puts.push({ path, json: JSON.parse(content.toString("utf8")), opts });
      return over.put ? over.put() : { ok: true, version: (files[path]?.version ?? 0) + 1 };
    },
    close: async () => void closed++,
  };
  return { store, puts, closed: () => closed };
}

const add = (store: NonNullable<GatewayIdentitiesDeps["store"]>, tool: string, body: unknown) => addGatewayIdentity(tool, body, { store });
const failure = async (p: Promise<unknown>): Promise<HttpError> => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(HttpError);
    return e as HttpError;
  }
  throw new Error("expected a rejection");
};

describe("addGatewayIdentity", () => {
  test("adds to a pool: copies the member folder shape, joins the members, writes with the version check", async () => {
    const { store, puts } = fakeStore({ [CLAUDE_PATH]: { content: claudeRegistry(), version: 7 } });
    const result = await add(store, "claude", { name: "new-one", label: "New One", description: "alice@example.test", pool: "pool-a" });
    expect(result).toEqual({
      tool: "claude",
      identity: { name: "new-one", label: "New One", description: "alice@example.test", configDir: "/profiles/u/.claude/identities/new-one" },
      pool: "pool-a",
      registryVersion: 8,
    });
    expect(puts).toHaveLength(1);
    expect(puts[0]!.path).toBe(CLAUDE_PATH);
    expect(puts[0]!.opts).toEqual({ account: null, kind: "registry", expectedVersion: 7 });
    const written = puts[0]!.json;
    expect(written.identities.map((i) => i.name)).toEqual(["pool-a", "member-a", "member-b", "solo", "new-one"]);
    expect(written.identities[0]!.swapPool!.accounts).toEqual(["member-a", "member-b", "new-one"]);
    // Nothing else moved.
    expect(written.identities[1]).toEqual(claudeRegistry().identities[1]!);
  });

  test("adds without a pool: copies the first plain identity, leaves every pool alone", async () => {
    const { store, puts } = fakeStore({ [CLAUDE_PATH]: { content: claudeRegistry(), version: 3 } });
    const result = await add(store, "claude", { name: "loner", label: "Loner" });
    expect(result.pool).toBeUndefined();
    expect(result.identity.configDir).toBe("/profiles/u/.claude/identities/loner");
    expect(puts[0]!.json.identities[0]!.swapPool!.accounts).toEqual(["member-a", "member-b"]);
  });

  test("codex copies the sign-in method of the donor", async () => {
    const { store } = fakeStore({ [CODEX_PATH]: { content: codexRegistry(), version: 1 } });
    const result = await add(store, "codex", { name: "cx-b", label: "Codex B" });
    expect(result.identity).toEqual({ name: "cx-b", label: "Codex B", configDir: "/profiles/u/.codex/identities/cx-b", codexLoginMethod: "browser" });
  });

  test("a version conflict is a 409 and nothing is reported as added", async () => {
    const { store } = fakeStore({ [CLAUDE_PATH]: { content: claudeRegistry(), version: 7 } }, { put: () => ({ ok: false }) });
    const e = await failure(add(store, "claude", { name: "new-one", label: "N" }));
    expect(e.status).toBe(409);
    expect(e.message).toContain("try again");
  });

  test("a duplicate name or alias is a 409 and writes nothing", async () => {
    const { store, puts } = fakeStore({ [CLAUDE_PATH]: { content: claudeRegistry(), version: 7 } });
    expect((await failure(add(store, "claude", { name: "member-a", label: "x" }))).status).toBe(409);
    expect((await failure(add(store, "claude", { name: "mb", label: "x" }))).status).toBe(409);
    expect(puts).toHaveLength(0);
  });

  test("bad input is a 400 and the store is never read", async () => {
    let listed = 0;
    const { store, puts } = fakeStore({ [CLAUDE_PATH]: { content: claudeRegistry(), version: 7 } }, { list: async () => (listed++, []) });
    for (const name of ["Bad", "has space", "-lead", "trail-", "dou--ble", "../x", "a/b", ""]) {
      expect((await failure(add(store, "claude", { name, label: "x" }))).status).toBe(400);
    }
    expect((await failure(add(store, "claude", { name: "ok", label: "" }))).status).toBe(400);
    expect((await failure(add(store, "claude", { name: "ok", label: "x", description: 5 }))).status).toBe(400);
    expect((await failure(add(store, "claude", "nope"))).status).toBe(400);
    expect((await failure(add(store, "grok", { name: "ok", label: "x" }))).status).toBe(400);
    expect(listed).toBe(0);
    expect(puts).toHaveLength(0);
  });

  test("an unknown pool is a 404, a missing registry is a 404", async () => {
    const { store, puts } = fakeStore({ [CLAUDE_PATH]: { content: claudeRegistry(), version: 7 } });
    expect((await failure(add(store, "claude", { name: "ok", label: "x", pool: "solo" }))).status).toBe(404);
    expect((await failure(add(store, "claude", { name: "ok", label: "x", pool: "ghost" }))).status).toBe(404);
    expect((await failure(add(store, "codex", { name: "ok", label: "x" }))).status).toBe(404);
    expect(puts).toHaveLength(0);
  });

  test("store failures are 502 without leaking detail", async () => {
    const down = fakeStore({}, { list: async () => Promise.reject(new Error("gateway store API unreachable (TimeoutError)")) });
    expect(await failure(add(down.store, "claude", { name: "ok", label: "x" }))).toMatchObject({ status: 502, message: "gateway admin unreachable" });
    const refused = fakeStore({ [CLAUDE_PATH]: { content: claudeRegistry(), version: 7 } }, { put: () => Promise.reject(new StoreApiError(403, "PUT /store/files")) });
    expect(await failure(add(refused.store, "claude", { name: "ok", label: "x" }))).toMatchObject({ status: 502, message: "gateway store answered 403" });
  });

  test("without the gateway admin config it is a 503 and no store is opened", async () => {
    const saved = [process.env.AIS_GATEWAY_ADMIN_URL, process.env.AIS_GATEWAY_ADMIN_TOKEN];
    delete process.env.AIS_GATEWAY_ADMIN_URL;
    delete process.env.AIS_GATEWAY_ADMIN_TOKEN;
    try {
      const e = await failure(addGatewayIdentity("claude", { name: "ok", label: "x" }, { secretsPath: "/nonexistent/ais-secrets" }));
      expect(e.status).toBe(503);
      expect(e.message).toContain("not configured");
    } finally {
      if (saved[0] !== undefined) process.env.AIS_GATEWAY_ADMIN_URL = saved[0];
      if (saved[1] !== undefined) process.env.AIS_GATEWAY_ADMIN_TOKEN = saved[1];
    }
  });
});

describe("parseGatewayIdentityInput", () => {
  test("trims text, defaults nothing, and drops empty optional fields", () => {
    expect(parseGatewayIdentityInput({ name: " abc ", label: " L ", description: "  ", pool: "" })).toEqual({ name: "abc", label: "L" });
  });
});

describe("POST /api/gateway/identities/:tool", () => {
  const base = { token: "t", port: 47129, startedAt: Date.now(), peerAddress: "127.0.0.1", peerPort: 50000, peerUid: () => process.getuid?.() };
  const headers = { Host: "127.0.0.1:47129" };
  const mutating = { ...headers, "X-AIS-Console": "1", "content-type": "application/json" };
  const appWith = (extra: Partial<ConsoleAppDeps>) => createApp({ ...base, ...extra });

  test("reaches the seam, answers 201, needs the console header, maps errors", async () => {
    const seen: Array<[string, unknown]> = [];
    const app = appWith({
      gatewayIdentityAdd: async (tool, body) => {
        seen.push([tool, body]);
        if ((body as { name?: string } | undefined)?.name === "dup") throw new HttpError(409, "dup taken");
        return { tool: "claude", identity: { name: "ok", label: "ok", configDir: "/x/ok" }, registryVersion: 2 };
      },
    });
    const res = await app.request("/api/gateway/identities/claude", { method: "POST", headers: mutating, body: JSON.stringify({ name: "ok", label: "ok" }) });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ registryVersion: 2 });
    expect((await app.request("/api/gateway/identities/claude", { method: "POST", headers: mutating, body: JSON.stringify({ name: "dup", label: "x" }) })).status).toBe(409);
    expect((await app.request("/api/gateway/identities/claude", { method: "POST", headers, body: JSON.stringify({ name: "ok", label: "ok" }) })).status).toBe(403);
    expect(seen.map(([t]) => t)).toEqual(["claude", "claude"]);
    expect((await appWith({ peerAddress: "203.0.113.9" }).request("/api/gateway/identities/claude", { method: "POST", headers: mutating, body: "{}" })).status).toBe(401);
  });

  test("a body that is not JSON reaches the validator as undefined and is a 400", async () => {
    const app = appWith({ gatewayIdentityAdd: (tool, body) => addGatewayIdentity(tool, body, { store: fakeStore({ [CLAUDE_PATH]: { content: claudeRegistry(), version: 1 } }).store }) });
    const res = await app.request("/api/gateway/identities/claude", { method: "POST", headers: mutating, body: "not json" });
    expect(res.status).toBe(400);
  });
});
