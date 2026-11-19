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
  manualReset: {
    availableCount: 1,
    label: "Full reset SYNTHETIC_FIXTURE",
    grants: [{ id: "full-reset-SYNTHETIC_FIXTURE-m1", kind: "full", resetsLeft: 1, usableNow: true, paused: false, endsAt: "2099-01-01T00:00:00.000Z" }],
    grantsCapturedAt: STAMP,
  },
  capturedAt: STAMP,
  ...over,
});

const codexCredits: PoolUsage["manualReset"] = {
  availableCount: 1,
  label: "Full reset (Weekly + 5 hr)",
  creditExpiries: [{ id: "credit-SYNTHETIC_FIXTURE-c1", endsAt: "2099-01-01T00:00:00.000Z" }],
};

/** The usage source's readings, keyed "provider/identity"; a missing key is a cold miss (undefined). */
const readings = new Map<string, PoolUsage>([
  ["claude/m1", reading()],
  ["claude/m2", reading({ stale: true, status: "rate-limited" })],
  ["codex/c1", { status: "live", maxUtilization: 15, windows: [{ label: "week", utilization: 15, resetsAt: RESET_WEEK }], manualReset: codexCredits, capturedAt: STAMP }],
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

  test("one row per managed identity: pool members plus active pins, canonicalised and deduped", async () => {
    const app = appWith({});
    expect((await put(app, "web")).status).toBe(201); // pin m1, already a pool member
    expect((await put(app, "solo", { target: { kind: "pin", identity: "solo" } })).status).toBe(201);
    expect((await put(app, "cx", { provider: "codex", style: "openai", target: { kind: "pin", identity: "c2" } })).status).toBe(201);
    expect((await put(app, "km", { provider: "kimi", style: "openai", target: { kind: "pin", identity: "k9" } })).status).toBe(201);
    expect((await put(app, "poolapp", { target: { kind: "pool" } })).status).toBe(201); // a pool app pins nothing
    expect((await put(app, "dead", { target: { kind: "pin", identity: "dead" } })).status).toBe(201);
    expect((await app.request("http://admin.test/apps/dead/revoke", { method: "POST", headers: { authorization: `Bearer ${ADMIN}` } })).status).toBe(200);

    const res = await call(app, "/limits");
    expect(res.status).toBe(200);
    const { limits } = (await res.json()) as { limits: Array<Record<string, unknown>> };
    expect(limits.map((r) => `${r.provider}/${r.identity}`)).toEqual([
      "claude/m1", "claude/m2", "claude/solo", "codex/c1", "codex/c2", "kimi/k9",
    ]);
    // Every read used the canonical name, once per identity.
    expect(asked.sort()).toEqual(["claude/m1", "claude/m2", "claude/solo", "codex/c1", "codex/c2", "kimi/k9"]);

    const m1 = limits[0]!;
    expect(m1).toMatchObject({ provider: "claude", identity: "m1", status: "live", maxUtilization: 100, capturedAt: STAMP });
    expect(m1.windows).toEqual(reading().windows);
    expect(m1.extraUsage).toEqual(reading().extraUsage);
    // The reset grants ride on the row unchanged: claude's cedar_ember list and codex's reset credits.
    expect(m1.manualReset).toEqual(reading().manualReset);
    expect(limits[1]).toMatchObject({ identity: "m2", stale: true, status: "rate-limited", manualReset: reading().manualReset });
    // A cold identity answers unavailable with no figure; the background refresh fills it in later.
    expect(limits[2]).toEqual({ provider: "claude", identity: "solo", status: "unavailable", windows: [] });
    expect(limits[3]!.manualReset).toEqual(codexCredits);
    expect(limits[4]).toMatchObject({ identity: "c2", status: "unavailable", error: "not authenticated" });
    expect(limits[4]!.manualReset).toBeUndefined();
    // kimi's registry read failed: its pinned identity still answers.
    expect(limits[5]).toEqual({ provider: "kimi", identity: "k9", status: "unavailable", windows: [] });
  });

  test("provider and identity filters, unknown provider is 400", async () => {
    const app = appWith({});
    await put(app, "solo", { target: { kind: "pin", identity: "solo" } });
    const claude = (await (await call(app, "/limits?provider=claude")).json()) as { limits: Array<{ identity: string }> };
    expect(claude.limits.map((r) => r.identity)).toEqual(["m1", "m2", "solo"]);
    const one = (await (await call(app, "/limits?provider=claude&identity=m2")).json()) as { limits: Array<{ identity: string }> };
    expect(one.limits.map((r) => r.identity)).toEqual(["m2"]);
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
    expect(limits[0]).toEqual({ provider: "claude", identity: "m1", status: "unavailable", windows: [] });
    expect(limits[1]).toMatchObject({ identity: "m2", stale: true });
  });
});