import { describe, expect, test } from "bun:test";
import { ConcurrencyLimiter, isCachedScanKind, scanWorkerConcurrencyLimit, terminateScanProcess } from "../../src/server/workers.ts";

/**
 * Usage and breakdown reads now consume canonical persisted snapshots and
 * queue marker-only refresh requests. PollCache remains for the API-backed
 * limits path and the daemon's other cacheable scans.
 */
describe("isCachedScanKind", () => {
  test("usage and breakdown bypass request-local caches", () => {
    expect(isCachedScanKind("usage")).toBe(false);
    expect(isCachedScanKind("limits")).toBe(true);
    expect(isCachedScanKind("breakdown")).toBe(false);
    expect(isCachedScanKind("tree")).toBe(true);
    expect(isCachedScanKind("transcript")).toBe(true);
  });

  test("sessions is cached too (stale-while-revalidate)", () => {
    expect(isCachedScanKind("sessions")).toBe(true);
  });
});

describe("scanWorkerConcurrencyLimit", () => {
  test("defaults to 1 and honours AIS_SCAN_WORKER_CONCURRENCY", () => {
    const original = process.env.AIS_SCAN_WORKER_CONCURRENCY;
    try {
      delete process.env.AIS_SCAN_WORKER_CONCURRENCY;
      expect(scanWorkerConcurrencyLimit()).toBe(1);
      process.env.AIS_SCAN_WORKER_CONCURRENCY = "2";
      expect(scanWorkerConcurrencyLimit()).toBe(2);
      process.env.AIS_SCAN_WORKER_CONCURRENCY = "0";
      expect(scanWorkerConcurrencyLimit()).toBe(1);
      process.env.AIS_SCAN_WORKER_CONCURRENCY = "not-a-number";
      expect(scanWorkerConcurrencyLimit()).toBe(1);
    } finally {
      if (original === undefined) delete process.env.AIS_SCAN_WORKER_CONCURRENCY;
      else process.env.AIS_SCAN_WORKER_CONCURRENCY = original;
    }
  });
});

describe("ConcurrencyLimiter", () => {
  test("never lets more than `limit` jobs run at once, and every job still completes", async () => {
    const limiter = new ConcurrencyLimiter(2);
    let active = 0;
    let maxActive = 0;
    const job = async (n: number) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await Bun.sleep(15);
      active--;
      return n;
    };
    const results = await Promise.all([1, 2, 3, 4, 5].map((n) => limiter.run(() => job(n))));
    expect(results.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(maxActive).toBeGreaterThan(0);
  });

  test("a limit of 1 fully serializes jobs (FIFO)", async () => {
    const limiter = new ConcurrencyLimiter(1);
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3].map((n) =>
        limiter.run(async () => {
          order.push(n);
          await Bun.sleep(5);
        }),
      ),
    );
    expect(order).toEqual([1, 2, 3]);
  });

  test("a failing job releases its slot so queued jobs still run", async () => {
    const limiter = new ConcurrencyLimiter(1);
    const first = limiter.run(async () => {
      throw new Error("boom");
    });
    const second = limiter.run(async () => "recovered");
    await expect(first).rejects.toThrow("boom");
    expect(await second).toBe("recovered");
  });

  test("stop rejects queued and future jobs while allowing the active job to finish", async () => {
    const limiter = new ConcurrencyLimiter(1);
    let finish!: () => void;
    const active = limiter.run(() => new Promise<void>((resolve) => { finish = resolve; }));
    const queued = limiter.run(async () => "should not run");
    limiter.stop();
    await expect(queued).rejects.toThrow("scan worker is stopping");
    await expect(limiter.run(async () => "also should not run")).rejects.toThrow("scan worker is stopping");
    finish();
    await active;
  });
});

describe("scan process cleanup", () => {
  test("kills descendants before the next queued scan starts", async () => {
    if (!Bun.which("setsid") || !Bun.which("sh")) return;
    const limiter = new ConcurrencyLimiter(1);
    const proc = Bun.spawn(["setsid", "sh", "-c", "trap '' TERM; sleep 30 & echo $!; wait"], {
      stdin: "ignore", stdout: "pipe", stderr: "ignore",
    });
    const reader = proc.stdout.getReader();
    let line = "";
    while (!line.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      line += new TextDecoder().decode(chunk.value);
    }
    const childPid = Number.parseInt(line.trim(), 10);
    // Recreate the worker case: successful output is ready, but a descendant
    // remains alive and inherits the worker's output descriptor.
    const order: string[] = [];
    const first = limiter.run(async () => {
      await terminateScanProcess(proc, true);
      order.push("cleaned");
    });
    const second = limiter.run(async () => {
      let live = false;
      try {
        const stat = await Bun.file(`/proc/${childPid}/stat`).text();
        live = !/^[ZX]$/.test(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]!);
      } catch { /* gone */ }
      expect(live).toBe(false);
      order.push("next");
    });
    await Promise.all([first, second]);
    expect(order).toEqual(["cleaned", "next"]);
    let running = false;
    try {
      const stat = await Bun.file(`/proc/${childPid}/stat`).text();
      running = !/^[ZX]$/.test(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]!);
    } catch { /* process is gone */ }
    expect(running).toBe(false);
  }, 5000);
});
