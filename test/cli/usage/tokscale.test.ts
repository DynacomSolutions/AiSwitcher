import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeZaiAuthFile } from "../../../src/identities/zai-auth.ts";
import { buildMergedEnv, dailyUsageFromHourlyEntries, tokscaleInvocationFor } from "../../../src/cli/usage/tokscale.ts";
import type { Identity } from "../../../src/identities/types.ts";

function identity(configDir: string): Identity {
  return { name: "identity-a", label: "Identity A", configDir };
}

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeConfigDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ais-tokscale-test-"));
  tempDirs.push(dir);
  return dir;
}

describe("tokscaleInvocationFor", () => {
  test("codex: sets CODEX_HOME to the identity's configDir", async () => {
    const { env, clientArgs } = (await tokscaleInvocationFor(
      "codex",
      identity("/Users/alice/.codex/identities/identity-a"),
    ))!;
    expect(env).toEqual({ CODEX_HOME: "/Users/alice/.codex/identities/identity-a" });
    expect(clientArgs).toEqual(["--client", "codex"]);
  });

  test("grok: sets GROK_HOME to the identity's configDir", async () => {
    const { env, clientArgs } = (await tokscaleInvocationFor(
      "grok",
      identity("/Users/alice/.grok/identities/identity-a"),
    ))!;
    expect(env).toEqual({ GROK_HOME: "/Users/alice/.grok/identities/identity-a" });
    expect(clientArgs).toEqual(["--client", "grok"]);
  });

  test("kimi: sets KIMI_CODE_HOME to the identity's configDir", async () => {
    const { env, clientArgs } = (await tokscaleInvocationFor(
      "kimi",
      identity("/Users/alice/.kimi-code/identities/identity-a"),
    ))!;
    expect(env).toEqual({ KIMI_CODE_HOME: "/Users/alice/.kimi-code/identities/identity-a" });
    expect(clientArgs).toEqual(["--client", "kimi"]);
  });

  test("claude: sets TOKSCALE_EXTRA_DIRS to <configDir>/projects, prefixed with the client id", async () => {
    const { env, clientArgs } = (await tokscaleInvocationFor(
      "claude",
      identity("/Users/alice/.claude/identities/identity-a"),
    ))!;
    expect(env).toEqual({ TOKSCALE_EXTRA_DIRS: "claude:/Users/alice/.claude/identities/identity-a/projects" });
    expect(clientArgs).toEqual(["--client", "claude"]);
  });

  test("opencode: points XDG_DATA_HOME at the identity's data subdir — the root tokscale's opencode client resolves through", async () => {
    const { env, clientArgs } = (await tokscaleInvocationFor(
      "opencode",
      identity("/Users/alice/.opencode/identities/identity-a"),
    ))!;
    expect(env).toEqual({ XDG_DATA_HOME: "/Users/alice/.opencode/identities/identity-a/data" });
    expect(clientArgs).toEqual(["--client", "opencode"]);
  });

  test("zai: sets ZAI_API_KEY from the identity's own crush.json, not a directory scan, and no --client (never a valid value for zai)", async () => {
    const configDir = await makeConfigDir();
    await writeZaiAuthFile(configDir, "sk-zai-key");
    const { env, clientArgs } = (await tokscaleInvocationFor("zai", identity(configDir)))!;
    expect(env).toEqual({ ZAI_API_KEY: "sk-zai-key" });
    expect(clientArgs).toEqual([]);
  });

  test("zai: returns undefined (not supported) when the identity has no usable key yet", async () => {
    const configDir = await makeConfigDir();
    expect(await tokscaleInvocationFor("zai", identity(configDir))).toBeUndefined();
  });

  test("ali: always returns undefined (no tokscale client, no live quota API to key off either)", async () => {
    const configDir = await makeConfigDir();
    expect(await tokscaleInvocationFor("ali", identity(configDir))).toBeUndefined();
  });

  test("pi: returns undefined because AIS reads Pi's provider-tagged JSONL directly", async () => {
    expect(await tokscaleInvocationFor("pi", identity("/Users/alice/.pi/identities/all"))).toBeUndefined();
  });
});

describe("buildMergedEnv", () => {
  test("merges claude/codex/grok/kimi extra-dir entries into one comma-separated TOKSCALE_EXTRA_DIRS", async () => {
    const env = await buildMergedEnv([
      { toolName: "claude", identity: identity("/Users/alice/.claude/identities/a") },
      { toolName: "codex", identity: identity("/Users/alice/.codex/identities/b") },
    ]);
    expect(env.TOKSCALE_EXTRA_DIRS).toBe(
      "claude:/Users/alice/.claude/identities/a/projects,codex:/Users/alice/.codex/identities/b/sessions",
    );
    expect(env.ZAI_API_KEY).toBeUndefined();
  });

  test("includes ZAI_API_KEY when exactly one zai target has a usable key", async () => {
    const configDir = await makeConfigDir();
    await writeZaiAuthFile(configDir, "sk-only-zai");
    const env = await buildMergedEnv([{ toolName: "zai", identity: identity(configDir) }]);
    expect(env.ZAI_API_KEY).toBe("sk-only-zai");
  });

  test("drops zai from the merge (no ZAI_API_KEY at all) when more than one zai identity is targeted", async () => {
    const configDirA = await makeConfigDir();
    const configDirB = await makeConfigDir();
    await writeZaiAuthFile(configDirA, "sk-a");
    await writeZaiAuthFile(configDirB, "sk-b");
    const env = await buildMergedEnv([
      { toolName: "zai", identity: identity(configDirA) },
      { toolName: "zai", identity: identity(configDirB) },
    ]);
    expect(env.ZAI_API_KEY).toBeUndefined();
  });

  test("includes XDG_DATA_HOME when exactly one opencode target is in the set", async () => {
    const env = await buildMergedEnv([{ toolName: "opencode", identity: identity("/Users/alice/.opencode/identities/a") }]);
    expect(env.XDG_DATA_HOME).toBe("/Users/alice/.opencode/identities/a/data");
  });

  test("drops opencode from the merge when more than one opencode identity is targeted (one XDG_DATA_HOME can only point at one data root)", async () => {
    const env = await buildMergedEnv([
      { toolName: "opencode", identity: identity("/Users/alice/.opencode/identities/a") },
      { toolName: "opencode", identity: identity("/Users/alice/.opencode/identities/b") },
    ]);
    expect(env.XDG_DATA_HOME).toBeUndefined();
  });
});

describe("dailyUsageFromHourlyEntries", () => {
  test("no entries at all yields undefined", () => {
    expect(dailyUsageFromHourlyEntries([])).toBeUndefined();
  });

  test("rolls hour buckets up into a per-day total (input+output), keyed by the date portion of the bucket", () => {
    const result = dailyUsageFromHourlyEntries([
      { hour: "2026-03-10 09:00", input: 100, output: 20 },
      { hour: "2026-03-10 14:00", input: 50, output: 10 },
      { hour: "2026-03-11 08:00", input: 200, output: 5 },
    ]);
    expect(result?.daily).toEqual({ "2026-03-10": 180, "2026-03-11": 205 });
  });

  test("dateSpan is the min/max of every bucket's parsed local timestamp", () => {
    const result = dailyUsageFromHourlyEntries([
      { hour: "2026-03-10 14:00", input: 1, output: 0 },
      { hour: "2026-03-10 09:00", input: 1, output: 0 },
      { hour: "2026-03-12 23:00", input: 1, output: 0 },
    ]);
    expect(result?.dateSpan.firstMs).toBe(new Date("2026-03-10T09:00:00").getTime());
    expect(result?.dateSpan.lastMs).toBe(new Date("2026-03-12T23:00:00").getTime());
  });

  test("a bucket with an unparseable hour string is skipped, not fatal to the rest", () => {
    const result = dailyUsageFromHourlyEntries([
      { hour: "not-a-date", input: 999, output: 999 },
      { hour: "2026-03-10 09:00", input: 5, output: 5 },
    ]);
    expect(result?.daily).toEqual({ "2026-03-10": 10 });
  });
});
