import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PoolResetReview, PoolThreshold } from "../../src/gateway/pool-reset-view.ts";
import { DEFAULT_RESET_PUSH_INTERVAL_MS, POOL_PUSH_INTERVAL_MS, ResetExpiryNotifier } from "../../src/server/reset-expiry-push.ts";
import { trySharedFileLock } from "../../src/shared/file-lock.ts";
import type { PushMessage } from "../../src/server/web-push.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "ais-pool-threshold-"));
  directories.push(directory);
  const path = join(directory, "episodes.json");
  const messages: PushMessage[] = [];
  const row: PoolThreshold = { tool: "codex", pool: "sample pool", percent: 90, complete: true, observedAt: 1_000 };
  const state = { enabled: true, rows: [row], canReset: true, failSend: false, stateAtSend: "", waitForScan: Promise.resolve() };
  const scan = Promise.withResolvers<void>();
  const notifier = () => new ResetExpiryNotifier({
    poolStatePath: path,
    scanLimits: async () => ({ ok: true }),
    scanPoolThresholds: async () => {
      scan.resolve();
      await state.waitForScan;
      return state.rows;
    },
    reviewPoolReset: async (): Promise<PoolResetReview> => ({
      ...row, members: ["sample-a"], availability: state.canReset ? "available" : "no_credit",
    }),
    hasSubscribers: async () => state.enabled,
    send: async (message) => {
      state.stateAtSend = readFileSync(path, "utf8");
      messages.push(message);
      if (state.failSend) throw new Error("synthetic push failure");
      return { sent: 1, removed: 0, failed: 0 };
    },
    log: () => {},
  });
  return { state, row, notifier, messages, scan: scan.promise, path };
}

test("persists a crossing before delivery and preserves it across daemon restart", async () => {
  const { state, row, notifier, messages } = setup();
  state.enabled = false;
  expect(await notifier().tickPools()).toBe(0);
  state.enabled = true;
  state.failSend = true;
  expect(await notifier().tickPools()).toBe(0);
  expect(JSON.parse(state.stateAtSend)).toEqual({ "/limits/pools/codex/sample%20pool": { startedAt: row.observedAt } });
  state.failSend = false;
  expect(await notifier().tickPools()).toBe(0);
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({
    url: "/limits/pools/codex/sample%20pool?reset=1",
    tag: "pool-threshold:/limits/pools/codex/sample%20pool",
    poolAlert: "review",
  });
});

test("unknown cannot clear a crossing and complete recovery rearms it with the same tag", async () => {
  const { state, row, notifier, messages } = setup();
  const scheduler = notifier();
  expect(await scheduler.tickPools()).toBe(1);
  state.rows = [{ ...row, percent: undefined, complete: false }];
  expect(await scheduler.tickPools()).toBe(0);
  state.rows = [{ ...row, percent: 70, complete: false }];
  expect(await scheduler.tickPools()).toBe(0);
  state.rows = [{ ...row, percent: 89.8 }];
  expect(await scheduler.tickPools()).toBe(1);
  expect(messages[1]).toMatchObject({ url: "/limits/pools/codex/sample%20pool", tag: messages[0].tag });
  expect(messages[1].body).toContain("89%");
  expect(messages[1].poolAlert).toBeUndefined();
  state.rows = [{ ...row, observedAt: 2_000 }];
  expect(await notifier().tickPools()).toBe(1);
  expect(messages[2].tag).toBe(messages[0].tag);
});

test("pool scans run twelve times as often as reset expiry scans", () => {
  expect(POOL_PUSH_INTERVAL_MS).toBe(5 * 60_000);
  expect(DEFAULT_RESET_PUSH_INTERVAL_MS).toBe(12 * POOL_PUSH_INTERVAL_MS);
});

test("verified reset replaces once while another window remains high", async () => {
  const { state, row, notifier, messages } = setup();
  expect(await notifier().tickPools()).toBe(1);
  state.rows = [{ ...row, percent: 96, complete: false, verifiedResetAt: 2_000, observedAt: 3_000 }];
  expect(await notifier().tickPools()).toBe(1);
  expect(await notifier().tickPools()).toBe(0);
  expect(messages[1]).toMatchObject({ tag: messages[0].tag, title: "Pool usage update" });
  expect(messages[1].body).toContain("Reset verified · 96% used");
  state.rows = [{ ...row, percent: 70, observedAt: 4_000 }];
  expect(await notifier().tickPools()).toBe(0);
  state.rows = [{ ...row, observedAt: 5_000 }];
  expect(await notifier().tickPools()).toBe(1);
});

test("sends a threshold alert without a use action when there is no supported credit", async () => {
  const { state, row, notifier, messages } = setup();
  state.canReset = false;
  state.rows = [row, { ...row, tool: "claude" }];
  expect(await notifier().tickPools()).toBe(2);
  expect(messages.map(({ poolAlert }) => poolAlert)).toEqual(["dismiss", "dismiss"]);
  expect(messages[1].url).toBe("/limits/pools/claude/sample%20pool?reset=1");
});

test("rolling Console daemons claim a shared crossing only once", async () => {
  const { state, notifier, messages, scan } = setup();
  const releaseScan = Promise.withResolvers<void>();
  state.waitForScan = releaseScan.promise;
  const first = notifier().tickPools();
  try {
    await scan;
    expect(await notifier().tickPools()).toBe(0);
  } finally {
    releaseScan.resolve();
  }
  expect(await first).toBe(1);
  expect(await notifier().tickPools()).toBe(0);
  expect(messages).toHaveLength(1);
});

test("the shared claim lock releases when a separate process crashes", async () => {
  const { path, notifier } = setup();
  const lockModule = new URL("../../src/shared/file-lock.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, "-e", `
    import { trySharedFileLock } from ${JSON.stringify(lockModule)};
    const release = await trySharedFileLock(${JSON.stringify(path)});
    if (!release) process.exit(1);
    console.log("locked");
    await Bun.sleep(30_000);
  `], { stdout: "pipe" });
  try {
    const result = await child.stdout.getReader().read();
    expect(new TextDecoder().decode(result.value).trim()).toBe("locked");
    expect(await notifier().tickPools()).toBe(0);
  } finally {
    child.kill("SIGKILL");
    await child.exited;
  }
  const deadline = Date.now() + 1_000;
  let release: Awaited<ReturnType<typeof trySharedFileLock>>;
  do {
    release = await trySharedFileLock(path);
    if (release) break;
    await Bun.sleep(10);
  } while (Date.now() < deadline);
  expect(release).toBeDefined();
  await release?.();
  expect(await notifier().tickPools()).toBe(1);
});
