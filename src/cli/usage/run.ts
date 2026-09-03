import type { Identity, ToolConfig } from "../../identities/types.ts";
import { stringFlag, type ParsedArgs } from "../args.ts";
import { CliUsageError } from "../errors.ts";
import { loadAll, TOOL_CONFIGS, toolConfigFromFlag } from "../identities/resolve-tool.ts";
import { fetchClaudeLimits } from "../limits/claude-limits.ts";
import { fetchCodexLimits } from "../limits/codex-limits.ts";
import { fetchKimiLimits } from "../limits/kimi-limits.ts";
import type { OverageInfo } from "../limits/types.ts";
import { fetchAliUsage } from "./ali-usage.ts";
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
      return suppression.explicitTool
        ? [providerResult(target, "unattributed", { error: "no local Pi provider usage yet for this identity" })]
        : [];
    }
    return providers.map(({ provider, nativeCoverageTool, report, dateSpan, dailyUsage }) =>
      providerResult(target, provider, { report, dateSpan, dailyUsage, ...(nativeCoverageTool ? { nativeCoverageTool } : {}) }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return [providerResult(target, "unattributed", { error: `Could not read Pi usage: ${message}` })];
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
  if (!invocation) return [providerResult(target, fallbackProvider, { error: "usage tracking is not supported for this source" })];
  const { env, clientArgs } = invocation;

  try {
    const stdout = await runTokscaleProcess([...clientArgs, "--json"], env);
    return providerReportsFromTokscale(target, JSON.parse(stdout) as TokscaleReport, suppression);
  } catch (err) {
    const message = err instanceof SyntaxError
      ? "Could not parse tokscale's --json output."
      : `Could not run tokscale: ${err instanceof Error ? err.message : String(err)}`;
    return [providerResult(target, fallbackProvider, { error: message })];
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

/** Per-target ceiling. A single target whose storage is unreachable (a
 * crush.db on a hung network mount, observed live) must not hold the whole
 * report forever; it degrades to an honest error row instead, matching the
 * existing "report the error, don't crash" contract for unreadable data. */
const PER_TARGET_TIMEOUT_MS = 25_000;

async function runOneBounded(target: UsageTarget, suppression: UsageRowSuppression): Promise<UsageResult[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<UsageResult[]>((resolve) => {
    timer = setTimeout(() => resolve([{ ...pendingUsageResult(target), pending: undefined, error: `timed out after ${PER_TARGET_TIMEOUT_MS / 1000}ms` }]), PER_TARGET_TIMEOUT_MS);
  });
  try {
    return await Promise.race([runOne(target, suppression), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runUsageQueryForTargets(
  targets: UsageTarget[],
  options: { explicitTool?: boolean; onItemDone?: (index: number, results: UsageResult[]) => void } = {},
): Promise<UsageResult[]> {
  const suppression: UsageRowSuppression = { explicitTool: options.explicitTool ?? false };
  if (targets.some((target) => !["zai", "ali", "pi"].includes(target.toolName))) await ensureTokscaleCacheFresh();
  const results: UsageResult[][] = new Array(targets.length);
  await Promise.all(
    targets.map(async (target, index) => {
      const targetResults = await runOneBounded(target, suppression);
      results[index] = targetResults;
      options.onItemDone?.(index, targetResults);
    }),
  );
  return aggregateUsageResults(results.flat());
}

export async function runUsageQuery(flags: ParsedArgs["flags"]): Promise<UsageResult[]> {
  const targets = await collectTargets(flags);
  return runUsageQueryForTargets(targets, { explicitTool: toolConfigFromFlag(flags) !== undefined });
}

/** JSON follows the same provider-first contract as the table. Client/tool
 * provenance is removed from model entries; provider and model remain. */
export function usageResultsForJson(results: UsageResult[]): unknown[] {
  return results.map(({ pending: _pending, sourceTool: _sourceTool, nativeCoverageTool: _nativeCoverageTool, ...result }) => ({
    ...result,
    ...(result.report
      ? { report: { ...result.report, entries: result.report.entries.map(({ client: _client, ...entry }) => entry) } }
      : {}),
  }));
}
