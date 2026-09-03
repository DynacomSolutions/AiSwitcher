import type { Identity, ToolConfig } from "../../identities/types.ts";
import { stringFlag, type ParsedArgs } from "../args.ts";
import { CliUsageError } from "../errors.ts";
import { loadAll, TOOL_CONFIGS, toolConfigFromFlag } from "../identities/resolve-tool.ts";
import { runBatched } from "../limits/collect.ts";
import { fetchClaudeLimits } from "../limits/claude-limits.ts";
import { fetchCodexLimits } from "../limits/codex-limits.ts";
import { fetchKimiLimits } from "../limits/kimi-limits.ts";
import type { OverageInfo } from "../limits/types.ts";
import { fetchAliUsage } from "./ali-usage.ts";
import { OPENCODE_DEFAULT_PROFILE_IDENTITY, defaultOpencodeProfileDbPath, readOpencodeProfileUsage } from "./opencode-usage.ts";
import { fetchPiUsage } from "./pi-usage.ts";
import { canonicalUsageProvider, providerForTool } from "./providers.ts";
import {
  ensureTokscaleCacheFresh,
  fetchTokscaleDailyUsage,
  runTokscaleProcess,
  tokscaleInvocationFor,
  type DateSpan,
  type TokscaleEntry,
  type TokscaleReport,
} from "./tokscale.ts";
import { fetchZaiUsage } from "./zai-usage.ts";

export interface UsageTarget {
  toolName: ToolConfig["toolName"];
  identity: Identity;
}

/** User-facing usage is provider-first. The wrapper/tool remains an input
 * concern on UsageTarget only; once local records have exposed the real
 * upstream, results from native clients and Pi merge by provider+identity. */
export interface UsageResult {
  provider: string;
  identity: Identity;
  /** Internal collection provenance; omitted from every public JSON result. */
  sourceTool?: ToolConfig["toolName"];
  /** Pi CLI adapters are covered by this native history when it is present. */
  nativeCoverageTool?: "claude" | "codex";
  /** Internal: a real failure from a source whose provider can't be named
   * (a multi-provider client's reader failed before attributing anything).
   * Never rendered as a provider TABLE row — a fabricated "Unattributed"
   * row is exactly the pseudo-provider output the provider-first rule
   * forbids — it surfaces only in the trailing Errors section under its
   * SOURCE label (`pi/dynacom: ...`). Omitted from every public JSON
   * result. */
  sourceOnlyError?: true;
  report?: TokscaleReport;
  error?: string;
  extraCost?: OverageInfo;
  dateSpan?: DateSpan;
  dailyUsage?: Record<string, number>;
  pending?: true;
}

/** Every (tool, identity) pair to query, filtered by --tool and/or --identity.
 * Tools remain legitimate collection filters even though the output is
 * grouped and labelled by provider. */
export async function collectTargets(
  flags: ParsedArgs["flags"],
  configs: ToolConfig[] = Object.values(TOOL_CONFIGS),
): Promise<UsageTarget[]> {
  const toolFilter = toolConfigFromFlag(flags);
  const identityFilter = stringFlag(flags, "identity");
  const targetConfigs = toolFilter ? [toolFilter] : configs;
  const loaded = await loadAll(targetConfigs);

  const targets: UsageTarget[] = [];
  for (const { cfg, file } of loaded) {
    for (const identity of file.identities) {
      if (identityFilter && identity.name !== identityFilter && !(identity.aliases ?? []).includes(identityFilter)) continue;
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

/** Pending seed for a not-yet-resolved target. Multi-provider clients (pi,
 * opencode) get NO seed: their provider isn't known until their own source
 * resolves, and a placeholder under the tool's fallback label would render
 * a fake "Detecting providers"/"OpenCode" section — tool-shaped output the
 * provider-first views rule forbids. Returns undefined for those. */
export function pendingUsageResult(target: UsageTarget): UsageResult | undefined {
  if (target.toolName === "pi" || target.toolName === "opencode") return undefined;
  return { provider: providerForTool(target.toolName), identity: target.identity, sourceTool: target.toolName, pending: true };
}

function providerResult(target: UsageTarget, provider: string, fields: Omit<UsageResult, "provider" | "identity">): UsageResult {
  return { provider: canonicalUsageProvider(provider), identity: target.identity, sourceTool: target.toolName, ...fields };
}

/** A real failure from a multi-provider source (pi/opencode) whose reader
 * failed before attributing any provider. Kept out of the provider table —
 * there is no honest provider to name and a fabricated "Unattributed" row
 * is tool-shaped noise — and surfaced only in the Errors footer under the
 * SOURCE label. */
function sourceErrorResult(target: UsageTarget, error: string): UsageResult {
  return { provider: "unattributed", identity: target.identity, sourceTool: target.toolName, sourceOnlyError: true, error };
}

/** The multi-provider clients: sources whose failures have no honest
 * provider-level row. */
function isMultiProviderSource(toolName: UsageTarget["toolName"]): boolean {
  return toolName === "pi" || toolName === "opencode";
}

/** Sources with nothing to report render no row in an unscoped report — the
 * view is provider/identity-first, and a "0 messages" or "no local data"
 * placeholder against a pseudo-provider label is noise, not information
 * (per-provider views rule). When the user asked about that source
 * specifically (`--tool=<t>`), the same condition becomes an explicit,
 * honest row instead of silence: they asked, so it must answer. */
export type UsageRowSuppression = { explicitTool: boolean };

async function runZaiUsage(target: UsageTarget, suppression: UsageRowSuppression): Promise<UsageResult[]> {
  const result = await fetchZaiUsage(target.identity).catch(() => undefined);
  if (!result) {
    return suppression.explicitTool ? [providerResult(target, "zai", { error: "no local Crush session data yet for this identity" })] : [];
  }
  const { dateSpan, ...report } = result;
  return [providerResult(target, "zai", { report, ...(dateSpan ? { dateSpan } : {}) })];
}

async function runAliUsage(target: UsageTarget, suppression: UsageRowSuppression): Promise<UsageResult[]> {
  const result = await fetchAliUsage(target.identity).catch(() => undefined);
  if (!result) {
    return suppression.explicitTool ? [providerResult(target, "alibaba", { error: "no local Crush session data yet for this identity" })] : [];
  }
  const { dateSpan, ...report } = result;
  return [providerResult(target, "alibaba", { report, ...(dateSpan ? { dateSpan } : {}) })];
}

async function runPiUsage(target: UsageTarget, suppression: UsageRowSuppression): Promise<UsageResult[]> {
  try {
    const providers = await fetchPiUsage(target.identity);
    if (providers.length === 0) {
      return suppression.explicitTool ? [sourceErrorResult(target, "no local Pi provider usage yet for this identity")] : [];
    }
    return providers.map(({ provider, nativeCoverageTool, report, dateSpan, dailyUsage }) =>
      providerResult(target, provider, { report, dateSpan, dailyUsage, ...(nativeCoverageTool ? { nativeCoverageTool } : {}) }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return [sourceErrorResult(target, `Could not read Pi usage: ${message}`)];
  }
}

async function fetchExtraCost(toolName: UsageTarget["toolName"], identity: Identity): Promise<OverageInfo | undefined> {
  switch (toolName) {
    case "claude":
      return (await fetchClaudeLimits(identity).catch(() => undefined))?.overage;
    case "codex":
      return (await fetchCodexLimits(identity).catch(() => undefined))?.overage;
    case "kimi":
      return (await fetchKimiLimits(identity).catch(() => undefined))?.overage;
    default:
      return undefined;
  }
}

function reportFromEntries(entries: TokscaleEntry[]): TokscaleReport {
  return entries.reduce<TokscaleReport>(
    (report, entry) => {
      report.entries.push(entry);
      report.totalInput += entry.input;
      report.totalOutput += entry.output;
      report.totalCacheRead += entry.cacheRead;
      report.totalCacheWrite += entry.cacheWrite;
      report.totalMessages += entry.messageCount;
      report.totalCost += entry.cost;
      return report;
    },
    { entries: [], totalInput: 0, totalOutput: 0, totalCacheRead: 0, totalCacheWrite: 0, totalMessages: 0, totalCost: 0 },
  );
}

/** Split tokscale output by its recorded upstream provider, never by the
 * wrapper that happened to produce the session file. A report with zero
 * entries (an identity registered but never used) renders no row unless the
 * user explicitly asked about this source — see UsageRowSuppression. */
export function providerReportsFromTokscale(target: UsageTarget, report: TokscaleReport, suppression: UsageRowSuppression = { explicitTool: false }): UsageResult[] {
  const fallback = providerForTool(target.toolName);
  if (report.entries.length === 0) {
    return suppression.explicitTool ? [providerResult(target, fallback, { report })] : [];
  }

  const groups = new Map<string, TokscaleEntry[]>();
  for (const entry of report.entries) {
    const provider = canonicalUsageProvider(entry.provider || fallback);
    groups.set(provider, [...(groups.get(provider) ?? []), { ...entry, provider }]);
  }
  if (groups.size === 1) {
    const [provider, entries] = groups.entries().next().value!;
    return [providerResult(target, provider, { report: { ...report, entries } })];
  }
  return [...groups].map(([provider, entries]) => providerResult(target, provider, { report: reportFromEntries(entries) }));
}

async function runTokscale(target: UsageTarget, suppression: UsageRowSuppression): Promise<UsageResult[]> {
  const fallbackProvider = providerForTool(target.toolName);
  const invocation = await tokscaleInvocationFor(target.toolName, target.identity);
  if (!invocation) {
    const error = "usage tracking is not supported for this source";
    return isMultiProviderSource(target.toolName) ? [sourceErrorResult(target, error)] : [providerResult(target, fallbackProvider, { error })];
  }
  const { env, clientArgs } = invocation;

  try {
    const stdout = await runTokscaleProcess([...clientArgs, "--json"], env);
    return providerReportsFromTokscale(target, JSON.parse(stdout) as TokscaleReport, suppression);
  } catch (err) {
    const message = err instanceof SyntaxError
      ? "Could not parse tokscale's --json output."
      : `Could not run tokscale: ${err instanceof Error ? err.message : String(err)}`;
    return isMultiProviderSource(target.toolName) ? [sourceErrorResult(target, message)] : [providerResult(target, fallbackProvider, { error: message })];
  }
}

async function runOne(target: UsageTarget, suppression: UsageRowSuppression): Promise<UsageResult[]> {
  if (target.toolName === "zai") return runZaiUsage(target, suppression);
  if (target.toolName === "ali") return runAliUsage(target, suppression);
  if (target.toolName === "pi") return runPiUsage(target, suppression);

  const [results, extraCost, daily] = await Promise.all([
    runTokscale(target, suppression),
    fetchExtraCost(target.toolName, target.identity),
    fetchTokscaleDailyUsage(target.toolName as "claude" | "codex" | "grok" | "kimi" | "opencode", target.identity),
  ]);
  const primaryProvider = providerForTool(target.toolName);
  return results.map((result, index) => ({
    ...result,
    ...(extraCost && (result.provider === primaryProvider || (index === 0 && !results.some((r) => r.provider === primaryProvider)))
      ? { extraCost }
      : {}),
    ...(daily && results.length === 1 ? { dateSpan: daily.dateSpan, dailyUsage: daily.daily } : {}),
  }));
}

function mergeExtraCost(a: OverageInfo | undefined, b: OverageInfo | undefined): OverageInfo | undefined {
  if (!a) return b;
  if (!b) return a;
  if (a.active !== b.active) return a.active ? a : b;
  if (typeof a.spentUsd === "number" || typeof b.spentUsd === "number") return (a.spentUsd ?? -1) >= (b.spentUsd ?? -1) ? a : b;
  return a;
}

function mergeReports(a: TokscaleReport | undefined, b: TokscaleReport | undefined): TokscaleReport | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    entries: [...a.entries, ...b.entries],
    totalInput: a.totalInput + b.totalInput,
    totalOutput: a.totalOutput + b.totalOutput,
    totalCacheRead: a.totalCacheRead + b.totalCacheRead,
    totalCacheWrite: a.totalCacheWrite + b.totalCacheWrite,
    totalMessages: a.totalMessages + b.totalMessages,
    totalCost: a.totalCost + b.totalCost,
  };
}

/** Merge the same provider+identity across native clients and Pi. */
export function aggregateUsageResults(results: UsageResult[]): UsageResult[] {
  const nativeCoverage = new Set(
    results
      .filter((result) => result.report && (result.sourceTool === "claude" || result.sourceTool === "codex"))
      .map((result) => `${result.sourceTool}\u0000${result.identity.name}`),
  );
  const grouped = new Map<string, UsageResult>();
  for (const result of results) {
    if (result.nativeCoverageTool && nativeCoverage.has(`${result.nativeCoverageTool}\u0000${result.identity.name}`)) continue;
    // Source-only failures never merge: each source's failure stays its own
    // Errors-footer line under its own source label, never folded into
    // another source's row (or into a provider group).
    if (result.sourceOnlyError) {
      grouped.set(`sourceOnlyError\u0000${result.sourceTool ?? ""}\u0000${result.identity.name}`, result);
      continue;
    }
    const provider = canonicalUsageProvider(result.provider);
    const key = `${provider}\u0000${result.identity.name}`;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, { ...result, provider });
      continue;
    }

    const dailyUsage = { ...(existing.dailyUsage ?? {}) };
    for (const [day, tokens] of Object.entries(result.dailyUsage ?? {})) dailyUsage[day] = (dailyUsage[day] ?? 0) + tokens;
    const firstMs = [existing.dateSpan?.firstMs, result.dateSpan?.firstMs].filter((v): v is number => v !== undefined);
    const lastMs = [existing.dateSpan?.lastMs, result.dateSpan?.lastMs].filter((v): v is number => v !== undefined);
    const errors = [...new Set([existing.error, result.error].filter((v): v is string => Boolean(v)))];
    const report = mergeReports(existing.report, result.report);
    const extraCost = mergeExtraCost(existing.extraCost, result.extraCost);

    grouped.set(key, {
      provider,
      identity: existing.identity,
      ...(report ? { report } : {}),
      ...(errors.length ? { error: errors.join("; ") } : {}),
      ...(extraCost ? { extraCost } : {}),
      ...(firstMs.length && lastMs.length ? { dateSpan: { firstMs: Math.min(...firstMs), lastMs: Math.max(...lastMs) } } : {}),
      ...(Object.keys(dailyUsage).length ? { dailyUsage } : {}),
      ...(existing.pending && result.pending ? { pending: true as const } : {}),
    });
  }
  return [...grouped.values()];
}

// NOTE, deliberately NO per-target timeout here (a 25s cap was tried in the
// console work and reverted 2026-09-03): ~25 targets run concurrently and
// contend for disk, so a single target's real tokscale scan routinely takes
// 25-55s on this data volume — the cap turned ENTIRE reports into error
// rows ("timed out after 25ms", itself mislabeled). Genuine hangs are
// already bounded where they actually occur: tokscale spawns have their own
// timeout (tokscale.ts), and limits never had a cap either. Truncating
// good data to bound a pathological hang is the wrong trade for the report.

/** Ceiling on targets fetched at once. Every non-zai/ali/pi target spawns a
 * tokscale child scanning that identity's whole history; with ~25 targets
 * firing simultaneously the children thrash the disk and EACH one crawls
 * (25-55s alone; far worse all-parallel). A bounded pool keeps every scan
 * out of each other's way enough to finish quickly, matches limits's own
 * fan-out cap, and makes the live render fill in in waves. */
const USAGE_MAX_CONCURRENT = 6;

export async function runUsageQueryForTargets(
  targets: UsageTarget[],
  options: { explicitTool?: boolean; onItemDone?: (index: number, results: UsageResult[]) => void } = {},
): Promise<UsageResult[]> {
  const suppression: UsageRowSuppression = { explicitTool: options.explicitTool ?? false };
  if (targets.some((target) => !["zai", "ali", "pi"].includes(target.toolName))) await ensureTokscaleCacheFresh();
  return runBatched(
    targets,
    USAGE_MAX_CONCURRENT,
    async (target) => runOne(target, suppression),
    options.onItemDone,
  ).then((batches) => aggregateUsageResults(batches.flat()));
}

/** When the default opencode profile contributes to a report: it is the
 * user's own unscoped opencode usage, so it belongs whenever identities
 * aren't being filtered, and whenever the query is scoped to opencode at
 * all — not when scoped to some other tool's registry. */
export function shouldIncludeDefaultOpencodeProfile(flags: ParsedArgs["flags"]): boolean {
  if (stringFlag(flags, "identity") !== undefined) return false;
  const toolFilter = toolConfigFromFlag(flags);
  return !toolFilter || toolFilter.toolName === "opencode";
}

/** Raw (pre-aggregation) per-provider rows for the default opencode
 * profile, under the synthetic "default" identity — it is not an AIS
 * identity, and pretending otherwise would misattribute the usage. Read
 * failures are real failures: source-only error rows, never fabricated
 * provider rows. */
export async function defaultOpencodeProfileUsageResults(): Promise<UsageResult[]> {
  const identity: Identity = { ...OPENCODE_DEFAULT_PROFILE_IDENTITY, configDir: defaultOpencodeProfileDbPath() };
  const outcome = readOpencodeProfileUsage(defaultOpencodeProfileDbPath());
  if (outcome.kind === "absent") return [];
  if (outcome.kind === "error") {
    return [{ provider: "unattributed", identity, sourceTool: "opencode", sourceOnlyError: true, error: `Could not read the default OpenCode profile: ${outcome.message}` }];
  }
  return outcome.providers.map(({ provider, report, dateSpan, dailyUsage }) => ({
    provider: canonicalUsageProvider(provider),
    identity,
    sourceTool: "opencode" as const,
    report,
    dateSpan,
    dailyUsage,
  }));
}

export async function runUsageQuery(flags: ParsedArgs["flags"]): Promise<UsageResult[]> {
  const targets = await collectTargets(flags);
  const includeDefaultProfile = shouldIncludeDefaultOpencodeProfile(flags);
  const [results, defaultProfileResults] = await Promise.all([
    runUsageQueryForTargets(targets, { explicitTool: toolConfigFromFlag(flags) !== undefined }),
    includeDefaultProfile ? defaultOpencodeProfileUsageResults() : Promise.resolve([] as UsageResult[]),
  ]);
  return aggregateUsageResults([...results, ...defaultProfileResults]);
}

/** JSON follows the same provider-first contract as the table. Client/tool
 * provenance is removed from model entries; provider and model remain. */
export function usageResultsForJson(results: UsageResult[]): unknown[] {
  return results.map(({ pending: _pending, sourceTool: _sourceTool, nativeCoverageTool: _nativeCoverageTool, sourceOnlyError: _sourceOnlyError, ...result }) => ({
    ...result,
    ...(result.report
      ? { report: { ...result.report, entries: result.report.entries.map(({ client: _client, ...entry }) => entry) } }
      : {}),
  }));
}
