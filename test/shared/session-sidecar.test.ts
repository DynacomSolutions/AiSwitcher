import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_CONFIG, CODEX_CONFIG } from "../../src/identities/tool-configs.ts";
import {
  isPidRunning,
  launchWithSession,
  MAX_LOG_BYTES,
  MAX_PROMPT_BYTES,
  procStartTime,
  SIDECAR_ARG,
  SIDECAR_SPEC_ENV,
  selfCommand,
  takeSidecarSpec,
  waitForPidExit,
  type LaunchDeps,
  type RealLaunch,
  type SessionSpec,
} from "../../src/shared/session-sidecar.ts";
import { IDENTITY_SESSION_MARKER, IDENTITY_SESSION_TOOL_MARKER } from "../../src/shared/exec.ts";
import { activeParentSession, resolveNestedIdentity } from "../../src/shared/cli-args.ts";

// Start-time and zombie detection exist on both: /proc on Linux, sysctl on macOS.
const supported = process.platform === "linux" || process.platform === "darwin";

describe("pid exit detection", () => {
  test("this process is running; an unused pid is not", () => {
    expect(isPidRunning(process.pid)).toBe(true);
    expect(isPidRunning(2 ** 22 + 12345)).toBe(false);
  });

  test.skipIf(!supported)("a recycled pid (different start time) counts as exited", () => {
    const start = procStartTime(process.pid);
    expect(start).toBeTruthy();
    expect(isPidRunning(process.pid, start)).toBe(true);
    expect(isPidRunning(process.pid, `${start}0`)).toBe(false);
  });

  test.skipIf(process.platform !== "darwin")("the macOS start time is the real process start (sysctl layout check)", async () => {
    const child = Bun.spawn(["sleep", "5"], { stdio: ["ignore", "ignore", "ignore"] });
    try {
      const [seconds] = (procStartTime(child.pid) ?? "").split(".");
      expect(Math.abs(Number(seconds) * 1000 - Date.now())).toBeLessThan(10_000);
    } finally {
      child.kill();
      await child.exited;
    }
  });

  test.skipIf(!supported)("an unreaped zombie counts as exited", async () => {
    // The shell exits; we keep the Subprocess unreaped by not awaiting it yet.
    const child = Bun.spawn(["sh", "-c", "exit 0"], { stdio: ["ignore", "ignore", "ignore"] });
    const start = Date.now();
    while (isPidRunning(child.pid, procStartTime(child.pid)) && Date.now() - start < 5_000) await Bun.sleep(20);
    expect(isPidRunning(child.pid)).toBe(false);
    await child.exited;
  });

  test("waitForPidExit resolves only once the probe reports the pid gone", async () => {
    let calls = 0;
    await waitForPidExit(4242, { pollMs: 1, isRunning: () => ++calls < 4 });
    expect(calls).toBe(4);
  });

  test.skipIf(!supported)("waitForPidExit follows a real process that is not our child", async () => {
    const child = Bun.spawn(["sleep", "0.4"], { stdio: ["ignore", "ignore", "ignore"] });
    const started = Date.now();
    await waitForPidExit(child.pid, { pollMs: 20, startTime: procStartTime(child.pid) as string });
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    await child.exited;
  });
});

describe("sidecar re-entry", () => {
  const spec: SessionSpec = { toolName: "codex", pid: 1234, configDirValue: "/example/cfg", cwd: "/example/cwd", syncAtLaunch: true };

  test("takeSidecarSpec needs both the argument and the spec, and consumes the spec", () => {
    const env: Record<string, string | undefined> = { [SIDECAR_SPEC_ENV]: JSON.stringify(spec) };
    expect(takeSidecarSpec(["bun", "x.ts", "--help"], env)).toBeUndefined();
    expect(takeSidecarSpec(["bun", "x.ts", SIDECAR_ARG], {})).toBeUndefined();
    expect(takeSidecarSpec(["bun", "x.ts", SIDECAR_ARG], { [SIDECAR_SPEC_ENV]: "{not json" })).toBeUndefined();
    expect(takeSidecarSpec(["bun", "x.ts", SIDECAR_ARG], env)).toEqual(spec);
    expect(env[SIDECAR_SPEC_ENV]).toBeUndefined();
  });

  test("selfCommand re-enters a compiled binary directly, or bun plus the entry script", () => {
    expect(selfCommand("/example/bin/codex", "/$bunfs/root/codex")).toEqual(["/example/bin/codex"]);
    expect(selfCommand("/usr/bin/bun", "/repo/src/codex.ts")).toEqual(["/usr/bin/bun", "/repo/src/codex.ts"]);
  });
});

describe("launchWithSession", () => {
  const logDir = mkdtempSync(join(tmpdir(), "ais-launch-log-"));
  afterAll(() => rmSync(logDir, { recursive: true, force: true }));
  const real: RealLaunch = { path: "/real/codex", args: ["a"], env: { K: "v" } };
  const base = { configDirValue: "/example/cfg", cwd: "/example/cwd", syncAtLaunch: true };

  function deps(overrides: Partial<LaunchDeps> = {}) {
    const calls: string[] = [];
    const seen: { spec?: SessionSpec; real?: RealLaunch; execve?: RealLaunch } = {};
    const d: LaunchDeps = {
      spawnSidecar: (spec) => (calls.push("sidecar"), (seen.spec = spec), true),
      execve: (real) => (calls.push("execve"), (seen.execve = real), "execve failed"),
      spawn: async (real) => (calls.push("spawn"), (seen.real = real), 5),
      logPath: join(logDir, "fallback.log"),
      startWork: async () => (calls.push("work"), { stop: async () => void calls.push("stop") }),
      ...overrides,
    };
    return { d, calls, seen };
  }

  test("sidecar first, then execve; the spec identifies this process", async () => {
    const { d, calls, seen } = deps();
    await launchWithSession(CODEX_CONFIG, base, real, d);
    expect(calls.slice(0, 2)).toEqual(["sidecar", "execve"]);
    expect(seen.spec).toMatchObject({ toolName: "codex", pid: process.pid, syncAtLaunch: true });
  });

  test("stamps the originating tool beside a seeded session marker before execve", async () => {
    const { d, seen } = deps();
    await launchWithSession(CODEX_CONFIG, base, {
      ...real,
      env: {
        ...real.env,
        CODEX_HOME: "/synthetic/codex/member-a",
        [IDENTITY_SESSION_MARKER]: "member-a",
      },
    }, d);
    expect(seen.execve?.env).toMatchObject({
      [IDENTITY_SESSION_MARKER]: "member-a",
      [IDENTITY_SESSION_TOOL_MARKER]: "codex",
    });
    const childContext = activeParentSession("claude", {
      ...seen.execve!.env,
      CLAUDE_CONFIG_DIR: "/synthetic/claude/pool-b",
    });
    expect(childContext).toEqual({ toolName: "codex", identity: "member-a" });
    expect(resolveNestedIdentity("claude", undefined, "pool-b")).toBe("pool-b");
  });

  test("Claude resume launches stamp Claude so a nested Codex launch stays provider-scoped", async () => {
    const { d, seen } = deps();
    await launchWithSession(CLAUDE_CONFIG, base, {
      ...real,
      env: {
        CLAUDE_CONFIG_DIR: "/synthetic/claude/pool-a",
        [IDENTITY_SESSION_MARKER]: "pool-a",
      },
    }, d);
    const childContext = activeParentSession("codex", {
      ...seen.execve!.env,
      CODEX_HOME: "/synthetic/codex/member-b",
    });
    expect(childContext).toEqual({ toolName: "claude", identity: "pool-a" });
    expect(resolveNestedIdentity("codex", undefined, "member-b")).toBe("member-b");
  });

  test("stamps the tool on spawn fallback and leaves an unseeded launch unmarked", async () => {
    const fallback = deps({ execve: () => "unavailable" });
    await launchWithSession(CODEX_CONFIG, base, {
      ...real,
      env: { ...real.env, [IDENTITY_SESSION_MARKER]: "member-a" },
    }, fallback.d);
    expect(fallback.seen.real?.env[IDENTITY_SESSION_TOOL_MARKER]).toBe("codex");

    const unseeded = deps();
    await launchWithSession(CODEX_CONFIG, base, real, unseeded.d);
    expect(unseeded.seen.real?.env[IDENTITY_SESSION_TOOL_MARKER]).toBeUndefined();
  });

  test("stamps the originating tool when the sidecar cannot start", async () => {
    const noSidecar = deps({ spawnSidecar: () => false });
    await launchWithSession(CODEX_CONFIG, base, {
      ...real,
      env: { ...real.env, [IDENTITY_SESSION_MARKER]: "member-a" },
    }, noSidecar.d);
    expect(noSidecar.seen.real?.env).toMatchObject({
      [IDENTITY_SESSION_MARKER]: "member-a",
      [IDENTITY_SESSION_TOOL_MARKER]: "codex",
    });
  });

  test("execve unavailable: spawns the child, the sidecar keeps the session work", async () => {
    const { d, calls } = deps();
    expect(await launchWithSession(CODEX_CONFIG, base, real, d)).toBe(5);
    expect(calls).toEqual(["sidecar", "execve", "spawn"]);
  });

  test("sidecar unavailable: legacy in-process work around spawn, post-exit stop last", async () => {
    const { d, calls } = deps({ spawnSidecar: () => (false) });
    expect(await launchWithSession(CODEX_CONFIG, { ...base, syncAtLaunch: false }, real, d)).toBe(5);
    expect(calls).toEqual(["work", "spawn", "stop"]);
  });

  test("an oversized initial prompt is truncated so the spec can never overflow the env limit", async () => {
    const { d, seen } = deps();
    await launchWithSession(CODEX_CONFIG, { ...base, title: { tool: "codex", initialPrompt: "x".repeat(300_000) } }, real, d);
    expect(seen.spec?.title?.initialPrompt?.length).toBe(MAX_PROMPT_BYTES);
    expect(JSON.stringify(seen.spec).length).toBeLessThan(10_000);
  });

  test("every fallback to the old spawn path leaves one log line saying which and why", async () => {
    const home = mkdtempSync(join(tmpdir(), "ais-fallback-log-"));
    const log = join(home, "shim-fallback.log");
    try {
      const { d } = deps({ execve: () => "execve failed: boom", logPath: log });
      await launchWithSession(CODEX_CONFIG, base, real, d);
      const noSidecar = deps({ spawnSidecar: () => false, logPath: log });
      await launchWithSession(CODEX_CONFIG, base, real, noSidecar.d);
      const lines = readFileSync(log, "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain("codex");
      expect(lines[0]).toContain("spawn fallback");
      expect(lines[0]).toContain("execve failed: boom");
      expect(lines[1]).toContain("in-process fallback");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a platform where execve is never expected is not logged, but a real failure on Linux or macOS is", async () => {
    const home = mkdtempSync(join(tmpdir(), "ais-fallback-log-"));
    const log = join(home, "shim-fallback.log");
    try {
      const other = deps({ execve: () => "execve unsupported on win32", logPath: log, platform: "win32" });
      await launchWithSession(CODEX_CONFIG, base, real, other.d);
      expect(existsSync(log)).toBe(false);
      for (const platform of ["linux", "darwin"] as const) {
        const failing = deps({ execve: () => `execve(/real/${platform}) failed`, logPath: log, platform });
        await launchWithSession(CODEX_CONFIG, base, real, failing.d);
      }
      const text = readFileSync(log, "utf8");
      expect(text).toContain("execve(/real/linux) failed");
      expect(text).toContain("execve(/real/darwin) failed");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the fallback log is truncated once it passes its size cap", async () => {
    const home = mkdtempSync(join(tmpdir(), "ais-fallback-log-"));
    const log = join(home, "shim-fallback.log");
    try {
      writeFileSync(log, "x".repeat(MAX_LOG_BYTES + 1));
      const { d } = deps({ logPath: log, platform: "linux" });
      await launchWithSession(CODEX_CONFIG, base, real, d);
      const text = readFileSync(log, "utf8");
      expect(text.length).toBeLessThan(1000);
      expect(text).toContain("spawn fallback");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
