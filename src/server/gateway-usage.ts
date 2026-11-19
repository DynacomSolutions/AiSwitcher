import { canonicalUsageProvider } from "../cli/usage/providers.ts";
import type { UsageResult } from "../cli/usage/run.ts";
import type { TokscaleEntry, TokscaleReport } from "../cli/usage/tokscale.ts";
import { loadAll, type LoadedFile } from "../cli/identities/resolve-tool.ts";
import { findIdentityByNameOrAlias } from "../identities/store.ts";
import type { GatewayModelUsageView } from "../gateway/usage-view.ts";

/**
 * The cluster gateway ledger is the source of truth for the token usage of the identities it manages.
 * The console reads the gateway admin route `GET /usage/models` server-side (the admin token never reaches
 * the page) and merges its per-model totals over the host transcript scan, so a pod with stale or missing
 * local history still shows the real figures. Host rows the gateway does not cover stay as they are.
 *
 * The ledger records tokens, cost and request counts per provider, identity, app and model. It has no
 * per-day split, no tool-call categories and no working directory, so this merge replaces the report and
 * date span only: a merged row counts under "All time" (the web period view says so honestly), and the
 * breakdown and projects views stay host-only.
 */

/** The ledger window the console reads: the admin API bounds it to 90 days. */
export const GATEWAY_USAGE_WINDOW_DAYS = 90;

/** Gateway provider (which equals the tool name) to the console's canonical usage provider. */
const PROVIDER_BY_TOOL: Record<string, string> = {
  claude: "anthropic",
  codex: "openai",
  grok: "xai",
  kimi: "kimi",
  zai: "zai",
  ali: "alibaba",
  opencode: "opencode-go",
};
/** The reverse map, to find the registry a gateway-only identity belongs to. */
const TOOL_BY_PROVIDER: Record<string, string> = Object.fromEntries(Object.entries(PROVIDER_BY_TOOL).map(([tool, provider]) => [provider, tool]));

/**
 * Builds one usage row per provider and identity from the ledger's per-model rows, summing each model
 * across apps. The tool and identity filters apply here, so a filtered read never gains rows outside its
 * filter. A null model becomes an "(unknown)" bucket: its tokens are never dropped. Returns nothing when
 * the gateway is unconfigured or errored.
 */
export function gatewayUsageResults(view: GatewayModelUsageView, filters: { tool?: string; identity?: string } = {}): UsageResult[] {
  if (!view.configured || view.error) return [];
  const groups = new Map<string, { provider: string; identity: string; models: Map<string, TokscaleEntry>; firstMs?: number; lastMs?: number }>();
  for (const row of view.rows) {
    if (filters.tool !== undefined && row.provider !== filters.tool) continue;
    if (filters.identity !== undefined && row.identity !== filters.identity) continue;
    const provider = PROVIDER_BY_TOOL[row.provider] ?? row.provider;
    const key = `${provider}\u0000${row.identity}`;
    let g = groups.get(key);
    if (!g) {
      g = { provider, identity: row.identity, models: new Map() };
      groups.set(key, g);
    }
    const model = row.model ?? "(unknown)";
    let e = g.models.get(model);
    if (!e) {
      e = { client: "gateway", model, provider, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, messageCount: 0, cost: 0 };
      g.models.set(model, e);
    }
    e.input += row.inputTokens;
    e.output += row.outputTokens;
    e.cacheRead += row.cacheReadTokens;
    e.cacheWrite += row.cacheWriteTokens;
    e.messageCount += row.requests;
    e.cost += row.estCostUsd;
    const first = row.firstTs === undefined ? Number.NaN : Date.parse(row.firstTs);
    const last = row.lastTs === undefined ? Number.NaN : Date.parse(row.lastTs);
    if (Number.isFinite(first)) g.firstMs = g.firstMs === undefined ? first : Math.min(g.firstMs, first);
    if (Number.isFinite(last)) g.lastMs = g.lastMs === undefined ? last : Math.max(g.lastMs, last);
  }
  const results: UsageResult[] = [];
  for (const g of groups.values()) {
    const entries = [...g.models.values()].sort((a, b) => b.cost - a.cost || a.model.localeCompare(b.model));
    const report: TokscaleReport = {
      entries,
      totalInput: entries.reduce((s, e) => s + e.input, 0),
      totalOutput: entries.reduce((s, e) => s + e.output, 0),
      totalCacheRead: entries.reduce((s, e) => s + e.cacheRead, 0),
      totalCacheWrite: entries.reduce((s, e) => s + e.cacheWrite, 0),
      totalMessages: entries.reduce((s, e) => s + e.messageCount, 0),
      totalCost: entries.reduce((s, e) => s + e.cost, 0),
    };
    results.push({
      provider: g.provider,
      identity: { name: g.identity, label: g.identity, configDir: "" },
      report,
      ...(g.firstMs !== undefined && g.lastMs !== undefined ? { dateSpan: { firstMs: g.firstMs, lastMs: g.lastMs } } : {}),
    });
  }
  return results.sort((a, b) => a.provider.localeCompare(b.provider) || a.identity.name.localeCompare(b.identity.name));
}

/** The public report shape: entries carry no internal `client` provenance, matching the host rows. */
function publicReport(report: TokscaleReport) {
  return { ...report, entries: report.entries.map(({ client: _client, ...entry }) => entry) };
}

/**
 * Merges the gateway rows into a host usage payload. The gateway is authoritative for the tokens, cost and
 * messages of the identities it manages: its report and date span replace the host's, keeping the host's
 * registry entry and overage. The host's per-day splits and error are dropped (the gateway answer replaces
 * them and cannot split by day). Host rows the gateway does not cover stay as they are; gateway rows with no
 * host row are added with their registry entry when one exists. An unconfigured or failed gateway read leaves
 * the payload unchanged. The tool and identity filters apply to the gateway rows as well.
 */
export async function mergeGatewayUsage(
  payload: unknown,
  view: GatewayModelUsageView,
  filters: { tool?: string; identity?: string } = {},
  loadRegistries: () => Promise<LoadedFile[]> = () => loadAll(),
): Promise<unknown> {
  if (!view.configured || view.error) return payload;
  const results = (payload as { results?: unknown } | null | undefined)?.results;
  if (!Array.isArray(results)) return payload;
  const keyOf = (provider: string, name: string): string => `${canonicalUsageProvider(provider)}\u0000${name}`;
  const gatewayByKey = new Map<string, UsageResult>();
  for (const row of gatewayUsageResults(view, filters)) gatewayByKey.set(keyOf(row.provider, row.identity.name), row);
  const used = new Set<string>();
  const merged: unknown[] = (results as UsageResult[]).map((host) => {
    const key = host?.provider && host.identity?.name ? keyOf(host.provider, host.identity.name) : undefined;
    const gateway = key ? gatewayByKey.get(key) : undefined;
    if (!key || !gateway || !gateway.report) return host;
    used.add(key);
    const { report: _report, dateSpan: _dateSpan, dailyUsage: _dailyUsage, dailyTotals: _dailyTotals, error: _error, pending: _pending, ...rest } = host;
    return { ...rest, report: publicReport(gateway.report), ...(gateway.dateSpan ? { dateSpan: gateway.dateSpan } : {}) };
  });
  const added = [...gatewayByKey.values()].filter((row) => !used.has(keyOf(row.provider, row.identity.name)));
  if (added.length > 0) {
    // A managed identity the host scan did not return still deserves its real registry entry (label, aliases).
    const registries = await loadRegistries().catch(() => [] as LoadedFile[]);
    for (const row of added) {
      const file = registries.find((r) => r.cfg.toolName === TOOL_BY_PROVIDER[row.provider])?.file;
      const found = file ? findIdentityByNameOrAlias(file.identities, row.identity.name) : undefined;
      if (found) row.identity = found;
    }
    added.sort((a, b) => a.provider.localeCompare(b.provider) || a.identity.name.localeCompare(b.identity.name));
    merged.push(...added.map((row) => ({ ...row, ...(row.report ? { report: publicReport(row.report) } : {}) })));
  }
  return { ...(payload as object), results: merged };
}