import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scanTree,
  shouldScanDirectory,
  shouldTriggerProfileSync,
  snapshotsDiffer,
} from "../../src/sync/watch.ts";

const openFds = () => readdirSync("/proc/self/fd").length;

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ais-watch-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
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

describe("scanTree", () => {
  test("holds no descriptors after scanning a large tree with 3000 excluded files", async () => {
    const root = fixture();
    mkdirSync(join(root, "sessions", "2026"), { recursive: true });
    for (let i = 0; i < 100; i++) writeFileSync(join(root, "sessions", "2026", `s${i}.jsonl`), "x");
    bigExcludedTree(root);
    const before = openFds();
    for (let i = 0; i < 5; i++) await scanTree(root);
    expect(openFds() - before).toBeLessThan(3);
  });

  test("excluded trees are not even stat-walked", async () => {
    const root = fixture();
    bigExcludedTree(root);
    writeFileSync(join(root, "settings.json"), "{}");
    mkdirSync(join(root, "skills", "synced"), { recursive: true });
    writeFileSync(join(root, "skills", "synced", "a.md"), "x");
    const snapshot = await scanTree(root);
    expect([...snapshot.keys()].sort()).toEqual(["settings.json", "skills/synced/a.md"]);
  });

  test("a missing root scans as empty", async () => {
    expect((await scanTree(join(fixture(), "missing"))).size).toBe(0);
  });

  test("snapshotsDiffer sees additions, edits and removals", async () => {
    const root = fixture();
    writeFileSync(join(root, "a.json"), "x");
    const first = await scanTree(root);
    expect(snapshotsDiffer(first, await scanTree(root))).toBe(false);
    mkdirSync(join(root, "newdir"));
    writeFileSync(join(root, "newdir", "b.json"), "x");
    const second = await scanTree(root);
    expect(snapshotsDiffer(first, second)).toBe(true);
    rmSync(join(root, "newdir"), { recursive: true });
    expect(snapshotsDiffer(second, await scanTree(root))).toBe(true);
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
