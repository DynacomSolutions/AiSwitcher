import { boolFlag, parseArgs } from "../args.ts";
import { CliUsageError } from "../errors.ts";
import { runPassthrough } from "./passthrough.ts";
import {
  breakdownQueryFromFlags,
  formatBreakdownReport,
} from "./breakdown.ts";
import {
  readUsageBreakdownEnvelope,
  requestUsageBreakdownRefresh,
} from "./breakdown-snapshot.ts";
import { formatUsageReport } from "./report.ts";
import {
  collectTargets,
  type UsageResult,
} from "./run.ts";
import { readUsageSnapshotEnvelope, startUsageSnapshotRefreshInBackground } from "./snapshot.ts";

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
  // "breakdown" is our own subcommand, never a tokscale one: intercept it
  // before the passthrough splitter would hand the bare word to tokscale.
  if (rawArgs[0] === "breakdown") {
    const { flags, positionals } = parseArgs(rawArgs.slice(1));
    const query = breakdownQueryFromFlags(flags, positionals[0]);
    await collectTargets({
      ...(query.tool ? { tool: query.tool } : {}),
      ...(query.identity ? { identity: query.identity } : {}),
    }); // validate registry filters without reading usage history
    let envelope = readUsageBreakdownEnvelope(query);
    if (!envelope || envelope.stale) {
      requestUsageBreakdownRefresh(query);
      envelope = readUsageBreakdownEnvelope(query);
    }
    const results = envelope.results;
    if (boolFlag(flags, "json")) {
      console.log(JSON.stringify(envelope, null, 2));
      return;
    }
    if (envelope.stale || envelope.pending) console.error("Usage breakdown snapshot is stale or still being collected.");
    if (envelope.error) console.error(`Usage breakdown refresh failed: ${envelope.error.category} (${envelope.error.at}).`);
    console.log(formatBreakdownReport(results));
    return;
  }

  const split = splitPassthroughArgs(rawArgs);
  if (split) {
    const { flags } = parseArgs(split.ownArgs);
    return runPassthrough(flags, split.tokscaleArgs);
  }

  const { flags } = parseArgs(rawArgs);
  const json = boolFlag(flags, "json");

  const tool = typeof flags.tool === "string" ? flags.tool : undefined;
  const identity = typeof flags.identity === "string" ? flags.identity : undefined;
  await collectTargets(flags); // validates filters without reading usage history
  let envelope = readUsageSnapshotEnvelope(tool, identity);
  if (!envelope || envelope.stale) startUsageSnapshotRefreshInBackground();
  const results = (envelope?.results ?? []) as UsageResult[];
  if (json) {
    console.log(JSON.stringify(envelope?.results ?? [], null, 2));
    console.error(`AIS_USAGE_STATUS ${JSON.stringify({
      stale: envelope?.stale ?? true,
      pending: envelope?.pending ?? true,
      nativeCoverage: envelope?.nativeCoverage ?? { supported: 0, unsupported: 0, error: 0, pending: 0 },
      ...(envelope?.generatedAt ? { generatedAt: envelope.generatedAt } : {}),
      ...(envelope?.lastSuccessAt ? { lastSuccessAt: envelope.lastSuccessAt } : {}),
      ...(envelope?.lastError ? { error: envelope.lastError } : {}),
      ...(envelope?.lastErrorAt ? { lastErrorAt: envelope.lastErrorAt } : {}),
    })}`);
    return;
  }
  if (!envelope || envelope.stale || envelope.pending) console.error("Usage snapshot is stale or still being collected.");
  if (envelope?.lastError) console.error(`Usage refresh failed: ${envelope.lastError}`);
  console.log(formatUsageReport(results));

}
