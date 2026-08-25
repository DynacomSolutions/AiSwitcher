import type { Identity, ToolConfig } from "../../identities/types.ts";
import type { ParsedArgs } from "../args.ts";
import { CliUsageError } from "../errors.ts";
import { loadAll, TOOL_CONFIGS, toolConfigFromFlag } from "../identities/resolve-tool.ts";
import { fetchAliLimits } from "./ali-limits.ts";
import { fetchClaudeLimits } from "./claude-limits.ts";
import { fetchCodexLimits } from "./codex-limits.ts";
import { fetchGrokLimits } from "./grok-limits.ts";
import { fetchKimiLimits } from "./kimi-limits.ts";
import { fetchZaiLimits } from "./zai-limits.ts";
import type { ToolLimitResult } from "./types.ts";

export interface LimitTarget {
  toolName: ToolConfig["toolName"];
  identity: Identity;
}

// Partial, not a full Record: ToolConfig["toolName"]'s union can grow (e.g. a
// tool added to the identities registry before its own limits fetcher exists
// yet) without this failing to compile — fetchTarget below reports
// "unavailable" for any tool with no entry here instead of assuming
// exhaustive coverage. Mirrors doctor/collect.ts's PROBES. zai's own live
// fetcher (zai-limits.ts) hits Z.ai's quota API directly with the key stored
// in that identity's crush.json — nothing to do with Crush's own (still
// uninvestigated) session storage format. ali's fetcher (ali-limits.ts) is
// the odd one out: the Token plan has no API-key quota endpoint at all, so
// it hits Alibaba's OneConsole gateway with a pasted console cookie.
const FETCHERS: Partial<Record<ToolConfig["toolName"], (identity: Identity) => Promise<ToolLimitResult>>> = {
  claude: fetchClaudeLimits,
  codex: fetchCodexLimits,
  grok: fetchGrokLimits,
  kimi: fetchKimiLimits,
  zai: fetchZaiLimits,
  ali: fetchAliLimits,
};

/** Same shape/rules as usage/run.ts's collectTargets, except the identity
 * filter is a positional (`ais limits <identity>`), not `--identity=` —
 * matches the CLI surface actually presented to the user, not usage's own
 * flag convention. An identity that exists in more than one registry (a real
 * case) is not an error here — a report showing that identity's claude AND
 * codex limits side by side is the point. `configs` defaults to the real
 * TOOL_CONFIGS, only overridden by tests. */
export async function collectLimitTargets(
  identityFilter: string | undefined,
  flags: ParsedArgs["flags"],
  configs: ToolConfig[] = Object.values(TOOL_CONFIGS),
): Promise<LimitTarget[]> {
  const toolFilter = toolConfigFromFlag(flags);
  const targetConfigs = toolFilter ? [toolFilter] : configs;
  const loaded = await loadAll(targetConfigs);

  const targets: LimitTarget[] = [];
  for (const { cfg, file } of loaded) {
    for (const identity of file.identities) {
      if (identityFilter && identity.name !== identityFilter && !(identity.aliases ?? []).includes(identityFilter)) {
        continue;
      }
      targets.push({ toolName: cfg.toolName, identity });
    }
  }

  if (identityFilter && targets.length === 0) {
    throw new CliUsageError(
      `No identity named "${identityFilter}" found${toolFilter ? ` in ${toolFilter.toolName}'s registry` : ""}.`,
    );
  }
  return targets;
}

/** Seeds a placeholder result for a not-yet-fetched target — what
 * limits/dispatch.ts's plain live render and limits/watch.ts's `--watch`
 * loop both use to give report.ts's "pending" spinner row something to
 * render for a target before its own fetch has resolved. */
export function pendingLimitResult(target: LimitTarget): ToolLimitResult {
  return { toolName: target.toolName, identity: target.identity, windows: [], status: "pending" };
}

/** Grok's fetch is always a local log-scrape (no live path exists at all —
 * see grok-limits.ts), so `--cached` doesn't change its behavior. Claude,
 * Codex, Kimi, zai, and ali have no offline cache in this version — under
 * `--cached` they report "unavailable" honestly rather than silently
 * falling back to a live call. */
function unavailableCached(target: LimitTarget): ToolLimitResult {
  return {
    toolName: target.toolName,
    identity: target.identity,
    windows: [],
    status: "unavailable",
    error: "cached data not available for this tool (no offline cache implemented yet) — omit --cached to fetch live",
  };
}

/** Codex, Kimi, and zai live reads hit a real third-party backend once per
 * identity (Kimi's is one cheap GET to api.kimi.com — see kimi-limits.ts;
 * zai's is one cheap GET to api.z.ai — see zai-limits.ts) — cap concurrency
 * as a courtesy/timeout-safety measure rather than firing every identity at
 * once, even though nothing found in investigation suggests these reads
 * consume visible rate-limit budget themselves. Claude and Grok reads have
 * no such concern (Claude's non-interactive /usage is a single
 * client-intercepted call per identity; Grok is pure local file I/O) but are
 * batched through the same pool for simplicity — the cap only meaningfully
 * throttles Codex, Kimi, and zai in practice. */
const MAX_CONCURRENT = 6;

/** `onItemDone`, when given, fires with each item's ORIGINAL index (not the
 * worker loop's own claim order) right as its result lands — this is what
 * lets limits/dispatch.ts's live TTY render update one row in place the
 * moment its fetch resolves, without waiting for every other in-flight
 * fetch too. Optional so every other caller (JSON mode, --watch, tests)
 * is unaffected. Exported (unlike the rest of this file's internals) purely
 * so this concurrency/callback mechanism has direct unit coverage without
 * needing real identity files or network access — see
 * test/cli/limits/collect.test.ts. */
export async function runBatched<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  onItemDone?: (index: number, result: R) => void,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      const result = await fn(items[i]!);
      results[i] = result;
      onItemDone?.(i, result);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function fetchTarget(target: LimitTarget): Promise<ToolLimitResult> {
  const fetcher = FETCHERS[target.toolName];
  if (!fetcher) {
    return Promise.resolve({
      toolName: target.toolName,
      identity: target.identity,
      windows: [],
      status: "unavailable",
      error: `no limits fetcher implemented for "${target.toolName}" yet`,
    });
  }
  return fetcher(target.identity);
}

/** Fetches results for an already-collected target list — split out from
 * runLimitsQuery so limits/dispatch.ts's live TTY render can call
 * collectLimitTargets up front (to seed pending placeholder rows before any
 * fetch has even started) and then drive this against the SAME target list,
 * with a per-item callback to update one row in place as it resolves. */
export async function fetchLimitResults(
  targets: LimitTarget[],
  cached: boolean,
  onItemDone?: (index: number, result: ToolLimitResult) => void,
): Promise<ToolLimitResult[]> {
  return runBatched(targets, MAX_CONCURRENT, async (target) => (cached ? unavailableCached(target) : fetchTarget(target)), onItemDone);
}

export async function runLimitsQuery(
  identityFilter: string | undefined,
  flags: ParsedArgs["flags"],
  cached: boolean,
): Promise<ToolLimitResult[]> {
  const targets = await collectLimitTargets(identityFilter, flags);
  return fetchLimitResults(targets, cached);
}
