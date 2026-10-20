import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scheduleAutomaticSync } from "../../src/sync/auto-schedule.ts";
import type { SyncRunOptions } from "../../src/sync/types.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), "ais-sched-"));
  dirs.push(dir);
  let clock = 1_000_000;
  const runs: SyncRunOptions[] = [];
  const sleeps: number[] = [];
  const deps = {
    dir,
    minIntervalMinutes: 10,
    now: () => clock,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    },
    skipNext: false,
    run: async (o: SyncRunOptions) => {
      runs.push(o);
      if (deps.skipNext) {
        deps.skipNext = false;
        return { skipped: true };
      }
      return { skipped: false };
    },
  };
  return { deps, runs, sleeps, advance: (ms: number) => (clock += ms) };
}

describe("scheduleAutomaticSync", () => {
  test("first request runs at once with its own options; one inside the interval is queued and run once as scope all", async () => {
    const h = await harness();
    await scheduleAutomaticSync({ direction: "push", includeDatabases: false }, h.deps);
    expect(h.runs).toEqual([{ direction: "push", includeDatabases: false }]);

    h.advance(60_000);
    await scheduleAutomaticSync({ direction: "push", includeDatabases: false }, h.deps);
    expect(h.runs.length).toBe(2);
    expect(h.runs[1]).toEqual({ direction: "push", scope: { kind: "all" }, includeDatabases: false, waitForLock: false });
    expect(h.sleeps).toEqual([540_000]);
  });

  test("queued requests union directions and databases into one run", async () => {
    const h = await harness();
    await scheduleAutomaticSync({ direction: "both" }, h.deps);
    await mkdir(join(h.deps.dir, "sync-pending"), { recursive: true });
    await Bun.write(join(h.deps.dir, "sync-pending", "seed.json"), '{"databases":false,"direction":"pull"}');
    await scheduleAutomaticSync({ direction: "push", includeDatabases: true }, h.deps);
    expect(h.runs.length).toBe(2);
    expect(h.runs[1]).toEqual({ direction: "both", scope: { kind: "all" }, includeDatabases: true, waitForLock: false });
  });

  test("a coalesced run skipped by the sync lock is requeued and retried after the next interval", async () => {
    const h = await harness();
    await scheduleAutomaticSync({}, h.deps);
    h.deps.skipNext = true;
    h.advance(60_000);
    await scheduleAutomaticSync({ direction: "pull", includeDatabases: false }, h.deps);
    expect(h.runs.length).toBe(3);
    expect(h.runs[2]).toEqual(h.runs[1]!);
    expect(h.sleeps.length).toBe(2);
    expect(await readdir(join(h.deps.dir, "sync-pending"))).toEqual([]);
  });

  test("a direct run skipped by the sync lock is requeued", async () => {
    const h = await harness();
    h.deps.skipNext = true;
    await scheduleAutomaticSync({ direction: "push", includeDatabases: false }, h.deps);
    expect(h.runs.length).toBe(2);
    expect(h.runs[1]).toEqual({ direction: "push", scope: { kind: "all" }, includeDatabases: false, waitForLock: false });
    expect(h.sleeps).toEqual([600_000]);
  });

  test("a stamp in the future is stale and runs at once", async () => {
    const h = await harness();
    await Bun.write(join(h.deps.dir, "last-auto-sync"), String(2_000_000_000));
    await scheduleAutomaticSync({ direction: "pull" }, h.deps);
    expect(h.runs).toEqual([{ direction: "pull" }]);
    expect(h.sleeps).toEqual([]);
  });

  test("a held lock means the caller only queues and returns", async () => {
    const h = await harness();
    await scheduleAutomaticSync({}, h.deps);
    await Bun.write(join(h.deps.dir, "sync-pending.lock"), JSON.stringify({ pid: process.pid, token: "x" }));
    await scheduleAutomaticSync({ direction: "pull" }, h.deps);
    expect(h.runs.length).toBe(1);
    expect(h.sleeps).toEqual([]);
  });

  test("interval 0 never delays", async () => {
    const h = await harness();
    h.deps.minIntervalMinutes = 0;
    await scheduleAutomaticSync({}, h.deps);
    await scheduleAutomaticSync({}, h.deps);
    expect(h.runs.length).toBe(2);
    expect(h.sleeps).toEqual([]);
  });

  test("a request after the interval runs immediately", async () => {
    const h = await harness();
    await scheduleAutomaticSync({}, h.deps);
    h.advance(600_000);
    await scheduleAutomaticSync({ direction: "pull" }, h.deps);
    expect(h.runs[1]).toEqual({ direction: "pull" });
    expect(h.sleeps).toEqual([]);
  });
});
