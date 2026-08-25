import { execReal } from "../../shared/exec.ts";
import { stringFlag, type ParsedArgs } from "../args.ts";
import { CliUsageError } from "../errors.ts";
import { collectTargets } from "./run.ts";
import { buildMergedEnv, resolveTokscaleCommand, tokscaleInvocationFor } from "./tokscale.ts";

/**
 * Full tokscale capability — TUI, `graph`, `monthly`, `hourly`, `pricing`,
 * `report`, `wrapped`, the social commands, everything — via
 * `ais usage [--identity=] [--tool=] [-- ]<tokscale args...>`. Unlike the
 * default aggregate report (run.ts), this execs the real tokscale process
 * with full stdio inheritance (so the interactive TUI and raw-mode terminal
 * handling actually work), so it can only ever target zero or one
 * (tool, identity) pair — an interactive/streaming invocation can't
 * sensibly run once per identity and merge results the way the JSON report
 * can.
 *
 * --identity omitted: NOT the same as no env injection at all — tokscale's
 * own bare defaults resolve to this project's top-level ~/.claude/~/.codex/
 * ~/.grok containers, which are deliberately kept empty of real session data
 * (see AGENTS.md's disk layout). An unscoped passthrough instead merges
 * every configured identity (optionally narrowed by --tool) into one
 * TOKSCALE_EXTRA_DIRS value, confirmed empirically to surface every
 * identity/provider in a single tokscale process — this is what makes
 * `ais usage -- tui` show everything rather than next to nothing. Zero
 * configured identities at all falls back to a truly bare passthrough (no
 * env injection), which is still correct for identity-agnostic commands
 * like `pricing "<model>"`.
 *
 * --identity given: resolved via the same collectTargets() as the aggregate
 * report (so it throws the same "not found" error on zero matches), then
 * requires exactly one match — pass --tool= too when an identity name is
 * configured for more than one tool.
 */
export async function runPassthrough(flags: ParsedArgs["flags"], tokscaleArgs: string[]): Promise<never> {
  const [cmd, ...prefixArgs] = resolveTokscaleCommand();
  const identityFilter = stringFlag(flags, "identity");

  if (!identityFilter) {
    const targets = await collectTargets(flags);
    if (targets.length === 0) {
      return execReal(cmd!, [...prefixArgs, ...tokscaleArgs], {});
    }
    return execReal(cmd!, [...prefixArgs, ...tokscaleArgs], await buildMergedEnv(targets));
  }

  const targets = await collectTargets(flags);
  if (targets.length > 1) {
    throw new CliUsageError(
      `--identity="${identityFilter}" matches more than one registry (${targets.map((t) => t.toolName).join(", ")}) — ` +
        `pass --tool=<t> too to target exactly one for a passthrough command.`,
    );
  }

  const target = targets[0]!;
  const invocation = await tokscaleInvocationFor(target.toolName, target.identity);
  if (!invocation) {
    const reason =
      target.toolName === "zai"
        ? "no Z.ai API key configured for this identity yet — run `ais identities update --tool=zai --api-key=<key>`"
        : target.toolName === "ali"
          ? "tokscale has no client for ali, and Alibaba's Token plan has no documented quota API for its own `usage` subcommand to hit either"
          : `tokscale has no client for "${target.toolName}" yet`;
    throw new CliUsageError(`${reason} — usage tracking not supported.`);
  }
  const { env, clientArgs } = invocation;
  // clientArgs MUST come after tokscaleArgs, not before — confirmed
  // empirically: tokscale's `--client` is parsed as one of the invoked
  // subcommand's own flags (e.g. `models`, `monthly`, `graph`), not a true
  // root-level global one. `tokscale --client claude models` silently
  // ignores the filter (leaks every other client's data into the report);
  // `tokscale models --client claude` scopes correctly. Root-level
  // invocations with no subcommand (e.g. `--json`) accept either order, so
  // putting clientArgs last is correct in both cases.
  return execReal(cmd!, [...prefixArgs, ...tokscaleArgs, ...clientArgs], env);
}
