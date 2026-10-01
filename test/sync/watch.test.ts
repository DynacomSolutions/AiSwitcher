import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolConfig } from "../../src/identities/types.ts";
import {
  scanTree,
  shouldScanDirectory,
  shouldTriggerProfileSync,
  startProfileSyncWatcher,
} from "../../src/sync/watch.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const openFds = () => readdirSync("/proc/self/fd").length;
const cfg = { toolName: "claude", realBinaryName: "claude" } as unknown as ToolConfig;
const FAST = { pollMs: 50, debounceMs: 100 };

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "ais-watch-"));
  const shimDir = join(base, "shim");
  const log = join(base, "ais.log");
  mkdirSync(shimDir);
  writeFileSync(join(shimDir, "ais"), `#!/bin/sh\necho "$@" >> "${log}"\n`);
  chmodSync(join(shimDir, "ais"), 0o755);
  const prev = process.env.AI_PROFILE_SWITCHER_SHIM_DIR;
  process.env.AI_PROFILE_SWITCHER_SHIM_DIR = shimDir;
  cleanups.push(() => {
    if (prev === undefined) delete process.env.AI_PROFILE_SWITCHER_SHIM_DIR;
    else process.env.AI_PROFILE_SWITCHER_SHIM_DIR = prev;
    rmSync(base, { recursive: true, force: true });
  });
  const root = join(base, "identity");
  mkdirSync(root);
  // Background syncs started by the watcher (debounced, not the final one).
  const syncs = () =>
    (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []).filter((c) =>
      c.includes("--no-databases"),
    ).length;
  return { root, syncs };
}

function bigExcludedTree(root: string) {
  for (let d = 0; d < 40; d++) {
    const dir = join(root, "plugins", "marketplaces", "x", "node_modules", `pkg${d}`);
    mkdirSync(dir, { recursive: true });
    for (let f = 0; f < 50; f++) writeFileSync(join(dir, `f${f}.js`), "x");
  }
  for (let d = 0; d < 20; d++) {
    const dir = join(root, "plugins", "cache", `c${d}`);
    mkdirSync(dir, { recursive: true });
    for (let f = 0; f < 50; f++) writeFileSync(join(dir, `f${f}.js`), "x");
  }
  mkdirSync(join(root, "session-env", "a"), { recursive: true });
  mkdirSync(join(root, "plugins", ".trash", "old"), { recursive: true });
}

describe("startProfileSyncWatcher fd use", () => {
  test("holds no descriptors for a large tree with 3000 excluded files", async () => {
    const { root } = fixture();
    mkdirSync(join(root, "sessions", "2026"), { recursive: true });
    for (let i = 0; i < 100; i++) writeFileSync(join(root, "sessions", "2026", `s${i}.jsonl`), "x");
    bigExcludedTree(root);
    const before = openFds();
    const watcher = startProfileSyncWatcher(cfg, "t", root, root, FAST);
    let peak = 0;
    for (let i = 0; i < 20; i++) {
      await sleep(25);
      peak = Math.max(peak, openFds() - before);
    }
    console.log(`peak extra fds while watching (3100 files, 3000 excluded): ${peak}`);
    expect(peak).toBeLessThan(10);
    await watcher.stop();
    await sleep(100);
    expect(openFds() - before).toBeLessThan(3);
  });

  test("excluded trees are not even stat-walked", async () => {
    const { root } = fixture();
    bigExcludedTree(root);
    writeFileSync(join(root, "settings.json"), "{}");
    mkdirSync(join(root, "skills", "synced"), { recursive: true });
    writeFileSync(join(root, "skills", "synced", "a.md"), "x");
    const snapshot = await scanTree(root);
    expect([...snapshot.keys()].sort()).toEqual(["settings.json", "skills/synced/a.md"]);
  });
});

describe("startProfileSyncWatcher triggers", () => {
  test("a sync-relevant change schedules a sync; excluded changes do not", async () => {
    const { root, syncs } = fixture();
    mkdirSync(join(root, "sessions"), { recursive: true });
    mkdirSync(join(root, "plugins", "cache"), { recursive: true });
    const watcher = startProfileSyncWatcher(cfg, "t", root, root, FAST);
    await sleep(300);
    writeFileSync(join(root, "plugins", "cache", "ignored.txt"), "x");
    await sleep(500);
    expect(syncs()).toBe(0);
    writeFileSync(join(root, "sessions", "s.jsonl"), "x");
    await sleep(600);
    expect(syncs()).toBe(1);
    await watcher.stop();
  });

  test("new directories and removals during the session are noticed", async () => {
    const { root, syncs } = fixture();
    const watcher = startProfileSyncWatcher(cfg, "t", root, root, FAST);
    await sleep(300);
    mkdirSync(join(root, "newdir", "deeper"), { recursive: true });
    writeFileSync(join(root, "newdir", "deeper", "a.json"), "x");
    await sleep(600);
    expect(syncs()).toBe(1);
    rmSync(join(root, "newdir"), { recursive: true });
    await sleep(600);
    expect(syncs()).toBe(2);
    await watcher.stop();
  });

  test("a missing root is fine and picked up once created", async () => {
    const { root, syncs } = fixture();
    const missing = join(root, "later");
    const watcher = startProfileSyncWatcher(cfg, "t", missing, root, FAST);
    await sleep(300);
    mkdirSync(missing);
    writeFileSync(join(missing, "x.json"), "x");
    await sleep(600);
    expect(syncs()).toBe(1);
    await watcher.stop();
  });

  test("stop schedules no further debounced syncs", async () => {
    const { root, syncs } = fixture();
    const watcher = startProfileSyncWatcher(cfg, "t", root, root, FAST);
    await sleep(300);
    await watcher.stop();
    writeFileSync(join(root, "late.json"), "x");
    await sleep(500);
    expect(syncs()).toBe(0);
  });
});

describe("shouldScanDirectory", () => {
  test("skips reproducible and scratch trees", () => {
    expect(shouldScanDirectory("plugins/marketplaces")).toBe(false);
    expect(shouldScanDirectory("plugins/cache/x")).toBe(false);
    expect(shouldScanDirectory("plugins/.trash")).toBe(false);
    expect(shouldScanDirectory("session-env")).toBe(false);
    expect(shouldScanDirectory("skills/synced")).toBe(true);
    expect(shouldScanDirectory("sessions/2026")).toBe(true);
  });
});

describe("shouldTriggerProfileSync", () => {
  test("session and profile files trigger debounced reconciliation", () => {
    expect(shouldTriggerProfileSync("sessions/2026/07/22/rollout.jsonl")).toBe(true);
    expect(shouldTriggerProfileSync("settings.json")).toBe(true);
  });

  test("high-churn databases and transient process files wait for final reconciliation", () => {
    expect(shouldTriggerProfileSync("state_5.sqlite-wal")).toBe(false);
    expect(shouldTriggerProfileSync("crush.db")).toBe(false);
    expect(shouldTriggerProfileSync("daemon.lock")).toBe(false);
    expect(shouldTriggerProfileSync("plugins/cache/native-addon.node")).toBe(false);
    expect(shouldTriggerProfileSync("chrome-profile/Default/Cookies")).toBe(false);
  });
});
