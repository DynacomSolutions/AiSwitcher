import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthRefreshScheduler, parseRefreshIntervalMs } from "../../src/server/auth-refresh.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function withHome<T>(fn: () => T | Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "ais-refresh-"));
  tempDirs.push(dir);
  const previous = process.env.HOME;
  process.env.HOME = dir;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  }
}

function countingRefresher(failFirst: number) {
  let calls = 0;
  const seen: string[] = [];
  return {
    seen,
    refresher: async (identity: { name: string }) => {
      calls += 1;
      seen.push(identity.name);
      if (calls <= failFirst) throw new Error(`flaky failure #${calls}`);
      return `/tmp/console-cookie-${identity.name}.txt`;
    },
    get calls() {
      return calls;
    },
  };
}

describe("AuthRefreshScheduler", () => {
  test("refreshNow records success and clears the error", async () => {
    await withHome(() => {
      const { refresher } = countingRefresher(0);
      const scheduler = new AuthRefreshScheduler(0, { ali: refresher }, async () => [{ name: "personal", label: "personal", configDir: "/tmp/ali-personal" }]);
      const ok = scheduler.refreshNow("ali", "personal");
      expect(ok).toBeInstanceOf(Promise);
      return ok.then((success) => {
        expect(success).toBe(true);
        const status = scheduler.status();
        expect(status).toHaveLength(1);
        expect(status[0].lastError).toBeNull();
        expect(status[0].lastSuccessAt).not.toBeNull();
      });
    });
  });

  test("failures land in lastError and a later success clears them", async () => {
    await withHome(() => {
      const { refresher } = countingRefresher(1);
      const scheduler = new AuthRefreshScheduler(0, { ali: refresher }, async () => [{ name: "personal", label: "personal", configDir: "/tmp/ali-personal" }]);
      return scheduler
        .refreshNow("ali", "personal")
        .then((first) => {
          expect(first).toBe(false);
          expect(scheduler.status()[0].lastError).toContain("flaky failure #1");
          return scheduler.refreshNow("ali", "personal");
        })
        .then((second) => {
          expect(second).toBe(true);
          expect(scheduler.status()[0].lastError).toBeNull();
        });
    });
  });

  test("refreshNow rejects unknown tools and identities", async () => {
    await withHome(() => {
      const { refresher } = countingRefresher(0);
      const scheduler = new AuthRefreshScheduler(0, { ali: refresher }, async () => [{ name: "personal", label: "personal", configDir: "/tmp/ali-personal" }]);
      return Promise.all([
        scheduler.refreshNow("claude", "personal").then(
          () => expect.unreachable(),
          (error: Error) => expect(error.message).toContain("no refresh flow"),
        ),
        scheduler.refreshNow("ali", "does-not-exist").then(
          () => expect.unreachable(),
          (error: Error) => expect(error.message).toContain("does-not-exist"),
        ),
      ]);
    });
  });

  test("interval 0 disables the scheduler but refreshNow still works", async () => {
    await withHome(() => {
      const counter = countingRefresher(0);
      const scheduler = new AuthRefreshScheduler(0, { ali: counter.refresher });
      expect(scheduler.enabled).toBe(false);
      scheduler.start();
      return scheduler.refreshNow("ali", "personal").then(() => {
        expect(counter.calls).toBe(1);
        scheduler.stop();
      });
    });
  });

  test("parseRefreshIntervalMs falls back on garbage and honours zero", () => {
    expect(parseRefreshIntervalMs(undefined)).toBe(600_000);
    expect(parseRefreshIntervalMs("")).toBe(600_000);
    expect(parseRefreshIntervalMs("nonsense")).toBe(600_000);
    expect(parseRefreshIntervalMs("-5")).toBe(600_000);
    expect(parseRefreshIntervalMs("0")).toBe(0);
    expect(parseRefreshIntervalMs("60000")).toBe(60_000);
  });
});
