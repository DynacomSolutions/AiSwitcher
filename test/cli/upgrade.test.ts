import { describe, expect, test } from "bun:test";
import { BinaryResolutionError } from "../../src/identities/errors.ts";
import {
  GROK_INSTALLER_URL,
  MANAGED_NPM_PREFIX,
  UPGRADE_SPECS,
  helpListsUpdater,
  isOfficialXaiGrokHelp,
  resolvePublicNpmLatestVersion,
  runUpgradeWithDeps,
  UpgradeCancelledError,
  type UpgradeDeps,
} from "../../src/cli/upgrade.ts";

function oneSpec(toolName: string) {
  const spec = UPGRADE_SPECS.find((candidate) => candidate.cfg.toolName === toolName);
  if (!spec) throw new Error(`missing upgrade spec for ${toolName}`);
  return spec;
}

function fakeDeps(overrides: Partial<UpgradeDeps> = {}) {
  const spawns: Array<{ command: string; args: string[] }> = [];
  const logs: string[] = [];
  const deps: UpgradeDeps = {
    shimExists: async () => true,
    which: (command) => (command === "npm" ? "/usr/bin/npm" : null),
    resolve: (binaryName) => `/real/${binaryName}`,
    spawn: async (command, args) => {
      spawns.push({ command, args });
      return 0;
    },
    capture: async () => ({
      stdout: "Grok Build TUI\nCommands:\n  update    Update to the latest version",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    }),
    managedBinaryExists: async () => true,
    prepareManagedPrefix: async () => {},
    installGrok: async () => 0,
    log: (message) => logs.push(message),
    ...overrides,
  };
  return { deps, spawns, logs };
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

  test("distinguishes Grok Build from the similarly named community CLI", () => {
    expect(isOfficialXaiGrokHelp("Grok Build TUI\nCommands:\n  update")).toBe(true);
    expect(isOfficialXaiGrokHelp("AI coding agent powered by Grok\nCommands:\n  update")).toBe(false);
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
  test("rethrows cancellation from npm version lookup before fallback or later tools", async () => {
    const calls: string[] = [];
    const { deps } = fakeDeps({
      latestNpmVersion: async () => {
        calls.push("lookup");
        throw new UpgradeCancelledError(130);
      },
      spawn: async () => {
        calls.push("install");
        return 0;
      },
    });

    await expect(runUpgradeWithDeps(deps, [oneSpec("codex"), oneSpec("claude")])).rejects.toEqual(
      new UpgradeCancelledError(130),
    );
    expect(calls).toEqual(["lookup"]);
  });

  test("rethrows npm cancellation before attempting native fallback or later tools", async () => {
    const calls: string[] = [];
    const { deps } = fakeDeps({
      spawn: async () => {
        calls.push("npm");
        return 130;
      },
      resolve: () => {
        calls.push("resolve");
        return "/real/codex";
      },
    });

    await expect(runUpgradeWithDeps(deps, [oneSpec("codex"), oneSpec("claude")])).rejects.toEqual(
      new UpgradeCancelledError(130),
    );
    expect(calls).toEqual(["npm"]);
  });

  test("rethrows native fallback cancellation before moving to the next tool", async () => {
    const calls: string[] = [];
    const { deps } = fakeDeps({
      which: () => null,
      spawn: async () => {
        calls.push("native");
        return 130;
      },
      shimExists: async (toolName) => {
        calls.push(toolName);
        return true;
      },
    });

    await expect(runUpgradeWithDeps(deps, [oneSpec("codex"), oneSpec("claude")])).rejects.toEqual(
      new UpgradeCancelledError(130),
    );
    expect(calls).toEqual(["codex", "native"]);
  });

  test("rethrows cancellation from Grok native updater without installing", async () => {
    let installerCalls = 0;
    const { deps } = fakeDeps({
      spawn: async () => 143,
      installGrok: async () => {
        installerCalls++;
        return 0;
      },
    });

    await expect(runUpgradeWithDeps(deps, [oneSpec("grok")])).rejects.toEqual(new UpgradeCancelledError(143));
    expect(installerCalls).toBe(0);
  });

  test("rethrows cancellation from the Grok installer", async () => {
    const { deps } = fakeDeps({
      resolve: () => {
        throw new BinaryResolutionError("missing");
      },
      installGrok: async () => 131,
    });

    await expect(runUpgradeWithDeps(deps, [oneSpec("grok")])).rejects.toEqual(new UpgradeCancelledError(131));
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
          "--fetch-timeout=60000",
          "--fetch-retries=1",
          "--fetch-retry-mintimeout=1000",
          "--fetch-retry-maxtimeout=5000",
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

  test("pins a fresh public npm version and prefers the local cache", async () => {
    const { deps, spawns } = fakeDeps({ latestNpmVersion: async () => "0.144.6" });
    await runUpgradeWithDeps(deps, [oneSpec("codex")]);
    expect(spawns[0]?.args).toContain("--prefer-offline");
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

  test("falls back to npm @latest when the version lookup fails", async () => {
    const { deps, spawns } = fakeDeps({ latestNpmVersion: async () => undefined });
    await runUpgradeWithDeps(deps, [oneSpec("codex")]);
    expect(spawns[0]?.args).not.toContain("--prefer-offline");
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
        return 0;
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
        return 0;
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
        return 0;
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
        return 1;
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
