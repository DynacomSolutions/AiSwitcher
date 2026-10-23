import { describe, expect, test } from "bun:test";
import {
  ConcurrencyLimiter,
  isCachedScanKind,
  runUsageSnapshotRefreshCycle,
  scheduleUsageSnapshotJobs,
  scanWorkerConcurrencyLimit,
  terminateScanProcess,
  usageSnapshotRefreshTimeoutMs,
  waitForUsageSnapshotJobs,
} from "../../src/server/workers.ts";

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

describe("usage snapshot collector cycle", () => {
  test("uses at least 30 minutes and follows a longer configured Tokscale ceiling", () => {
    const original = process.env.AIS_TOKSCALE_TIMEOUT_MS;
    try {
      delete process.env.AIS_TOKSCALE_TIMEOUT_MS;
      expect(usageSnapshotRefreshTimeoutMs()).toBe(30 * 60_000);
      process.env.AIS_TOKSCALE_TIMEOUT_MS = String(35 * 60_000);
      expect(usageSnapshotRefreshTimeoutMs()).toBe(35 * 60_000 + 30_000);
    } finally {
      if (original === undefined) delete process.env.AIS_TOKSCALE_TIMEOUT_MS;
      else process.env.AIS_TOKSCALE_TIMEOUT_MS = original;
    }
  });

  test("does not record a successful source cycle", async () => {
    const events: string[] = [];
    await runUsageSnapshotRefreshCycle(
      async () => ({ ok: true }),
      async (category) => { events.push(`record:${category}`); },
      (category) => { events.push(`log:${category}`); },
    );
    expect(events).toEqual([]);
  });

  test("records timeout after the isolated child cleanup completes", async () => {
    const events: string[] = [];
    await runUsageSnapshotRefreshCycle(
      async () => {
        // spawnScanWorker resolves only after its finally block has reaped
        // the process group. Model that ordering at this injectable seam.
        events.push("child-cleanup-complete");
        return { ok: false, status: 504 };
      },
      async (category) => { events.push(`record:${category}`); },
      (category) => { events.push(`log:${category}`); },
    );
    expect(events).toEqual([
      "child-cleanup-complete",
      "log:collector-timeout",
      "record:collector-timeout",
    ]);
  });

  test("records rejected and unsuccessful collector results with bounded categories", async () => {
    const events: string[] = [];
    const record = async (category: string) => { events.push(category); };
    await runUsageSnapshotRefreshCycle(async () => ({ ok: false, status: 500 }), record, () => {});
    await runUsageSnapshotRefreshCycle(async () => { throw new Error("private provider detail"); }, record, () => {});
    expect(events).toEqual(["collector-failed", "collector-rejected"]);
  });

  test("warns with only the safe category when failure persistence rejects", async () => {
    const warnings: string[] = [];
    await runUsageSnapshotRefreshCycle(
      async () => ({ ok: false, status: 504 }),
      async () => { throw new Error("private persistence detail"); },
      () => {},
      (category) => { warnings.push(category); },
    );
    expect(warnings).toEqual(["collector-timeout"]);
  });

  test("a held breakdown does not suppress the next source schedule and shutdown awaits both jobs", async () => {
    const deferred = <T = void>() => {
      let resolve!: (value: T | PromiseLike<T>) => void;
      const promise = new Promise<T>((accept) => { resolve = accept; });
      return { promise, resolve };
    };
    const limiter = new ConcurrencyLimiter(1);
    const jobs: { source?: Promise<void>; breakdown?: Promise<unknown> } = {};
    const firstSourceGate = deferred();
    const breakdownGate = deferred();
    const secondSourceGate = deferred();
    const firstSourceStarted = deferred();
    const secondSourceQueued = deferred();
    const secondSourceStarted = deferred();
    const breakdownStarted = deferred();
    let sourceSchedules = 0;
    let breakdownDrains = 0;
    let activeHeavy = 0;
    let maxActiveHeavy = 0;
    const heavy = async (started: { resolve: () => void }, gate: { promise: Promise<void> }) =>
      limiter.run(async () => {
        activeHeavy++;
        maxActiveHeavy = Math.max(maxActiveHeavy, activeHeavy);
        started.resolve();
        await gate.promise;
        activeHeavy--;
      });
    const startSource = () => {
      sourceSchedules++;
      if (sourceSchedules === 1) return heavy(firstSourceStarted, firstSourceGate);
      secondSourceQueued.resolve();
      return heavy(secondSourceStarted, secondSourceGate);
    };
    const startBreakdown = () => {
      breakdownDrains++;
      return heavy(breakdownStarted, breakdownGate);
    };

    scheduleUsageSnapshotJobs(jobs, startSource, startBreakdown);
    await firstSourceStarted.promise;
    firstSourceGate.resolve();
    await breakdownStarted.promise;

    scheduleUsageSnapshotJobs(jobs, startSource, startBreakdown);
    scheduleUsageSnapshotJobs(jobs, startSource, startBreakdown);
    await secondSourceQueued.promise;
    expect(sourceSchedules).toBe(2);
    expect(breakdownDrains).toBe(1);
    expect(activeHeavy).toBe(1);

    let shutdownComplete = false;
    const shutdown = waitForUsageSnapshotJobs(jobs).then(() => { shutdownComplete = true; });
    await Promise.resolve();
    expect(shutdownComplete).toBe(false);
    breakdownGate.resolve();
    await secondSourceStarted.promise;
    expect(maxActiveHeavy).toBe(1);
    expect(shutdownComplete).toBe(false);
    secondSourceGate.resolve();
    await shutdown;
    expect(shutdownComplete).toBe(true);
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
