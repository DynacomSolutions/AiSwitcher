import { boolFlag, stringFlag, type ParsedArgs } from "../args.ts";
import { CliUsageError } from "../errors.ts";
import { spinnerChar, withLiveRender } from "../live.ts";
import { aggregateLimitResults, collectLimitTargets, fetchLimitResults, pendingLimitResult, runLimitsQuery } from "./collect.ts";
import { toolConfigFromFlag } from "../identities/resolve-tool.ts";
import { formatLimitsReport } from "./report.ts";
import type { ToolLimitResult } from "./types.ts";
import { runWatch } from "./watch.ts";

const DEFAULT_INTERVAL_SECONDS = 30;

/** Exported standalone so interval validation is unit-testable without going
 * through the full command (mirrors usage/dispatch.ts's splitPassthroughArgs
 * convention). */
export function parseIntervalSeconds(flags: ParsedArgs["flags"]): number {
  const raw = stringFlag(flags, "interval");
  if (raw === undefined) return DEFAULT_INTERVAL_SECONDS;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new CliUsageError(`--interval must be a positive number of seconds, got "${raw}"`);
  }
  return seconds;
}

/** `ais limits [identity] [--tool=] [--json] [--cached] [--watch] [--interval=<seconds>]`
 * Identity is a positional, not `--identity=`. Takes the top-level parser's
 * already-parsed `positionals`/`flags` directly (mirrors
 * identities/dispatch.ts's `runIdentitiesCommand(rest, flags)`) rather than
 * re-parsing raw argv — unlike `usage`, `limits` has no "--" passthrough mode
 * that would need the unparsed remainder, so there's nothing forcing a
 * second parse pass. A prior version DID re-parse a `rest` that only ever
 * contained positionals (cli/dispatch.ts's top-level parseArgs already
 * consumed all "--flag" tokens into its own `flags`, never forwarded to
 * subcommands taking a raw `rest`) — `--tool=`/`--json`/etc. were silently
 * dropped as a result. Fixed by taking the top-level flags directly, like
 * `identities` already does. */
export async function runLimitsCommand(positionals: string[], flags: ParsedArgs["flags"]): Promise<void> {
  const identityFilter = positionals[0];
  const json = boolFlag(flags, "json");
  const cached = boolFlag(flags, "cached");
  const watch = boolFlag(flags, "watch");
  const explicitTool = toolConfigFromFlag(flags) !== undefined;

  if (watch) {
    if (json) throw new CliUsageError("--watch and --json cannot be combined.");
    return runWatch(identityFilter, flags, explicitTool, parseIntervalSeconds(flags) * 1000);
  }

  // Live per-row-spinner render: only when there's an actual TTY to redraw
  // in place (an in-place redraw is meaningless piped/redirected — same
  // requirement watch.ts already has) and only for the plain report (--json
  // is for programmatic consumption; a stream of partial-then-final JSON
  // blobs would just be noise a parser can't use). `bun test` runs with
  // isTTY false, so this path is naturally untouched by the existing test
  // suite — see live.ts's own note on why the TTY check lives in callers.
  if (!json && process.stdout.isTTY) {
    const targets = await collectLimitTargets(identityFilter, flags);
    // One slot per target: 1:1 tools seed a pending row so the live render
    // has a spinner to show, multi-provider clients seed NOTHING (their
    // provider isn't known until the adapter reads the identity's auth
    // store — a tool-shaped placeholder would render a fake section).
    // aggregateLimitResults on every frame: the same provider+identity can
    // be answered by more than one target (a Z.ai key imported into Pi is
    // the account the zai tool queries too) — the flat list must not show
    // duplicate branches mid-render.
    const slots: ToolLimitResult[][] = targets.map((target) => {
      const pending = pendingLimitResult(target);
      return pending ? [pending] : [];
    });
    await withLiveRender(
      (tick) => formatLimitsReport(aggregateLimitResults(slots.flat()), new Date(), spinnerChar(tick)),
      async () => {
        await fetchLimitResults(targets, cached, explicitTool, (i, resolved) => (slots[i] = resolved));
      },
    );
    return;
  }

  const results = await runLimitsQuery(identityFilter, flags, cached);
  if (json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  console.log(formatLimitsReport(results));
}
