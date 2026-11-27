import { afterEach, expect, test } from "bun:test";
import { createECDH, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolLimitResult } from "../../src/cli/limits/types.ts";
import type { PoolResetReview, PoolThreshold } from "../../src/gateway/pool-reset-view.ts";
import { DEFAULT_RESET_PUSH_INTERVAL_MS, POOL_PUSH_INTERVAL_MS, ResetExpiryNotifier, resetPushStatePath } from "../../src/server/reset-expiry-push.ts";
import { writeServerState } from "../../src/server/state.ts";
import { trySharedFileLock } from "../../src/shared/file-lock.ts";
import { addSubscription, hasSubscription, loadSubscriptions, loadVapid, sendToAll, subscriptionsPath, vapidPath, type PushMessage } from "../../src/server/web-push.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "ais-pool-threshold-"));
  directories.push(directory);
  return directory;
}

async function withPushEnvironment(pushState: string | undefined, webState: string, run: () => Promise<void>) {
  const env = {
    AIS_WEB_PUSH_STATE_DIR: pushState,
    AIS_WEB_STATE_DIR: webState,
  };
  const previous = Object.keys(env).map((name) => [name, process.env[name]] as const);
  function setEnv(name: string, value: string | undefined) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    for (const [name, value] of Object.entries(env)) setEnv(name, value);
    await run();
  } finally {
    for (const [name, value] of previous) setEnv(name, value);
  }
}

function subscription(label: string) {
  const key = createECDH("prime256v1");
  return {
    endpoint: `https://push.example.com/send/SYNTHETIC_FIXTURE_${label}`,
    keys: { p256dh: key.generateKeys().toString("base64url"), auth: randomBytes(16).toString("base64url") },
  };
}

function setup(useStateDirectory = false) {
  const directory = tempDirectory();
  const path = join(directory, useStateDirectory ? "pool-threshold-push.json" : "episodes.json");
  const messages: PushMessage[] = [];
  const row: PoolThreshold = { tool: "codex", pool: "sample pool", percent: 90, complete: true, observedAt: 1_000 };
  const state = { enabled: true, rows: [row], canReset: true, failSend: false, stateAtSend: "", waitForScan: Promise.resolve() };
  const scan = Promise.withResolvers<void>();
  const notifier = () => new ResetExpiryNotifier({
    ...(useStateDirectory ? {} : { poolStatePath: path }),
    scanLimits: async () => ({ ok: true }),
    scanPoolThresholds: async () => {
      scan.resolve();
      await state.waitForScan;
      return state.rows;
    },
    reviewPoolReset: async (): Promise<PoolResetReview> => ({
      ...row, members: ["sample-a"], availability: state.canReset ? "available" : "no_credit",
    }),
    ...(useStateDirectory ? {} : { hasSubscribers: async () => state.enabled }),
    send: async (message) => {
      state.stateAtSend = readFileSync(path, "utf8");
      messages.push(message);
      if (state.failSend) throw new Error("synthetic push failure");
      return { sent: 1, removed: 0, failed: 0 };
    },
    log: () => {},
  });
  return { state, row, notifier, messages, scan: scan.promise, path, directory };
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

test("the persistent push directory keeps subscriptions, key and episodes separate from Console lifecycle state", async () => {
  const { notifier, directory, path } = setup(true);
  const webState = tempDirectory();
  const sub = subscription("SHARED");
  await withPushEnvironment(directory, webState, async () => {
    expect(await notifier().tickPools()).toBe(0);
    await addSubscription(sub, undefined);
    await loadVapid();
    await writeServerState({ pid: 123, port: 47129, token: "SYNTHETIC_FIXTURE", startedAt: "2026-01-01T00:00:00.000Z" });
    expect(await notifier().tickPools()).toBe(1);
    expect(await notifier().tickPools()).toBe(0);
    for (const file of [path, subscriptionsPath(directory), vapidPath(directory)]) {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(existsSync(join(webState, file.slice(directory.length + 1)))).toBe(false);
    }
    expect(existsSync(join(webState, "server.json"))).toBe(true);
    expect(existsSync(join(directory, "server.json"))).toBe(false);
  });
});

test("production defaults keep existing push files and explicit paths override the opt-in", async () => {
  const webState = tempDirectory();
  const pushState = tempDirectory();
  const { directory: injectedDir, notifier, path } = setup();
  const sub = subscription("LOCAL");
  await addSubscription(sub, undefined, webState);
  const original = await loadVapid(webState);
  await withPushEnvironment(" ", webState, async () => {
    expect(await hasSubscription(sub.endpoint)).toBe(true);
    expect((await loadVapid()).publicKey).toBe(original.publicKey);
    expect(subscriptionsPath()).toBe(subscriptionsPath(webState));
  });
  await withPushEnvironment(pushState, webState, async () => {
    expect(await hasSubscription(sub.endpoint)).toBe(false);
    expect(await hasSubscription(sub.endpoint, webState)).toBe(true);
    expect((await loadVapid(webState)).publicKey).toBe(original.publicKey);
    await addSubscription(sub, undefined, injectedDir);
    expect(await loadSubscriptions()).toEqual([]);
    expect(await hasSubscription(sub.endpoint, injectedDir)).toBe(true);
    expect(await notifier().tickPools()).toBe(1);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(join(pushState, "pool-threshold-push.json"))).toBe(false);
  });
});

test("overlapping Console processes keep one VAPID key and every subscription", async () => {
  const pushState = tempDirectory();
  const webState = tempDirectory();
  const pushModule = new URL("../../src/server/web-push.ts", import.meta.url).pathname;
  const subs = Array.from({ length: 4 }, (_, index) => subscription(`ROLLOUT_${index}`));
  const runConsole = async (index: number, sub?: ReturnType<typeof subscription>) => {
    const keyPath = join(webState, `public-key-${index}`);
    const child = Bun.spawn([process.execPath, "-e", `
      import { writeFileSync } from "node:fs";
      import { addSubscription, loadVapid } from ${JSON.stringify(pushModule)};
      const sub = JSON.parse(process.env.SYNTHETIC_SUBSCRIPTION);
      const { publicKey } = await loadVapid();
      if (sub) await addSubscription(sub);
      writeFileSync(${JSON.stringify(keyPath)}, publicKey);
    `], {
      env: {
        PATH: process.env.PATH ?? "",
        AIS_WEB_PUSH_STATE_DIR: pushState,
        AIS_WEB_STATE_DIR: webState,
        SYNTHETIC_SUBSCRIPTION: JSON.stringify(sub ?? null),
      },
      stdin: "ignore",
      stdout: "ignore",
    });
    expect(await child.exited).toBe(0);
    return readFileSync(keyPath, "utf8");
  };
  const concurrent = await Promise.all(subs.map((sub, index) => runConsole(index, sub)));
  const restarted = await runConsole(subs.length);
  expect(restarted).not.toBe("");
  expect(concurrent).toEqual(subs.map(() => restarted));
  expect((await loadSubscriptions(pushState)).map((sub) => sub.endpoint).sort()).toEqual(subs.map((sub) => sub.endpoint).sort());
});

test("a stale 410 response preserves a replacement and a concurrent subscription", async () => {
  const pushState = tempDirectory();
  const sub = subscription("REPLACED");
  const replacement = { ...subscription("NEW_KEYS"), endpoint: sub.endpoint };
  const other = subscription("OTHER");
  await withPushEnvironment(pushState, tempDirectory(), async () => {
    await addSubscription(sub, undefined);
    const fetchImpl = (async () => {
      await Promise.all([addSubscription(replacement, undefined), addSubscription(other, undefined)]);
      return new Response(null, { status: 410 });
    }) as unknown as typeof fetch;
    expect(await sendToAll({ title: "Synthetic", body: "Test" }, { fetchImpl })).toEqual({ sent: 0, removed: 0, failed: 0 });
    const subs = await loadSubscriptions();
    expect(subs).toHaveLength(2);
    expect(subs).toEqual(expect.arrayContaining([expect.objectContaining(replacement), expect.objectContaining(other)]));
  });
});

test("shared subscribers get one expiry reminder across overlapping and restarted Consoles", async () => {
  const directory = tempDirectory();
  const now = Date.parse("2026-01-01T00:00:00Z");
  const row: ToolLimitResult = {
    toolName: "codex", provider: "openai", status: "live", windows: [],
    identity: { name: "sample", label: "Sample", configDir: directory },
    manualReset: {
      availableCount: 1,
      creditExpiries: [{ id: "RateLimitResetCredit_SYNTHETIC_FIXTURE", label: "Full reset", endsAt: "2026-01-02T00:00:00Z" }],
    },
  };
  const sending = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const notifier = (holdSend = false) => new ResetExpiryNotifier({
    scanLimits: async () => ({ ok: true, payload: { results: [row] } }),
    now: () => now,
    log: () => {},
    send: async () => {
      if (holdSend) {
        sending.resolve();
        await resume.promise;
      }
      return { sent: 1, removed: 0, failed: 0 };
    },
  });
  await withPushEnvironment(directory, tempDirectory(), async () => {
    await addSubscription(subscription("EXPIRY"), undefined);
    const first = notifier(true).tick();
    try {
      expect(await Promise.race([sending.promise.then(() => true), first.then(() => false)])).toBe(true);
      expect(await notifier().tick()).toBe(0);
    } finally {
      resume.resolve();
    }
    expect(await first).toBe(1);
    expect(await notifier().tick()).toBe(0);
    expect(existsSync(resetPushStatePath(directory))).toBe(true);
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
