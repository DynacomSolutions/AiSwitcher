import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookCommand } from "../../src/identities/claude-swap-hook.ts";
import { runClaudeSwapCommand } from "../../src/cli/claude-swap/dispatch.ts";
import { continuedSince, runContinuation, CONTINUE_TEXT } from "../../src/identities/claude-swap-continue.ts";
import { loadIdentitiesFile } from "../../src/identities/store.ts";
import { mergeIdentity } from "../../src/sync/registry.ts";

const dirs: string[] = [];
let root = "";
let registry = "";
let out: string[] = [];
const noEnv: Record<string, string> = {};
const deps = () => ({ env: noEnv, registryPath: registry, ledgerPath: join(root, "ledger.jsonl"), log: (l: string) => out.push(l), fetchUsage: async () => ({ status: "live" as const, fiveHour: { utilization: 12 }, sevenDay: { utilization: 30 }, maxUtilization: 30, capturedAt: "SYNTHETIC_FIXTURE" }) });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ais-cswap-cli-"));
  dirs.push(root);
  registry = join(root, "identities.json");
  out = [];
  for (const [n, rt] of [["a", "rt-a"], ["b", "rt-b"]] as const) {
    await mkdir(join(root, n), { recursive: true });
    await writeFile(join(root, n, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: `SYNTHETIC_FIXTURE_at-${n}`, refreshToken: `SYNTHETIC_FIXTURE_${rt}`, expiresAt: 4_000_000_000_000 } }));
    await writeFile(join(root, n, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: `SYNTHETIC_FIXTURE_u-${n}` } }));
  }
  await writeFile(registry, JSON.stringify({ version: 1, identities: [{ name: "a", label: "a", configDir: join(root, "a") }, { name: "b", label: "b", configDir: join(root, "b") }] }));
});
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

test("pool create, status, to, allow/disallow, auto", async () => {
  await runClaudeSwapCommand(["pool", "create", "shared"], { accounts: "a,b", "config-dir": join(root, "shared") }, deps());
  let file = await loadIdentitiesFile(registry);
  const pool = file.identities.find((i) => i.name === "shared")!;
  expect(pool.swapPool).toEqual({ accounts: ["a", "b"], active: "a" });
  expect(JSON.parse(await readFile(join(root, "shared", ".credentials.json"), "utf8")).claudeAiOauth.accessToken).toBe("SYNTHETIC_FIXTURE_at-a");

  out = [];
  await runClaudeSwapCommand(["status"], { json: true }, deps());
  const status = JSON.parse(out.join("\n"));
  expect(status.active).toBe("a");
  expect(status.accounts.map((r: { name: string }) => r.name)).toEqual(["a", "b"]);

  await runClaudeSwapCommand(["disallow", "b"], {}, deps());
  await expect(runClaudeSwapCommand(["to", "b"], {}, deps())).rejects.toThrow(/not allowed/);
  await runClaudeSwapCommand(["allow", "b"], {}, deps());
  await runClaudeSwapCommand(["to", "b"], {}, deps());
  await runClaudeSwapCommand(["next"], {}, deps());
  file = await loadIdentitiesFile(registry);
  expect(file.identities.find((i) => i.name === "shared")!.swapPool).toEqual({ accounts: ["a", "b"], active: "a" });

  await runClaudeSwapCommand(["auto", "on"], { threshold: "90" }, deps());
  file = await loadIdentitiesFile(registry);
  expect(file.identities.find((i) => i.name === "shared")!.swapPool).toMatchObject({ auto: true, thresholdPercent: 90 });
  await expect(runClaudeSwapCommand(["auto", "on"], { threshold: "500" }, deps())).rejects.toThrow();
});

test("pool create refuses unknown accounts and a reused configDir", async () => {
  await expect(runClaudeSwapCommand(["pool", "create", "p"], { accounts: "a,zzz" }, deps())).rejects.toThrow(/not an existing/);
  await expect(runClaudeSwapCommand(["pool", "create", "p"], { accounts: "a,b", "config-dir": join(root, "a") }, deps())).rejects.toThrow(/already used/);
});

// The assumed failure time is "now"; push it past the pool-create ledger event (same millisecond otherwise).
const afterLedger = () => Date.now() + 1_000;

test("recovery flags resolve by config directory and reject a stale expected active member", async () => {
  await runClaudeSwapCommand(["pool", "create", "shared"], { accounts: "a,b", "config-dir": join(root, "shared") }, deps());
  out = [];
  await runClaudeSwapCommand(["next"], {
    "config-dir": join(root, "shared"),
    "if-limited": true,
    "assume-limited": true,
    "expected-active": "b",
    json: true,
  }, { ...deps(), now: afterLedger });
  expect(JSON.parse(out.join("\n"))).toMatchObject({ action: "skipped", why: 'pool changed to "a" before limit recovery' });

  out = [];
  await runClaudeSwapCommand(["next"], {
    "config-dir": join(root, "shared"),
    "if-limited": true,
    "assume-limited": true,
    "expected-active": "a",
    json: true,
  }, {
    ...deps(),
    now: afterLedger,
    fetchUsage: async (member) => {
      const utilization = member.name === "a" ? 100 : 12;
      return { status: "live" as const, fiveHour: { utilization }, sevenDay: { utilization }, maxUtilization: utilization, capturedAt: "SYNTHETIC_FIXTURE" };
    },
  });
  expect(JSON.parse(out.join("\n"))).toMatchObject({ action: "swapped", result: { from: "a", to: "b" } });
});

test("a ledger swap since the failure is reported and prevents a second recovery rotation", async () => {
  await runClaudeSwapCommand(["pool", "create", "shared"], { accounts: "a,b", "config-dir": join(root, "shared") }, deps());
  const failureAtMs = Date.now() - 1_000;
  await runClaudeSwapCommand(["to", "b"], {}, deps());
  out = [];
  await runClaudeSwapCommand(["status"], { "config-dir": join(root, "shared"), json: true }, deps());
  expect(Date.parse(JSON.parse(out.join("\n")).lastSwapAt)).toBeGreaterThanOrEqual(failureAtMs);

  out = [];
  await runClaudeSwapCommand(["next"], {
    "config-dir": join(root, "shared"),
    "if-limited": true,
    "assume-limited": true,
    "failure-at-ms": String(failureAtMs),
    json: true,
  }, deps());
  expect(JSON.parse(out.join("\n"))).toMatchObject({ action: "skipped", why: "limit failure was already handled by a pool swap" });
  expect((await loadIdentitiesFile(registry)).identities.find((i) => i.name === "shared")?.swapPool?.active).toBe("b");
});

test("trust-limit-evidence reaches the pool core despite fresh live headroom", async () => {
  const baseDeps = deps();
  const fixtureDeps = { ...baseDeps, now: () => Date.now() };
  await runClaudeSwapCommand(["pool", "create", "shared"], { accounts: "a,b", "config-dir": join(root, "shared") }, fixtureDeps);
  const creationEvent = JSON.parse((await readFile(baseDeps.ledgerPath, "utf8")).trim());
  const afterCreation = Date.parse(creationEvent.ts) + 1;
  out = [];
  await runClaudeSwapCommand(["next"], {
    "config-dir": join(root, "shared"),
    "if-limited": true,
    "assume-limited": true,
    "trust-limit-evidence": true,
    json: true,
  }, {
    ...fixtureDeps,
    now: () => afterCreation,
    fetchUsage: async (member) => {
      const utilization = member.name === "a" ? 60 : 10;
      return { status: "live" as const, fiveHour: { utilization }, sevenDay: { utilization }, maxUtilization: utilization, capturedAt: "SYNTHETIC_FIXTURE" };
    },
  });
  expect(JSON.parse(out.join("\n"))).toMatchObject({ action: "swapped", result: { from: "a", to: "b" } });
});

test("sync merge carries swapPool and unions accounts", () => {
  const mk = (accounts: string[], extra = {}) => ({ name: "p", label: "p", configDir: "/x/p", swapPool: { accounts, ...extra } });
  const merged = mergeIdentity(mk(["a", "b"], { auto: true }), mk(["b", "c"], { active: "c" }));
  expect(merged.swapPool).toEqual({ accounts: ["a", "b", "c"], auto: true, active: "c" });
  const plain = { name: "q", label: "q", configDir: "/x/q" };
  expect(mergeIdentity(plain, mk(["a", "b"])).swapPool).toEqual({ accounts: ["a", "b"] });
});

test("hook on/off edits only its own StopFailure entry", async () => {
  await runClaudeSwapCommand(["pool", "create", "shared"], { accounts: "a,b", "config-dir": join(root, "shared") }, deps());
  const settingsPath = join(root, "shared", "settings.json");
  const before = JSON.parse(await readFile(settingsPath, "utf8"));
  await writeFile(settingsPath, JSON.stringify({ ...before, hooks: { StopFailure: [{ matcher: "x", hooks: [{ type: "command", command: "echo hi" }] }] } }));
  await runClaudeSwapCommand(["hook", "on"], {}, deps());
  let s = JSON.parse(await readFile(settingsPath, "utf8"));
  expect(s.hooks.StopFailure).toHaveLength(2);
  expect(s.hooks.StopFailure[1].hooks[0].command).toBe(hookCommand());
  expect(s.hooks.StopFailure[1].hooks[0].command).not.toContain("--pool");
  expect(s.hooks.StopFailure[1].hooks[0].command).not.toContain("--expected-active");
  await runClaudeSwapCommand(["hook", "off"], {}, deps());
  s = JSON.parse(await readFile(settingsPath, "utf8"));
  expect(s.hooks.StopFailure).toHaveLength(1);
  expect(s.hooks.StopFailure[0].hooks[0].command).toBe("echo hi");
});

test("hookCommand carries no pool name and hook on migrates an old --pool= hook in place", async () => {
  expect(hookCommand()).toBe('ais claude-swap next --if-limited --assume-limited --reason=auto --config-dir="$CLAUDE_CONFIG_DIR"');
  await runClaudeSwapCommand(["pool", "create", "shared"], { accounts: "a,b", "config-dir": join(root, "shared") }, deps());
  const settingsPath = join(root, "shared", "settings.json");
  const old = "ais claude-swap next --if-limited --assume-limited --reason=auto --pool=shared";
  await writeFile(settingsPath, JSON.stringify({ hooks: { StopFailure: [{ matcher: "rate_limit", hooks: [{ type: "command", command: old }] }] } }));
  await runClaudeSwapCommand(["hook", "on"], { pool: "shared" }, deps());
  const s = JSON.parse(await readFile(settingsPath, "utf8"));
  expect(s.hooks.StopFailure).toHaveLength(1);
  expect(s.hooks.StopFailure[0].hooks[0].command).toBe(hookCommand());
});

test("next/status --config-dir picks the matching pool among several, tolerating a trailing slash", async () => {
  await runClaudeSwapCommand(["pool", "create", "one"], { accounts: "a,b", "config-dir": join(root, "one") }, deps());
  await runClaudeSwapCommand(["pool", "create", "two"], { accounts: "a,b", "config-dir": join(root, "two") }, deps());
  await runClaudeSwapCommand(["to", "b"], { pool: "two" }, deps());
  out = [];
  await runClaudeSwapCommand(["status"], { "config-dir": `${join(root, "two")}/`, json: true }, deps());
  expect(JSON.parse(out.join("\n")).active).toBe("b");
  out = [];
  await runClaudeSwapCommand(["status"], { "config-dir": join(root, "one"), json: true }, deps());
  expect(JSON.parse(out.join("\n")).active).toBe("a");
  await expect(runClaudeSwapCommand(["status"], { "config-dir": join(root, "none") }, deps())).rejects.toThrow(/No unique/);
  await expect(runClaudeSwapCommand(["next"], { "config-dir": "" }, deps())).rejects.toThrow(/--config-dir is empty/);
});

const T0 = Date.parse("2026-10-19T10:00:00Z");
const line = (o: object) => JSON.stringify(o);
const failure = line({ type: "assistant", isApiErrorMessage: true, timestamp: "2026-10-19T10:00:00Z" });

test("continuedSince: real user prompt or assistant turn after the failure counts, tool results and errors do not", () => {
  const later = "2026-10-19T10:01:00Z";
  expect(continuedSince(failure, T0)).toBe(false);
  expect(continuedSince(line({ type: "user", timestamp: later, message: { content: [{ type: "tool_result" }] } }), T0)).toBe(false);
  expect(continuedSince(line({ type: "user", timestamp: later, message: { content: "go" } }), T0)).toBe(true);
  expect(continuedSince(line({ type: "assistant", timestamp: later }), T0)).toBe(true);
  expect(continuedSince(line({ type: "user", timestamp: "2026-10-19T09:00:00Z", message: { content: "old" } }), T0)).toBe(false);
});

test("runContinuation sends once, skips when the transcript moved on", async () => {
  const calls: string[][] = [];
  const mk = (transcript: string, slept: number[] = []) => ({
    sleep: async (ms: number) => { slept.push(ms); },
    readTranscript: async () => transcript,
    herdr: async (a: string[]) => { calls.push(a); return 0; },
    stateDir: root,
    delayMs: 90_000,
  });
  const req = { paneId: "p1", transcriptPath: "t", sessionId: "s1", failureAtMs: T0 };
  expect(await runContinuation(req, mk(line({ type: "user", timestamp: "2026-10-19T10:01:00Z", message: { content: "hi" } })))).toBe("already-continued");
  expect(calls).toEqual([]);
  const slept: number[] = [];
  expect(await runContinuation(req, mk(failure, slept))).toBe("sent");
  expect(slept).toEqual([90_000]);
  expect(calls).toEqual([["pane", "send-text", "p1", CONTINUE_TEXT], ["pane", "send-keys", "p1", "Enter"]]);
  expect(await runContinuation(req, mk(failure))).toBe("already-sent");
  expect(calls).toHaveLength(2);
});

test("hook swap schedules the continuation only with a pane, a transcript and a session", async () => {
  await runClaudeSwapCommand(["pool", "create", "shared"], { accounts: "a,b", "config-dir": join(root, "shared") }, deps());
  const stdin = JSON.stringify({ session_id: "s1", transcript_path: "/t.jsonl" });
  const spawned: unknown[] = [];
  const base = {
    ...deps(),
    now: afterLedger,
    fetchUsage: async (m: { name: string }) => ({ status: "live" as const, fiveHour: { utilization: m.name === "a" ? 60 : 10 }, sevenDay: { utilization: 10 }, maxUtilization: m.name === "a" ? 60 : 10, capturedAt: "SYNTHETIC_FIXTURE" }),
    readHookStdin: async () => stdin,
    spawnContinuation: (r: unknown) => { spawned.push(r); },
  };
  const env = { AIS_HERDR_BIN: process.execPath };
  const flags = { "config-dir": join(root, "shared"), "if-limited": true, "assume-limited": true, "trust-limit-evidence": true, reason: "auto", json: true } as Record<string, string | true>;
  const failureAt = String(Date.now());

  await runClaudeSwapCommand(["next"], flags, { ...base, env }); // swaps a -> b, no pane
  expect(spawned).toEqual([]);

  // Later hook runs for the same failure see the swap as already recorded, which still counts as handled.
  const again = { ...flags, "failure-at-ms": failureAt };
  await runClaudeSwapCommand(["next"], again, { ...base, env: { ...env, HERDR_PANE_ID: "p9" }, readHookStdin: async () => "not json" });
  expect(spawned).toEqual([]);
  await runClaudeSwapCommand(["next"], again, { ...base, env: { ...env, HERDR_PANE_ID: "p9" } });
  expect(spawned).toMatchObject([{ paneId: "p9", transcriptPath: "/t.jsonl", sessionId: "s1" }]);
});
