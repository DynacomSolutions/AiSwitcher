import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeZaiAuthFile } from "../../../src/identities/zai-auth.ts";
import {
  buildMergedEnv,
  dailyUsageFromHourlyEntries,
  findCachedTokscaleBinary,
  shouldRefreshTokscaleCache,
  tokscaleInvocationFor,
  tokscalePlatformVariants,
  tokscaleRefreshIntervalMs,
  tokscaleSpawnTimeoutMs,
  tokscaleTimeoutMessage,
  DEFAULT_TOKSCALE_SPAWN_TIMEOUT_MS,
} from "../../../src/cli/usage/tokscale.ts";
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

describe("tokscalePlatformVariants (native-binary cache resolution)", () => {
  test("darwin has no libc suffix at all — the previous bug appended one unconditionally", () => {
    expect(tokscalePlatformVariants("darwin", "arm64")).toEqual(["cli-darwin-arm64"]);
    expect(tokscalePlatformVariants("darwin", "x64")).toEqual(["cli-darwin-x64"]);
  });

  test("win32 uses -msvc, not -gnu/-musl", () => {
    expect(tokscalePlatformVariants("win32", "x64")).toEqual(["cli-win32-x64-msvc"]);
  });

  test("linux tries the glibc variant before the musl one", () => {
    expect(tokscalePlatformVariants("linux", "x64")).toEqual(["cli-linux-x64-gnu", "cli-linux-x64-musl"]);
    expect(tokscalePlatformVariants("linux", "arm64")).toEqual(["cli-linux-arm64-gnu", "cli-linux-arm64-musl"]);
  });
});

describe("findCachedTokscaleBinary (prefers the cached native binary over bunx)", () => {
  const tempDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function fakeCacheRoot(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "ais-tokscale-cache-"));
    tempDirs.push(dir);
    return dir;
  }

  /** A tiny real executable that answers `--version` successfully, standing
   * in for the real native tokscale binary tokscale's optional-dep package
   * ships. */
  async function writeFakeBinary(path: string): Promise<void> {
    await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await writeFile(path, "#!/bin/sh\nexit 0\n");
    await chmod(path, 0o755);
  }

  test("darwin: finds the cached cli-darwin-<arch> binary with no libc suffix", async () => {
    const cacheRoot = await fakeCacheRoot();
    await writeFakeBinary(join(cacheRoot, "cli-darwin-arm64", "4.17.0@@@1", "bin", "tokscale"));
    const found = findCachedTokscaleBinary({ cacheRoot, platform: "darwin", arch: "arm64" });
    expect(found).toEqual([join(cacheRoot, "cli-darwin-arm64", "4.17.0@@@1", "bin", "tokscale")]);
  });

  test("darwin: a cache shaped like the OLD (buggy) -gnu/-musl variant names is never matched (regression guard)", async () => {
    const cacheRoot = await fakeCacheRoot();
    // Only a wrongly-libc-suffixed directory exists - what the OLD variant
    // list (unconditional -gnu/-musl) would have looked for and, on a real
    // machine, never found either (npm never ships that package name for
    // darwin at all). The real, correctly-shaped darwin package is absent
    // here on purpose.
    await writeFakeBinary(join(cacheRoot, "cli-darwin-arm64-gnu", "4.17.0@@@1", "bin", "tokscale"));
    expect(findCachedTokscaleBinary({ cacheRoot, platform: "darwin", arch: "arm64" })).toBeUndefined();
  });

  test("picks the newest semver-sorted cached version when several are present", async () => {
    const cacheRoot = await fakeCacheRoot();
    await writeFakeBinary(join(cacheRoot, "cli-linux-x64-gnu", "4.9.0@@@1", "bin", "tokscale"));
    await writeFakeBinary(join(cacheRoot, "cli-linux-x64-gnu", "4.17.0@@@1", "bin", "tokscale"));
    await writeFakeBinary(join(cacheRoot, "cli-linux-x64-gnu", "4.12.0@@@1", "bin", "tokscale"));
    const found = findCachedTokscaleBinary({ cacheRoot, platform: "linux", arch: "x64" });
    expect(found).toEqual([join(cacheRoot, "cli-linux-x64-gnu", "4.17.0@@@1", "bin", "tokscale")]);
  });

  test("falls through gnu -> musl, and to undefined (bunx fallback) when nothing is cached", async () => {
    const cacheRoot = await fakeCacheRoot();
    await writeFakeBinary(join(cacheRoot, "cli-linux-x64-musl", "4.5.0@@@1", "bin", "tokscale"));
    const found = findCachedTokscaleBinary({ cacheRoot, platform: "linux", arch: "x64" });
    expect(found).toEqual([join(cacheRoot, "cli-linux-x64-musl", "4.5.0@@@1", "bin", "tokscale")]);

    expect(findCachedTokscaleBinary({ cacheRoot: await fakeCacheRoot(), platform: "linux", arch: "x64" })).toBeUndefined();
  });

  test("a real symlinked bin directory (the actual bun cache layout) resolves fine", async () => {
    const cacheRoot = await fakeCacheRoot();
    const real = join(cacheRoot, "cli-linux-x64-gnu@4.17.0@@@1");
    await writeFakeBinary(join(real, "bin", "tokscale"));
    await mkdir(join(cacheRoot, "cli-linux-x64-gnu"), { recursive: true });
    await symlink(real, join(cacheRoot, "cli-linux-x64-gnu", "4.17.0@@@1"));
    const found = findCachedTokscaleBinary({ cacheRoot, platform: "linux", arch: "x64" });
    expect(found).toEqual([join(cacheRoot, "cli-linux-x64-gnu", "4.17.0@@@1", "bin", "tokscale")]);
  });

  test("a cache entry that exists but cannot execute (wrong libc / corrupt download) is skipped", async () => {
    const cacheRoot = await fakeCacheRoot();
    const badBin = join(cacheRoot, "cli-linux-x64-gnu", "4.17.0@@@1", "bin", "tokscale");
    await mkdir(badBin.slice(0, badBin.lastIndexOf("/")), { recursive: true });
    await writeFile(badBin, "#!/bin/sh\nexit 1\n");
    await chmod(badBin, 0o755);
    expect(findCachedTokscaleBinary({ cacheRoot, platform: "linux", arch: "x64" })).toBeUndefined();
  });
});

describe("shouldRefreshTokscaleCache / tokscaleRefreshIntervalMs (never re-run --version per scan)", () => {
  test("no prior refresh timestamp always refreshes (genuine cold start)", () => {
    expect(shouldRefreshTokscaleCache(undefined, Date.now(), 60_000)).toBe(true);
  });

  test("within the interval: no refresh needed", () => {
    const now = 1_000_000;
    expect(shouldRefreshTokscaleCache(now - 1_000, now, 60_000)).toBe(false);
  });

  test("interval elapsed: refresh again", () => {
    const now = 1_000_000;
    expect(shouldRefreshTokscaleCache(now - 60_000, now, 60_000)).toBe(true);
  });

  test("tokscaleRefreshIntervalMs defaults to 24h and honours the env override", () => {
    const original = process.env.AIS_TOKSCALE_REFRESH_INTERVAL_MS;
    try {
      delete process.env.AIS_TOKSCALE_REFRESH_INTERVAL_MS;
      expect(tokscaleRefreshIntervalMs()).toBe(24 * 60 * 60 * 1000);
      process.env.AIS_TOKSCALE_REFRESH_INTERVAL_MS = "5000";
      expect(tokscaleRefreshIntervalMs()).toBe(5000);
      process.env.AIS_TOKSCALE_REFRESH_INTERVAL_MS = "not-a-number";
      expect(tokscaleRefreshIntervalMs()).toBe(24 * 60 * 60 * 1000);
    } finally {
      if (original === undefined) delete process.env.AIS_TOKSCALE_REFRESH_INTERVAL_MS;
      else process.env.AIS_TOKSCALE_REFRESH_INTERVAL_MS = original;
    }
  });
});

describe("tokscaleSpawnTimeoutMs", () => {
  const saved = process.env.AIS_TOKSCALE_TIMEOUT_MS;
  afterEach(() => {
    if (saved === undefined) delete process.env.AIS_TOKSCALE_TIMEOUT_MS;
    else process.env.AIS_TOKSCALE_TIMEOUT_MS = saved;
  });

  test("defaults to 10 minutes when unset", () => {
    delete process.env.AIS_TOKSCALE_TIMEOUT_MS;
    expect(tokscaleSpawnTimeoutMs()).toBe(600_000);
    expect(DEFAULT_TOKSCALE_SPAWN_TIMEOUT_MS).toBe(600_000);
  });

  test("honours a valid positive integer override at call time", () => {
    process.env.AIS_TOKSCALE_TIMEOUT_MS = "1800000";
    expect(tokscaleSpawnTimeoutMs()).toBe(1_800_000);
    process.env.AIS_TOKSCALE_TIMEOUT_MS = " 5000 ";
    expect(tokscaleSpawnTimeoutMs()).toBe(5000);
  });

  test("falls back to the default for empty or invalid values", () => {
    for (const bad of ["", "   ", "abc", "0", "-5", "1.5", "1e3", "12abc", "NaN", "99999999999999999999"]) {
      process.env.AIS_TOKSCALE_TIMEOUT_MS = bad;
      expect(tokscaleSpawnTimeoutMs()).toBe(DEFAULT_TOKSCALE_SPAWN_TIMEOUT_MS);
    }
  });
});

describe("tokscaleTimeoutMessage", () => {
  test("states the limit and names the env var", () => {
    const message = tokscaleTimeoutMessage("/bin/tokscale", 600_000);
    expect(message).toContain("/bin/tokscale timed out after 600s");
    expect(message).toContain("AIS_TOKSCALE_TIMEOUT_MS");
  });
});
