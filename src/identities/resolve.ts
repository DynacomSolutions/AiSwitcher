import type { IdentitiesFile, ResolveOptions, ResolvedIdentity, ToolConfig } from "./types.ts";
import { expandPath, matchDirectory } from "./match.ts";
import { findIdentityByNameOrAlias, loadIdentitiesFile, saveIdentitiesFile } from "./store.ts";
import { promptForIdentity } from "./prompt.ts";
import { NonInteractiveResolutionError, RetiredIdentityError, UnknownIdentityError, UnknownPoolError } from "./errors.ts";
import { findRetiredByConfigDir, isRetired } from "./retired.ts";
import { adapterFor } from "./pool/registry.ts";
import { findPool, poolsOf } from "./pool/swap-pool.ts";

const DEFAULT_PROMPT_TIMEOUT_MS = 60_000;

export interface ResolveDeps {
  loadIdentitiesFile: typeof loadIdentitiesFile;
  saveIdentitiesFile: typeof saveIdentitiesFile;
  matchDirectory: typeof matchDirectory;
  promptForIdentity: typeof promptForIdentity;
  isInteractive: () => boolean;
}

const realIsInteractive = () =>
  Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);

export const defaultResolveDeps: ResolveDeps = {
  loadIdentitiesFile,
  saveIdentitiesFile,
  matchDirectory,
  promptForIdentity,
  isInteractive: realIsInteractive,
};

/**
 * A preset env var normally skips the registry. A retired identity must still
 * never launch through it, so look the value up among retired config dirs. A
 * missing or unreadable registry must not break the power-user override.
 */
async function assertEnvNotRetired(
  cfg: ToolConfig,
  envValue: string,
  deps: ResolveDeps,
): Promise<void> {
  let retired;
  try {
    const file = await deps.loadIdentitiesFile(cfg.identitiesJsonPath);
    retired = findRetiredByConfigDir(file.identities, expandPath(envValue));
  } catch {
    return;
  }
  if (retired) throw new RetiredIdentityError(cfg.toolName, retired);
}

export async function resolveIdentity(
  cfg: ToolConfig,
  opts: ResolveOptions,
  deps: ResolveDeps = defaultResolveDeps,
): Promise<ResolvedIdentity> {
  // Single-instance tools (pi) keep ordinary identities on one shared config
  // dir. An unresolved interactive launch offers the picker when an active
  // pool exists; selecting a pool uses its own config directory.
  if (cfg.singleInstanceDir) {
    return resolveSingleInstanceIdentity(cfg, opts, deps);
  }

  // (a) explicit --identity=<name> flag always wins outright.
  if (opts.explicitIdentityFlag) {
    const file = await deps.loadIdentitiesFile(cfg.identitiesJsonPath);
    const identity = findIdentityByNameOrAlias(file.identities, opts.explicitIdentityFlag);
    if (!identity) {
      throw new UnknownIdentityError(
        opts.explicitIdentityFlag,
        file.identities.map((i) => i.name),
      );
    }
    if (isRetired(identity)) throw new RetiredIdentityError(cfg.toolName, identity);
    return { identity, configDirValue: expandPath(identity.configDir), source: "flag" };
  }

  // (a2) explicit --pool=<name> launches a registered pool directly. A legacy
  // duplicate name (same configDir as an earlier record) resolves to the
  // canonical pool record.
  if (opts.explicitPoolFlag) {
    const file = await deps.loadIdentitiesFile(cfg.identitiesJsonPath);
    const pool = findPool(file, opts.explicitPoolFlag);
    if (!pool) {
      throw new UnknownPoolError(
        opts.explicitPoolFlag,
        poolsOf(file).map((p) => p.name),
      );
    }
    return { identity: pool, configDirValue: expandPath(pool.configDir), source: "flag" };
  }

  // (b) an already-set env var is an explicit override — skip everything
  // else. Preserves nested/child-session inheritance (e.g. subagents) and
  // deliberate manual power-user overrides.
  const presetEnvValue = opts.env[cfg.envVarName];
  if (presetEnvValue && !opts.pickerMode) {
    await assertEnvNotRetired(cfg, presetEnvValue, deps);
    return { identity: undefined, configDirValue: presetEnvValue, source: "env" };
  }

  // (c) directory-pattern match against cwd, if unique.
  const file = await deps.loadIdentitiesFile(cfg.identitiesJsonPath);
  let matchResult = opts.pickerMode ? undefined : deps.matchDirectory(opts.cwd, file.identities);
  // A retired identity tying with active ones must not make the match
  // ambiguous (that would block every non-interactive launch): drop the
  // retired candidates from the tie. A unique best match that is itself
  // retired is still refused below.
  if (matchResult && "ambiguous" in matchResult) {
    if (matchResult.candidates.some(isRetired) && !matchResult.candidates.every(isRetired)) {
      // Re-match against the active identities only: they hold the same
      // tied best score, so this yields the unique or still-ambiguous result.
      matchResult = deps.matchDirectory(opts.cwd, file.identities.filter((i) => !isRetired(i)));
    }
  }
  if (matchResult && !("ambiguous" in matchResult)) {
    // Refuse rather than silently switching to some other identity: the
    // directory was explicitly bound to this one.
    if (isRetired(matchResult.identity)) throw new RetiredIdentityError(cfg.toolName, matchResult.identity);
    return {
      identity: matchResult.identity,
      configDirValue: expandPath(matchResult.identity.configDir),
      source: "directory-match",
    };
  }
  if (matchResult && "ambiguous" in matchResult) {
    console.error(
      `${cfg.toolName}: cwd matches multiple identities [${matchResult.candidates
        .map((c) => c.name)
        .join(", ")}] with equally-specific directory patterns — falling back to interactive selection.`,
    );
  }

  // (d) no unique match — interactive prompt (bounded by a hard timeout), or
  // a loud, fast error in any non-interactive context.
  const nonInteractive = Boolean(opts.nonInteractiveHint) || !deps.isInteractive();
  if (nonInteractive) {
    throw new NonInteractiveResolutionError(
      `${cfg.toolName}: no --identity given, no ${cfg.envVarName} set, and no unique ` +
        `directory match for "${opts.cwd}" — refusing to prompt in a non-interactive context. ` +
        `Pass --identity=<name> explicitly.`,
    );
  }

  const timeoutMs = opts.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;
  const { identity, created } = await deps.promptForIdentity(file, cfg, timeoutMs, undefined, opts.pickerMode);
  return {
    identity,
    configDirValue: expandPath(identity.configDir),
    source: created ? "interactive-created" : "interactive-existing",
  };
}

/**
 * Resolution for single-instance tools (ToolConfig.singleInstanceDir - pi).
 * Ordinary identities use the shared instance dir; pool identities use their
 * configured pool directory. Without active pools or an explicit picker mode,
 * no-match still launches the shared instance without prompting. An explicit
 * --identity must still name a real registry entry, and a preset
 * PI_CODING_AGENT_DIR remains a power-user override of the whole instance.
 */
export async function resolveSingleInstanceIdentity(
  cfg: ToolConfig,
  opts: ResolveOptions,
  deps: ResolveDeps = defaultResolveDeps,
): Promise<ResolvedIdentity> {
  if (!cfg.singleInstanceDir) {
    throw new Error(`${cfg.toolName}: resolveSingleInstanceIdentity requires singleInstanceDir`);
  }
  const file = await deps.loadIdentitiesFile(cfg.identitiesJsonPath);

  // (a) explicit --identity=<name> must exist. Ordinary identities seed the
  // in-app default in the shared dir; a pool identity uses its own directory.
  if (opts.explicitIdentityFlag) {
    const identity = findIdentityByNameOrAlias(file.identities, opts.explicitIdentityFlag);
    if (!identity) {
      throw new UnknownIdentityError(
        opts.explicitIdentityFlag,
        file.identities.map((i) => i.name),
      );
    }
    if (isRetired(identity)) throw new RetiredIdentityError(cfg.toolName, identity);
    return {
      identity,
      configDirValue: expandPath(identity.swapPool ? identity.configDir : cfg.singleInstanceDir),
      source: "flag",
    };
  }

  // An explicit pool is a separate runtime config for pi. It must use the
  // pool's own directory so the pool adapter's credentials are loaded. A
  // legacy duplicate name resolves to the canonical record for its configDir.
  if (opts.explicitPoolFlag) {
    const pool = findPool(file, opts.explicitPoolFlag);
    if (!adapterFor(cfg.toolName) || !pool) {
      throw new UnknownPoolError(opts.explicitPoolFlag, poolsOf(file).map((p) => p.name));
    }
    return { identity: pool, configDirValue: expandPath(pool.configDir), source: "flag" };
  }

  // (b) preset env var: power-user override of the whole instance dir.
  const presetEnvValue = opts.env[cfg.envVarName];
  if (presetEnvValue && !opts.pickerMode) {
    await assertEnvNotRetired(cfg, presetEnvValue, deps);
    return { identity: undefined, configDirValue: presetEnvValue, source: "env" };
  }

  // (c) directory match seeds an ordinary identity in the shared instance; a
  // matched pool uses its pool directory. Ambiguity is demoted to "no seed".
  const matchResult = opts.pickerMode ? undefined : deps.matchDirectory(opts.cwd, file.identities);
  // A retired match is ignored: it must never seed the in-app default.
  if (matchResult && !("ambiguous" in matchResult) && !isRetired(matchResult.identity)) {
    return {
      identity: matchResult.identity,
      configDirValue: expandPath(
        matchResult.identity.swapPool ? matchResult.identity.configDir : cfg.singleInstanceDir,
      ),
      source: "directory-match",
    };
  }
  if (matchResult && "ambiguous" in matchResult) {
    console.error(
      `${cfg.toolName}: cwd matches multiple identities [${matchResult.candidates
        .map((c) => c.name)
        .join(", ")}] - no unique default identity; falling back to interactive selection when available.`,
    );
  }

  const hasPools =
    adapterFor(cfg.toolName) !== undefined && file.identities.some((i) => i.swapPool !== undefined && !isRetired(i));
  if (opts.pickerMode || (hasPools && !opts.nonInteractiveHint && deps.isInteractive())) {
    if (opts.nonInteractiveHint || !deps.isInteractive()) {
      throw new NonInteractiveResolutionError(
        `${cfg.toolName}: pool or identity selection needs an interactive terminal. Pass --identity=<name> or --pool=<name>.`,
      );
    }
    const timeoutMs = opts.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;
    const { identity, created } = await deps.promptForIdentity(file, cfg, timeoutMs, undefined, opts.pickerMode);
    return {
      identity,
      configDirValue: expandPath(identity.swapPool ? identity.configDir : cfg.singleInstanceDir),
      source: created ? "interactive-created" : "interactive-existing",
    };
  }

  // (d) no picker was requested: launch the shared instance plain. With pools,
  // this includes noninteractive invocations that cannot open a prompt.
  return { identity: undefined, configDirValue: expandPath(cfg.singleInstanceDir), source: "single-instance" };
}
