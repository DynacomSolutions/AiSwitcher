import { execReal } from "../../shared/exec.ts";
import { stringFlag, type ParsedArgs } from "../args.ts";
import { CliUsageError } from "../errors.ts";
import { collectTargets, shouldIncludeDefaultOpencodeProfile } from "./run.ts";
import {
  prepareMergedPassthrough,
  resolveAisTokscaleSharedTui,
  resolveTokscaleCommand,
  tokscaleInvocationFor,
} from "./tokscale.ts";

/**
 * Full tokscale capability — TUI, `graph`, `monthly`, `hourly`, `pricing`,
 * `report`, `wrapped`, the social commands, everything — via
 * `ais usage [--identity=] [--tool=] [-- ]<tokscale args...>`. Unlike the
 * default aggregate report (run.ts), this execs the real tokscale process
 * with full stdio inheritance (so the interactive TUI and raw-mode terminal
 * handling actually work). Unscoped passthrough merges all configured
 * identity roots into one Tokscale process, including the default OpenCode
 * profile whenever the usage filters allow it.
 *
 * --identity omitted: NOT the same as no env injection at all — tokscale's
 * own bare defaults resolve to this project's top-level ~/.claude/~/.codex/
 * ~/.grok containers, which are deliberately kept empty of real session data
 * (see AGENTS.md's disk layout). An unscoped passthrough instead merges
 * every configured identity (optionally narrowed by --tool) into Tokscale's
 * additive scan settings. The default OpenCode profile is included unless
 * an identity filter or unrelated tool filter excludes it. If there are no
 * configured identities and no default profile applies, passthrough remains
 * bare, which is correct for identity-agnostic commands like `pricing
 * "<model>"`.
 *
 * --identity given: resolved via the same collectTargets() as the aggregate
 * report (so it throws the same "not found" error on zero matches), then
 * requires exactly one match — pass --tool= too when an identity name is
 * configured for more than one tool.
 */
export async function runPassthrough(flags: ParsedArgs["flags"], tokscaleArgs: string[]): Promise<never> {
  if (tokscaleArgs[0] === "tui") {
    if (stringFlag(flags, "identity") !== undefined) {
      throw new CliUsageError("--identity cannot select a partition in shared Tokscale TUI mode");
    }
    if (stringFlag(flags, "tool") !== undefined) {
      throw new CliUsageError("--tool cannot select one partition in shared Tokscale TUI mode");
    }

    let shared: Awaited<ReturnType<typeof resolveAisTokscaleSharedTui>>;
    try {
      shared = await resolveAisTokscaleSharedTui();
    } catch (error) {
      throw new CliUsageError(error instanceof Error ? error.message : "AIS shared Tokscale binary is unavailable");
    }
    return execReal(shared.command, [...shared.args, ...tokscaleArgs], {});
  }

  const [cmd, ...prefixArgs] = resolveTokscaleCommand();
  const identityFilter = stringFlag(flags, "identity");

  if (!identityFilter) {
    const targets = await collectTargets(flags, undefined, { includePools: true });
    const prepared = await prepareMergedPassthrough(targets, tokscaleArgs, {
      includeDefaultOpencodeProfile: shouldIncludeDefaultOpencodeProfile(flags),
    });
    return execReal(cmd!, [...prefixArgs, ...prepared.args], prepared.env);
  }

  const targets = await collectTargets(flags, undefined, { includePools: true });
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
