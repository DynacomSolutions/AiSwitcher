import { dim } from "../colors.ts";
import { spinnerChar, withLiveRender } from "../live.ts";
import type { ParsedArgs } from "../args.ts";
import { aggregateLimitResults, collectLimitTargets, fetchLimitResults, pendingLimitResult, runLimitsQuery } from "./collect.ts";
import { formatLimitsReport } from "./report.ts";
import type { ToolLimitResult } from "./types.ts";

/**
 * Redraws in place via withLiveRender — the SAME primitive
 * limits/dispatch.ts's plain (non-watch) live render uses, so `--watch`
 * gets the identical per-row-spinner-then-update-in-place behavior each
 * cycle, not just on the very first fetch. `run()` below never resolves
 * (it loops forever); the only way out is SIGINT/SIGTERM, handled entirely
 * inside withLiveRender itself. Requires a real TTY — an in-place redraw
 * means nothing when piped/redirected, so `--watch` there silently degrades
 * to a single plain run instead of erroring or producing ANSI noise in a
 * log file.
 *
 * Re-collects targets fresh every cycle (not just once up front), matching
 * the pre-live-render behavior: an identity added mid-watch shows up on the
 * next cycle rather than requiring a restart.
 */
export async function runWatch(
  identityFilter: string | undefined,
  flags: ParsedArgs["flags"],
  explicitTool: boolean,
  intervalMs: number,
): Promise<void> {
  if (!process.stdout.isTTY) {
    const results = await runLimitsQuery(identityFilter, flags, false);
    console.log(formatLimitsReport(results));
    return;
  }

  let slots: ToolLimitResult[][] = [];
  let statusLine = dim("fetching…");

  await withLiveRender(
    (tick) => `${statusLine}\n\n${formatLimitsReport(aggregateLimitResults(slots.flat()), new Date(), spinnerChar(tick))}`,
    async () => {
      while (true) {
        const targets = await collectLimitTargets(identityFilter, flags);
        // One slot per target — 1:1 tools seed a pending spinner row,
        // multi-provider clients seed nothing until their per-provider
        // rows land (see collect.ts's MULTI_PROVIDER_TOOLS).
        slots = targets.map((target) => {
          const pending = pendingLimitResult(target);
          return pending ? [pending] : [];
        });
        statusLine = dim("fetching…");
        await fetchLimitResults(targets, false, explicitTool, (i, resolved) => (slots[i] = resolved));
        statusLine = dim(`updated ${new Date().toLocaleTimeString()}`);
        await Bun.sleep(intervalMs);
      }
    },
  );
}
