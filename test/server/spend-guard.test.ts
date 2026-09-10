import { describe, expect, test, afterAll } from "bun:test";
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_KILL_GRACE_S,
  DEFAULT_SPEND_GUARD_INTERVAL_S,
  MIN_SPEND_GUARD_INTERVAL_S,
  parseSpendGuardConfig,
  SpendGuardScheduler,
  type SpendGuardSchedulerDeps,
} from "../../src/server/spend-guard.ts";
import { runSpendGuardCycle } from "../../src/spend/compute.ts";
import { loadSpendGuardCache } from "../../src/spend/cache.ts";
import type { AccountSpendState } from "../../src/spend/state.ts";

const TMP = mkdtempSync(join(tmpdir(), "ais-spend-guard-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const NOW = new Date(2026, 8, 10, 12, 0, 0);

function state(overrides: Partial<AccountSpendState> = {}): AccountSpendState {
  return {
    accountId: "123456789012",
    profile: "acme-prod",
    budgetName: "acme-bedrock-monthly",
    budgetLimitUsd: 1000,
    budgetActualUsd: 0,
    budgetTimeUnit: "MONTHLY",
    localEstimateUsd: 1004,
    effectiveUsd: 1004,
    breached: true,
    enforced: true,
    degraded: false,
    reason: "spend 1004.12 reached cap 1000.00",
    identities: ["canary-identity"],
    computedAt: NOW.toISOString(),
    ...overrides,
  };
}

describe("parseSpendGuardConfig", () => {
  test("defaults when absent; clamps interval up to the minimum and grace into a sane band", () => {
    expect(parseSpendGuardConfig(undefined)).toEqual({ intervalS: DEFAULT_SPEND_GUARD_INTERVAL_S, killGraceS: DEFAULT_KILL_GRACE_S });
    expect(parseSpendGuardConfig({ intervalS: 5, killGraceS: 10 }).intervalS).toBe(MIN_SPEND_GUARD_INTERVAL_S);
    expect(parseSpendGuardConfig({ intervalS: "abc" }).intervalS).toBe(DEFAULT_SPEND_GUARD_INTERVAL_S);
    expect(parseSpendGuardConfig({ killGraceS: 9999 }).killGraceS).toBe(120);
    expect(parseSpendGuardConfig({ intervalS: 60, killGraceS: 2 })).toEqual({ intervalS: 60, killGraceS: 2 });
  });
});

function schedulerDeps(overrides: Partial<SpendGuardSchedulerDeps> = {}): SpendGuardSchedulerDeps {
  return {
    config: { intervalS: 60, killGraceS: 1 },
    cycle: async () => ({ states: {}, errors: [], computedAt: NOW.toISOString() }),
    scan: async () => ({ processes: [] }),
    signal: () => {},
    alive: () => false,
    sleep: async () => {},
    cachePath: join(TMP, `cache-${Math.random().toString(36).slice(2)}.json`),
    log: () => {},
    now: () => NOW,
    ...overrides,
  };
}

describe("SpendGuardScheduler transitions", () => {
  test("kills on entry into breach: only wrapped sessions of the breached account's identities", async () => {
    const signalled: Array<[number, string]> = [];
    const deps = schedulerDeps({
      cycle: async () => ({ states: { "123456789012": state() }, errors: [], computedAt: NOW.toISOString() }),
      scan: async () => ({
        processes: [
          { pid: 111, tool: "codex", identity: "canary-identity", cwd: null, startedAt: null, command: "codex", wrapped: true },
          { pid: 222, tool: "codex", identity: "other-identity", cwd: null, startedAt: null, command: "codex", wrapped: true },
          { pid: 333, tool: "codex", identity: "canary-identity", cwd: null, startedAt: null, command: "codex" }, // no marker
          { pid: process.pid, tool: "codex", identity: "canary-identity", cwd: null, startedAt: null, command: "codex", wrapped: true }, // the daemon itself
        ],
      }),
      signal: (pid, sig) => signalled.push([pid, sig]),
    });
    const scheduler = new SpendGuardScheduler(deps);
    await scheduler.tick();
    expect(signalled).toEqual([[111, "SIGTERM"]]);
    expect(scheduler.status().recentKills).toHaveLength(1);
    expect(scheduler.status().recentKills[0]).toMatchObject({ pid: 111, identity: "canary-identity", accountId: "123456789012", signal: "SIGTERM" });
  });

  test("no re-kill when the previous cycle was already breached (states come from the hydrated cache)", async () => {
    const cachePath = schedulerDeps({}).cachePath!;
    const previous = { version: 1 as const, updatedAt: NOW.toISOString(), accounts: { "123456789012": state() }, recentKills: [] };
    await Bun.write(cachePath, JSON.stringify(previous));
    const signalled: Array<[number, string]> = [];
    const scheduler = new SpendGuardScheduler(
      schedulerDeps({
        cachePath,
        cycle: async () => ({ states: { "123456789012": state() }, errors: [], computedAt: NOW.toISOString() }),
        scan: async () => ({ processes: [{ pid: 111, tool: "codex", identity: "canary-identity", cwd: null, startedAt: null, command: "codex", wrapped: true }] }),
        signal: (pid, sig) => signalled.push([pid, sig]),
      }),
    );
    await scheduler.hydrate();
    await scheduler.tick();
    expect(signalled).toEqual([]);

    // But a NEW breach (previously healthy) after hydration still kills.
    const healthy = { ...previous, accounts: { "123456789012": state({ breached: false, effectiveUsd: 5, localEstimateUsd: 5, reason: undefined }) } };
    await Bun.write(cachePath, JSON.stringify(healthy));
    const second = new SpendGuardScheduler(
      schedulerDeps({
        cachePath,
        cycle: async () => ({ states: { "123456789012": state() }, errors: [], computedAt: NOW.toISOString() }),
        scan: async () => ({ processes: [{ pid: 111, tool: "codex", identity: "canary-identity", cwd: null, startedAt: null, command: "codex", wrapped: true }] }),
        signal: (pid, sig) => signalled.push([pid, sig]),
      }),
    );
    await second.hydrate();
    await second.tick();
    expect(signalled).toEqual([[111, "SIGTERM"]]);
  });

  test("degraded accounts are never killed; cycle errors surface in status without throwing", async () => {
    const signalled: Array<[number, string]> = [];
    const scheduler = new SpendGuardScheduler(
      schedulerDeps({
        cycle: async () => ({
          states: { "123456789012": state({ breached: false, enforced: false, degraded: true, reason: "SSO expired", budgetLimitUsd: undefined, budgetName: undefined }) },
          errors: ["account ...9012: AWS SSO credentials expired"],
          computedAt: NOW.toISOString(),
        }),
        scan: async () => ({ processes: [{ pid: 111, tool: "codex", identity: "canary-identity", cwd: null, startedAt: null, command: "codex", wrapped: true }] }),
        signal: (pid, sig) => signalled.push([pid, sig]),
      }),
    );
    await scheduler.tick();
    expect(signalled).toEqual([]);
    expect(scheduler.status().lastError).toContain("SSO");
  });

  test("the fresh cycle result is persisted for the launch gate to read", async () => {
    const cachePath = schedulerDeps({}).cachePath!;
    const scheduler = new SpendGuardScheduler(schedulerDeps({ cachePath, cycle: async () => ({ states: { "123456789012": state() }, errors: [], computedAt: NOW.toISOString() }) }));
    await scheduler.tick();
    const cached = await loadSpendGuardCache(cachePath);
    expect(cached?.accounts["123456789012"]?.breached).toBe(true);
    expect(cached?.accounts["123456789012"]?.identities).toEqual(["canary-identity"]);
  });
});

/** The real-kill canary: an actual child process, running a sleep binary
 * copied under an agent name, carrying the marker env. The scheduler (with
 * the REAL /proc scanner and REAL signals) must terminate it. A twin
 * WITHOUT the marker must survive untouched. The identities involved are
 * synthetic, so no real session on this machine can ever match. */
describe("spend guard killer (real process canary)", () => {
  test("SIGTERMs a marked canary within grace and leaves unmarked processes alone", async () => {
    const dir = join(TMP, "kill-fixture");
    mkdirSync(join(dir, "bin"), { recursive: true });
    // A real, long-running binary under an AGENT_BINARIES name.
    copyFileSync("/bin/sleep", join(dir, "bin", "codex"));

    const spawnCanary = (marker: boolean) => {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
      if (marker) env.AI_PROFILE_SWITCHER_SESSION = "canary-identity";
      return Bun.spawn([join(dir, "bin", "codex"), "120"], {
        env,
        stdout: "ignore",
        stderr: "ignore",
      });
    };

    const marked = spawnCanary(true);
    const unmarked = spawnCanary(false);
    const cleanup = (): void => {
      for (const proc of [marked, unmarked]) {
        try {
          proc.kill(9);
        } catch {
          // already gone
        }
      }
    };

    try {
      // Wait until both are visible in /proc with their marker state settled.
      await Bun.sleep(300);

      const logs: string[] = [];
      const scheduler = new SpendGuardScheduler(
        schedulerDeps({
          config: { intervalS: 60, killGraceS: 5 },
          cycle: async () => ({ states: { "123456789012": state() }, errors: [], computedAt: NOW.toISOString() }),
          // Explicit undefined: fall back to the REAL /proc scanner, REAL
          // signals, and REAL liveness checks for this test.
          scan: undefined,
          signal: undefined,
          alive: undefined,
          sleep: undefined,
          log: (m) => logs.push(m),
        }),
      );
      await scheduler.tick();

      const markedGone = await Promise.race([
        marked.exited.then(() => true),
        Bun.sleep(20_000).then(() => false),
      ]);
      expect(markedGone).toBe(true);
      expect(unmarked.exitCode).toBeNull(); // still running

      const kill = scheduler.status().recentKills.find((k) => k.pid === marked.pid);
      expect(kill).toBeDefined();
      expect(kill).toMatchObject({ identity: "canary-identity", accountId: "123456789012", tool: "codex" });
      expect(["SIGTERM", "SIGKILL"]).toContain(kill!.signal);
      expect(logs.join("\n")).toContain(`KILLING pid ${marked.pid}`);
    } finally {
      cleanup();
    }
  }, 40_000);
});
