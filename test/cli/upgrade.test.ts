import { describe, expect, test } from "bun:test";
import { BinaryResolutionError } from "../../src/identities/errors.ts";
import {
  GROK_CHANNEL_URLS,
  GROK_INSTALLER_URL,
  MANAGED_NPM_PREFIX,
  UPGRADE_SPECS,
  compareSemver,
  extractSemver,
  helpListsUpdater,
  isOfficialXaiGrokHelp,
  planUpgrades,
  resolveGrokChannelLatestVersion,
  resolvePublicNpmLatestVersion,
  runUpgradeWithDeps,
  UpgradeCancelledError,
  type UpgradeDeps,
} from "../../src/cli/upgrade.ts";
import type { UpgradeEvent } from "../../src/cli/upgrade-status.ts";

function oneSpec(toolName: string) {
  const spec = UPGRADE_SPECS.find((candidate) => candidate.cfg.toolName === toolName);
  if (!spec) throw new Error(`missing upgrade spec for ${toolName}`);
  return spec;
}

function fakeDeps(overrides: Partial<UpgradeDeps> = {}) {
  const spawns: Array<{ command: string; args: string[] }> = [];
  const logs: string[] = [];
  const events: UpgradeEvent[] = [];
  const deps: UpgradeDeps = {
    shimExists: async () => true,
    which: (command) => (command === "npm" ? "/usr/bin/npm" : null),
    resolve: (binaryName) => `/real/${binaryName}`,
    spawn: async (command, args) => {
      spawns.push({ command, args });
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    capture: async () => ({
      stdout: "Grok Build TUI\nCommands:\n  update    Update to the latest version",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    }),
    managedBinaryExists: async () => true,
    prepareManagedPrefix: async () => {},
    installGrok: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    log: (message) => logs.push(message),
    ...overrides,
  };
  const hooks = { onEvent: (event: UpgradeEvent) => events.push(event), events };
  return { deps, spawns, logs, events, hooks };
}

describe("UPGRADE_SPECS", () => {
  test("ali gets its own spec with the same physical installer as zai", () => {
    const zai = oneSpec("zai");
    const ali = oneSpec("ali");
    expect(ali.npmPackage).toBe("@charmland/crush");
    expect(ali.npmPackage).toBe(zai.npmPackage);
    expect(ali.installer).toBe("npm");
  });

  test("pi is installed from the maintained Earendil package", () => {
    const pi = oneSpec("pi");
    expect(pi.npmPackage).toBe("@earendil-works/pi-coding-agent");
    expect(pi.installer).toBe("npm");
  });

  test("allows OpenCode's postinstall script to select its platform binary", () => {
    const opencode = oneSpec("opencode");
    expect(opencode.allowedScriptPackages).toEqual(["opencode-ai"]);
  });
});

describe("helpListsUpdater", () => {
  test("recognises an updater explicitly listed as a command", () => {
    expect(helpListsUpdater("Commands:\n  exec  Run a command\n  update  Update Codex", "update")).toBe(true);
  });

  test("does not mistake an old Codex update banner for an update command", () => {
    const oldCodexOutput =
      "Update available! 0.118.0 -> 0.144.6\nRun npm install -g @openai/codex to update.";
    expect(helpListsUpdater(oldCodexOutput, "update")).toBe(false);
  });
});

describe("xAI Grok detection", () => {
  test("uses xAI's documented installer", () => {
    expect(GROK_INSTALLER_URL).toBe("https://x.ai/cli/install.sh");
  });

  test("reads the same two stable-channel mirrors xAI's installer uses", () => {
    expect(GROK_CHANNEL_URLS).toEqual([
      "https://x.ai/cli/stable",
      "https://storage.googleapis.com/grok-build-public-artifacts/cli/stable",
    ]);
  });

  test("distinguishes Grok Build from the similarly named community CLI", () => {
    expect(isOfficialXaiGrokHelp("Grok Build TUI\nCommands:\n  update")).toBe(true);
    expect(isOfficialXaiGrokHelp("AI coding agent powered by Grok\nCommands:\n  update")).toBe(false);
  });
});

describe("semver helpers", () => {
  test("extractSemver reads every vendor --version shape seen live", () => {
    expect(extractSemver("2.1.268 (Claude Code)\n")).toBe("2.1.268");
    expect(extractSemver("codex-cli 0.154.0\n")).toBe("0.154.0");
    expect(extractSemver("crush version v0.93.1\n")).toBe("0.93.1");
    expect(extractSemver("grok 1.0.25 (f7e67d6988e2) [stable]\n")).toBe("1.0.25");
    expect(extractSemver("herdr 0.8.2\n")).toBe("0.8.2");
    expect(extractSemver("\x1b[32m1.18.30\x1b[0m")).toBe("1.18.30");
    expect(extractSemver("Grok Build TUI\nCommands:\n  update    Update to the latest version")).toBeUndefined();
  });

  test("compareSemver orders numeric cores and prereleases below releases", () => {
    expect(compareSemver("1.0.25", "1.0.30")).toBeLessThan(0);
    expect(compareSemver("2.1.269", "2.1.269")).toBe(0);
    expect(compareSemver("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareSemver("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
    expect(compareSemver("1.0.0", "1.0.0+build.5")).toBe(0);
  });
});

describe("resolveGrokChannelLatestVersion", () => {
  const text = (body: string, ok = true) => ({ ok, text: async () => body });

  test("reads xAI's stable channel", async () => {
    const fetched: string[] = [];
    const version = await resolveGrokChannelLatestVersion({
      fetch: async (url) => {
        fetched.push(url);
        return text("1.0.30\n");
      },
    });
    expect(version).toBe("1.0.30");
    expect(fetched).toEqual([GROK_CHANNEL_URLS[0]]);
  });

  test("falls back to the GCS mirror when x.ai fails", async () => {
    const version = await resolveGrokChannelLatestVersion({
      fetch: async (url) => (url.startsWith("https://x.ai") ? text("overloaded", false) : text("1.0.30")),
    });
    expect(version).toBe("1.0.30");
  });

  test("degrades to undefined when every mirror is unreachable or malformed", async () => {
    for (const fetch of [
      async () => text("bogus", false),
      async () => {
        throw new Error("offline");
      },
      async () => text("not a version"),
    ]) {
      await expect(resolveGrokChannelLatestVersion({ fetch })).resolves.toBeUndefined();
    }
  });
});

describe("resolvePublicNpmLatestVersion", () => {
  const result = (stdout: string, exitCode = 0) => ({ stdout, stderr: "", exitCode, timedOut: false });

  test("uses the public manifest after a scoped registry falls back to the public default", async () => {
    const captures: string[][] = [];
    const fetched: string[] = [];
    const version = await resolvePublicNpmLatestVersion("npm", "@openai/codex", {
      capture: async (_command, args) => {
        captures.push(args);
        return captures.length === 1 ? result("undefined\n") : result("https://registry.npmjs.org/\n");
      },
      fetch: async (url) => {
        fetched.push(url);
        return { ok: true, json: async () => ({ name: "@openai/codex", version: "0.144.6" }) };
      },
    });

    expect(version).toBe("0.144.6");
    expect(captures).toEqual([["config", "get", "@openai:registry"], ["config", "get", "registry"]]);
    expect(fetched).toEqual(["https://registry.npmjs.org/@openai%2fcodex/latest"]);
  });

  test("honours a custom scoped registry without contacting the public registry", async () => {
    let fetches = 0;
    const version = await resolvePublicNpmLatestVersion("npm", "@openai/codex", {
      capture: async () => result("https://npm.example.test/\n"),
      fetch: async () => {
        fetches++;
        return { ok: true, json: async () => ({}) };
      },
    });

    expect(version).toBeUndefined();
    expect(fetches).toBe(0);
  });

  test("falls back to npm latest when public metadata is invalid or unavailable", async () => {
    for (const fetch of [
      async () => ({ ok: true, json: async () => ({ name: "@openai/codex", version: "not-a-version" }) }),
      async () => {
        throw new Error("network failure");
      },
    ]) {
      await expect(
        resolvePublicNpmLatestVersion("npm", "@openai/codex", {
          capture: async () => result("https://registry.npmjs.org/\n"),
          fetch,
        }),
      ).resolves.toBeUndefined();
    }
  });
});

describe("runUpgradeWithDeps", () => {
  test("rethrows cancellation from npm version lookups without running any installer", async () => {
    const calls: string[] = [];
    const { deps, hooks } = fakeDeps({
      latestNpmVersion: async () => {
        calls.push("lookup");
        throw new UpgradeCancelledError(130);
      },
      spawn: async () => {
        calls.push("install");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    await expect(runUpgradeWithDeps(deps, [oneSpec("codex"), oneSpec("claude")], hooks)).rejects.toEqual(
      new UpgradeCancelledError(130),
    );
    // Both specs start in parallel, so both lookups may fire, but neither
    // physical installer is allowed to start once cancellation is observed.
    expect(calls).toEqual(["lookup", "lookup"]);
  });

  test("rethrows npm cancellation without attempting any native fallback", async () => {
    const calls: string[] = [];
    const { deps, hooks } = fakeDeps({
      spawn: async () => {
        calls.push("npm");
        return { exitCode: 130, stdout: "", stderr: "" };
      },
      resolve: () => {
        calls.push("resolve");
        return "/real/codex";
      },
    });

    await expect(runUpgradeWithDeps(deps, [oneSpec("codex"), oneSpec("claude")], hooks)).rejects.toEqual(
      new UpgradeCancelledError(130),
    );
    expect(calls).toEqual(["npm", "npm"]);
  });

  test("rethrows native fallback cancellation when npm is unavailable", async () => {
    const calls: string[] = [];
    const { deps, hooks } = fakeDeps({
      which: () => null,
      spawn: async () => {
        calls.push("native");
        return { exitCode: 130, stdout: "", stderr: "" };
      },
      shimExists: async (toolName) => {
        calls.push(toolName);
        return true;
      },
    });

    await expect(runUpgradeWithDeps(deps, [oneSpec("codex"), oneSpec("claude")], hooks)).rejects.toEqual(
      new UpgradeCancelledError(130),
    );
    // Shim checks all settle first, then both fallbacks run; neither reaches
    // a managed install.
    expect(calls).toEqual(["codex", "claude", "native", "native"]);
  });

  test("rethrows cancellation from Grok native updater without installing", async () => {
    let installerCalls = 0;
    const { deps, hooks } = fakeDeps({
      spawn: async () => ({ exitCode: 143, stdout: "", stderr: "" }),
      installGrok: async () => {
        installerCalls++;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    await expect(runUpgradeWithDeps(deps, [oneSpec("grok")], hooks)).rejects.toEqual(new UpgradeCancelledError(143));
    expect(installerCalls).toBe(0);
  });

  test("rethrows cancellation from the Grok installer", async () => {
    const { deps, hooks } = fakeDeps({
      resolve: () => {
        throw new BinaryResolutionError("missing");
      },
      installGrok: async () => ({ exitCode: 131, stdout: "", stderr: "" }),
    });

    await expect(runUpgradeWithDeps(deps, [oneSpec("grok")], hooks)).rejects.toEqual(new UpgradeCancelledError(131));
  });

  test("upgrades old Codex through the managed npm package without invoking `codex update`", async () => {
    const probes: Array<{ command: string; args: string[] }> = [];
    const { deps, spawns } = fakeDeps({
      capture: async (command, args) => {
        probes.push({ command, args });
        return { stdout: "codex-cli 0.144.6", stderr: "", exitCode: 0, timedOut: false };
      },
    });

    const summary = await runUpgradeWithDeps(deps, [oneSpec("codex")]);

    expect(summary).toEqual({ checked: 1, failed: 0, skipped: 0 });
    expect(spawns).toEqual([
      {
        command: "/usr/bin/npm",
        args: [
          "install",
          "--global",
          "--prefix",
          MANAGED_NPM_PREFIX,
          "--foreground-scripts",
          "--no-audit",
          "--no-fund",
          "--loglevel=http",
          "--fetch-timeout=300000",
          "--fetch-retries=1",
          "--fetch-retry-mintimeout=1000",
          "--fetch-retry-maxtimeout=5000",
          "--prefer-online",
          "@openai/codex@latest",
        ],
      },
    ]);
    expect(probes).toEqual([
      {
        command: `${MANAGED_NPM_PREFIX}/bin/codex`,
        args: ["--version"],
      },
    ]);
  });

  test("pins a fresh public npm version and revalidates cached metadata", async () => {
    const { deps, spawns } = fakeDeps({ latestNpmVersion: async () => "0.144.6" });
    await runUpgradeWithDeps(deps, [oneSpec("codex")]);
    expect(spawns[0]?.args).toContain("--prefer-online");
    expect(spawns[0]?.args).not.toContain("--prefer-offline");
    expect(spawns[0]?.args.at(-1)).toBe("@openai/codex@0.144.6");
  });

  test("skips npm when the pinned package manifest matches and its CLI runs", async () => {
    const { deps, spawns } = fakeDeps({
      latestNpmVersion: async () => "0.144.6",
      managedNpmVersion: async (packageName) => (packageName === "@openai/codex" ? "0.144.6" : undefined),
    });

    const summary = await runUpgradeWithDeps(deps, [oneSpec("codex")]);

    expect(summary).toEqual({ checked: 1, failed: 0, skipped: 0 });
    expect(spawns).toEqual([]);
  });

  test("reinstalls when the pinned package manifest matches but its CLI is broken", async () => {
    const { deps, spawns } = fakeDeps({
      latestNpmVersion: async () => "0.144.6",
      managedNpmVersion: async () => "0.144.6",
      capture: async (command) =>
        command.endsWith("/bin/codex")
          ? { stdout: "", stderr: "broken", exitCode: 1, timedOut: false }
          : { stdout: "", stderr: "", exitCode: 0, timedOut: false },
    });

    await runUpgradeWithDeps(deps, [oneSpec("codex")]);

    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.args.at(-1)).toBe("@openai/codex@0.144.6");
  });

  test("reinstalls when the matching managed CLI cannot be executed", async () => {
    const { deps, spawns } = fakeDeps({
      latestNpmVersion: async () => "0.144.6",
      managedNpmVersion: async () => "0.144.6",
      capture: async (command) => {
        if (command.endsWith("/bin/codex")) throw new Error("EACCES");
        return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
      },
    });

    await runUpgradeWithDeps(deps, [oneSpec("codex")]);

    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.args.at(-1)).toBe("@openai/codex@0.144.6");
  });

  test("rethrows cancellation from the matching managed CLI probe", async () => {
    const { deps, spawns } = fakeDeps({
      latestNpmVersion: async () => "0.144.6",
      managedNpmVersion: async () => "0.144.6",
      capture: async () => ({ stdout: "", stderr: "", exitCode: 130, timedOut: false }),
    });

    await expect(runUpgradeWithDeps(deps, [oneSpec("codex")])).rejects.toEqual(new UpgradeCancelledError(130));
    expect(spawns).toEqual([]);
  });

  test("falls back to npm @latest when the version lookup fails, still revalidating npm's cache", async () => {
    const { deps, spawns } = fakeDeps({ latestNpmVersion: async () => undefined });
    await runUpgradeWithDeps(deps, [oneSpec("codex")]);
    expect(spawns[0]?.args).not.toContain("--prefer-offline");
    expect(spawns[0]?.args).toContain("--prefer-online");
    expect(spawns[0]?.args.at(-1)).toBe("@openai/codex@latest");
  });

  test("does not report success when an installed npm package has no runnable CLI", async () => {
    const { deps, spawns } = fakeDeps({
      resolve: () => "/usr/bin/codex",
      capture: async (command, args) =>
        command.endsWith("/bin/codex")
          ? { stdout: "", stderr: "broken", exitCode: 1, timedOut: false }
          : { stdout: "Commands:\n  exec\n  login", stderr: "", exitCode: 0, timedOut: false },
    });

    const summary = await runUpgradeWithDeps(deps, [oneSpec("codex")]);

    expect(summary).toEqual({ checked: 0, failed: 1, skipped: 0 });
    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.command).toBe("/usr/bin/npm");
  });

  test("never launches an old Codex chat when npm is unavailable", async () => {
    const { deps, spawns } = fakeDeps({
      which: () => null,
      resolve: () => "/usr/bin/codex",
      capture: async () => ({
        stdout: "Commands:\n  exec\n  login\n  resume",
        stderr: "",
        exitCode: 0,
        timedOut: false,
      }),
    });

    const summary = await runUpgradeWithDeps(deps, [oneSpec("codex")]);

    expect(summary).toEqual({ checked: 0, failed: 1, skipped: 0 });
    expect(spawns).toEqual([]);
  });

  test("installs a missing Grok CLI through xAI's installer", async () => {
    let installed = false;
    const { deps, spawns } = fakeDeps({
      resolve: () => {
        if (!installed) throw new BinaryResolutionError("missing");
        return "/home/test/.grok/bin/grok";
      },
      installGrok: async () => {
        installed = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    const summary = await runUpgradeWithDeps(deps, [oneSpec("grok")]);

    expect(summary).toEqual({ checked: 1, failed: 0, skipped: 0 });
    expect(spawns).toEqual([]);
  });

  test("uses Grok's native updater when the installed binary advertises it", async () => {
    let installerCalls = 0;
    const { deps, spawns } = fakeDeps({
      installGrok: async () => {
        installerCalls++;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    const summary = await runUpgradeWithDeps(deps, [oneSpec("grok")]);

    expect(summary).toEqual({ checked: 1, failed: 0, skipped: 0 });
    expect(spawns).toEqual([{ command: "/real/grok", args: ["update"] }]);
    expect(installerCalls).toBe(0);
  });

  test("replaces the similarly named community Grok CLI instead of updating it", async () => {
    let installerCalls = 0;
    let installedOfficialCli = false;
    const { deps, spawns } = fakeDeps({
      capture: async () => ({
        stdout: installedOfficialCli
          ? "Grok Build TUI\nCommands:\n  update"
          : "AI coding agent powered by Grok\nCommands:\n  update",
        stderr: "",
        exitCode: 0,
        timedOut: false,
      }),
      installGrok: async () => {
        installerCalls++;
        installedOfficialCli = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    const summary = await runUpgradeWithDeps(deps, [oneSpec("grok")]);

    expect(summary).toEqual({ checked: 1, failed: 0, skipped: 0 });
    expect(spawns).toEqual([]);
    expect(installerCalls).toBe(1);
  });

  test("manages only tools whose AIS shims are installed", async () => {
    const { deps, spawns } = fakeDeps({
      shimExists: async (toolName) => toolName === "claude",
    });

    const summary = await runUpgradeWithDeps(deps, [oneSpec("claude"), oneSpec("zai")]);

    expect(summary).toEqual({ checked: 1, failed: 0, skipped: 1 });
    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.args.at(-1)).toBe("@anthropic-ai/claude-code@latest");
  });

  test("includes Crush as the real CLI behind an installed ZAI shim", async () => {
    const { deps, spawns } = fakeDeps();

    const summary = await runUpgradeWithDeps(deps, [oneSpec("zai")]);

    expect(summary).toEqual({ checked: 1, failed: 0, skipped: 0 });
    expect(spawns[0]?.args.at(-1)).toBe("@charmland/crush@latest");
    expect(spawns[0]?.args).toContain("--allow-scripts=@charmland/crush");
  });

  test("installs the shared Crush CLI only once for zai and ali", async () => {
    const { deps, spawns, logs } = fakeDeps();

    const summary = await runUpgradeWithDeps(deps, [oneSpec("zai"), oneSpec("ali")]);

    expect(summary).toEqual({ checked: 1, failed: 0, skipped: 0 });
    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.args.at(-1)).toBe("@charmland/crush@latest");
    expect(logs.some((line) => line.includes("ali shares") && line.includes("already installed/upgraded"))).toBe(
      true,
    );
  });

  test("reports a failed shared Crush installer only once", async () => {
    let spawnCount = 0;
    const { deps, logs } = fakeDeps({
      spawn: async () => {
        spawnCount++;
        return { exitCode: 1, stdout: "npm err", stderr: "" };
      },
    });

    const summary = await runUpgradeWithDeps(deps, [oneSpec("zai"), oneSpec("ali")]);

    expect(summary).toEqual({ checked: 0, failed: 1, skipped: 0 });
    expect(spawnCount).toBe(1);
    expect(logs.some((line) => line.includes("ali shares") && line.includes("already failed"))).toBe(true);
  });

  test("installs Crush for ali when the zai shim is absent", async () => {
    const { deps, spawns } = fakeDeps({
      shimExists: async (toolName) => toolName === "ali",
    });

    const summary = await runUpgradeWithDeps(deps, [oneSpec("zai"), oneSpec("ali")]);

    expect(summary).toEqual({ checked: 1, failed: 0, skipped: 1 });
    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.args.at(-1)).toBe("@charmland/crush@latest");
  });

  test("allows only Kimi's known install-script packages", async () => {
    const { deps, spawns } = fakeDeps();

    const summary = await runUpgradeWithDeps(deps, [oneSpec("kimi")]);

    expect(summary).toEqual({ checked: 1, failed: 0, skipped: 0 });
    expect(spawns[0]?.args).toContain("--allow-scripts=@moonshot-ai/kimi-code,node-pty");
  });
});

describe("grok honest install verification", () => {
  /** Mutable grok install: --version probes read `version`, --help probes
   * advertise the official xAI updater, everything else is the default. */
  function grokDeps(version: { value: string }, overrides: Partial<UpgradeDeps> = {}) {
    return fakeDeps({
      capture: async (_command, args) =>
        args[0] === "--version"
          ? { stdout: `grok ${version.value} (abc123) [stable]\n`, stderr: "", exitCode: 0, timedOut: false }
          : {
              stdout: "Grok Build TUI\nCommands:\n  update    Update to the latest version",
              stderr: "",
              exitCode: 0,
              timedOut: false,
            },
      grokChannelVersion: async () => "1.0.30",
      ...overrides,
    });
  }

  test("a lying exit 0 falls back to xAI's installer and reports the real transition", async () => {
    // 2026-09-12 incident: `grok update` exited 0 printing "installed
    // successfully" while npm had blocked the package postinstall, so
    // 1.0.25 stayed on disk under a green row.
    const version = { value: "1.0.25" };
    let installerCalls = 0;
    const spawns: Array<{ command: string; args: string[] }> = [];
    const { deps, hooks } = grokDeps(version, {
      spawn: async (command, args) => {
        spawns.push({ command, args });
        return { exitCode: 0, stdout: "✓ grok v1.0.30 installed successfully!\n", stderr: "" };
      },
      installGrok: async () => {
        installerCalls++;
        version.value = "1.0.30";
        return { exitCode: 0, stdout: "Grok 1.0.30 installed", stderr: "" };
      },
    });

    const summary = await runUpgradeWithDeps(deps, [oneSpec("grok")], hooks);

    expect(summary).toEqual({ checked: 1, failed: 0, skipped: 0 });
    expect(spawns).toEqual([{ command: "/real/grok", args: ["update"] }]);
    expect(installerCalls).toBe(1);
    const last = hooks.events.at(-1);
    expect(last?.type).toBe("finish");
    expect(last?.type === "finish" && last.detail?.startsWith("1.0.25 -> 1.0.30")).toBe(true);
  });

  test("a version that still did not move after the installer is an honest failed row", async () => {
    const version = { value: "1.0.25" };
    const { deps, hooks } = grokDeps(version, {
      spawn: async () => ({ exitCode: 0, stdout: "✓ grok v1.0.30 installed successfully!\n", stderr: "" }),
      installGrok: async () => ({ exitCode: 0, stdout: "Grok 1.0.30 installed", stderr: "" }),
    });

    const summary = await runUpgradeWithDeps(deps, [oneSpec("grok")], hooks);

    expect(summary).toEqual({ checked: 0, failed: 1, skipped: 0 });
    const last = hooks.events.at(-1);
    expect(last?.type).toBe("finish");
    expect(last?.type === "finish" && last.ok).toBe(false);
    expect(last?.type === "finish" && last.detail?.includes("grok still reports 1.0.25")).toBe(true);
    expect(last?.type === "finish" && last.detail?.includes("channel latest is 1.0.30")).toBe(true);
  });

  test("a native updater that really moves the version is a green transition without the installer", async () => {
    const version = { value: "1.0.25" };
    let installerCalls = 0;
    const spawns: Array<{ command: string; args: string[] }> = [];
    const { deps, hooks } = grokDeps(version, {
      spawn: async (command, args) => {
        spawns.push({ command, args });
        version.value = "1.0.30";
        return { exitCode: 0, stdout: "Updating Grok 1.0.25 → 1.0.30\n", stderr: "" };
      },
      installGrok: async () => {
        installerCalls++;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    const summary = await runUpgradeWithDeps(deps, [oneSpec("grok")], hooks);

    expect(summary).toEqual({ checked: 1, failed: 0, skipped: 0 });
    expect(spawns).toEqual([{ command: "/real/grok", args: ["update"] }]);
    expect(installerCalls).toBe(0);
    const last = hooks.events.at(-1);
    expect(last?.type === "finish" && last.detail?.startsWith("1.0.25 -> 1.0.30")).toBe(true);
  });

  test("with the channel unreachable an exit 0 that changes nothing stays honest as already X", async () => {
    const version = { value: "1.0.25" };
    let installerCalls = 0;
    const { deps, hooks } = grokDeps(version, {
      grokChannelVersion: async () => undefined,
      spawn: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      installGrok: async () => {
        installerCalls++;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    const summary = await runUpgradeWithDeps(deps, [oneSpec("grok")], hooks);

    expect(summary).toEqual({ checked: 1, failed: 0, skipped: 0 });
    expect(installerCalls).toBe(0);
    const last = hooks.events.at(-1);
    expect(last?.type === "finish" && last.detail?.startsWith("already 1.0.25")).toBe(true);
  });
});

describe("npm post-install verification gate", () => {
  test("fails honestly when the resolved binary still reports an older version than the pinned install", async () => {
    const { deps, spawns, hooks } = fakeDeps({
      latestNpmVersion: async () => "0.144.6",
      managedNpmVersion: async () => "0.144.6",
      // The user's PATH resolves codex somewhere other than the managed
      // prefix, and that shadow reports yesterday's version.
      resolve: (binaryName) => `/usr/bin/${binaryName}`,
      capture: async (command) =>
        command.startsWith(MANAGED_NPM_PREFIX)
          ? { stdout: "codex-cli 0.144.6", stderr: "", exitCode: 0, timedOut: false }
          : { stdout: "codex-cli 0.144.5", stderr: "", exitCode: 0, timedOut: false },
    });

    const summary = await runUpgradeWithDeps(deps, [oneSpec("codex")], hooks);

    expect(summary).toEqual({ checked: 0, failed: 1, skipped: 0 });
    expect(spawns).toEqual([]);
    const last = hooks.events.filter((event) => event.id === "codex").at(-1);
    expect(last?.type).toBe("finish");
    expect(last?.type === "finish" && last.ok).toBe(false);
    expect(last?.type === "finish" && last.detail?.includes("/usr/bin/codex still reports 0.144.5")).toBe(true);
    expect(last?.type === "finish" && last.detail?.includes("shadowing")).toBe(true);
  });

  test("fails honestly when the managed manifest did not actually move to the pinned version", async () => {
    const { deps, spawns, hooks } = fakeDeps({
      latestNpmVersion: async () => "0.144.6",
      managedNpmVersion: async () => "0.144.5",
      capture: async (command) =>
        command.startsWith(MANAGED_NPM_PREFIX)
          ? { stdout: "codex-cli 0.144.5", stderr: "", exitCode: 0, timedOut: false }
          : { stdout: "Grok Build TUI\nCommands:\n  update", stderr: "", exitCode: 0, timedOut: false },
    });

    const summary = await runUpgradeWithDeps(deps, [oneSpec("codex")], hooks);

    expect(summary).toEqual({ checked: 0, failed: 1, skipped: 0 });
    expect(spawns).toHaveLength(1);
    const last = hooks.events.filter((event) => event.id === "codex").at(-1);
    expect(last?.type === "finish" && last.ok).toBe(false);
    expect(
      last?.type === "finish" && last.detail?.includes("manifest still reports 0.144.5 after installing 0.144.6"),
    ).toBe(true);
  });

  test("reinstalls when the managed binary reports an older version than the pinned manifest", async () => {
    const { deps, spawns } = fakeDeps({
      latestNpmVersion: async () => "0.144.6",
      managedNpmVersion: async () => "0.144.6",
      capture: async (command) =>
        command.startsWith(MANAGED_NPM_PREFIX)
          ? { stdout: "codex-cli 0.144.5", stderr: "", exitCode: 0, timedOut: false }
          : { stdout: "", stderr: "", exitCode: 0, timedOut: false },
    });

    const summary = await runUpgradeWithDeps(deps, [oneSpec("codex")]);

    expect(summary).toEqual({ checked: 1, failed: 0, skipped: 0 });
    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.args.at(-1)).toBe("@openai/codex@0.144.6");
  });

  test("reports already with a matching managed binary that parses to the pinned version", async () => {
    const { deps, spawns, hooks } = fakeDeps({
      latestNpmVersion: async () => "0.144.6",
      managedNpmVersion: async () => "0.144.6",
      resolve: (binaryName) => `${MANAGED_NPM_PREFIX}/bin/${binaryName}`,
      capture: async () => ({ stdout: "codex-cli 0.144.6\n", stderr: "", exitCode: 0, timedOut: false }),
    });

    const summary = await runUpgradeWithDeps(deps, [oneSpec("codex")], hooks);

    expect(summary).toEqual({ checked: 1, failed: 0, skipped: 0 });
    expect(spawns).toEqual([]);
    const last = hooks.events.filter((event) => event.id === "codex").at(-1);
    expect(last?.type === "finish" && last.detail?.startsWith("already 0.144.6")).toBe(true);
  });
});

describe("planUpgrades", () => {
  test("keeps every installed spec, with later identical installers as followers", async () => {
    const { planned, missingShims } = await planUpgrades([oneSpec("zai"), oneSpec("ali"), oneSpec("claude")], async () => true);
    expect(missingShims).toEqual([]);
    expect(planned.map((task) => [task.spec.cfg.toolName, task.followerOf])).toEqual([
      ["zai", undefined],
      ["ali", "zai"],
      ["claude", undefined],
    ]);
  });

  test("an absent leader shim promotes the follower to leader", async () => {
    const { planned, missingShims } = await planUpgrades(
      [oneSpec("zai"), oneSpec("ali")],
      async (toolName) => toolName === "ali",
    );
    expect(missingShims.map((spec) => spec.cfg.toolName)).toEqual(["zai"]);
    expect(planned).toHaveLength(1);
    expect(planned[0]?.spec.cfg.toolName).toBe("ali");
    expect(planned[0]?.followerOf).toBeUndefined();
  });
});

describe("parallel upgrade behaviour", () => {
  test("one failure does not abort the other parallel upgrades", async () => {
    const { deps, hooks } = fakeDeps({
      // Fail everything attributable to claude: its npm install AND its
      // native fallback (the fake --help advertises "update", so without
      // this claude would quietly succeed through the fallback).
      spawn: async (command, args) => ({
        exitCode: command.includes("claude") || args.some((arg) => arg.includes("claude-code")) ? 1 : 0,
        stdout: "",
        stderr: "boom",
      }),
    });

    const summary = await runUpgradeWithDeps(deps, [oneSpec("claude"), oneSpec("codex")], hooks);

    expect(summary).toEqual({ checked: 1, failed: 1, skipped: 0 });
  });

  test("emits start then a terminal event per tool, and skip events for dedup followers", async () => {
    const { deps, hooks, events } = fakeDeps();

    const summary = await runUpgradeWithDeps(deps, [oneSpec("zai"), oneSpec("ali")], hooks);

    expect(summary).toEqual({ checked: 1, failed: 0, skipped: 0 });
    const aliEvents = events.filter((event) => event.id === "ali");
    expect(aliEvents.at(-1)).toEqual({ type: "skip", id: "ali", detail: "shares installer with zai" });
    const zaiEvents = events.filter((event) => event.id === "zai");
    expect(zaiEvents[0]).toEqual({ type: "start", id: "zai" });
    const zaiLast = zaiEvents.at(-1);
    expect(zaiLast?.type).toBe("finish");
    expect(zaiLast?.type === "finish" && zaiLast.ok).toBe(true);
  });

  test("surfaces a failed tool's captured installer output through onFailure", async () => {
    const failures: Array<{ toolName: string; reason: string; output: string }> = [];
    const { deps } = fakeDeps({
      spawn: async () => ({ exitCode: 1, stdout: "", stderr: "npm ERR! boom" }),
    });

    const summary = await runUpgradeWithDeps(deps, [oneSpec("codex")], {
      onFailure: (failure) => failures.push(failure),
    });

    expect(summary).toEqual({ checked: 0, failed: 1, skipped: 0 });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.toolName).toBe("codex");
    expect(failures[0]?.output).toContain("npm ERR! boom");
  });

  test("marks a dedup follower failed when its leader fails, without counting it twice", async () => {
    const { deps, hooks, events } = fakeDeps({
      spawn: async () => ({ exitCode: 1, stdout: "", stderr: "postinstall failed" }),
    });

    const summary = await runUpgradeWithDeps(deps, [oneSpec("zai"), oneSpec("ali")], hooks);

    expect(summary).toEqual({ checked: 0, failed: 1, skipped: 0 });
    const aliEvents = events.filter((event) => event.id === "ali");
    const aliLast = aliEvents.at(-1);
    expect(aliLast?.type).toBe("finish");
    expect(aliLast?.type === "finish" && aliLast.ok).toBe(false);
  });
});

describe("herdr row", () => {
  test("no herdr binary means no herdr events, spawns, or installs", async () => {
    const { deps, hooks, events, spawns } = fakeDeps({
      herdrBinary: () => null,
    });

    const summary = await runUpgradeWithDeps(deps, [oneSpec("claude")], hooks);

    expect(summary).toEqual({ checked: 1, failed: 0, skipped: 0 });
    expect(events.filter((event) => event.id === "herdr")).toEqual([]);
    expect(spawns.filter((call) => call.command.includes("herdr"))).toEqual([]);
  });

  test("an installed herdr runs its own updater as its own row", async () => {
    const { deps, hooks, events, spawns } = fakeDeps({
      herdrBinary: () => "/usr/bin/herdr",
      capture: async (command, args) => {
        if (command === "/usr/bin/herdr" && args[0] === "--version") {
          return { stdout: "herdr 0.8.2\n", stderr: "", exitCode: 0, timedOut: false };
        }
        return {
          stdout: "Grok Build TUI\nCommands:\n  update    Update to the latest version",
          stderr: "",
          exitCode: 0,
          timedOut: false,
        };
      },
    });

    const summary = await runUpgradeWithDeps(deps, [], hooks);

    expect(summary).toEqual({ checked: 1, failed: 0, skipped: 0 });
    expect(events.map((event) => event.id)).toEqual(["herdr", "herdr"]);
    expect(events[0]).toEqual({ type: "start", id: "herdr" });
    expect(spawns.some((call) => call.command === "/usr/bin/herdr" && call.args[0] === "update")).toBe(true);
    const last = events.at(-1);
    expect(last?.type).toBe("finish");
    expect(last?.type === "finish" && last.ok).toBe(true);
    expect(last?.type === "finish" && last.detail?.startsWith("already 0.8.2")).toBe(true);
  });

  test("a version transition is reported as before -> after", async () => {
    let installed = "0.8.2";
    const { deps, hooks, events } = fakeDeps({
      herdrBinary: () => "/usr/bin/herdr",
      capture: async (command, args) => {
        if (command === "/usr/bin/herdr" && args[0] === "--version") {
          return { stdout: `herdr ${installed}\n`, stderr: "", exitCode: 0, timedOut: false };
        }
        return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
      },
      spawn: async () => {
        installed = "0.8.3";
        return { exitCode: 0, stdout: "updated\n", stderr: "" };
      },
    });

    await runUpgradeWithDeps(deps, [], hooks);

    const last = events.at(-1);
    expect(last?.type).toBe("finish");
    expect(last?.type === "finish" && last.detail?.startsWith("0.8.2 -> 0.8.3")).toBe(true);
  });

  test("a failed herdr update is a failed row with the captured output surfaced", async () => {
    const failures: Array<{ toolName: string; reason: string; output: string }> = [];
    const { deps, events } = fakeDeps({
      herdrBinary: () => "/usr/bin/herdr",
      spawn: async (_command, args) => ({
        exitCode: args[0] === "update" ? 1 : 0,
        stdout: "",
        stderr: "download failed: connection reset",
      }),
    });

    const summary = await runUpgradeWithDeps(deps, [], {
      onEvent: (event) => events.push(event),
      onFailure: (failure) => failures.push(failure),
    });

    expect(summary).toEqual({ checked: 0, failed: 1, skipped: 0 });
    const last = events.at(-1);
    expect(last?.type).toBe("finish");
    expect(last?.type === "finish" && last.ok).toBe(false);
    expect(failures[0]?.toolName).toBe("herdr");
    expect(failures[0]?.output).toContain("connection reset");
  });

  test("an unreadable --version degrades to the generic 'updated' outcome, never a fake number", async () => {
    const { deps, events } = fakeDeps({
      herdrBinary: () => "/usr/bin/herdr",
      capture: async () => ({ stdout: "", stderr: "boom", exitCode: 1, timedOut: false }),
    });

    await runUpgradeWithDeps(deps, [], { onEvent: (event) => events.push(event) });

    const last = events.at(-1);
    expect(last?.type).toBe("finish");
    expect(last?.type === "finish" && last.detail?.startsWith("updated")).toBe(true);
  });

  test("running inside a herdr pane skips the row before spawning anything", async () => {
    const { deps, hooks, events, spawns, logs } = fakeDeps({
      herdrBinary: () => "/usr/bin/herdr",
      insideHerdr: () => true,
    });

    const summary = await runUpgradeWithDeps(deps, [], hooks);

    expect(summary).toEqual({ checked: 0, failed: 0, skipped: 1 });
    expect(events).toEqual([
      {
        type: "skip",
        id: "herdr",
        detail: "skipped (herdr is running; detach and rerun ais upgrade, or run herdr update yourself)",
      },
    ]);
    expect(spawns).toEqual([]);
    expect(logs.some((line) => line.includes("herdr is running in this session"))).toBe(true);
  });

  test("herdr's attached-refusal output is classified as skipped, never failed", async () => {
    const failures: Array<{ toolName: string; reason: string }> = [];
    const { deps, events } = fakeDeps({
      herdrBinary: () => "/usr/bin/herdr",
      insideHerdr: () => false,
      capture: async () => ({ stdout: "", stderr: "probe failure", exitCode: 1, timedOut: false }),
      spawn: async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "update failed: run `herdr update` outside herdr after detaching from the session",
      }),
    });

    const summary = await runUpgradeWithDeps(deps, [], {
      onEvent: (event) => events.push(event),
      onFailure: (failure) => failures.push(failure),
    });

    expect(summary).toEqual({ checked: 0, failed: 0, skipped: 1 });
    const last = events.at(-1);
    expect(last?.type).toBe("skip");
    expect(last?.type === "skip" && last.detail?.startsWith("skipped (herdr is running")).toBe(true);
    expect(failures).toEqual([]);
  });
});
