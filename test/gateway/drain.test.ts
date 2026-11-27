import { describe, expect, test } from "bun:test";
import { DEFAULT_DRAIN_TIMING, DrainStats, drainTiming, settle, waitIdle } from "../../src/gateway/drain.ts";

/** A clock the test moves by hand; `sleep` advances it, so the loops run without real waiting. */
function clock() {
  let t = 1_000_000;
  return { now: () => t, sleep: async (ms: number) => void (t += ms), set: (v: number) => void (t = v), at: () => t };
}

describe("drain timing", () => {
  test("defaults, environment and overrides, in that order", () => {
    expect(drainTiming({})).toEqual(DEFAULT_DRAIN_TIMING);
    expect(drainTiming({ AIS_GATEWAY_DRAIN_SETTLE_QUIET_MS: "500", AIS_GATEWAY_DRAIN_CEILING_MS: "840000", AIS_GATEWAY_DRAIN_CUT_HOLD_MS: "x" })).toMatchObject({ settleQuietMs: 500, ceilingMs: 840_000, cutHoldMs: 20_000 });
    expect(drainTiming({ AIS_GATEWAY_DRAIN_SETTLE_QUIET_MS: "500" }, { settleQuietMs: 10 }).settleQuietMs).toBe(10);
  });
});

describe("settle phase", () => {
  const timing = { settleQuietMs: 2_000, settleMaxMs: 15_000, pollMs: 100 };

  test("ends when no request arrived for the quiet time", async () => {
    const c = clock();
    const started = c.at();
    expect(await settle({ startedAt: started, lastArrivalAt: () => 0, timing, now: c.now, sleep: c.sleep })).toBe("quiet");
    expect(c.at() - started).toBe(2_000);
  });

  test("a request that arrives during the settle phase restarts the quiet time", async () => {
    const c = clock();
    const started = c.at();
    let last = 0;
    const sleep = async (ms: number): Promise<void> => {
      await c.sleep(ms);
      if (c.at() - started === 1_000) last = c.at();
    };
    expect(await settle({ startedAt: started, lastArrivalAt: () => last, timing, now: c.now, sleep })).toBe("quiet");
    expect(c.at() - started).toBe(3_000);
  });

  test("a replica that never goes quiet leaves after the maximum", async () => {
    const c = clock();
    const started = c.at();
    expect(await settle({ startedAt: started, lastArrivalAt: c.now, timing, now: c.now, sleep: c.sleep })).toBe("max");
    expect(c.at() - started).toBe(15_000);
  });
});

describe("wait phase", () => {
  test("returns as soon as nothing is in flight, with no timer", async () => {
    const c = clock();
    const started = c.at();
    const left = [3, 2, 1, 0];
    const r = await waitIdle({ startedAt: started, load: () => ({ requests: left.shift() ?? 0, tunnels: 0 }), timing: { ceilingMs: 0, pollMs: 100 }, now: c.now, sleep: c.sleep });
    expect(r).toEqual({ outcome: "drained" });
    expect(c.at() - started).toBe(300);
  });

  test("a long stream is waited for, however long it runs, when no ceiling is set", async () => {
    const c = clock();
    const started = c.at();
    const r = await waitIdle({ startedAt: started, load: () => ({ requests: c.at() - started < 3_600_000 ? 1 : 0, tunnels: 0 }), timing: { ceilingMs: 0, pollMs: 60_000 }, now: c.now, sleep: c.sleep });
    expect(r).toEqual({ outcome: "drained" });
  });

  test("with a ceiling the wait reports what it would cut", async () => {
    const c = clock();
    const started = c.at();
    const r = await waitIdle({ startedAt: started, load: () => ({ requests: 2, tunnels: 1 }), timing: { ceilingMs: 840_000, pollMs: 1_000 }, now: c.now, sleep: c.sleep });
    expect(r).toEqual({ outcome: "ceiling", cut: { requests: 2, tunnels: 1 } });
    expect(c.at() - started).toBe(840_000);
  });

  test("tunnels count as work", async () => {
    const c = clock();
    const left = [1, 0];
    const r = await waitIdle({ startedAt: c.at(), load: () => ({ requests: 0, tunnels: left.shift() ?? 0 }), timing: { ceilingMs: 0, pollMs: 100 }, now: c.now, sleep: c.sleep });
    expect(r.outcome).toBe("drained");
  });
});

describe("drain metrics", () => {
  test("exposition for a replica that is not draining, then one that drains and ends", () => {
    const c = clock();
    let load = { requests: 4, tunnels: 1 };
    const stats = new DrainStats(() => load, c.now);
    const text = () => stats.render().join("\n");
    expect(text()).toContain("ais_gateway_inflight_requests 4");
    expect(text()).toContain("ais_gateway_open_tunnels 1");
    expect(text()).toContain("ais_gateway_draining 0");
    expect(text()).toContain('ais_gateway_drain_phase{phase="serving"} 1');
    expect(text()).toContain("ais_gateway_drain_seconds 0");

    stats.begin();
    c.set(c.at() + 12_500);
    load = { requests: 2, tunnels: 0 };
    expect(text()).toContain("ais_gateway_draining 1");
    expect(text()).toContain("ais_gateway_drain_inflight_at_start 5");
    expect(text()).toContain("ais_gateway_drain_seconds 12.5");
    expect(text()).toContain('ais_gateway_drain_phase{phase="settle"} 1');

    stats.cutTotal += 2;
    stats.refusedTotal += 3;
    stats.end();
    c.set(c.at() + 60_000);
    expect(text()).toContain("ais_gateway_drain_seconds 12.5");
    expect(text()).toContain("ais_gateway_drain_cut_streams_total 2");
    expect(text()).toContain("ais_gateway_drain_refused_total 3");
    expect(text().match(/# TYPE ais_gateway_drain_cut_streams_total counter/)).not.toBeNull();
  });
});
