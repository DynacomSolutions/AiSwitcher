import { describe, expect, test } from "bun:test";
import { BinaryResolutionError } from "../../src/identities/errors.ts";
import {
  GROK_INSTALLER_URL,
  MANAGED_NPM_PREFIX,
  UPGRADE_SPECS,
  helpListsUpdater,
  isOfficialXaiGrokHelp,
  runUpgradeWithDeps,
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
  test("ali gets its own spec, sharing the same @charmland/crush npm package as zai", () => {
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

describe("runUpgradeWithDeps", () => {
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

  test("allows only Kimi's known install-script packages", async () => {
    const { deps, spawns } = fakeDeps();

    const summary = await runUpgradeWithDeps(deps, [oneSpec("kimi")]);

    expect(summary).toEqual({ checked: 1, failed: 0, skipped: 0 });
    expect(spawns[0]?.args).toContain("--allow-scripts=@moonshot-ai/kimi-code,node-pty");
  });
});
