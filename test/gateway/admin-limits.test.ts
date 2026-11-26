import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createAdminApp, type AdminDeps } from "../../src/gateway/admin.ts";
import { CachedGatewayStore } from "../../src/gateway/cache-store.ts";
import { MemoryGatewayStore } from "../../src/gateway/store.ts";
import type { PoolUsage } from "../../src/identities/pool/adapter.ts";
import type { GatewayProvider } from "../../src/gateway/types.ts";

const ADMIN = "adm-test-value-0001-0123456789abcdef";
const STAMP = "2026-11-19T08:00:00.000Z";
const RESET_WEEK = "2026-11-20T15:00:00.000Z";

let now: Date;
let inner: MemoryGatewayStore;
let store: CachedGatewayStore;

const reading = (over: Partial<PoolUsage> = {}): PoolUsage => ({
  status: "live",
  maxUtilization: 100,
  windows: [
    { label: "five-hour", utilization: 40, resetsAt: "2026-11-19T18:00:00.000Z" },
    { label: "seven-day", utilization: 100, resetsAt: RESET_WEEK },
    { label: "seven-day (Fable)", model: "Fable", utilization: 10, resetsAt: RESET_WEEK },
  ],
  extraUsage: { enabled: true, available: true, usedPercent: 25, label: "extra usage" },
  capturedAt: STAMP,
  ...over,
});

/** The usage source's readings, keyed "provider/identity"; a missing key is a cold miss (undefined). */
const readings = new Map<string, PoolUsage>([
  ["claude/m1", reading()],
  ["claude/m2", reading({ stale: true, status: "rate-limited" })],
  ["codex/c1", { status: "live", maxUtilization: 15, windows: [{ label: "week", utilization: 15, resetsAt: RESET_WEEK }], capturedAt: STAMP }],
  ["codex/c2", { status: "unavailable", error: "not authenticated", capturedAt: STAMP }],
]);
const asked: string[] = [];

const appWith = (extra: Partial<AdminDeps>) =>
  createAdminApp({
    store,
    adminToken: ADMIN,
    now: () => now,
    usageFor: async (provider, identity) => {
      asked.push(`${provider}/${identity}`);
      return readings.get(`${provider}/${identity}`);
    },
    poolMembers: async (provider) => {
      if (provider === "claude") return ["alias-one", "m2"];
      if (provider === "codex") return ["c1"];
      if (provider === "kimi") throw new Error("registry unreadable");
      return [];
    },
    canonical: async (provider, identity) => (provider === "claude" && identity === "alias-one" ? "m1" : identity),
    ...extra,
  });

const call = (app: ReturnType<typeof createAdminApp>, path: string, token: string | null = ADMIN) =>
  app.request(`http://admin.test${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

const put = (app: ReturnType<typeof createAdminApp>, name: string, over: object = {}) =>
  app.request(`http://admin.test/apps/${name}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
    body: JSON.stringify({ owner: "o", namespace: "ns", provider: "claude", style: "anthropic", target: { kind: "pin", identity: "m1" }, ...over }),
  });

beforeEach(async () => {
  now = new Date("2026-11-19T09:00:00.000Z");
  inner = new MemoryGatewayStore();
  store = new CachedGatewayStore(inner);
  await store.warm();
  asked.length = 0;
});
afterEach(() => store.stop());

describe("admin GET /limits", () => {
  test("404 without a usage source, 401 without the admin token", async () => {
    const bare = createAdminApp({ store, adminToken: ADMIN, now: () => now });
    expect((await call(bare, "/limits")).status).toBe(404);
    const app = appWith({});
    expect((await call(app, "/limits", null)).status).toBe(401);
    expect((await call(app, "/limits", "wrong")).status).toBe(401);
  });

  test("fresh reads require and refresh one Codex identity without a consume", async () => {
    const refreshed: string[] = [];
    const app = appWith({ refreshUsageFor: async (provider, identity) => { refreshed.push(`${provider}/${identity}`); } });
    const response = await call(app, "/limits?provider=codex&identity=c1&fresh=1");
    expect(response.status).toBe(200);
    expect(refreshed).toEqual(["codex/c1"]);
    expect(asked).toEqual(["codex/c1"]);
    expect((await call(app, "/limits?fresh=1")).status).toBe(400);
  });

  test("one row per managed identity: pool members plus active pins, canonicalised and deduped", async () => {
    const app = appWith({});
    expect((await put(app, "web")).status).toBe(201); // pin m1, already a pool member
    expect((await put(app, "solo", { target: { kind: "pin", identity: "solo" } })).status).toBe(201);
    expect((await put(app, "cx", { provider: "codex", style: "openai", target: { kind: "pin", identity: "c2" } })).status).toBe(201);
    expect((await put(app, "km", { provider: "kimi", style: "openai", target: { kind: "pin", identity: "k9" } })).status).toBe(201);
    for (const provider of ["grok", "ali", "opencode"] as const) {
      const style = provider === "ali" ? "anthropic" : "openai";
      expect((await put(app, `${provider}-app`, { provider, style, target: { kind: "pin", identity: `${provider}-member` } })).status).toBe(201);
    }
    expect((await put(app, "poolapp", { target: { kind: "pool" } })).status).toBe(201); // a pool app pins nothing
    expect((await put(app, "dead", { target: { kind: "pin", identity: "dead" } })).status).toBe(201);
    expect((await app.request("http://admin.test/apps/dead/revoke", { method: "POST", headers: { authorization: `Bearer ${ADMIN}` } })).status).toBe(200);

    const res = await call(app, "/limits");
    expect(res.status).toBe(200);
    const { limits } = (await res.json()) as { limits: Array<Record<string, unknown>> };
    expect(limits.map((r) => `${r.provider}/${r.identity}`)).toEqual([
      "claude/m1", "claude/m2", "claude/solo", "codex/c1", "codex/c2", "kimi/k9", "opencode/opencode-member",
    ]);
    // Every read used the canonical name, once per identity.
    expect(asked.sort()).toEqual(["ali/ali-member", "claude/m1", "claude/m2", "claude/solo", "codex/c1", "codex/c2", "grok/grok-member", "kimi/k9", "opencode/opencode-member"]);

    const m1 = limits[0]!;
    expect(m1).toMatchObject({ provider: "claude", identity: "m1", status: "live", maxUtilization: 100, capturedAt: STAMP });
    expect(m1.windows).toEqual(reading().windows);
    expect(m1.extraUsage).toEqual(reading().extraUsage);
    expect(limits[1]).toMatchObject({ identity: "m2", stale: true, status: "rate-limited" });
    // An identity with no reading does not replace host-side provider data.
    expect(limits.find((row) => row.identity === "solo")).toMatchObject({ status: "unavailable" });
    expect(limits.find((row) => row.identity === "c2")).toMatchObject({ status: "unavailable", error: "not authenticated" });
    expect(limits.every((row) => !["grok", "ali"].includes(String(row.provider)))).toBe(true);
  });

  test("Codex rows carry per-identity reset credits from the gateway reader", async () => {
    const app = appWith({ resetCreditsFor: async (identity) => identity === "c1" ? {
      availableCount: 2,
      creditExpiries: [{ id: "RateLimitResetCredit_SYNTHETIC_FIXTURE_001", label: "Full reset", endsAt: "2026-12-01T22:27:07.649Z" }],
    } : { availableCount: 0 } });
    await put(app, "codex-c2", { provider: "codex", style: "openai", target: { kind: "pin", identity: "c2" } });
    const { limits } = await (await call(app, "/limits?provider=codex")).json() as { limits: Array<Record<string, unknown>> };
    expect(limits[0]?.manualReset).toEqual({ availableCount: 2, creditExpiries: [{ id: "RateLimitResetCredit_SYNTHETIC_FIXTURE_001", label: "Full reset", endsAt: "2026-12-01T22:27:07.649Z" }] });
    expect(limits[1]?.manualReset).toEqual({ availableCount: 0 });
  });


  test("all-provider limits retain reset-only and managed failure rows while leaving unsupported rows to the host", async () => {
    const app = appWith({
      usageFor: async (provider, identity) => {
        if (provider === "claude" && identity === "m1") return reading({ windows: [], manualReset: { availableCount: 1, grants: [{ id: "cedar_ember_SYNTHETIC_FIXTURE_001", kind: "full", resetsLeft: 1, usableNow: true, paused: false }] } });
        if (provider === "codex" && identity === "c1") return readings.get("codex/c1");
        if (provider === "opencode") return { status: "unavailable", error: "quota service failed", capturedAt: STAMP };
        return undefined;
      },
      resetCreditsFor: async () => undefined,
    });
    await put(app, "grok-app", { provider: "grok", style: "openai", target: { kind: "pin", identity: "grok-member" } });
    await put(app, "ali-app", { provider: "ali", style: "anthropic", target: { kind: "pin", identity: "ali-member" } });
    await put(app, "open-code", { provider: "opencode", style: "openai", target: { kind: "pin", identity: "oc1" } });
    const { limits } = await (await call(app, "/limits")).json() as { limits: Array<Record<string, unknown>> };
    expect(limits.find((row) => row.identity === "m1")?.manualReset).toMatchObject({ availableCount: 1 });
    expect(limits.find((row) => row.identity === "c1")?.windows).toEqual(readings.get("codex/c1")?.windows);
    expect(limits.find((row) => row.identity === "oc1")).toMatchObject({ status: "unavailable", error: "quota service failed" });
    expect(limits.some((row) => row.identity === "grok-member" || row.identity === "ali-member")).toBe(false);
  });

  test("a failed Codex reset read does not delay the all-provider response or hide other figures", async () => {
    const concurrent: string[] = [];
    let active = 0;
    let peak = 0;
    const app = appWith({
      resetCreditsFor: async (identity) => {
        active++;
        peak = Math.max(peak, active);
        concurrent.push(identity);
        await Bun.sleep(40);
        active--;
        throw new Error("reset service failed");
      },
    });
    for (let i = 0; i < 20; i++) {
      const identity = `codex-${i}`;
      await put(app, `c-${i}`, { provider: "codex", style: "openai", target: { kind: "pin", identity } });
      readings.set(`codex/${identity}`, { status: "live", maxUtilization: 0, windows: [], capturedAt: STAMP });
    }
    try {
      const started = Date.now();
      const { limits } = await (await call(app, "/limits")).json() as { limits: Array<Record<string, unknown>> };
      expect(Date.now() - started).toBeLessThan(1000);
      expect(peak).toBeGreaterThan(1);
      expect(concurrent).toHaveLength(21);
      expect(limits.find((row) => row.identity === "m1")).toMatchObject({ provider: "claude", status: "live" });
      expect(limits.filter((row) => String(row.identity).startsWith("codex-") && row.maxUtilization === 0)).toHaveLength(20);
    } finally {
      for (let i = 0; i < 20; i++) readings.delete(`codex/codex-${i}`);
    }
  });

  test("an OpenCode no-plan answer does not replace the host reading with an empty row", async () => {
    const app = appWith({ usageFor: async () => ({ status: "unavailable", noPlan: true, capturedAt: STAMP }) });
    await put(app, "open-code", { provider: "opencode", style: "openai", target: { kind: "pin", identity: "oc1" } });
    const { limits } = await (await call(app, "/limits?provider=opencode")).json() as { limits: unknown[] };
    expect(limits).toEqual([]);
  });

  test("provider and identity filters, unknown provider is 400", async () => {
    const app = appWith({});
    await put(app, "solo", { target: { kind: "pin", identity: "solo" } });
    const claude = (await (await call(app, "/limits?provider=claude")).json()) as { limits: Array<{ identity: string }> };
    expect(claude.limits.map((r) => r.identity)).toEqual(["m1", "m2", "solo"]);
    const one = (await (await call(app, "/limits?provider=claude&identity=m2")).json()) as { limits: Array<{ identity: string }> };
    expect(one.limits.map((r) => r.identity)).toEqual(["m2"]);
    const cold = (await (await call(app, "/limits?provider=claude&identity=solo")).json()) as { limits: unknown[] };
    expect(cold.limits).toMatchObject([{ provider: "claude", identity: "solo", status: "unavailable" }]);
    const none = (await (await call(app, "/limits?identity=absent")).json()) as { limits: unknown[] };
    expect(none.limits).toEqual([]);
    // grok is a gateway provider but the usage source reads no grok windows.
    const grok = (await (await call(app, "/limits?provider=grok")).json()) as { limits: unknown[] };
    expect(grok.limits).toEqual([]);
    expect((await call(app, "/limits?provider=bogus")).status).toBe(400);
  });

  test("a failed usage read answers unavailable, never 500", async () => {
    const app = appWith({
      usageFor: async (provider: GatewayProvider, identity: string) => {
        if (identity === "m1") throw new Error("upstream down");
        return readings.get(`${provider}/${identity}`);
      },
    });
    const { limits } = (await (await call(app, "/limits?provider=claude")).json()) as { limits: Array<Record<string, unknown>> };
    expect(limits).toHaveLength(2);
    expect(limits.find((row) => row.identity === "m1")).toMatchObject({ status: "unavailable" });
    expect(limits.find((row) => row.identity === "m2")).toMatchObject({ identity: "m2", stale: true });
  });
});
describe("admin reset grants", () => {
  const grants = { availableCount: 1, grants: [{ id: "full-reset-2611", kind: "full" as const, resetsLeft: 1, usableNow: true, paused: false }] };

  test("GET /limits carries the reset grants of a claude row", async () => {
    readings.set("claude/m1", reading({ manualReset: grants }));
    try {
      const { limits } = (await (await call(appWith({}), "/limits?provider=claude&identity=m1")).json()) as { limits: Array<Record<string, unknown>> };
      expect(limits[0]!.manualReset).toEqual(grants);
    } finally {
      readings.set("claude/m1", reading());
    }
  });

  const post = (app: ReturnType<typeof createAdminApp>, path: string, token: string | null = ADMIN) =>
    app.request(`http://admin.test${path}`, { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {} });

  test("POST spends through the gateway seam under the canonical name; needs the admin token", async () => {
    const spent: string[] = [];
    const app = appWith({ spendReset: async (identity, grant) => { spent.push(`${identity}:${grant}`); return { identity, grantId: grant, result: "reset", cleared: [] }; } });
    expect((await post(app, "/limits/claude/alias-one/resets/g1", null)).status).toBe(401);
    const res = await post(app, "/limits/claude/alias-one/resets/g1");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ identity: "m1", result: "reset" });
    expect(spent).toEqual(["m1:g1"]);
  });

  test("refusals keep a known status and a short reason; no seam is 404", async () => {
    const refuse = appWith({ spendReset: async () => { throw Object.assign(new Error("no usable Claude login"), { status: 409 }); } });
    const res = await post(refuse, "/limits/claude/m1/resets/g1");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "no usable Claude login" });
    const odd = appWith({ spendReset: async () => { throw new Error("x"); } });
    expect((await post(odd, "/limits/claude/m1/resets/g1")).status).toBe(502);
    expect((await post(appWith({}), "/limits/claude/m1/resets/g1")).status).toBe(404);
  });
});
