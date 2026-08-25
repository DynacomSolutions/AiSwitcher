import type { IdentitiesFile, ResolveOptions, ResolvedIdentity, ToolConfig } from "./types.ts";
import { expandPath, matchDirectory } from "./match.ts";
import { findIdentityByNameOrAlias, loadIdentitiesFile, saveIdentitiesFile } from "./store.ts";
import { promptForIdentity } from "./prompt.ts";
import { NonInteractiveResolutionError, UnknownIdentityError } from "./errors.ts";

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

export async function resolveIdentity(
  cfg: ToolConfig,
  opts: ResolveOptions,
  deps: ResolveDeps = defaultResolveDeps,
): Promise<ResolvedIdentity> {
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
    return { identity, configDirValue: expandPath(identity.configDir), source: "flag" };
  }

  // (b) an already-set env var is an explicit override — skip everything
  // else. Preserves nested/child-session inheritance (e.g. subagents) and
  // deliberate manual power-user overrides.
  const presetEnvValue = opts.env[cfg.envVarName];
  if (presetEnvValue) {
    return { identity: undefined, configDirValue: presetEnvValue, source: "env" };
  }

  // (c) directory-pattern match against cwd, if unique.
  const file = await deps.loadIdentitiesFile(cfg.identitiesJsonPath);
  const matchResult = deps.matchDirectory(opts.cwd, file.identities);
  if (matchResult && !("ambiguous" in matchResult)) {
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
  const { identity, created } = await deps.promptForIdentity(file, cfg, timeoutMs);
  return {
    identity,
    configDirValue: expandPath(identity.configDir),
    source: created ? "interactive-created" : "interactive-existing",
  };
}
