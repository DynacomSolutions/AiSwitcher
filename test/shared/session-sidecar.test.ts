import { describe, expect, test } from "bun:test";
import { CODEX_CONFIG } from "../../src/identities/tool-configs.ts";
import {
  isPidRunning,
  launchWithSession,
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

const linux = process.platform === "linux";

describe("pid exit detection", () => {
  test("this process is running; an unused pid is not", () => {
    expect(isPidRunning(process.pid)).toBe(true);
    expect(isPidRunning(2 ** 22 + 12345)).toBe(false);
  });

  test.skipIf(!linux)("a recycled pid (different start time) counts as exited", () => {
    const start = procStartTime(process.pid);
    expect(start).toBeTruthy();
    expect(isPidRunning(process.pid, start)).toBe(true);
    expect(isPidRunning(process.pid, `${start}0`)).toBe(false);
  });

  test.skipIf(!linux)("an unreaped zombie counts as exited", async () => {
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

  test.skipIf(!linux)("waitForPidExit follows a real process that is not our child", async () => {
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
  const real: RealLaunch = { path: "/real/codex", args: ["a"], env: { K: "v" } };
  const base = { configDirValue: "/example/cfg", cwd: "/example/cwd", syncAtLaunch: true };

  function deps(overrides: Partial<LaunchDeps> = {}) {
    const calls: string[] = [];
    const seen: { spec?: SessionSpec } = {};
    const d: LaunchDeps = {
      spawnSidecar: (spec) => (calls.push("sidecar"), (seen.spec = spec), true),
      execve: () => (calls.push("execve"), false),
      spawn: async () => (calls.push("spawn"), 5),
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
});
