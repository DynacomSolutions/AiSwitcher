import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runClaudeSwapCommand } from "../../src/cli/claude-swap/dispatch.ts";
import { loadIdentitiesFile } from "../../src/identities/store.ts";
import { mergeIdentity } from "../../src/sync/registry.ts";

const dirs: string[] = [];
let root = "";
let registry = "";
let out: string[] = [];
const deps = () => ({ registryPath: registry, ledgerPath: join(root, "ledger.jsonl"), log: (l: string) => out.push(l), fetchUsage: async () => ({ status: "live" as const, fiveHour: { utilization: 12 }, sevenDay: { utilization: 30 }, maxUtilization: 30, capturedAt: "x" }) });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ais-cswap-cli-"));
  dirs.push(root);
  registry = join(root, "identities.json");
  out = [];
  for (const [n, rt] of [["a", "rt-a"], ["b", "rt-b"]] as const) {
    await mkdir(join(root, n), { recursive: true });
    await writeFile(join(root, n, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: `at-${n}`, refreshToken: rt, expiresAt: 4_000_000_000_000 } }));
    await writeFile(join(root, n, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: `u-${n}` } }));
  }
  await writeFile(registry, JSON.stringify({ version: 1, identities: [{ name: "a", label: "a", configDir: join(root, "a") }, { name: "b", label: "b", configDir: join(root, "b") }] }));
});
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

test("pool create, status, to, allow/disallow, auto", async () => {
  await runClaudeSwapCommand(["pool", "create", "shared"], { accounts: "a,b", "config-dir": join(root, "shared") }, deps());
  let file = await loadIdentitiesFile(registry);
  const pool = file.identities.find((i) => i.name === "shared")!;
  expect(pool.swapPool).toEqual({ accounts: ["a", "b"], active: "a" });
  expect(JSON.parse(await readFile(join(root, "shared", ".credentials.json"), "utf8")).claudeAiOauth.accessToken).toBe("at-a");

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
  expect(s.hooks.StopFailure[1].hooks[0].command).toContain("next --if-limited --assume-limited --reason=auto --pool=shared");
  await runClaudeSwapCommand(["hook", "off"], {}, deps());
  s = JSON.parse(await readFile(settingsPath, "utf8"));
  expect(s.hooks.StopFailure).toHaveLength(1);
  expect(s.hooks.StopFailure[0].hooks[0].command).toBe("echo hi");
});
