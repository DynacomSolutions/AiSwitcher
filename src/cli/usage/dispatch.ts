import { boolFlag, parseArgs } from "../args.ts";
import { spinnerChar, withLiveRender } from "../live.ts";
import { runPassthrough } from "./passthrough.ts";
import { formatUsageReport } from "./report.ts";
import {
  aggregateUsageResults,
  collectTargets,
  pendingUsageResult,
  runUsageQuery,
  runUsageQueryForTargets,
  usageResultsForJson,
  type UsageResult,
} from "./run.ts";

/** Our own recognized `ais usage` flags — anything else is tokscale's, not
 * ours, even if it happens to start with "--" (tokscale has plenty of its
 * own flags: --client, --group-by, --since, ...). */
const OWN_FLAG_NAMES = new Set(["identity", "tool", "json"]);

/**
 * Splits "ais usage [our flags] [tokscale args]" into our own flags and
 * tokscale's raw passthrough argv. Two ways to trigger passthrough, both
 * supported:
 *   - an explicit "--" (always wins, wherever it appears)
 *   - the first token that ISN'T one of our own recognized flags — whether
 *     that's a bare tokscale subcommand ("tui", "monthly", "pricing", ...)
 *     or one of tokscale's own flags ("--group-by", "--client") — so
 *     `ais usage tui` and `ais usage --identity=x monthly` work without
 *     ever needing "--".
 * Everything from that point on is forwarded to tokscale VERBATIM, never run
 * through our own `--flag=value`-only parser — tokscale's grammar uses
 * space-separated flag values (`--client codex`, `--group-by workspace,model`)
 * that parser would otherwise mangle. Exported standalone so this splitting
 * logic is unit-testable without touching execReal's process.exit. */
export function splitPassthroughArgs(
  rawArgs: string[],
): { ownArgs: string[]; tokscaleArgs: string[] } | undefined {
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i]!;
    if (arg === "--") {
      return { ownArgs: rawArgs.slice(0, i), tokscaleArgs: rawArgs.slice(i + 1) };
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      if (OWN_FLAG_NAMES.has(name)) continue;
    }
    return { ownArgs: rawArgs.slice(0, i), tokscaleArgs: rawArgs.slice(i) };
  }
  return undefined;
}

/** rawArgs is everything after "usage" in the original argv, unparsed — see
 * splitPassthroughArgs for why this can't be the already-parsed top-level
 * flags the other `ais` subcommands use. */
export async function runUsageCommand(rawArgs: string[]): Promise<void> {
  const split = splitPassthroughArgs(rawArgs);
  if (split) {
    const { flags } = parseArgs(split.ownArgs);
    return runPassthrough(flags, split.tokscaleArgs);
  }

  const { flags } = parseArgs(rawArgs);
  const json = boolFlag(flags, "json");

  // Live per-row-spinner render — same rationale/gating as
  // limits/dispatch.ts's own live path: only with a real TTY to redraw in
  // place, and only for the plain report (not --json, and not this
  // function's own earlier `runPassthrough` branch above, which already
  // hands off to tokscale's own interactive stdio-inherited process and has
  // nothing to do with this render loop at all).
  if (!json && process.stdout.isTTY) {
    const targets = await collectTargets(flags);
    const resultSlots: UsageResult[][] = targets.map((target) => [pendingUsageResult(target)]);
    await withLiveRender(
      (tick) => formatUsageReport(aggregateUsageResults(resultSlots.flat()), spinnerChar(tick)),
      async () => {
        await runUsageQueryForTargets(targets, (index, results) => (resultSlots[index] = results));
      },
    );
    return;
  }

  const results = await runUsageQuery(flags);
  if (json) {
    console.log(JSON.stringify(usageResultsForJson(results), null, 2));
    return;
  }
  console.log(formatUsageReport(results));
}
