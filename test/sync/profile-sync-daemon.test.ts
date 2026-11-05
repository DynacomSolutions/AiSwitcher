import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_CONFIG, ZAI_CONFIG } from "../../src/identities/tool-configs.ts";
import { startSessionWork, type SessionSpec } from "../../src/shared/session-sidecar.ts";
import { acquireDaemonLock, createProfileSyncDaemon, watchTargets } from "../../src/sync/profile-sync-daemon.ts";
import { listLiveSessions, registerSession, unregisterSession, type RegisteredSession } from "../../src/sync/session-registry.ts";
import type { SyncRunOptions } from "../../src/sync/types.ts";
import { scanTree } from "../../src/sync/watch.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function tempDir(prefix = "ais-psd-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function session(overrides: Partial<Omit<RegisteredSession, "v">> & { pid: number }): Omit<RegisteredSession, "v"> {
  return { toolName: "claude", identityName: "alpha", configDir: "/nonexistent", cwd: "/tmp", ...overrides };
}

/** A daemon over a temp registry with a controllable "running" set and recorded effects. */
function harness() {
  const base = tempDir();
  const registryDir = join(base, "sessions");
  const running = new Set<number>();
  const scanned: string[] = [];
  const syncs: SyncRunOptions[] = [];
  const dirty: string[] = [];
  const daemon = createProfileSyncDaemon({
    registryDir,
    isRunning: (pid) => running.has(pid),
    scan: async (root) => (scanned.push(root), scanTree(root)),
    sync: (options) => void syncs.push(options),
    markDirty: (tool, identity) => void dirty.push(`${tool}:${identity}`),
  });
  const start = (s: Omit<RegisteredSession, "v">) => {
    running.add(s.pid);
    registerSession(s, registryDir);
  };
  const exit = (pid: number) => running.delete(pid);
  return { base, registryDir, running, scanned, syncs, dirty, daemon, start, exit };
}

describe("session registry", () => {
  test("register, list and unregister", () => {
    const dir = tempDir();
    registerSession(session({ pid: 11, startTime: "100" }), dir);
    expect(listLiveSessions(() => true, dir).map((s) => s.pid)).toEqual([11]);
    unregisterSession(11, "100", dir);
    expect(listLiveSessions(() => true, dir)).toEqual([]);
  });

  test("entries whose process is gone or whose PID was reused are pruned", () => {
    const dir = tempDir();
    registerSession(session({ pid: 11, startTime: "100" }), dir);
    registerSession(session({ pid: 12, startTime: "200" }), dir);
    writeFileSync(join(dir, "garbage.json"), "{not json");
    // pid 12 is alive but with a different start time: a reused PID.
    const live = listLiveSessions((pid, startTime) => pid === 11 || (pid === 12 && startTime === "999"), dir);
    expect(live.map((s) => s.pid)).toEqual([11]);
    expect(readdirSync(dir)).toEqual(["11-100.json"]);
  });

  test("a missing registry is no sessions", () => {
    expect(listLiveSessions(() => true, join(tempDir(), "missing"))).toEqual([]);
  });
});

describe("profile sync daemon", () => {
  test("N sessions of one identity share one scan and one sync per change", async () => {
    const h = harness();
    const root = join(h.base, "identity");
    mkdirSync(join(root, "sessions"), { recursive: true });
    for (let pid = 1; pid <= 5; pid++) h.start(session({ pid, configDir: root, cwd: `/work/${pid}` }));

    expect(await h.daemon.tick()).toEqual({ sessions: 5, roots: 1, syncs: 0 });
    expect(h.scanned).toEqual([root]);

    writeFileSync(join(root, "sessions", "s.jsonl"), "x");
    expect((await h.daemon.tick()).syncs).toBe(1);
    expect(h.scanned).toEqual([root, root]);
    expect(h.syncs).toEqual([
      { direction: "both", scope: { kind: "identity", cfg: CLAUDE_CONFIG, identityName: "alpha" }, includeDatabases: false },
    ]);
    expect(h.dirty).toEqual(["claude:alpha"]);

    // No change, no sync.
    expect((await h.daemon.tick()).syncs).toBe(0);
  });

  test("excluded churn does not trigger a sync", async () => {
    const h = harness();
    const root = join(h.base, "identity");
    mkdirSync(join(root, "plugins", "cache"), { recursive: true });
    h.start(session({ pid: 1, configDir: root }));
    await h.daemon.tick();
    writeFileSync(join(root, "plugins", "cache", "x.txt"), "x");
    writeFileSync(join(root, "state.sqlite-wal"), "x");
    expect((await h.daemon.tick()).syncs).toBe(0);
    expect(h.dirty).toEqual([]);
  });

  test("different identities are scanned and synced separately", async () => {
    const h = harness();
    const a = join(h.base, "a");
    const b = join(h.base, "b");
    mkdirSync(a);
    mkdirSync(b);
    h.start(session({ pid: 1, identityName: "alpha", configDir: a }));
    h.start(session({ pid: 2, identityName: "beta", configDir: b }));
    await h.daemon.tick();
    writeFileSync(join(b, "x.json"), "x");
    await h.daemon.tick();
    expect(h.syncs.map((s) => (s.scope as { identityName: string }).identityName)).toEqual(["beta"]);
  });

  test("once every session of a root exits, the root is no longer scanned", async () => {
    const h = harness();
    const root = join(h.base, "identity");
    mkdirSync(root);
    h.start(session({ pid: 1, configDir: root }));
    h.start(session({ pid: 2, configDir: root }));
    await h.daemon.tick();
    h.exit(1);
    expect((await h.daemon.tick()).roots).toBe(1);
    h.exit(2);
    h.scanned.length = 0;
    expect(await h.daemon.tick()).toEqual({ sessions: 0, roots: 0, syncs: 0 });
    expect(h.scanned).toEqual([]);
    expect(readdirSync(h.registryDir)).toEqual([]);
  });

  test("a root that returns after a gap is a fresh baseline, not a change", async () => {
    const h = harness();
    const root = join(h.base, "identity");
    mkdirSync(root);
    h.start(session({ pid: 1, configDir: root }));
    await h.daemon.tick();
    h.exit(1);
    await h.daemon.tick();
    writeFileSync(join(root, "x.json"), "x");
    h.start(session({ pid: 2, configDir: root }));
    expect((await h.daemon.tick()).syncs).toBe(0);
  });

  test("crush .crush roots stay per cwd; a project change syncs with that cwd", async () => {
    const h = harness();
    const config = join(h.base, "zai-config");
    const p1 = join(h.base, "p1");
    const p2 = join(h.base, "p2");
    for (const dir of [config, join(p1, ".crush"), join(p2, ".crush")]) mkdirSync(dir, { recursive: true });
    h.start(session({ pid: 1, toolName: "zai", configDir: config, cwd: p1, crushRoot: join(p1, ".crush") }));
    h.start(session({ pid: 2, toolName: "zai", configDir: config, cwd: p2, crushRoot: join(p2, ".crush") }));
    h.start(session({ pid: 3, toolName: "zai", configDir: config, cwd: p2, crushRoot: join(p2, ".crush") }));

    expect((await h.daemon.tick()).roots).toBe(3);
    expect(new Set(h.scanned)).toEqual(new Set([config, join(p1, ".crush"), join(p2, ".crush")]));

    writeFileSync(join(p2, ".crush", "session.json"), "x");
    await h.daemon.tick();
    expect(h.syncs).toEqual([
      { direction: "both", scope: { kind: "identity", cfg: ZAI_CONFIG, identityName: "alpha", cwd: p2 }, includeDatabases: false },
    ]);

    // A configDir-only change is one cwd-less identity sync.
    h.syncs.length = 0;
    writeFileSync(join(config, "crush.json"), "{}");
    await h.daemon.tick();
    expect(h.syncs.map((s) => (s.scope as { cwd?: string }).cwd)).toEqual([undefined]);
  });

  test("watchTargets ignores unknown tools", () => {
    expect(watchTargets([{ v: 1, ...session({ pid: 1, toolName: "nope" }) }])).toEqual([]);
  });

  test("a failing scan or sync does not stop the other roots", async () => {
    const base = tempDir();
    const registryDir = join(base, "sessions");
    const syncs: string[] = [];
    const daemon = createProfileSyncDaemon({
      registryDir,
      isRunning: () => true,
      scan: async (root) => {
        if (root.endsWith("bad")) throw new Error("boom");
        return new Map([["f", String(Math.random())]]);
      },
      sync: (options) => {
        const name = (options.scope as { identityName: string }).identityName;
        if (name === "beta") throw new Error("spawn failed");
        syncs.push(name);
      },
      markDirty: () => {},
    });
    registerSession(session({ pid: 1, identityName: "alpha", configDir: join(base, "good") }), registryDir);
    registerSession(session({ pid: 2, identityName: "beta", configDir: join(base, "good2") }), registryDir);
    registerSession(session({ pid: 3, identityName: "gamma", configDir: join(base, "bad") }), registryDir);
    await daemon.tick();
    expect((await daemon.tick()).syncs).toBe(1);
    expect(syncs).toEqual(["alpha"]);
  });
});

describe("daemon single instance", () => {
  test("a second daemon stands by while the first is alive and takes over once it exits", () => {
    const lock = join(tempDir(), "daemon.pid");
    writeFileSync(lock, "424242 777\n");
    let ownerAlive = true;
    const isRunning = (pid: number, startTime?: string) => pid === 424242 && startTime === "777" && ownerAlive;
    expect(acquireDaemonLock(lock, isRunning)).toBe(false);
    expect(readFileSync(lock, "utf8")).toBe("424242 777\n");
    ownerAlive = false;
    expect(acquireDaemonLock(lock, isRunning)).toBe(true);
    expect(readFileSync(lock, "utf8").startsWith(`${process.pid} `)).toBe(true);
  });

  test("a reused PID with a different start time does not hold the lock", () => {
    const lock = join(tempDir(), "daemon.pid");
    writeFileSync(lock, "424242 777\n");
    expect(acquireDaemonLock(lock, (pid, startTime) => pid === 424242 && startTime === "778")).toBe(true);
  });
});

describe("session sidecar registration", () => {
  function spec(cwd: string, configDir: string): SessionSpec {
    return {
      toolName: "zai",
      pid: 31337,
      startTime: "4242",
      identity: { name: "alpha", configDir },
      configDirValue: configDir,
      cwd,
      syncAtLaunch: false,
    };
  }

  test("the sidecar registers, never syncs mid-session, and keeps its post-exit sync", async () => {
    const base = tempDir();
    const registryDir = join(base, "sessions");
    const syncs: SyncRunOptions[] = [];
    const cwd = join(base, "project");
    const work = await startSessionWork(ZAI_CONFIG, spec(cwd, join(base, "cfg")), {
      registryDir,
      startSync: (options) => (syncs.push(options ?? {}), true),
      markDirty: () => {},
    });
    const [entry] = listLiveSessions(() => true, registryDir);
    expect(entry).toMatchObject({ toolName: "zai", identityName: "alpha", cwd, crushRoot: join(cwd, ".crush"), pid: 31337, startTime: "4242" });
    await Bun.sleep(50);
    expect(syncs).toEqual([]);

    await work.stop();
    expect(existsSync(join(registryDir, "31337-4242.json"))).toBe(false);
    expect(syncs).toEqual([
      { direction: "both", scope: { kind: "identity", cfg: ZAI_CONFIG, identityName: "alpha", cwd }, waitForLock: true, includeDatabases: true },
    ]);
  });

  test("a non-crush session registers no crush root", async () => {
    const base = tempDir();
    const registryDir = join(base, "sessions");
    const work = await startSessionWork(CLAUDE_CONFIG, { ...spec(base, base), toolName: "claude" }, {
      registryDir,
      startSync: () => true,
      markDirty: () => {},
    });
    expect(listLiveSessions(() => true, registryDir)[0]?.crushRoot).toBeUndefined();
    await work.stop();
  });

  test("an unwritable registry never breaks the session", async () => {
    const base = tempDir();
    const blocker = join(base, "file");
    writeFileSync(blocker, "x");
    const syncs: SyncRunOptions[] = [];
    const work = await startSessionWork(CLAUDE_CONFIG, { ...spec(base, base), toolName: "claude" }, {
      registryDir: join(blocker, "sessions"),
      startSync: (options) => (syncs.push(options ?? {}), true),
      markDirty: () => {},
    });
    await work.stop();
    expect(syncs.length).toBe(1);
  });
});

describe("unit file", () => {
  test("runs the hidden daemon entrypoint and keeps detached syncs alive across restarts", () => {
    const unit = readFileSync(join(import.meta.dir, "..", "..", "scripts", "systemd", "ais-profile-sync.service"), "utf8");
    expect(unit).toContain("ExecStart=%h/.local/bin/ais __profile_sync_daemon");
    expect(unit).toContain("KillMode=process");
  });
});
