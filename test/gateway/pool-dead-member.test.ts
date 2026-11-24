import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PoolUsage } from "../../src/identities/pool/adapter.ts";
import { createGatewayApp, type GatewayDeps } from "../../src/gateway/app.ts";
import { GatewayCredentialError } from "../../src/gateway/credentials.ts";
import { LedgerBuffer } from "../../src/gateway/ledger-buffer.ts";
import { noopMetrics } from "../../src/gateway/metrics.ts";
import { pickIdentity } from "../../src/gateway/select.ts";
import { MemoryGatewayStore } from "../../src/gateway/store.ts";
import { generateToken } from "../../src/gateway/tokens.ts";
import type { GatewayApp } from "../../src/gateway/types.ts";

const NOW = new Date("2026-11-24T10:00:00.000Z");
const live = (u: number): PoolUsage => ({ status: "live", maxUtilization: u, capturedAt: NOW.toISOString() });
const pool: GatewayApp = {
  name: "pool", owner: "o", namespace: "n", provider: "opencode", style: "openai",
  target: { kind: "pool" }, state: "active", createdAt: "2026-11-01T00:00:00.000Z",
};

/** Selection deps with a liveness probe that marks the named members dead. */
const selectDeps = (readings: Record<string, PoolUsage | undefined>, dead: string[], members = Object.keys(readings)) => ({
  usageFor: async (_p: string, id: string) => readings[id],
  poolMembers: async () => members,
  creds: { loggedOut: async (_p: string, id: string) => dead.includes(id) } as unknown as GatewayDeps["creds"],
});

describe("pool selection never picks a dead member", () => {
  test("known-usage path: a dead member with the lowest utilisation is skipped for the healthy one", async () => {
    // Without the probe the dead member (5%) would win on headroom.
    const deps = selectDeps({ dead: live(5), healthy: live(40) }, ["dead"]);
    expect(await pickIdentity(pool, deps)).toEqual({ identity: "healthy" });
  });

  test("unknown-usage path: a dead member with no figure is not the fallback", async () => {
    // The healthy member is full, so the old code fell back to the first undefined figure (the dead member).
    const deps = selectDeps({ dead: undefined, healthy: live(100) }, ["dead"]);
    expect(await pickIdentity(pool, deps)).toEqual({ reject: "no-headroom" });
  });

  test("unknown-usage path: a live member with no figure is still allowed after known headroom", async () => {
    const deps = selectDeps({ dead: undefined, healthy: undefined }, ["dead"]);
    expect(await pickIdentity(pool, deps)).toEqual({ identity: "healthy" });
  });

  test("every member dead: no-identities, never a dead login", async () => {
    const deps = selectDeps({ a: live(5), b: undefined }, ["a", "b"]);
    expect(await pickIdentity(pool, deps)).toEqual({ reject: "no-identities" });
  });

  test("a probe error keeps the member (the send and failover still guard it)", async () => {
    const deps = {
      usageFor: async (_p: string, id: string) => (id === "a" ? live(5) : live(40)),
      poolMembers: async () => ["a", "b"],
      creds: { loggedOut: async () => { throw new Error("probe blew up"); } } as unknown as GatewayDeps["creds"],
    };
    expect(await pickIdentity(pool, deps)).toEqual({ identity: "a" });
  });

  test("a pinned app is unaffected: the probe is never consulted", async () => {
    const pin: GatewayApp = { ...pool, target: { kind: "pin", identity: "dead" } };
    let probed = 0;
    const deps = {
      usageFor: async () => live(5),
      poolMembers: async () => ["dead"],
      creds: { loggedOut: async () => { probed++; return true; } } as unknown as GatewayDeps["creds"],
    };
    expect(await pickIdentity(pin, deps)).toEqual({ identity: "dead" });
    expect(probed).toBe(0);
  });

  test("no probe wired: selection behaves exactly as before", async () => {
    const deps = { usageFor: async (_p: string, id: string) => (id === "a" ? undefined : live(100)), poolMembers: async () => ["a", "b"] };
    expect(await pickIdentity(pool, deps)).toEqual({ identity: "a" });
  });
});

describe("a streamed pool request never lands on a dead login", () => {
  let upstream: ReturnType<typeof Bun.serve>;
  let seenAuth: string[];
  let store: MemoryGatewayStore;
  let ledger: LedgerBuffer;
  let deps: GatewayDeps;
  let gets: string[];

  beforeEach(async () => {
    seenAuth = [];
    gets = [];
    upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        seenAuth.push(req.headers.get("authorization") ?? "");
        await req.arrayBuffer();
        return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
      },
    });
    store = new MemoryGatewayStore();
    ledger = new LedgerBuffer(store, { max: 1000, flushMs: 3_600_000 });
    // Member "a" is the dead (logged-out) login; "b" is healthy.
    deps = {
      sleep: async () => {},
      store,
      ledger,
      creds: {
        get: async (_p: string, id: string) => {
          gets.push(id);
          if (id === "a") throw new GatewayCredentialError("login-dead", "opencode", id);
          return { identity: id, accessToken: `tok-${id}` };
        },
        refreshAfter401: async () => { throw new Error("not used"); },
        loggedOut: async (_p: string, id: string) => id === "a",
      } as unknown as GatewayDeps["creds"],
      usageFor: async (_p, id) => (id === "a" ? undefined : live(10)),
      poolMembers: async () => ["a", "b"],
      fetch: ((input: string | URL | Request, init?: RequestInit) => {
        const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        return fetch(`http://127.0.0.1:${upstream.port}${u.pathname}${u.search}`, init);
      }) as typeof fetch,
      now: () => NOW,
      metrics: noopMetrics,
      log: () => {},
    };
  });
  afterEach(async () => {
    await upstream.stop(true);
    await ledger.close();
  });

  const addPool = async (over: Partial<GatewayApp> = {}) => {
    const app = { ...pool, ...over };
    await store.putApp(app);
    const t = generateToken();
    await store.addToken({ app: app.name, prefix: t.prefix, hash: t.hash, createdAt: NOW.toISOString() });
    return t.token;
  };
  /** A body over the replay cap: the gateway streams it and cannot fail over. */
  const bigBody = () => JSON.stringify({ model: "m", messages: [{ role: "user", content: "x".repeat(33 * 1024 * 1024) }] });
  const send = async (token: string, body: string) => {
    const gw = createGatewayApp(deps);
    const r = await gw.request("http://gw.test/pool/v1/chat/completions", {
      method: "POST", body, headers: { authorization: `Bearer ${token}`, "content-length": String(body.length), "content-type": "application/json" },
    });
    return new Response(await r.arrayBuffer(), { status: r.status, headers: r.headers });
  };

  test("a dead member and a healthy member: the healthy one serves, no login-dead error", async () => {
    const t = await addPool();
    const res = await send(t, bigBody());
    expect(res.status).toBe(200);
    expect(seenAuth).toEqual(["Bearer tok-b"]);
    expect(gets).not.toContain("a");
    expect(await res.text()).not.toContain("logged out");
  });

  test("every live member full: the proper limit answer with the real reset, not a dead login", async () => {
    const resetIso = "2026-11-30T00:00:00.000Z";
    const full = (): PoolUsage => ({ status: "live", maxUtilization: 100, capturedAt: NOW.toISOString(), windows: [{ label: "weekly", utilization: 100, resetsAt: resetIso }] });
    deps.usageFor = async () => full();
    deps.poolMembers = async () => ["a", "b"];
    (deps.creds as { loggedOut: (p: string, i: string) => Promise<boolean> }).loggedOut = async () => false;
    const t = await addPool();
    const res = await send(t, bigBody());
    expect(res.status).toBe(429);
    expect(seenAuth).toEqual([]);
    // opencode has no native limit shape: the generic answer carries the real reset from the full window.
    const resetSec = Date.parse(resetIso) / 1000;
    expect(Number(res.headers.get("retry-after"))).toBe(resetSec - Math.floor(NOW.getTime() / 1000));
    const text = await res.text();
    expect(text).toContain(`Resets at ${resetIso}.`);
    expect(text).not.toContain("logged out");
  });
});
