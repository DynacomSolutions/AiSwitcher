import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchClaudeLimits, saveLastGood, USAGE_PROBE_ARGS } from "../../../src/cli/limits/claude-limits.ts";
import type { FetchedLimitResult } from "../../../src/cli/limits/types.ts";
import { AIS_LIMITS_PROBE_ENV } from "../../../src/shared/limits-probe.ts";

const id = { name: "acct", label: "Acct", configDir: "/nonexistent/acct" };
const cacheDir = () => mkdtempSync(join(tmpdir(), "ais-probe-"));
const noApi = async () => ({ error: "offline" });
const AUTH_OK = { stdout: '{"loggedIn":true}', exitCode: 0, timedOut: false };
const USAGE_OK = { stdout: "Current session: 25% used · resets Jul 15 at 2pm\n", exitCode: 0, timedOut: false };
const USAGE_EMPTY = { stdout: "What's contributing to your usage?\n", exitCode: 0, timedOut: false };
const base = { reconcile: async () => undefined as never, fetchBody: noApi, resolveBinary: () => "/bin/claude", fetchResets: async () => undefined, isProbe: false };

async function seedLastGood(dir: string): Promise<void> {
  const good: FetchedLimitResult = {
    toolName: "claude",
    identity: id,
    windows: [{ label: "session (5h)", category: "session", usedPercent: 7 }],
    status: "live",
    capturedAt: new Date(Date.now() - 3_600_000).toISOString(),
  };
  await saveLastGood(id, good, dir);
}

describe("claude usage probe", () => {
  test("probe args are isolated and the probe env marker is set", async () => {
    const calls: { args: string[] }[] = [];
    const result = await fetchClaudeLimits(id, {
      ...base,
      cacheDir: cacheDir(),
      run: async (_bin, args) => (calls.push({ args }), args[0] === "auth" ? AUTH_OK : USAGE_OK),
    });
    expect(result.status).toBe("live");
    expect(calls[1]!.args).toEqual(["-p", "/usage", "--no-session-persistence", "--safe-mode", "--strict-mcp-config"]);
    expect(USAGE_PROBE_ARGS).toEqual(calls[1]!.args);
    expect(AIS_LIMITS_PROBE_ENV).toBe("AIS_LIMITS_PROBE");
  });

  test("the real runner passes AIS_LIMITS_PROBE=1 to the child", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ais-probe-bin-"));
    const bin = join(dir, "fake-claude");
    writeFileSync(bin, '#!/bin/sh\nif [ "$1" = auth ]; then echo \'{"loggedIn":true}\'; elif [ "$AIS_LIMITS_PROBE" = 1 ]; then echo "Current session: 5% used"; fi\n', { mode: 0o755 });
    const result = await fetchClaudeLimits(id, { ...base, cacheDir: cacheDir(), resolveBinary: () => bin });
    expect(result.status).toBe("live");
    expect(result.windows[0]?.usedPercent).toBe(5);
  });

  test("under AIS_LIMITS_PROBE=1 no probe is spawned: cached or unavailable", async () => {
    let spawned = 0;
    const run = async () => (spawned++, AUTH_OK);
    const empty = await fetchClaudeLimits(id, { ...base, cacheDir: cacheDir(), run, isProbe: true });
    expect(empty.status).toBe("unavailable");
    const dir = cacheDir();
    await seedLastGood(dir);
    const cached = await fetchClaudeLimits(id, { ...base, cacheDir: dir, run, isProbe: true });
    expect(cached.status).toBe("cached");
    expect(spawned).toBe(0);
  });

  test("the guard is read from the environment by default", async () => {
    const saved = process.env[AIS_LIMITS_PROBE_ENV];
    process.env[AIS_LIMITS_PROBE_ENV] = "1";
    try {
      let spawned = 0;
      const { isProbe: _omit, ...rest } = base;
      const result = await fetchClaudeLimits(id, { ...rest, cacheDir: cacheDir(), run: async () => (spawned++, AUTH_OK) });
      expect(result.status).toBe("unavailable");
      expect(spawned).toBe(0);
    } finally {
      if (saved === undefined) delete process.env[AIS_LIMITS_PROBE_ENV];
      else process.env[AIS_LIMITS_PROBE_ENV] = saved;
    }
  });

  test("single-flight: a second concurrent caller does not spawn", async () => {
    const dir = cacheDir();
    await seedLastGood(dir);
    let spawns = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const run = async (_b: string, args: string[]) => {
      if (args[0] === "auth") {
        spawns++;
        await gate;
        return AUTH_OK;
      }
      return USAGE_OK;
    };
    const first = fetchClaudeLimits(id, { ...base, cacheDir: dir, run });
    await Bun.sleep(100);
    const second = await fetchClaudeLimits(id, { ...base, cacheDir: dir, run });
    expect(second.status).toBe("cached");
    expect(spawns).toBe(1);
    release();
    expect((await first).status).toBe("live");
    expect(existsSync(join(dir, "claude-limits", "acct.probe.lock"))).toBe(false);
  });

  test("second caller with nothing cached gets the running-probe error", async () => {
    const dir = cacheDir();
    mkdirSync(join(dir, "claude-limits"), { recursive: true });
    writeFileSync(join(dir, "claude-limits", "acct.probe.lock"), JSON.stringify({ pid: process.pid, startedAtMs: Date.now() }));
    const result = await fetchClaudeLimits(id, { ...base, cacheDir: dir, run: async () => AUTH_OK });
    expect(result.status).toBe("unavailable");
    expect(result.error).toBe("another usage probe for this identity is running");
  });

  test("a stale lock (dead pid) is replaced", async () => {
    const dir = cacheDir();
    mkdirSync(join(dir, "claude-limits"), { recursive: true });
    writeFileSync(join(dir, "claude-limits", "acct.probe.lock"), JSON.stringify({ pid: 999_999, startedAtMs: Date.now() }));
    const result = await fetchClaudeLimits(id, {
      ...base,
      cacheDir: dir,
      lock: { isPidAlive: () => false },
      run: async (_b, args) => (args[0] === "auth" ? AUTH_OK : USAGE_OK),
    });
    expect(result.status).toBe("live");
  });

  test("a lock older than the limit is replaced even when its pid is alive", async () => {
    const dir = cacheDir();
    mkdirSync(join(dir, "claude-limits"), { recursive: true });
    writeFileSync(join(dir, "claude-limits", "acct.probe.lock"), JSON.stringify({ pid: process.pid, startedAtMs: Date.now() - 3_600_000 }));
    const result = await fetchClaudeLimits(id, { ...base, cacheDir: dir, run: async (_b, args) => (args[0] === "auth" ? AUTH_OK : USAGE_OK) });
    expect(result.status).toBe("live");
  });

  test("a failed probe backs off; a successful one is saved as last good", async () => {
    const dir = cacheDir();
    let spawns = 0;
    let now = 1_000_000;
    const run = async (_b: string, args: string[]) => (spawns++, args[0] === "auth" ? AUTH_OK : USAGE_EMPTY);
    const first = await fetchClaudeLimits(id, { ...base, cacheDir: dir, run, now: () => now });
    expect(first.status).toBe("unavailable");
    const spawnsAfterFirst = spawns;
    now += 60_000;
    const second = await fetchClaudeLimits(id, { ...base, cacheDir: dir, run, now: () => now });
    expect(second.status).toBe("unavailable");
    expect(second.error).toContain("not retried");
    expect(spawns).toBe(spawnsAfterFirst);
    now += 11 * 60_000;
    const ok = await fetchClaudeLimits(id, { ...base, cacheDir: dir, now: () => now, run: async (_b, args) => (args[0] === "auth" ? AUTH_OK : USAGE_OK) });
    expect(ok.status).toBe("live");
    // The saved result now answers within the fresh-read window without any spawn.
    const again = await fetchClaudeLimits(id, { ...base, cacheDir: dir, run: async () => { throw new Error("must not spawn"); } });
    expect(again.windows[0]?.usedPercent).toBe(25);
  });
});
