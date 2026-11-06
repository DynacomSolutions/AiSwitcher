import { describe, expect, test } from "bun:test";
import { bodyBudgetFromEnv, BODY_BUDGET_BYTES, createGatewayApp, readBody, scanModel, type GatewayDeps } from "../../src/gateway/app.ts";
import { BodyBudget } from "../../src/gateway/body-budget.ts";
import { LedgerBuffer } from "../../src/gateway/ledger-buffer.ts";
import { noopMetrics } from "../../src/gateway/metrics.ts";
import { MemoryGatewayStore } from "../../src/gateway/store.ts";
import { generateToken } from "../../src/gateway/tokens.ts";

const enc = new TextEncoder();
const model = (s: string): string | undefined => scanModel(enc.encode(s)).model;

describe("scanModel", () => {
  test("finds the top-level model without parsing the rest", () => {
    expect(model('{"model":"claude-x","messages":[{"model":"inner","content":"a\\"b}"}]}')).toBe("claude-x");
    expect(model('{"messages":[{"role":"user","content":"{\\"model\\":\\"no\\"}"}],\n "model" : "late"}')).toBe("late");
  });
  test("the last duplicate wins, as in JSON.parse", () => {
    expect(model('{"model":"ok","x":1,"model":"other"}')).toBe("other");
  });
  test("non-string model and empty objects give no model", () => {
    expect(scanModel(enc.encode('{"model":5}'))).toEqual({ ok: true });
    expect(scanModel(enc.encode("{}"))).toEqual({ ok: true });
  });
  test("malformed or escaped-key input is left to JSON.parse", () => {
    expect(scanModel(enc.encode('{"model":"a"')).ok).toBe(false);
    expect(scanModel(enc.encode('{"\\u006dodel":"hidden"}')).ok).toBe(false);
    expect(scanModel(enc.encode("[1]")).ok).toBe(false);
  });
});

describe("readBody", () => {
  test("a declared length within the limit is read natively and exactly", async () => {
    const body = "z".repeat(300_000);
    const b = await readBody(new Request("http://x/", { method: "POST", body }));
    expect(b.kind).toBe("buffered");
    expect(b.kind === "buffered" && b.bytes.length).toBe(300_000);
  });
});

describe("BodyBudget", () => {
  test("held bytes never exceed the limit under 40 concurrent reservations", async () => {
    const budget = new BodyBudget(10);
    let peak = 0;
    await Promise.all(
      Array.from({ length: 40 }, async () => {
        const release = await budget.reserve(3);
        peak = Math.max(peak, budget.inUse);
        await Bun.sleep(1);
        release();
      }),
    );
    expect(peak).toBeLessThanOrEqual(10);
    expect(budget.inUse).toBe(0);
    expect(budget.waiting).toBe(0);
  });
  test("a request larger than the budget runs alone", async () => {
    const budget = new BodyBudget(10);
    const small = await budget.reserve(4);
    let big = false;
    const pending = budget.reserve(100).then((r) => {
      big = true;
      return r;
    });
    await Bun.sleep(5);
    expect(big).toBe(false);
    small();
    const release = await pending;
    expect(budget.inUse).toBe(10);
    release();
    expect(budget.inUse).toBe(0);
  });
  test("an abort while waiting frees the queue slot", async () => {
    const budget = new BodyBudget(10);
    const hold = await budget.reserve(10);
    const ac = new AbortController();
    const waiting = budget.reserve(5, ac.signal);
    ac.abort();
    await expect(waiting).rejects.toThrow();
    expect(budget.waiting).toBe(0);
    hold();
    expect(budget.inUse).toBe(0);
  });
});

async function rig(opts: { budget: number; holdMs: number }) {
  let live = 0;
  let peakLive = 0;
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      live += 1;
      peakLive = Math.max(peakLive, live);
      await req.arrayBuffer();
      await Bun.sleep(opts.holdMs); // time to first byte: the request is held until headers
      live -= 1;
      return new Response('{"model":"claude-x","usage":{"input_tokens":1,"output_tokens":1}}', { headers: { "content-type": "application/json" } });
    },
  });
  const store = new MemoryGatewayStore();
  const rows: string[] = [];
  const ledger = new LedgerBuffer(store, { max: 1000, flushMs: 3_600_000 });
  const t = generateToken();
  await store.putApp({ name: "a", owner: "o", namespace: "ns", provider: "claude", style: "anthropic", target: { kind: "pin", identity: "id1" }, state: "active", createdAt: "2026-11-01T00:00:00.000Z" });
  await store.addToken({ app: "a", prefix: t.prefix, hash: t.hash, createdAt: new Date().toISOString() });
  const waits: number[] = [];
  const waiting: number[] = [];
  const deps: GatewayDeps = {
    store,
    ledger,
    creds: { get: async (_p: string, identity: string) => ({ identity, accessToken: "x" }), refreshAfter401: async () => ({ identity: "id1", accessToken: "y" }) } as unknown as GatewayDeps["creds"],
    usageFor: async () => undefined,
    poolMembers: async () => ["id1"],
    fetch: ((input: string | URL | Request, init?: RequestInit) => fetch(`http://127.0.0.1:${upstream.port}${new URL(String(input)).pathname}`, init)) as typeof fetch,
    now: () => new Date(),
    metrics: { ...noopMetrics, bodyBudgetWait: (s) => waits.push(s), bodyBudgetWaiting: (n) => waiting.push(n), request: (e) => rows.push(e.status) },
    log: () => {},
    bodyBudgetBytes: opts.budget,
  };
  const app = createGatewayApp(deps);
  const post = async (payload: string, signal?: AbortSignal): Promise<Response> =>
    app.fetch(new Request("http://gw/a/v1/messages", { method: "POST", headers: { authorization: `Bearer ${t.token}`, "content-type": "application/json" }, body: payload, ...(signal ? { signal } : {}) }));
  return { post, peak: () => peakLive, waits, waiting, rows, stop: () => upstream.stop(true) };
}

const MIB = 1024 * 1024;
const big = (n: number): string => JSON.stringify({ model: "claude-x", pad: "y".repeat(n - 100) });

describe("gateway memory", () => {
  test("defaults to 512 MiB and reads AIS_GATEWAY_BODY_BUDGET_MB", () => {
    expect(BODY_BUDGET_BYTES).toBe(512 * MIB);
    expect(bodyBudgetFromEnv({})).toBe(512 * MIB);
    expect(bodyBudgetFromEnv({ AIS_GATEWAY_BODY_BUDGET_MB: "64" })).toBe(64 * MIB);
    expect(bodyBudgetFromEnv({ AIS_GATEWAY_BODY_BUDGET_MB: "junk" })).toBe(512 * MIB);
    expect(bodyBudgetFromEnv({ AIS_GATEWAY_BODY_BUDGET_MB: "0" })).toBe(512 * MIB);
  });

  test("waits and completes when budget frees: bodies held stay within the budget and nobody gets a 503", async () => {
    const r = await rig({ budget: 4 * MIB, holdMs: 40 });
    const payload = big(MIB);
    const statuses = await Promise.all(
      Array.from({ length: 24 }, async () => {
        const res = await r.post(payload);
        await res.arrayBuffer();
        return res.status;
      }),
    );
    r.stop();
    expect(statuses.every((s) => s === 200)).toBe(true);
    expect(r.peak()).toBeLessThanOrEqual(4);
    expect(r.waits).toHaveLength(24);
    expect(Math.max(...r.waits)).toBeGreaterThan(0.03);
    expect(Math.max(...r.waiting)).toBeGreaterThan(0);
    expect(r.waiting[r.waiting.length - 1]).toBe(0);
  });

  test("abort while queued releases nothing and records client_aborted", async () => {
    const r = await rig({ budget: MIB, holdMs: 300 });
    const payload = big(MIB);
    const first = r.post(payload).then((x) => x.arrayBuffer());
    await Bun.sleep(50); // the first holds the whole budget
    const ac = new AbortController();
    const queued = r.post(payload, ac.signal);
    await Bun.sleep(50);
    expect(r.waiting[r.waiting.length - 1]).toBe(1);
    ac.abort();
    const res = await queued.catch(() => undefined);
    if (res) expect(res.status).toBe(499);
    await first;
    // The aborted request never reached the upstream, and the budget is whole again.
    const after = await r.post(payload);
    expect(after.status).toBe(200);
    await after.arrayBuffer();
    r.stop();
    expect(r.peak()).toBe(1);
    expect(r.rows).toContain("client_aborted");
    expect(r.waiting[r.waiting.length - 1]).toBe(0);
  });
});
