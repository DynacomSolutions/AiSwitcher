import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRefusal, evaluateLaunchGate, type LaunchGateDeps } from "../../src/spend/gate.ts";
import type { AccountSpendState } from "../../src/spend/state.ts";
import type { SpendGuardCache } from "../../src/spend/cache.ts";

const NOW = new Date("2026-09-10T10:00:00.000Z");

function state(overrides: Partial<AccountSpendState> = {}): AccountSpendState {
  return {
    accountId: "123456789012",
    profile: "nazare-prod",
    budgetName: "pcg-bedrock-monthly-1000",
    budgetLimitUsd: 1000,
    budgetActualUsd: 982.55,
    budgetTimeUnit: "MONTHLY",
    periodStart: "2026-09-01T00:00:00.000Z",
    periodEnd: "2026-10-01T00:00:00.000Z",
    localEstimateUsd: 1004.12,
    realReportedUsd: 990,
    effectiveUsd: 1004.12,
    breached: true,
    enforced: true,
    degraded: false,
    reason: "spend 1004.12 reached cap 1000.00 (pcg-bedrock-monthly-1000)",
    identities: ["guarded"],
    computedAt: NOW.toISOString(),
    ...overrides,
  };
}

function cache(accounts: Record<string, AccountSpendState>, overrides: Partial<SpendGuardCache> = {}): SpendGuardCache {
  return { version: 1, updatedAt: NOW.toISOString(), accounts, recentKills: [], ...overrides };
}

const MAPPED: LaunchGateDeps = {
  target: { profile: "nazare-prod", accountId: "123456789012", region: "eu-west-2" },
  now: () => NOW,
  intervalS: 300,
};

describe("evaluateLaunchGate", () => {
  test("no AWS mapping: the gate is invisible and asks for nothing", () => {
    const outcome = evaluateLaunchGate("codex", "plain", { target: undefined, now: () => NOW });
    expect(outcome).toEqual({ applies: false, decision: "allow", refresh: false });
  });

  test("a malformed mapping warns loudly but never blocks (never block on missing data)", () => {
    const outcome = evaluateLaunchGate("codex", "plain", {
      now: () => NOW,
      awsProfileDeps: {
        readText: () => "{ broken",
        awsProfilesPath: "/f/aws-profiles.json",
        awsConfigPath: "/f/config",
      },
    });
    expect(outcome.decision).toBe("allow");
    expect(outcome.warn).toContain("invalid");
  });

  test("cached breach -> BLOCK with a complete refusal", () => {
    const outcome = evaluateLaunchGate("codex", "guarded", { ...MAPPED, cache: cache({ "123456789012": state() }) });
    expect(outcome.decision).toBe("block");
    expect(outcome.refusal).toContain("launch REFUSED");
    expect(outcome.refusal).toContain("...9012");
    expect(outcome.refusal).toContain("nazare-prod");
    expect(outcome.refusal).toContain("pcg-bedrock-monthly-1000");
    expect(outcome.refusal).toContain("$1000.00");
    expect(outcome.refusal).toContain("$1004.12");
    expect(outcome.refusal).toContain("Cost Explorer $990.00");
    expect(outcome.refusal).toContain("no override");
    expect(outcome.refresh).toBe(false); // fresh cache: nothing to do
  });

  test("cached healthy -> allow, silent", () => {
    const outcome = evaluateLaunchGate("codex", "guarded", {
      ...MAPPED,
      cache: cache({ "123456789012": state({ breached: false, effectiveUsd: 400, localEstimateUsd: 400, reason: undefined }) }),
    });
    expect(outcome).toMatchObject({ applies: true, decision: "allow" });
    expect(outcome.warn).toBeUndefined();
  });

  test("cached degraded (cap unfetchable) -> allow with a loud warn", () => {
    const outcome = evaluateLaunchGate("codex", "guarded", {
      ...MAPPED,
      cache: cache({
        "123456789012": state({
          breached: false,
          enforced: false,
          degraded: true,
          reason: "AWS SSO credentials expired or unavailable for profile \"nazare-prod\"",
          budgetName: undefined,
          budgetLimitUsd: undefined,
        }),
      }),
    });
    expect(outcome.decision).toBe("allow");
    expect(outcome.warn).toContain("UNENFORCED");
    expect(outcome.warn).toContain("SSO");
  });

  test("no cached state -> allow with warn + refresh queued; the inline estimate shows in the warn", () => {
    const outcome = evaluateLaunchGate("codex", "guarded", {
      ...MAPPED,
      cache: cache({}),
      inlineEstimate: () => 12.5,
    });
    expect(outcome.decision).toBe("allow");
    expect(outcome.warn).toContain("no spend state cached");
    expect(outcome.warn).toContain("$12.50");
    expect(outcome.refresh).toBe(true);
  });

  test("a stale cache is still enforced on, but queues a refresh", () => {
    const staleCache = cache({ "123456789012": state({ breached: false }) }, { updatedAt: "2026-09-10T09:00:00.000Z" });
    const outcome = evaluateLaunchGate("codex", "guarded", { ...MAPPED, cache: staleCache });
    expect(outcome.decision).toBe("allow");
    expect(outcome.refresh).toBe(true);
    // Even a STALE breach blocks: enforcement runs on last-known state.
    const staleBreach = evaluateLaunchGate("codex", "guarded", {
      ...MAPPED,
      cache: cache({ "123456789012": state() }, { updatedAt: "2026-09-09T10:00:00.000Z" }),
    });
    expect(staleBreach.decision).toBe("block");
    expect(staleBreach.refresh).toBe(true);
  });
});

describe("buildRefusal", () => {
  test("carries every fact the user needs to act, with no bypass language", () => {
    const text = buildRefusal("codex", "guarded", state());
    expect(text).toContain("codex: launch REFUSED for identity \"guarded\"");
    // Local-timezone day rendering, so only the shape is asserted.
    expect(text).toMatch(/period since \d{4}-\d{2}-\d{2}/);
    expect(text).toMatch(/resets \d{4}-\d{2}-\d{2}/);
    expect(text).toContain("budget actual $982.55");
    expect(text).toContain("raise or remove the budget in AWS");
  });
});

/** The full-process proof: a REAL wrapper invocation against a temp HOME
 * with a synthetic identity mapped to a fake account and a synthetic cache
 * showing breach -> refusal on stderr, exit code 1, and (crucially) the
 * real binary never spawned. */
/** Child env with every escape hatch that could reach the REAL machine
 * neutralised: no inherited session marker, no real AWS config overrides,
 * no managed real-bin dir. */
function isolatedChildEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k === "AI_PROFILE_SWITCHER_SESSION" || k === "AWS_CONFIG_FILE" || k === "AIS_AWS_PROFILES_CONFIG" || k === "AI_PROFILE_SWITCHER_REAL_BIN_DIR") continue;
    env[k] = v;
  }
  env.HOME = home;
  env.AI_PROFILE_SWITCHER_REAL_BIN_DIR = join(home, "nonexistent-real-bin");
  return env;
}

describe("launch gate end-to-end (temp HOME)", () => {
  test("a breached account refuses a real wrapper launch with exit code 1 and the exact message", async () => {
    const home = mkdtempSync(join(tmpdir(), "ais-gate-home-"));
    const childEnv = isolatedChildEnv(home);
    try {
      mkdirSync(join(home, ".codex", "identities", "guarded"), { recursive: true });
      mkdirSync(join(home, ".ais", "config"), { recursive: true });
      mkdirSync(join(home, ".ais", "cache"), { recursive: true });
      mkdirSync(join(home, ".aws"), { recursive: true });
      mkdirSync(join(home, "shims"), { recursive: true });
      mkdirSync(join(home, "bin"), { recursive: true });

      writeFileSync(
        join(home, ".codex", "identities.json"),
        JSON.stringify({ version: 1, identities: [{ name: "guarded", label: "Guarded", configDir: join(home, ".codex", "identities", "guarded") }] }),
      );
      writeFileSync(
        join(home, ".ais", "config", "aws-profiles.json"),
        JSON.stringify({ version: 1, identities: { guarded: { profile: "fake-profile" } } }),
      );
      writeFileSync(join(home, ".aws", "config"), "[profile fake-profile]\nsso_account_id = 123456789012\nregion = eu-west-2\n");
      writeFileSync(
        join(home, ".ais", "cache", "spend-guard.json"),
        JSON.stringify(cache({ "123456789012": state() })),
      );
      // A fake `ais` so the gate's detached refresh spawn is a no-op, and a
      // fake `codex` that would loudly fail the test if it were ever
      // spawned (a block must happen BEFORE the real binary).
      const fakeAis = join(home, "shims", "ais");
      writeFileSync(fakeAis, "#!/bin/sh\nexit 0\n");
      chmodSync(fakeAis, 0o755);
      const fakeCodex = join(home, "bin", "codex");
      writeFileSync(fakeCodex, "#!/bin/sh\necho 'REAL BINARY MUST NOT RUN WHEN BLOCKED' >&2\nexit 0\n");
      chmodSync(fakeCodex, 0o755);
      childEnv.AI_PROFILE_SWITCHER_SHIM_DIR = join(home, "shims");
      childEnv.PATH = `${join(home, "bin")}:${childEnv.PATH ?? ""}`;

      const src = join(import.meta.dir, "..", "..", "src", "codex.ts");
      const proc = Bun.spawn([process.execPath, src, "--id=guarded"], {
        env: childEnv,
        stdout: "pipe",
        stderr: "pipe",
        cwd: home,
      });
      const timer = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("gate e2e child hung")), 30_000));
      const [stderr, exitCode] = await Promise.race([
        Promise.all([new Response(proc.stderr).text(), proc.exited]),
        timer,
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain("launch REFUSED");
      expect(stderr).toContain("...9012");
      expect(stderr).toContain("pcg-bedrock-monthly-1000");
      expect(stderr).not.toContain("REAL BINARY MUST NOT RUN");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("an unmapped identity launches straight through (gate invisible, exit 0)", async () => {
    const home = mkdtempSync(join(tmpdir(), "ais-gate-allow-"));
    const childEnv = isolatedChildEnv(home);
    try {
      mkdirSync(join(home, ".codex", "identities", "free"), { recursive: true });
      mkdirSync(join(home, "shims"), { recursive: true });
      mkdirSync(join(home, "bin"), { recursive: true });
      writeFileSync(
        join(home, ".codex", "identities.json"),
        JSON.stringify({ version: 1, identities: [{ name: "free", label: "Free", configDir: join(home, ".codex", "identities", "free") }] }),
      );
      const fakeAis = join(home, "shims", "ais");
      writeFileSync(fakeAis, "#!/bin/sh\nexit 0\n");
      chmodSync(fakeAis, 0o755);
      const fakeCodex = join(home, "bin", "codex");
      writeFileSync(fakeCodex, "#!/bin/sh\necho FAKE_CODEX_RAN\n");
      chmodSync(fakeCodex, 0o755);
      childEnv.AI_PROFILE_SWITCHER_SHIM_DIR = join(home, "shims");
      childEnv.PATH = `${join(home, "bin")}:${childEnv.PATH ?? ""}`;

      const src = join(import.meta.dir, "..", "..", "src", "codex.ts");
      const proc = Bun.spawn([process.execPath, src, "--id=free"], {
        env: childEnv,
        stdout: "pipe",
        stderr: "pipe",
        cwd: home,
      });
      const timer = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("gate e2e allow child hung")), 30_000));
      const [stdout, exitCode] = await Promise.race([
        Promise.all([new Response(proc.stdout).text(), proc.exited]),
        timer,
      ]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("FAKE_CODEX_RAN");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
