import { afterEach, describe, expect, test } from "bun:test";
import { createWarmGate } from "../../src/shared/warm-gate.ts";
import { ServerLifecycle } from "../../src/server/lifecycle.ts";
import { renderReadinessMetrics, resetReadinessMetrics, warmLimitsThenReady } from "../../src/server/limits-warm.ts";
import { WidgetService } from "../../src/server/widgets.ts";

afterEach(() => resetReadinessMetrics());

describe("console limits warm-up", () => {
  test("not ready until the first limits read ends, then ready, with metrics", async () => {
    const lifecycle = new ServerLifecycle();
    let finish!: () => void;
    const slow = new Promise<void>((r) => (finish = r));
    const run = warmLimitsThenReady(lifecycle, { warm: () => slow }, { timeoutMs: 60_000 });
    await Bun.sleep(0);
    expect(lifecycle.isReady).toBe(false);
    let text = renderReadinessMetrics();
    expect(text).toContain("ais_console_ready 0");
    expect(text).toContain('ais_console_readiness_state{state="cold"} 1');
    finish();
    await run;
    expect(lifecycle.isReady).toBe(true);
    text = renderReadinessMetrics();
    expect(text).toContain("ais_console_ready 1");
    expect(text).toContain('ais_console_readiness_state{state="warm"} 1');
    expect(text).toContain("ais_console_limits_warmup_seconds ");
    expect(text).toContain("ais_console_limits_warmup_timeouts_total 0");
  });

  test("a timeout warns and the console becomes ready", async () => {
    const lifecycle = new ServerLifecycle();
    const logs: string[] = [];
    let fire: (() => void) | undefined;
    const gate = createWarmGate({ timeoutMs: 5, setTimer: (fn) => ((fire = fn), 1), clearTimer: () => {} });
    const run = warmLimitsThenReady(lifecycle, { warm: () => new Promise(() => {}) }, { gate, log: (l) => void logs.push(l) });
    await Bun.sleep(0);
    fire?.();
    await run;
    expect(lifecycle.isReady).toBe(true);
    expect(logs.length).toBe(1);
    const text = renderReadinessMetrics();
    expect(text).toContain('ais_console_readiness_state{state="timeout"} 1');
    expect(text).toContain("ais_console_limits_warmup_timeouts_total 1");
  });

  test("draining during the warm-up wins over ready", async () => {
    const lifecycle = new ServerLifecycle();
    let finish!: () => void;
    const slow = new Promise<void>((r) => (finish = r));
    const run = warmLimitsThenReady(lifecycle, { warm: () => slow }, { timeoutMs: 60_000 });
    lifecycle.beginDrain();
    finish();
    await run;
    expect(lifecycle.isReady).toBe(false);
    expect(lifecycle.isDraining).toBe(true);
    expect(renderReadinessMetrics()).toContain('ais_console_readiness_state{state="draining"} 1');
  });

  test("WidgetService.warm fills the cache a later limits request reads", async () => {
    let calls = 0;
    const service = new WidgetService({
      limits: async () => (calls += 1, { results: [] }),
      auth: async () => ({ entries: [] }),
      processes: async () => ({ processes: [] }),
      gatewayUsage: async () => ({ configured: false, rows: [] }),
    });
    await service.warm("limits");
    expect(calls).toBe(1);
    const res = await service.get("limits");
    expect(res.status).toBe(200);
    expect(calls).toBe(1);
  });

  test("a limits panel built without the gateway part is not kept for the full refresh period", async () => {
    let builds = 0;
    let degraded = true;
    const service = new WidgetService({
      limits: async () => ((builds += 1), (degraded = builds === 1), { results: [] }),
      limitsDegraded: () => degraded,
      auth: async () => ({ entries: [] }),
      processes: async () => ({ processes: [] }),
      gatewayUsage: async () => ({ configured: false, rows: [] }),
    });
    const realNow = Date.now;
    let clock = realNow();
    Date.now = () => clock;
    try {
      await service.get("limits");
      clock += 31_000;
      await service.get("limits");
      expect(builds).toBe(2);
      // The second read was healthy: it is kept for the full refresh period.
      clock += 31_000;
      await service.get("limits");
      expect(builds).toBe(2);
    } finally {
      Date.now = realNow;
    }
  });
});
