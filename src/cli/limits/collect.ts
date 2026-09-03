import type { Identity, ToolConfig } from "../../identities/types.ts";
import type { ParsedArgs } from "../args.ts";
import { CliUsageError } from "../errors.ts";
import { loadAll, TOOL_CONFIGS, toolConfigFromFlag } from "../identities/resolve-tool.ts";
import { canonicalUsageProvider, providerForTool } from "../usage/providers.ts";
import { fetchAliLimits } from "./ali-limits.ts";
import { fetchClaudeLimits } from "./claude-limits.ts";
import { fetchCodexLimits } from "./codex-limits.ts";
import { fetchGrokLimits } from "./grok-limits.ts";
import { fetchKimiLimits } from "./kimi-limits.ts";
import { fetchOpencodeLimits } from "./opencode-limits.ts";
import { fetchPiLimits } from "./pi-limits.ts";
import { fetchZaiLimits } from "./zai-limits.ts";
import type { FetchedLimitResult, ToolLimitResult } from "./types.ts";

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
//
// A fetcher returns ONE RESULT PER PROVIDER, not per tool — the views are
// provider-first, and the multi-provider clients (pi, opencode) legitimately
// answer for several providers from one identity (see pi-limits.ts). The six
// 1:1 tools wrap their single-result fetcher via `singleToolFetcher`, which
// stamps the result's provider from the tool; pi/opencode stamp each
// result's provider themselves because only they know which upstream each
// answer came from. `explicitTool` threads the `ais limits --tool=<t>` signal
// down so a source with nothing to report can still say so honestly when the
// user asked about that source specifically (unscoped reports just omit
// nothing-to-report sources — same rule as the usage pipeline).
type LimitFetcher = (identity: Identity, explicitTool: boolean) => Promise<ToolLimitResult[]>;

function singleToolFetcher(
  fetch: (identity: Identity) => Promise<FetchedLimitResult>,
  toolName: ToolConfig["toolName"],
): LimitFetcher {
  return async (identity) => [{ ...(await fetch(identity)), provider: providerForTool(toolName) }];
}

const FETCHERS: Partial<Record<ToolConfig["toolName"], LimitFetcher>> = {
  claude: singleToolFetcher(fetchClaudeLimits, "claude"),
  codex: singleToolFetcher(fetchCodexLimits, "codex"),
  grok: singleToolFetcher(fetchGrokLimits, "grok"),
  kimi: singleToolFetcher(fetchKimiLimits, "kimi"),
  zai: singleToolFetcher(fetchZaiLimits, "zai"),
  ali: singleToolFetcher(fetchAliLimits, "ali"),
  pi: fetchPiLimits,
  opencode: fetchOpencodeLimits,
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

/** The multi-provider clients. Their limits come from per-provider adapters
 * that only learn which providers an identity answers for by reading that
 * identity's own auth store — so there is no meaningful tool-shaped
 * placeholder row for them anywhere in the pipeline: not a pending seed
 * (it would render a fake "Detecting providers"/"OpenCode" section), not a
 * cached-mode row (it would do the same). Unscoped, they render nothing
 * until their real per-provider results land; an explicit --tool= still
 * gets an honest row. */
const MULTI_PROVIDER_TOOLS: ReadonlySet<ToolConfig["toolName"]> = new Set(["pi", "opencode"]);

/** Seeds a placeholder result for a not-yet-fetched 1:1 tool — what
 * limits/dispatch.ts's plain live render and limits/watch.ts's `--watch`
 * loop both use to give report.ts's "pending" spinner row something to
 * render for a target before its own fetch has resolved. Multi-provider
 * clients get NO pending seed: their provider isn't known yet, and a
 * placeholder under the tool's own fallback label would render a fake
 * tool-shaped section. Returns undefined for those. */
export function pendingLimitResult(target: LimitTarget): ToolLimitResult | undefined {
  if (MULTI_PROVIDER_TOOLS.has(target.toolName)) return undefined;
  return { toolName: target.toolName, provider: providerForTool(target.toolName), identity: target.identity, windows: [], status: "pending" };
}

/** Grok's fetch is always a local log-scrape (no live path exists at all —
 * see grok-limits.ts), so `--cached` doesn't change its behavior. Claude,
 * Codex, Kimi, zai, and ali have no offline cache in this version — under
 * `--cached` they report "unavailable" honestly rather than silently
 * falling back to a live call. */
function unavailableCached(target: LimitTarget): ToolLimitResult {
  return {
    toolName: target.toolName,
    provider: providerForTool(target.toolName),
    identity: target.identity,
    windows: [],
    status: "unavailable",
    error: "cached data not available for this tool (no offline cache implemented yet) — omit --cached to fetch live",
  };
}

/** Cached-mode results for one target. The multi-provider clients have no
 * offline cache AND no honest tool-level provider label, so they render
 * nothing unscoped — a placeholder section ("Detecting providers",
 * "OpenCode") would be exactly the tool-shaped output the provider-first
 * views rule forbids. An explicit --tool= still gets the honest row. */
function cachedResults(target: LimitTarget, explicitTool: boolean): ToolLimitResult[] {
  if (MULTI_PROVIDER_TOOLS.has(target.toolName)) {
    return explicitTool
      ? [
          {
            toolName: target.toolName,
            provider: "unattributed",
            identity: target.identity,
            windows: [],
            status: "unavailable",
            error: "cached data not available for this source (no offline cache implemented yet) — omit --cached to fetch live",
          },
        ]
      : [];
  }
  return [unavailableCached(target)];
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
 * throttles Codex, Kimi, and zai in practice. Pi and opencode fan out to one
 * backend call per provider they hold a fetchable credential for, so the
 * cap bounds them the same way. */
const MAX_CONCURRENT = 6;

/** `onItemDone`, when given, fires with each item's ORIGINAL index (not the
 * worker loop's own claim order) right as its result lands — this is what
 * lets limits/dispatch.ts's live TTY render update one row in place the
 * moment its fetch resolves, without waiting for every other in-flight
 * fetch too. A fetch may resolve to several rows (pi/opencode fan-out), so
 * the callback receives the whole resolved batch for that target and callers
 * splice it in as a unit. Optional so every other caller (JSON mode,
 * --watch, tests) is unaffected. Exported (unlike the rest of this file's
 * internals) purely so this concurrency/callback mechanism has direct unit
 * coverage without needing real identity files or network access — see
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

function fetchTarget(target: LimitTarget, explicitTool: boolean): Promise<ToolLimitResult[]> {
  const fetcher = FETCHERS[target.toolName];
  if (!fetcher) {
    return Promise.resolve([
      {
        toolName: target.toolName,
        provider: providerForTool(target.toolName),
        identity: target.identity,
        windows: [],
        status: "unavailable",
        error: `no limits fetcher implemented for "${target.toolName}" yet`,
      },
    ]);
  }
  return fetcher(target.identity, explicitTool);
}

/** Merges every source's answer for the same provider+identity into one row
 * — the limits counterpart of usage/run.ts's aggregateUsageResults. The
 * same upstream account is often reachable through more than one wrapper
 * (a Z.ai key imported into Pi is the same account the zai tool queries), so
 * without this the provider-first report would show duplicate branches.
 * Windows come from the best-ranked live result (the flat targets order
 * puts native tools before pi/opencode, so native wins ties deterministically);
 * statuses rank live > cached > unavailable; error strings and overage info
 * merge like usage's does. Pending rows never share a key with resolved ones
 * (callers replace them wholesale), so they pass through untouched. */
export function aggregateLimitResults(results: ToolLimitResult[]): ToolLimitResult[] {
  const STATUS_RANK = { live: 3, cached: 2, unavailable: 1, pending: 0 } as const;
  const grouped = new Map<string, ToolLimitResult>();
  for (const result of results) {
    const provider = canonicalUsageProvider(result.provider);
    const key = `${provider}\u0000${result.identity.name}`;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, { ...result, provider });
      continue;
    }
    if (result.status === "pending" || existing.status === "pending") {
      // Keep whichever is still pending only if the other hasn't landed —
      // a resolved result always supersedes a pending placeholder.
      if (existing.status !== "pending" || result.status !== "pending") {
        grouped.set(key, existing.status === "pending" ? { ...result, provider } : existing);
      }
      continue;
    }
    const preferNew = STATUS_RANK[result.status] > STATUS_RANK[existing.status];
    const winner = preferNew ? result : existing;
    const loser = preferNew ? existing : result;
    // A live answer makes any duplicate source's failure irrelevant — its
    // error text must not leak onto a working row. Only when the winner has
    // no windows of its own do the two failure reasons merge, so a
    // multi-source identity shows every reason it couldn't be fetched.
    const errors =
      winner.windows.length === 0
        ? [...new Set([winner.error, loser.error].filter((v): v is string => Boolean(v)))]
        : winner.error
          ? [winner.error]
          : [];
    grouped.set(key, {
      ...winner,
      provider,
      ...(errors.length ? { error: errors.join("; ") } : {}),
    });
  }
  return [...grouped.values()];
}

/** Fetches results for an already-collected target list — split out from
 * runLimitsQuery so limits/dispatch.ts's live TTY render can call
 * collectLimitTargets up front (to seed pending placeholder rows before any
 * fetch has even started) and then drive this against the SAME target list,
 * with a per-item callback to update one row in place as it resolves. The
 * callback receives the target's full resolved batch (several rows for the
 * multi-provider clients). */
export async function fetchLimitResults(
  targets: LimitTarget[],
  cached: boolean,
  explicitTool: boolean,
  onItemDone?: (index: number, results: ToolLimitResult[]) => void,
): Promise<ToolLimitResult[]> {
  const batches = await runBatched(
    targets,
    MAX_CONCURRENT,
    async (target) => (cached ? cachedResults(target, explicitTool) : fetchTarget(target, explicitTool)),
    onItemDone,
  );
  return aggregateLimitResults(batches.flat());
}

export async function runLimitsQuery(
  identityFilter: string | undefined,
  flags: ParsedArgs["flags"],
  cached: boolean,
): Promise<ToolLimitResult[]> {
  const targets = await collectLimitTargets(identityFilter, flags);
  return fetchLimitResults(targets, cached, toolConfigFromFlag(flags) !== undefined);
}
