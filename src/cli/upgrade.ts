import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { resolveRealBinary, MANAGED_REAL_BIN_DIR } from "../shared/resolve-binary.ts";
import { spawnCapturedBounded, spawnReal, type BoundedSpawnResult } from "../shared/exec.ts";
import { BinaryResolutionError } from "../identities/errors.ts";
import {
  ALI_CONFIG,
  CLAUDE_CONFIG,
  CODEX_CONFIG,
  GROK_CONFIG,
  KIMI_CONFIG,
  PI_CONFIG,
  OPENCODE_CONFIG,
  ZAI_CONFIG,
} from "../identities/tool-configs.ts";
import type { ToolConfig } from "../identities/types.ts";
import { cyan, dim, green, red, yellow } from "./colors.ts";

/**
 * Real vendor CLIs managed by AIS live in an npm prefix separate from the
 * wrappers in ~/.local/bin. resolveRealBinary() prefers this prefix, so a
 * successful upgrade takes effect immediately even in an already-open shell.
 */
export const MANAGED_NPM_PREFIX = dirname(MANAGED_REAL_BIN_DIR);

const SHIM_DIR = process.env.AI_PROFILE_SWITCHER_SHIM_DIR ?? join(homedir(), ".local", "bin");
export const GROK_INSTALLER_URL = "https://x.ai/cli/install.sh";

interface UpgradeSpec {
  cfg: ToolConfig;
  npmPackage?: string;
  allowedScriptPackages?: string[];
  nativeUpdateArgs?: string[];
  installer: "npm" | "grok-script";
}

// Presence of this project's corresponding shim decides whether a real CLI
// is "meant to be installed" on this machine. Four tools have official npm
// distributions, which gives AIS one deterministic, user-owned install
// location without sudo or PATH-order dependence. xAI's documented installer
// provides the Grok Build standalone binary in ~/.grok/bin.
export const UPGRADE_SPECS: UpgradeSpec[] = [
  {
    cfg: CLAUDE_CONFIG,
    npmPackage: "@anthropic-ai/claude-code",
    allowedScriptPackages: ["@anthropic-ai/claude-code"],
    nativeUpdateArgs: ["update"],
    installer: "npm",
  },
  {
    cfg: CODEX_CONFIG,
    npmPackage: "@openai/codex",
    nativeUpdateArgs: ["update"],
    installer: "npm",
  },
  {
    cfg: GROK_CONFIG,
    nativeUpdateArgs: ["update"],
    installer: "grok-script",
  },
  {
    cfg: KIMI_CONFIG,
    npmPackage: "@moonshot-ai/kimi-code",
    allowedScriptPackages: ["@moonshot-ai/kimi-code", "node-pty"],
    nativeUpdateArgs: ["update"],
    installer: "npm",
  },
  {
    cfg: ZAI_CONFIG,
    npmPackage: "@charmland/crush",
    allowedScriptPackages: ["@charmland/crush"],
    installer: "npm",
  },
  // ali remains a separate shim/spec, but shares this physical installer
  // with zai. runUpgradeWithDeps caches an identical installer result so npm
  // never reruns Crush's network-bound postinstall in the same upgrade.
  {
    cfg: ALI_CONFIG,
    npmPackage: "@charmland/crush",
    allowedScriptPackages: ["@charmland/crush"],
    installer: "npm",
  },
  {
    cfg: PI_CONFIG,
    npmPackage: "@earendil-works/pi-coding-agent",
    installer: "npm",
  },
  {
    cfg: OPENCODE_CONFIG,
    npmPackage: "opencode-ai",
    allowedScriptPackages: ["opencode-ai"],
    nativeUpdateArgs: ["upgrade"],
    installer: "npm",
  },
];

export interface UpgradeDeps {
  shimExists(toolName: string): Promise<boolean>;
  which(command: string): string | null;
  resolve(binaryName: ToolConfig["realBinaryName"]): string;
  spawn(command: string, args: string[]): Promise<number>;
  capture(command: string, args: string[]): Promise<BoundedSpawnResult>;
  managedBinaryExists(binaryName: string): Promise<boolean>;
  prepareManagedPrefix(): Promise<void>;
  installGrok(): Promise<number>;
  log(message: string): void;
}

export interface UpgradeSummary {
  checked: number;
  failed: number;
  skipped: number;
}

interface SharedInstallerResult {
  toolName: string;
  ok: boolean;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Capability detection, not a version threshold: old Codex releases accepted
 * an arbitrary positional word as a chat prompt, so blindly running
 * `codex update` opened a TUI and then looked successful when Ctrl-C returned
 * exit code 0. Only a command explicitly listed in --help is safe to invoke.
 */
export function helpListsUpdater(help: string, command: string): boolean {
  const commandPattern = new RegExp(`^\\s*${command}(?:\\s|$)`);
  return stripAnsi(help)
    .split("\n")
    .some((line) => commandPattern.test(line));
}

export function isOfficialXaiGrokHelp(help: string): boolean {
  return stripAnsi(help).includes("Grok Build TUI");
}

function sharedInstallerKey(spec: UpgradeSpec): string | undefined {
  if (spec.installer !== "npm" || !spec.npmPackage) return undefined;

  // Include every field that changes installation or fallback behaviour.
  // Only genuinely interchangeable specs (currently zai and ali) coalesce.
  return [
    spec.npmPackage,
    spec.cfg.realBinaryName,
    spec.allowedScriptPackages?.join(",") ?? "",
    spec.nativeUpdateArgs?.join(",") ?? "",
  ].join("\0");
}

async function defaultInstallGrok(): Promise<number> {
  const response = await fetch(GROK_INSTALLER_URL);
  if (!response.ok) {
    throw new Error(`Grok installer download failed: HTTP ${response.status} (${GROK_INSTALLER_URL})`);
  }

  const tempDir = await mkdtemp(join(tmpdir(), "ais-grok-install."));
  const installerPath = join(tempDir, "install.sh");
  try {
    await Bun.write(installerPath, response);
    const bash = Bun.which("bash") ?? "/bin/bash";
    // xAI's installer edits shell startup files and may symlink directly into
    // ~/.local/bin only when ~/.grok/bin is absent from PATH. Supply that path
    // just for the installer and clear SHELL, keeping this project's shim and
    // the user's shell configuration untouched.
    const grokBinDir = join(homedir(), ".grok", "bin");
    const installerPathEnv = [grokBinDir, process.env.PATH ?? ""].filter(Boolean).join(delimiter);
    return await spawnReal(bash, [installerPath], { PATH: installerPathEnv, SHELL: "" });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function defaultDeps(): UpgradeDeps {
  return {
    shimExists: async (toolName) => await Bun.file(join(SHIM_DIR, toolName)).exists(),
    which: (command) => Bun.which(command),
    resolve: (binaryName) => resolveRealBinary(binaryName),
    spawn: async (command, args) => await spawnReal(command, args, {}),
    capture: async (command, args) => await spawnCapturedBounded(command, args, {}, 10_000),
    managedBinaryExists: async (binaryName) =>
      await Bun.file(join(MANAGED_REAL_BIN_DIR, binaryName)).exists(),
    prepareManagedPrefix: async () => {
      await mkdir(MANAGED_NPM_PREFIX, { recursive: true });
    },
    installGrok: defaultInstallGrok,
    log: console.log,
  };
}

function tryResolve(spec: UpgradeSpec, deps: UpgradeDeps): string | undefined {
  try {
    return deps.resolve(spec.cfg.realBinaryName);
  } catch (err) {
    if (err instanceof BinaryResolutionError) return undefined;
    throw err;
  }
}

async function supportsNativeUpdater(
  spec: UpgradeSpec,
  realBinary: string,
  deps: UpgradeDeps,
): Promise<boolean> {
  const command = spec.nativeUpdateArgs?.[0];
  if (!command) return false;
  const help = await deps.capture(realBinary, ["--help"]);
  if (help.timedOut || help.exitCode !== 0) return false;
  const output = `${help.stdout}\n${help.stderr}`;
  if (spec.cfg.toolName === "grok" && !isOfficialXaiGrokHelp(output)) return false;
  return helpListsUpdater(output, command);
}

async function runNativeFallback(spec: UpgradeSpec, deps: UpgradeDeps, prefix: string): Promise<boolean> {
  const realBinary = tryResolve(spec, deps);
  if (!realBinary || !(await supportsNativeUpdater(spec, realBinary, deps))) {
    deps.log(
      `${prefix} ${red(
        `${spec.cfg.toolName} has no usable managed installer and its installed binary exposes no safe updater`,
      )}`,
    );
    return false;
  }

  const updateArgs = spec.nativeUpdateArgs!;
  deps.log(`${prefix} running fallback ${cyan(`${spec.cfg.realBinaryName} ${updateArgs.join(" ")}`)} (${realBinary})`);
  return (await deps.spawn(realBinary, updateArgs)) === 0;
}

async function installNpmTool(spec: UpgradeSpec, deps: UpgradeDeps, prefix: string): Promise<boolean> {
  const npm = deps.which("npm");
  if (!npm) {
    deps.log(`${prefix} ${yellow("npm is unavailable; trying the installed CLI's native updater")}`);
    return await runNativeFallback(spec, deps, prefix);
  }

  await deps.prepareManagedPrefix();
  const packageSpec = `${spec.npmPackage}@latest`;
  const args = [
    "install",
    "--global",
    "--prefix",
    MANAGED_NPM_PREFIX,
    ...(spec.allowedScriptPackages?.length
      ? [`--allow-scripts=${spec.allowedScriptPackages.join(",")}`]
      : []),
    packageSpec,
  ];
  deps.log(`${prefix} installing/upgrading ${cyan(packageSpec)} in ${MANAGED_NPM_PREFIX}`);
  const exitCode = await deps.spawn(npm, args);
  const managedBinary = join(MANAGED_REAL_BIN_DIR, spec.cfg.realBinaryName);
  if (exitCode === 0 && (await deps.managedBinaryExists(spec.cfg.realBinaryName))) {
    const probe = await deps.capture(managedBinary, ["--version"]);
    if (!probe.timedOut && probe.exitCode === 0) return true;
  }

  deps.log(
    `${prefix} ${yellow(
      exitCode === 0
        ? `${packageSpec} finished but did not provide a runnable ${spec.cfg.realBinaryName}; trying the native updater`
        : `${packageSpec} exited with code ${exitCode}; trying the native updater`,
    )}`,
  );
  return await runNativeFallback(spec, deps, prefix);
}

async function installOrUpgradeGrok(spec: UpgradeSpec, deps: UpgradeDeps, prefix: string): Promise<boolean> {
  const realBinary = tryResolve(spec, deps);
  if (realBinary && (await supportsNativeUpdater(spec, realBinary, deps))) {
    const updateArgs = spec.nativeUpdateArgs!;
    deps.log(`${prefix} running ${cyan(`grok ${updateArgs.join(" ")}`)} (${realBinary})`);
    if ((await deps.spawn(realBinary, updateArgs)) === 0) return true;
    deps.log(`${prefix} ${yellow("Grok's native updater failed; reinstalling with xAI's installer")}`);
  } else {
    deps.log(`${prefix} Grok is missing or is not xAI's Grok Build CLI; installing the latest xAI release`);
  }

  const exitCode = await deps.installGrok();
  if (exitCode !== 0) return false;
  const installedBinary = tryResolve(spec, deps);
  return installedBinary !== undefined && (await supportsNativeUpdater(spec, installedBinary, deps));
}

export async function runUpgradeWithDeps(
  deps: UpgradeDeps,
  specs: UpgradeSpec[] = UPGRADE_SPECS,
): Promise<UpgradeSummary> {
  const prefix = dim("ais upgrade:");
  const summary: UpgradeSummary = { checked: 0, failed: 0, skipped: 0 };
  const sharedInstallerResults = new Map<string, SharedInstallerResult>();

  for (const spec of specs) {
    const name = spec.cfg.toolName;
    if (!(await deps.shimExists(name))) {
      summary.skipped++;
      deps.log(`${prefix} ${yellow(`${name} shim is not installed, skipping`)}`);
      continue;
    }

    const installerKey = sharedInstallerKey(spec);
    const sharedResult = installerKey ? sharedInstallerResults.get(installerKey) : undefined;
    if (sharedResult) {
      const packageSpec = `${spec.npmPackage}@latest`;
      deps.log(
        sharedResult.ok
          ? `${prefix} ${name} shares ${cyan(packageSpec)} with ${sharedResult.toolName}; already installed/upgraded`
          : `${prefix} ${red(
              `${name} shares ${packageSpec} with ${sharedResult.toolName}; the shared installer already failed`,
            )}`,
      );
      continue;
    }

    try {
      const ok =
        spec.installer === "npm"
          ? await installNpmTool(spec, deps, prefix)
          : await installOrUpgradeGrok(spec, deps, prefix);
      if (installerKey) sharedInstallerResults.set(installerKey, { toolName: name, ok });
      if (ok) summary.checked++;
      else {
        summary.failed++;
        deps.log(`${prefix} ${red(`${name} install/upgrade failed`)}`);
      }
    } catch (err) {
      summary.failed++;
      const message = err instanceof Error ? err.message : String(err);
      if (installerKey) {
        sharedInstallerResults.set(installerKey, { toolName: name, ok: false });
      }
      deps.log(`${prefix} ${red(`${name} install/upgrade failed: ${message}`)}`);
    }
  }

  return summary;
}

export async function runUpgrade(): Promise<void> {
  const prefix = dim("ais upgrade:");
  const summary = await runUpgradeWithDeps(defaultDeps());

  if (summary.failed > 0) {
    console.log(
      `${prefix} ${red(`done with errors: ${summary.checked} installed/upgraded, ${summary.failed} failed.`)}`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    summary.checked > 0
      ? `${prefix} ${green(
          `done, installed/upgraded ${summary.checked} real CLI${summary.checked === 1 ? "" : "s"}.`,
        )}`
      : `${prefix} no installed AIS shims require a real CLI.`,
  );
}
