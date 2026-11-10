import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// Preloaded by bunfig.toml for every `bun test` run: no test may touch the real home directory (identity folders,
// registries, ~/.secrets, the gateway member store, the heartbeat).
//
// Bun fixes the home directory at process start, so setting HOME here would not move os.homedir(). Instead, when this
// run was not started with an isolated HOME, it re-runs itself with HOME pointing at a fresh scratch directory and exits
// with that run's status. The child sees AIS_TEST_ISOLATED_HOME and goes on to run the tests.
const MARK = "AIS_TEST_ISOLATED_HOME";

/** The arguments `bun` was started with (`test ...`); process.argv in a preload drops the `test` subcommand. */
function originalArgs(): string[] {
  try {
    const parts = readFileSync("/proc/self/cmdline", "utf8").split("\0");
    if (parts.at(-1) === "") parts.pop();
    return parts.slice(1);
  } catch {
    // macOS: no /proc. The CI and local invocations never put spaces inside an argument.
    const r = spawnSync("ps", ["-ww", "-o", "command=", "-p", String(process.pid)], { encoding: "utf8" });
    const parts = r.stdout.trim().split(/\s+/);
    if (r.status !== 0 || !parts.includes("test")) throw new Error("test/setup-env.ts: cannot recover the bun test command line to re-run it with an isolated HOME");
    return parts.slice(1);
  }
}
const isolated = process.env[MARK];
if (!isolated || homedir() !== isolated) {
  const home = mkdtempSync(join(tmpdir(), "ais-test-home-"));
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home, [MARK]: home };
  // Point XDG dirs into the scratch home too; git must not read the real global config.
  // Every variable that points AIS or a tool at a real-home file goes too (secrets, pi agent dir, host home, AWS profiles, Chrome MCP).
  for (const k of [
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "AIS_GATEWAY_MEMBERS_DIR", "AIS_GATEWAY_HEARTBEAT", "CLAUDE_CONFIG_DIR", "CODEX_HOME",
    "AIS_SECRETS_FILE", "PI_CODING_AGENT_DIR", "AIS_HOST_HOME", "AIS_AWS_PROFILES_CONFIG", "AIS_CHROME_MCP_CONFIG",
  ]) delete env[k];
  env.GIT_CONFIG_NOSYSTEM = "1";
  // Keep bun's install cache where it was (tests never install, but bun may look it up).
  env.BUN_INSTALL_CACHE_DIR ??= join(homedir(), ".bun", "install", "cache");
  const r = spawnSync(process.execPath, originalArgs(), { stdio: "inherit", env });
  rmSync(home, { recursive: true, force: true });
  process.exit(r.status ?? 1);
}

mkdirSync(join(isolated, ".ais"), { recursive: true });
// Even inside the scratch home: a test that starts a gateway process must not switch the whole run onto the member store.
process.env.AIS_GATEWAY_MEMBER_STORE = "0";
