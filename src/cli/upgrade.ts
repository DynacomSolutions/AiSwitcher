import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { resolveRealBinary, MANAGED_REAL_BIN_DIR } from "../shared/resolve-binary.ts";
import { spawnCaptured, spawnCapturedBounded, type BoundedSpawnResult, type CapturedRunResult } from "../shared/exec.ts";
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
import { spinnerChar, withLiveRender } from "./live.ts";
import {
  applyUpgradeEvent,
  createUpgradeRows,
  formatUpgradeFrame,
  type UpgradeEvent,
  type UpgradeRow,
} from "./upgrade-status.ts";

/**
 * Real vendor CLIs managed by AIS live in an npm prefix separate from the
 * wrappers in ~/.local/bin. resolveRealBinary() prefers this prefix, so a
 * successful upgrade takes effect immediately even in an already-open shell.
 */
export const MANAGED_NPM_PREFIX = dirname(MANAGED_REAL_BIN_DIR);

const SHIM_DIR = process.env.AI_PROFILE_SWITCHER_SHIM_DIR ?? join(homedir(), ".local", "bin");
export const GROK_INSTALLER_URL = "https://x.ai/cli/install.sh";

export class UpgradeCancelledError extends Error {
  readonly exitCode: number;

  constructor(exitCode: number) {
    super(`upgrade cancelled (exit code ${exitCode})`);
    this.name = "UpgradeCancelledError";
    this.exitCode = exitCode;
  }
}

const CANCELLATION_EXIT_CODES = new Set([129, 130, 131, 143]);
const HEARTBEAT_INTERVAL_MS = 15_000;
const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org/";
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const FAILURE_OUTPUT_MAX_LINES = 30;
const FAILURE_NARRATIVE_MAX_LINES = 10;

/** Heartbeats only; the cancellation check lives with the caller, which owns
 * the result's exit code (see cancellationFor). */
async function awaitUpgradeStep<T>(promise: Promise<T>, label: string, log: (message: string) => void): Promise<T> {
  const heartbeat = setInterval(() => log(`ais upgrade: still working on ${label}...`), HEARTBEAT_INTERVAL_MS);
  try {
    return await promise;
  } finally {
    clearInterval(heartbeat);
  }
}

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
  // with zai. planUpgrades keeps one leader per identical installer key and
  // the follower awaits the shared result, so npm never reruns Crush's
  // network-bound postinstall in the same upgrade.
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
  /** Fully-captured installer run (see spawnCaptured): output is buffered
   * per tool and only surfaced on failure or in non-TTY failure reports,
   * never streamed into the live status list. */
  spawn(command: string, args: string[]): Promise<CapturedRunResult>;
  capture(command: string, args: string[]): Promise<BoundedSpawnResult>;
  managedBinaryExists(binaryName: string): Promise<boolean>;
  prepareManagedPrefix(): Promise<void>;
  installGrok(): Promise<CapturedRunResult>;
  latestNpmVersion?(npm: string, packageName: string): Promise<string | undefined>;
  managedNpmVersion?(packageName: string): Promise<string | undefined>;
  log(message: string): void;
}

export interface NpmVersionResolverDeps {
  capture(command: string, args: string[]): Promise<BoundedSpawnResult>;
  fetch(url: string): Promise<{ ok: boolean; json(): Promise<unknown> }>;
}

/** Runner-to-caller callbacks. onEvent drives the status model (rows in the
 * caller's closure) and non-TTY start/finish lines; onFailure hands over a
 * tool's captured narrative and installer output for the failure report. */
export interface UpgradeRunHooks {
  onEvent?(event: UpgradeEvent): void;
  onFailure?(failure: UpgradeFailure): void;
}

export interface UpgradeFailure {
  toolName: string;
  reason: string;
  logLines: string[];
  output: string;
}

function cancellationFor(exitCode: number): UpgradeCancelledError | undefined {
  return CANCELLATION_EXIT_CODES.has(exitCode) ? new UpgradeCancelledError(exitCode) : undefined;
}

function isRegistryUnset(value: string): boolean {
  return /^(undefined|null)?$/i.test(value.trim());
}

function isPublicNpmRegistry(value: string): boolean {
  return `${value.trim().replace(/\/+$/, "")}/` === PUBLIC_NPM_REGISTRY;
}

/** Resolve an exact release only when npm is configured for the public registry. */
export async function resolvePublicNpmLatestVersion(
  npm: string,
  packageName: string,
  deps: NpmVersionResolverDeps,
): Promise<string | undefined> {
  const scope = packageName.startsWith("@") ? packageName.split("/")[0] : undefined;
  let probe = await deps.capture(npm, ["config", "get", scope ? `${scope}:registry` : "registry"]);
  const cancelled = cancellationFor(probe.exitCode);
  if (cancelled) throw cancelled;

  if (scope && probe.exitCode === 0 && isRegistryUnset(probe.stdout)) {
    probe = await deps.capture(npm, ["config", "get", "registry"]);
    const fallbackCancelled = cancellationFor(probe.exitCode);
    if (fallbackCancelled) throw fallbackCancelled;
  }
  if (probe.exitCode !== 0 || probe.timedOut || !isPublicNpmRegistry(probe.stdout)) return undefined;

  try {
    const response = await deps.fetch(
      `${PUBLIC_NPM_REGISTRY}${encodeURIComponent(packageName).replace("%40", "@").replaceAll("%2F", "%2f")}/latest`,
    );
    if (!response.ok) return undefined;
    const metadata = (await response.json()) as { name?: unknown; version?: unknown };
    return metadata.name === packageName && typeof metadata.version === "string" && SEMVER_PATTERN.test(metadata.version)
      ? metadata.version
      : undefined;
  } catch {
    return undefined;
  }
}

export interface UpgradeSummary {
  checked: number;
  failed: number;
  skipped: number;
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

/** One planned entry per installed spec. Specs sharing an installer key
 * (currently zai and ali) collapse onto a single leader whose physical
 * installer runs exactly once; followers await the leader's result instead
 * of launching their own. Pure apart from the injected shim check. */
export interface PlannedUpgrade {
  spec: UpgradeSpec;
  followerOf?: string;
}

export async function planUpgrades(
  specs: readonly UpgradeSpec[],
  shimExists: (toolName: string) => Promise<boolean>,
): Promise<{ planned: PlannedUpgrade[]; missingShims: UpgradeSpec[] }> {
  const installed = await Promise.all(specs.map(async (spec) => await shimExists(spec.cfg.toolName)));
  const missingShims: UpgradeSpec[] = [];
  const present: UpgradeSpec[] = [];
  specs.forEach((spec, i) => (installed[i] ? present : missingShims).push(spec));

  const leaderFor = new Map<string, string>();
  const planned: PlannedUpgrade[] = present.map((spec) => {
    const key = sharedInstallerKey(spec);
    if (!key) return { spec };
    const leader = leaderFor.get(key);
    if (leader) return { spec, followerOf: leader };
    leaderFor.set(key, spec.cfg.toolName);
    return { spec };
  });
  return { planned, missingShims };
}

async function defaultInstallGrok(): Promise<CapturedRunResult> {
  const response = await fetch(GROK_INSTALLER_URL, { signal: AbortSignal.timeout(60_000) });
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
    // the user's shell configuration untouched. Captured (not inherited), so
    // the installer's own output can never interleave into the status list.
    const grokBinDir = join(homedir(), ".grok", "bin");
    const installerPathEnv = [grokBinDir, process.env.PATH ?? ""].filter(Boolean).join(delimiter);
    return await spawnCaptured(bash, [installerPath], { PATH: installerPathEnv, SHELL: "" });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function defaultDeps(log: (message: string) => void = console.log): UpgradeDeps {
  return {
    shimExists: async (toolName) => await Bun.file(join(SHIM_DIR, toolName)).exists(),
    which: (command) => Bun.which(command),
    resolve: (binaryName) => resolveRealBinary(binaryName),
    spawn: async (command, args) => await spawnCaptured(command, args, {}),
    capture: async (command, args) => await spawnCapturedBounded(command, args, {}, 10_000),
    managedBinaryExists: async (binaryName) =>
      await Bun.file(join(MANAGED_REAL_BIN_DIR, binaryName)).exists(),
    prepareManagedPrefix: async () => {
      await mkdir(MANAGED_NPM_PREFIX, { recursive: true });
    },
    installGrok: defaultInstallGrok,
    latestNpmVersion: async (npm, packageName) =>
      await resolvePublicNpmLatestVersion(npm, packageName, {
        capture: async (command, args) => await spawnCapturedBounded(command, args, {}, 10_000),
        fetch: async (url) => await fetch(url, { signal: AbortSignal.timeout(15_000) }),
      }),
    managedNpmVersion: async (packageName) => {
      try {
        const manifest = (await Bun.file(join(MANAGED_NPM_PREFIX, "lib", "node_modules", packageName, "package.json")).json()) as {
          name?: unknown;
          version?: unknown;
        };
        return manifest.name === packageName && typeof manifest.version === "string" && SEMVER_PATTERN.test(manifest.version)
          ? manifest.version
          : undefined;
      } catch {
        return undefined;
      }
    },
    log,
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

interface UpgradeInstallResult {
  ok: boolean;
  /** Version transition for the status row, e.g. "0.144.5 -> 0.144.6" or
   * "already 0.144.6". Undefined when the installer cannot know versions
   * (native updaters, Grok's installer); the runner then shows "updated". */
  detail?: string;
}

function describeVersionChange(before: string | undefined, after: string | undefined): string | undefined {
  if (!after) return undefined;
  if (!before) return after;
  if (before === after) return `${after} (reinstalled)`;
  return `${before} -> ${after}`;
}

async function runNativeFallback(spec: UpgradeSpec, deps: UpgradeDeps, prefix: string): Promise<UpgradeInstallResult> {
  const realBinary = tryResolve(spec, deps);
  if (!realBinary || !(await supportsNativeUpdater(spec, realBinary, deps))) {
    deps.log(
      `${prefix} ${red(
        `${spec.cfg.toolName} has no usable managed installer and its installed binary exposes no safe updater`,
      )}`,
    );
    return { ok: false };
  }

  const updateArgs = spec.nativeUpdateArgs!;
  deps.log(`${prefix} running fallback ${cyan(`${spec.cfg.realBinaryName} ${updateArgs.join(" ")}`)} (${realBinary})`);
  const result = await awaitUpgradeStep(deps.spawn(realBinary, updateArgs), `${spec.cfg.toolName} native updater`, deps.log);
  const cancelled = cancellationFor(result.exitCode);
  if (cancelled) throw cancelled;
  return { ok: result.exitCode === 0 };
}

async function installNpmTool(spec: UpgradeSpec, deps: UpgradeDeps, prefix: string): Promise<UpgradeInstallResult> {
  if (!spec.npmPackage) {
    throw new Error(`${spec.cfg.toolName} has no npm package`);
  }
  const npm = deps.which("npm");
  if (!npm) {
    deps.log(`${prefix} ${yellow("npm is unavailable; trying the installed CLI's native updater")}`);
    return await runNativeFallback(spec, deps, prefix);
  }

  await deps.prepareManagedPrefix();
  const npmPackage = spec.npmPackage;
  let version: string | undefined;
  if (deps.latestNpmVersion) {
    try {
      version = await awaitUpgradeStep(
        deps.latestNpmVersion(npm, npmPackage),
        `${spec.cfg.toolName} npm version lookup`,
        deps.log,
      );
    } catch (err) {
      if (err instanceof UpgradeCancelledError) throw err;
      deps.log(`${prefix} latest ${npmPackage} lookup failed; using npm @latest (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  const resolvedPackageSpec = `${npmPackage}@${version ?? "latest"}`;
  const previousVersion = deps.managedNpmVersion ? await deps.managedNpmVersion(npmPackage) : undefined;
  if (version && previousVersion === version) {
    try {
      const probe = await deps.capture(join(MANAGED_REAL_BIN_DIR, spec.cfg.realBinaryName), ["--version"]);
      const cancelled = cancellationFor(probe.exitCode);
      if (cancelled) throw cancelled;
      if (!probe.timedOut && probe.exitCode === 0) {
        deps.log(`${prefix} ${spec.cfg.toolName} ${version} already up to date`);
        return { ok: true, detail: `already ${version}` };
      }
    } catch (err) {
      if (err instanceof UpgradeCancelledError) throw err;
    }
  }
  const args = [
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
    ...(version ? ["--prefer-online"] : []),
    ...(spec.allowedScriptPackages?.length
      ? [`--allow-scripts=${spec.allowedScriptPackages.join(",")}`]
      : []),
    resolvedPackageSpec,
  ];
  deps.log(`${prefix} installing/upgrading ${cyan(resolvedPackageSpec)} in ${MANAGED_NPM_PREFIX}`);
  const result = await awaitUpgradeStep(deps.spawn(npm, args), `${spec.cfg.toolName} npm installer`, deps.log);
  const cancelled = cancellationFor(result.exitCode);
  if (cancelled) throw cancelled;
  const managedBinary = join(MANAGED_REAL_BIN_DIR, spec.cfg.realBinaryName);
  if (result.exitCode === 0 && (await deps.managedBinaryExists(spec.cfg.realBinaryName))) {
    const probe = await deps.capture(managedBinary, ["--version"]);
    if (!probe.timedOut && probe.exitCode === 0) {
      const updatedVersion = deps.managedNpmVersion ? await deps.managedNpmVersion(npmPackage) : undefined;
      return { ok: true, detail: describeVersionChange(previousVersion, updatedVersion) };
    }
  }

  deps.log(
    `${prefix} ${yellow(
      result.exitCode === 0
        ? `${resolvedPackageSpec} finished but did not provide a runnable ${spec.cfg.realBinaryName}; trying the native updater`
        : `${resolvedPackageSpec} exited with code ${result.exitCode}; trying the native updater`,
    )}`,
  );
  return await runNativeFallback(spec, deps, prefix);
}

async function installOrUpgradeGrok(spec: UpgradeSpec, deps: UpgradeDeps, prefix: string): Promise<UpgradeInstallResult> {
  const realBinary = tryResolve(spec, deps);
  if (realBinary && (await supportsNativeUpdater(spec, realBinary, deps))) {
    const updateArgs = spec.nativeUpdateArgs!;
    deps.log(`${prefix} running ${cyan(`grok ${updateArgs.join(" ")}`)} (${realBinary})`);
    const update = await awaitUpgradeStep(deps.spawn(realBinary, updateArgs), "grok native updater", deps.log);
    const updateCancelled = cancellationFor(update.exitCode);
    if (updateCancelled) throw updateCancelled;
    if (update.exitCode === 0) return { ok: true };
    deps.log(`${prefix} ${yellow("Grok's native updater failed; reinstalling with xAI's installer")}`);
  } else {
    deps.log(`${prefix} Grok is missing or is not xAI's Grok Build CLI; installing the latest xAI release`);
  }

  const install = await awaitUpgradeStep(deps.installGrok(), "grok installer", deps.log);
  const cancelled = cancellationFor(install.exitCode);
  if (cancelled) throw cancelled;
  if (install.exitCode !== 0) return { ok: false };
  const installedBinary = tryResolve(spec, deps);
  const usable = installedBinary !== undefined && (await supportsNativeUpdater(spec, installedBinary, deps));
  return usable ? { ok: true } : { ok: false };
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function combineOutput(results: readonly CapturedRunResult[]): string {
  return results
    .map((result) => [result.stdout, result.stderr].filter((part) => part.trim().length > 0).join("\n").trimEnd())
    .filter((part) => part.length > 0)
    .join("\n");
}

function emit(hooks: UpgradeRunHooks, event: UpgradeEvent): void {
  hooks.onEvent?.(event);
}

/**
 * Runs every installed tool's upgrade IN PARALLEL and reports per-tool
 * progress through hooks instead of printing anything itself. Tools whose
 * specs share an installer key still run the physical installer exactly
 * once: the first spec of each key is the leader, the rest are followers
 * that await the leader's outcome (a leader failure fails its followers'
 * rows but is only counted once in the summary, matching the historical
 * sequential behaviour). Failures never abort sibling upgrades; a
 * cancellation exit code (Ctrl-C and friends) stops being ignored, lets the
 * already-running installs settle, and is rethrown once everything
 * terminates so callers can set the process exit code.
 */
export async function runUpgradeWithDeps(
  deps: UpgradeDeps,
  specs: UpgradeSpec[] = UPGRADE_SPECS,
  hooks: UpgradeRunHooks = {},
): Promise<UpgradeSummary> {
  const prefix = dim("ais upgrade:");
  const summary: UpgradeSummary = { checked: 0, failed: 0, skipped: 0 };
  const { planned, missingShims } = await planUpgrades(specs, deps.shimExists);
  let cancellation: UpgradeCancelledError | undefined;

  for (const spec of missingShims) {
    const name = spec.cfg.toolName;
    summary.skipped++;
    emit(hooks, { type: "skip", id: name, detail: "no shim" });
    deps.log(`${prefix} ${yellow(`${name} shim is not installed, skipping`)}`);
  }

  const runTask = async (task: PlannedUpgrade): Promise<void> => {
    const name = task.spec.cfg.toolName;
    const logLines: string[] = [];
    const spawned: CapturedRunResult[] = [];
    const log = (line: string) => {
      logLines.push(line);
      deps.log(line);
    };
    const taskDeps: UpgradeDeps = {
      ...deps,
      log,
      spawn: async (command, args) => {
        const result = await deps.spawn(command, args);
        spawned.push(result);
        return result;
      },
    };
    emit(hooks, { type: "start", id: name });
    const startedAt = Date.now();
    let outcome: { ok: boolean; detail?: string; reason?: string };
    try {
      const result =
        task.spec.installer === "npm"
          ? await installNpmTool(task.spec, taskDeps, prefix)
          : await installOrUpgradeGrok(task.spec, taskDeps, prefix);
      outcome = { ok: result.ok, detail: result.detail };
    } catch (err) {
      if (err instanceof UpgradeCancelledError) {
        cancellation = cancellation ?? err;
        outcome = { ok: false, reason: "cancelled" };
      } else {
        outcome = { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    }
    const elapsed = formatSeconds(Date.now() - startedAt);
    if (outcome.ok) {
      emit(hooks, { type: "finish", id: name, ok: true, detail: `${outcome.detail ?? "updated"} (${elapsed})` });
      summary.checked++;
    } else {
      const reason = outcome.reason ?? "install/upgrade failed";
      emit(hooks, { type: "finish", id: name, ok: false, detail: `${reason} (${elapsed})` });
      summary.failed++;
      hooks.onFailure?.({
        toolName: name,
        reason,
        logLines,
        output: combineOutput(spawned),
      });
    }

    // Resolve this leader's dedup followers now, so their rows settle the
    // moment the shared installer's outcome is known.
    for (const other of planned) {
      if (other.followerOf !== name) continue;
      const followerName = other.spec.cfg.toolName;
      if (outcome.ok) {
        const packageSpec = `${other.spec.npmPackage}@latest`;
        deps.log(`${prefix} ${followerName} shares ${cyan(packageSpec)} with ${name}; already installed/upgraded`);
        emit(hooks, { type: "skip", id: followerName, detail: `shares installer with ${name}` });
      } else {
        const packageSpec = `${other.spec.npmPackage}@latest`;
        deps.log(`${prefix} ${red(`${followerName} shares ${packageSpec} with ${name}; the shared installer already failed`)}`);
        emit(hooks, { type: "finish", id: followerName, ok: false, detail: `shares installer with ${name}, which failed` });
      }
    }
  };

  await Promise.all(planned.filter((task) => !task.followerOf).map(runTask));
  if (cancellation) throw cancellation;
  return summary;
}

function printUpgradeEventLine(prefix: string, event: UpgradeEvent): void {
  if (event.type === "start") {
    console.log(`${prefix} ${event.id}: upgrading...`);
    return;
  }
  if (event.type === "skip") return;
  console.log(`${prefix} ${event.id}: ${event.ok ? green("done") : red("failed")}${event.detail ? ` ${event.detail}` : ""}`);
}

function outputTail(output: string): string | undefined {
  const lines = stripAnsi(output)
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return undefined;
  return lines.slice(-FAILURE_OUTPUT_MAX_LINES).join("\n");
}

function printFailureDetails(failure: UpgradeFailure, prefix: string, includeNarrative: boolean): void {
  const lines: string[] = [];
  if (includeNarrative) {
    lines.push(`${prefix} ${red(`${failure.toolName} failed: ${failure.reason}`)}`);
    lines.push(...failure.logLines.slice(-FAILURE_NARRATIVE_MAX_LINES).map((line) => `  ${stripAnsi(line)}`));
  }
  const tail = outputTail(failure.output);
  if (tail) lines.push(...tail.split("\n").map((line) => `  ${dim(line)}`));
  if (lines.length > 0) console.log(lines.join("\n"));
}

function printUpgradeSummary(prefix: string, summary: UpgradeSummary, elapsed: string): void {
  const skippedNote = summary.skipped > 0 ? ` (${summary.skipped} skipped)` : "";
  if (summary.failed > 0) {
    console.log(
      `${prefix} ${red(
        `done with errors: ${summary.checked} installed/upgraded, ${summary.failed} failed in ${elapsed}.${skippedNote}`,
      )}`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    summary.checked > 0
      ? `${prefix} ${green(
          `done, installed/upgraded ${summary.checked} real CLI${summary.checked === 1 ? "" : "s"} in ${elapsed}.${skippedNote}`,
        )}`
      : `${prefix} no installed AIS shims require a real CLI.`,
  );
}

export async function runUpgrade(): Promise<void> {
  const prefix = dim("ais upgrade:");
  // Live status list only on a real TTY, where redrawing in place means
  // something (the same requirement limits/dispatch.ts already has). Piped
  // or CI output falls back to plain sequential-style start/finish lines.
  const live = process.stdout.isTTY === true;
  const startedAt = Date.now();
  let rows: UpgradeRow[] = createUpgradeRows(UPGRADE_SPECS.map((spec) => spec.cfg.toolName));
  const failures: UpgradeFailure[] = [];

  const run = () =>
    runUpgradeWithDeps(defaultDeps(live ? () => {} : console.log), UPGRADE_SPECS, {
      onEvent: (event) => {
        rows = applyUpgradeEvent(rows, event);
        if (!live) printUpgradeEventLine(prefix, event);
      },
      onFailure: (failure) => failures.push(failure),
    });

  let summary!: UpgradeSummary;
  try {
    if (live) {
      await withLiveRender(
        (tick) => formatUpgradeFrame(rows, spinnerChar(tick)),
        async () => {
          summary = await run();
        },
        // The terminal's SIGINT already reaches the captured installer
        // children directly; their cancellation exit codes settle the run
        // and set the real process exit code, so the render loop must not
        // exit(0) out from under that protocol.
        { onInterrupt: () => {} },
      );
    } else {
      summary = await run();
    }
  } catch (err) {
    if (err instanceof UpgradeCancelledError) {
      console.error(`${prefix} ${yellow("cancelled")}`);
      process.exitCode = err.exitCode;
      return;
    }
    throw err;
  }

  const elapsed = formatSeconds(Date.now() - startedAt);
  for (const failure of failures) printFailureDetails(failure, prefix, live);
  printUpgradeSummary(prefix, summary, elapsed);
}
