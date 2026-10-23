import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { writeZaiAuthFile } from "../../../src/identities/zai-auth.ts";
import { defaultOpencodeProfileDbPath } from "../../../src/cli/usage/opencode-usage.ts";
import {
  buildMergedEnv,
  dailyUsageFromHourlyEntries,
  findCachedTokscaleBinary,
  prepareMergedPassthrough,
  shouldRefreshTokscaleCache,
  tokscaleInvocationFor,
  tokscalePlatformVariants,
  tokscaleRefreshIntervalMs,
  tokscaleSpawnTimeoutMs,
  tokscaleTimeoutMessage,
  DEFAULT_TOKSCALE_SPAWN_TIMEOUT_MS,
  runAisTokscaleExportInvocation,
  spawnTokscaleProcess,
  terminateTokscaleProcess,
  withTokscaleProcessSlot,
} from "../../../src/cli/usage/tokscale.ts";
import type { Identity } from "../../../src/identities/types.ts";

function identity(configDir: string): Identity {
  return { name: "identity-a", label: "Identity A", configDir };
}

describe("tokscale process bounds", () => {
  test("serializes every process slot", async () => {
    let active = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 5 }, (_, i) => withTokscaleProcessSlot(async () => {
      active++;
      peak = Math.max(peak, active);
      await Bun.sleep(10);
      active--;
      return i;
    })));
    expect(peak).toBe(1);
  });

  test("native export invocations share the bounded tokscale process slot", async () => {
    if (process.platform !== "linux") return;
    const dir = await makeConfigDir();
    const events = join(dir, "events.log");
    const command = join(dir, "fake-tokscale");
    await writeFile(command, `#!/bin/sh\nprintf 'start\\n' >> '${events}'\nsleep 0.1\nprintf 'end\\n' >> '${events}'\nprintf '{}\\n'\n`);
    await chmod(command, 0o700);
    const invocation = { command, args: [], env: {}, cwd: dir };
    const output = await Promise.all([
      runAisTokscaleExportInvocation(invocation),
      runAisTokscaleExportInvocation(invocation),
    ]);
    expect(output).toEqual(["{}\n", "{}\n"]);
    expect((await readFile(events, "utf8")).trim().split("\n")).toEqual(["start", "end", "start", "end"]);
  });

  test("does not release a slot while a descendant survives its leader", async () => {
    if (!Bun.which("setsid") || !Bun.which("sh") || process.platform !== "linux") return;
    const proc = Bun.spawn(["setsid", "sh", "-c", "(trap '' TERM; exec sleep 30) >/dev/null 2>&1 & echo $!; exit 0"], {
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const childPid = Number.parseInt((await new Response(proc.stdout).text()).trim(), 10);
    await proc.exited;
    const order: string[] = [];
    const first = withTokscaleProcessSlot(async () => {
      await terminateTokscaleProcess(proc, true);
      order.push("cleaned");
    });
    const second = withTokscaleProcessSlot(async () => {
      const stat = await Bun.file(`/proc/${childPid}/stat`).text().catch(() => undefined);
      const state = stat?.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
      expect(state === undefined || /^[ZX]$/.test(state)).toBe(true);
      order.push("next");
    });
    await Promise.all([first, second]);
    expect(order).toEqual(["cleaned", "next"]);
    const stat = await Bun.file(`/proc/${childPid}/stat`).text().catch(() => undefined);
    const state = stat?.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
    expect(state === undefined || /^[ZX]$/.test(state)).toBe(true);
  }, 5000);

  test("warm-up timeout kills its child tree before rejecting", async () => {
    if (!Bun.which("sh") || process.platform !== "linux") return;
    const dir = await makeConfigDir();
    const pidFile = join(dir, "child.pid");
    const script = `trap '' TERM; (trap '' TERM; exec sleep 30) & echo $! > '${pidFile}'; wait`;
    await expect(spawnTokscaleProcess("sh", ["-c", script], [], {}, 100)).rejects.toThrow("timed out");
    const childPid = Number.parseInt((await Bun.file(pidFile).text()).trim(), 10);
    const stat = await Bun.file(`/proc/${childPid}/stat`).text().catch(() => undefined);
    const state = stat?.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
    expect(state === undefined || /^[ZX]$/.test(state)).toBe(true);
  }, 5000);

  test("normal tokscale completion still reaps a child after its leader exits", async () => {
    if (!Bun.which("sh") || process.platform !== "linux") return;
    const dir = await makeConfigDir();
    const pidFile = join(dir, "child.pid");
    const script = `(trap '' TERM; exec sleep 30) >/dev/null 2>&1 & echo $! > '${pidFile}'; sleep 0.1; printf ok`;
    await expect(spawnTokscaleProcess("sh", ["-c", script], [], {}, 2_000)).resolves.toBe("ok");
    const childPid = Number.parseInt((await Bun.file(pidFile).text()).trim(), 10);
    const stat = await Bun.file(`/proc/${childPid}/stat`).text().catch(() => undefined);
    const state = stat?.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
    expect(state === undefined || /^[ZX]$/.test(state)).toBe(true);
  }, 5000);
});

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

  test("claude: sets CLAUDE_CONFIG_DIR (replacing the default root) and no additive extra dir", async () => {
    const { env, clientArgs } = (await tokscaleInvocationFor(
      "claude",
      identity("/home/user/.claude/identities/identity-a"),
    ))!;
    expect(env).toEqual({ CLAUDE_CONFIG_DIR: "/home/user/.claude/identities/identity-a" });
    expect(clientArgs).toEqual(["--client", "claude"]);
  });

  test("claude: the child env overrides an inherited CLAUDE_CONFIG_DIR and never depends on HOME", async () => {
    const saved = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = "/home/user/.claude/identities/swap";
    try {
      const { env } = (await tokscaleInvocationFor("claude", identity("/x/identity-a")))!;
      const child = { ...process.env, ...env };
      expect(child.CLAUDE_CONFIG_DIR).toBe("/x/identity-a");
      expect(env.TOKSCALE_EXTRA_DIRS).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = saved;
    }
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

  test("zai: a retired identity is not supported (no live quota call), even if a key file lingers", async () => {
    const configDir = await makeConfigDir();
    await writeZaiAuthFile(configDir, "sk-zai-key");
    const invocation = await tokscaleInvocationFor("zai", { ...identity(configDir), retired: true });
    expect(invocation).toBeUndefined();
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

  test("redirects every default scan root to one empty path so $HOME's own sessions never leak in", async () => {
    const env = await buildMergedEnv([{ toolName: "claude", identity: identity("/home/user/.claude/identities/a") }]);
    const empty = env.CLAUDE_CONFIG_DIR!;
    expect(empty).toContain("no-default-scan");
    expect([env.CODEX_HOME, env.GROK_HOME, env.KIMI_CODE_HOME]).toEqual([empty, empty, empty]);
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

  test("prepares Tokscale settings with configured OpenCode DB paths and preserves user config state by symlink", async () => {
    const sourceConfigDir = await makeConfigDir();
    const overlayConfigDir = await makeConfigDir();
    await writeFile(join(sourceConfigDir, "settings.json"), JSON.stringify({
      tuiLanguage: "en",
      scanner: {
        opencodeDbPaths: ["/shared/opencode.db"],
        extraScanPaths: { opencode: ["/shared/opencode/storage/message"] },
        bucketTimezone: "Asia/Bangkok",
      },
    }));
    await mkdir(join(sourceConfigDir, "cache"));
    await writeFile(join(sourceConfigDir, "credentials.json"), "credential fixture");
    await writeFile(join(sourceConfigDir, "private-user-file.json"), "must not be linked");
    await symlink("/stale/tokscale-cache", join(overlayConfigDir, "warp-cache"), "dir");

    const env = await buildMergedEnv([
      { toolName: "opencode", identity: identity("/home/user/.opencode/identities/a") },
      { toolName: "opencode", identity: identity("/home/user/.opencode/identities/b") },
    ], { sourceConfigDir, overlayConfigDir });

    expect(env.TOKSCALE_CONFIG_DIR).toBe(overlayConfigDir);
    expect(env.XDG_DATA_HOME).toContain("no-default-scan");
    const overlaySettings = JSON.parse(await readFile(join(overlayConfigDir, "settings.json"), "utf8"));
    expect(overlaySettings.tuiLanguage).toBe("en");
    expect(overlaySettings.scanner.bucketTimezone).toBe("Asia/Bangkok");
    expect(overlaySettings.scanner.opencodeDbPaths).toEqual([
      "/shared/opencode.db",
      "/home/user/.opencode/identities/a/data/opencode/opencode.db",
      "/home/user/.opencode/identities/b/data/opencode/opencode.db",
    ]);
    expect(overlaySettings.scanner.extraScanPaths.opencode).toEqual([
      "/shared/opencode/storage/message",
      "/home/user/.opencode/identities/a/data/opencode/storage/message",
      "/home/user/.opencode/identities/b/data/opencode/storage/message",
    ]);
    expect(await readFile(join(sourceConfigDir, "settings.json"), "utf8")).toContain("/shared/opencode.db");
    expect((await Bun.file(join(overlayConfigDir, "cache")).stat()).isDirectory()).toBe(true);
    expect(await readFile(join(overlayConfigDir, "credentials.json"), "utf8")).toBe("credential fixture");
    expect(await readlink(join(overlayConfigDir, "credentials.json"))).toBe(join(sourceConfigDir, "credentials.json"));
    expect(await readlink(join(overlayConfigDir, "cache"))).toBe(join(sourceConfigDir, "cache"));
    expect(await readlink(join(overlayConfigDir, "warp-cache"))).toBe(join(sourceConfigDir, "warp-cache"));
    expect(await Bun.file(join(overlayConfigDir, "private-user-file.json")).exists()).toBe(false);
  });

  test("uses the Tokscale config below an existing XDG_CONFIG_HOME and retains overlay settings", async () => {
    const xdgConfigHome = await makeConfigDir();
    const sourceConfigDir = join(xdgConfigHome, "tokscale");
    const overlayConfigDir = await makeConfigDir();
    await mkdir(sourceConfigDir);
    await writeFile(join(sourceConfigDir, "settings.json"), JSON.stringify({ tuiLanguage: "en" }));
    const oldXdg = process.env.XDG_CONFIG_HOME;
    const oldTokscale = process.env.TOKSCALE_CONFIG_DIR;
    process.env.XDG_CONFIG_HOME = xdgConfigHome;
    delete process.env.TOKSCALE_CONFIG_DIR;
    try {
      const target = [{ toolName: "opencode", identity: identity("/identity/a") }];
      await buildMergedEnv(target, { overlayConfigDir });
      const settingsPath = join(overlayConfigDir, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8"));
      settings.tuiLanguage = "fr";
      await writeFile(settingsPath, JSON.stringify(settings));
      await buildMergedEnv(target, { overlayConfigDir });
      const retained = JSON.parse(await readFile(settingsPath, "utf8"));
      expect(retained.tuiLanguage).toBe("fr");
      expect(retained.scanner.opencodeDbPaths).toEqual(["/identity/a/data/opencode/opencode.db"]);
    expect(retained.scanner.extraScanPaths.opencode).toEqual(["/identity/a/data/opencode/storage/message"]);
    } finally {
      if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = oldXdg;
      if (oldTokscale === undefined) delete process.env.TOKSCALE_CONFIG_DIR;
      else process.env.TOKSCALE_CONFIG_DIR = oldTokscale;
    }
  });

  test("creates the overlay when Tokscale has no source config yet", async () => {
    const missingSourceConfig = join(await makeConfigDir(), "not-created", "tokscale");
    const overlayConfigDir = await makeConfigDir();
    const env = await buildMergedEnv([
      { toolName: "opencode", identity: identity("/identity/a") },
      { toolName: "opencode", identity: identity("/identity/b") },
    ], { sourceConfigDir: missingSourceConfig, overlayConfigDir });
    expect(env.TOKSCALE_CONFIG_DIR).toBe(overlayConfigDir);
    const settings = JSON.parse(await readFile(join(overlayConfigDir, "settings.json"), "utf8"));
    expect(settings.scanner.opencodeDbPaths).toEqual([
      "/identity/a/data/opencode/opencode.db",
      "/identity/b/data/opencode/opencode.db",
    ]);
    expect(settings.scanner.extraScanPaths.opencode).toEqual([
      "/identity/a/data/opencode/storage/message",
      "/identity/b/data/opencode/storage/message",
    ]);
    expect(await readlink(join(overlayConfigDir, "cache"))).toBe(join(missingSourceConfig, "cache"));
  });

  test("deduplicates repeated OpenCode DB paths", async () => {
    const sourceConfigDir = await makeConfigDir();
    const overlayConfigDir = await makeConfigDir();
    const env = await buildMergedEnv([
      { toolName: "opencode", identity: identity("/home/user/.opencode/identities/a") },
      { toolName: "opencode", identity: identity("/home/user/.opencode/identities/a") },
    ], { sourceConfigDir, overlayConfigDir });
    const overlaySettings = JSON.parse(await readFile(join(env.TOKSCALE_CONFIG_DIR!, "settings.json"), "utf8"));
    expect(overlaySettings.scanner.opencodeDbPaths).toHaveLength(1);
    expect(overlaySettings.scanner.extraScanPaths.opencode).toHaveLength(1);
  });

  test("deduplicates existing OpenCode DB paths that reach the same file through symlink aliases", async () => {
    const sourceConfigDir = await makeConfigDir();
    const overlayConfigDir = await makeConfigDir();
    const realDb = join(await makeConfigDir(), "opencode.db");
    const identityDir = await makeConfigDir();
    const identityDbDir = join(identityDir, "data", "opencode");
    const aliasDb = join(identityDbDir, "opencode.db");
    await mkdir(identityDbDir, { recursive: true });
    await writeFile(realDb, "fixture db");
    await symlink(realDb, aliasDb, "file");
    await writeFile(join(sourceConfigDir, "settings.json"), JSON.stringify({
      scanner: { opencodeDbPaths: [realDb] },
    }));

    await buildMergedEnv([
      { toolName: "opencode", identity: identity(identityDir) },
    ], { sourceConfigDir, overlayConfigDir });

    const overlaySettings = JSON.parse(await readFile(join(overlayConfigDir, "settings.json"), "utf8"));
    expect(overlaySettings.scanner.opencodeDbPaths).toEqual([realDb]);
  });

  test("prepares noninteractive --json passthrough args and config without executing Tokscale", async () => {
    const sourceConfigDir = await makeConfigDir();
    const overlayConfigDir = await makeConfigDir();
    const prepared = await prepareMergedPassthrough([
      { toolName: "opencode", identity: identity("/identities/a") },
      { toolName: "opencode", identity: identity("/identities/b") },
    ], ["--json"], { sourceConfigDir, overlayConfigDir });
    expect(prepared.args).toEqual(["--json"]);
    expect(prepared.env.TOKSCALE_CONFIG_DIR).toBe(overlayConfigDir);
    const overlaySettings = JSON.parse(await readFile(join(overlayConfigDir, "settings.json"), "utf8"));
    expect(overlaySettings.scanner.opencodeDbPaths).toEqual([
      "/identities/a/data/opencode/opencode.db",
      "/identities/b/data/opencode/opencode.db",
    ]);
    expect(overlaySettings.scanner.extraScanPaths.opencode).toEqual([
      "/identities/a/data/opencode/storage/message",
      "/identities/b/data/opencode/storage/message",
    ]);
  });

  test("includes default OpenCode DB and legacy roots when requested for unscoped passthrough", async () => {
    const sourceConfigDir = await makeConfigDir();
    const overlayConfigDir = await makeConfigDir();
    const prepared = await prepareMergedPassthrough([
      { toolName: "claude", identity: identity("/identities/claude") },
      { toolName: "opencode", identity: identity("/identities/opencode") },
    ], ["tui"], { sourceConfigDir, overlayConfigDir, includeDefaultOpencodeProfile: true });
    const scanner = JSON.parse(await readFile(join(overlayConfigDir, "settings.json"), "utf8")).scanner;
    const defaultDb = defaultOpencodeProfileDbPath();
    expect(prepared.args).toEqual(["tui"]);
    expect(scanner.opencodeDbPaths).toContain(defaultDb);
    expect(scanner.opencodeDbPaths).toContain("/identities/opencode/data/opencode/opencode.db");
    expect(scanner.extraScanPaths.opencode).toContain(join(dirname(defaultDb), "storage", "message"));
    expect(scanner.extraScanPaths.opencode).toContain("/identities/opencode/data/opencode/storage/message");
  });

  test("does not configure the default OpenCode profile when filtered to another tool", async () => {
    const sourceConfigDir = await makeConfigDir();
    const overlayConfigDir = await makeConfigDir();
    const prepared = await prepareMergedPassthrough([
      { toolName: "claude", identity: identity("/identities/claude") },
    ], ["tui"], { sourceConfigDir, overlayConfigDir, includeDefaultOpencodeProfile: false });
    expect(prepared.env.TOKSCALE_CONFIG_DIR).toBeUndefined();
    expect(await Bun.file(join(overlayConfigDir, "settings.json")).exists()).toBe(false);
  });

  test("configures the default OpenCode profile when no identities are configured", async () => {
    const sourceConfigDir = await makeConfigDir();
    const overlayConfigDir = await makeConfigDir();
    const prepared = await prepareMergedPassthrough([], ["tui"], {
      sourceConfigDir,
      overlayConfigDir,
      includeDefaultOpencodeProfile: true,
    });
    const scanner = JSON.parse(await readFile(join(overlayConfigDir, "settings.json"), "utf8")).scanner;
    const defaultDb = defaultOpencodeProfileDbPath();
    expect(prepared.env.TOKSCALE_CONFIG_DIR).toBe(overlayConfigDir);
    expect(scanner.opencodeDbPaths).toContain(defaultDb);
    expect(scanner.extraScanPaths.opencode).toContain(join(dirname(defaultDb), "storage", "message"));
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
