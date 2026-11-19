import { canonicalUsageProvider } from "../cli/usage/providers.ts";
import type { UsageResult } from "../cli/usage/run.ts";
import type { TokscaleEntry, TokscaleReport } from "../cli/usage/tokscale.ts";
import { loadAll, type LoadedFile } from "../cli/identities/resolve-tool.ts";
import { aisNativeTokscaleConfigDir, readTokscaleBucketTimezone, tokscalePinnedZone, addDailyTotals, type DailyTotals } from "../cli/usage/tokscale.ts";
import { TOKSCALE_TIME_ZONE_NAMES } from "../cli/usage/tokscale-zones.ts";
import { GATEWAY_REFRESH_TOOLS, listAliAccounts, listGatewayManagedAccounts } from "../identities/gateway-managed.ts";
import { findIdentityByNameOrAlias } from "../identities/store.ts";
import type { GatewayModelUsageView } from "../gateway/usage-view.ts";

/**
 * The cluster gateway ledger is the source of truth for the token usage of the identities it manages.
 * The console reads the gateway admin routes `GET /usage/models` and `GET /usage/models/daily` server-side
 * (the admin token never reaches the page) and merges them over the host transcript scan, so a pod with stale
 * or missing local history still shows the real figures. Host rows stay only for identities the gateway does
 * not manage; a managed identity never shows host numbers, even when the gateway read fails (it shows an
 * honest error instead).
 *
 * The ledger records tokens, cost and request counts per provider, identity, app, model and instant. The
 * merge fills the report, date span and the per-day figures (dailyUsage, dailyTotals, bucketed in the zone the
 * host usage view uses). It has no tool-call categories and no working directory, so the breakdown and
 * projects views stay host-only.
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
  const groups = new Map<string, { provider: string; identity: string; models: Map<string, TokscaleEntry>; firstMs?: number; lastMs?: number; daily: Record<string, number>; totals: DailyTotals }>();
  const groupFor = (rawProvider: string, identity: string) => {
    const provider = PROVIDER_BY_TOOL[rawProvider] ?? rawProvider;
    const key = `${provider}\u0000${identity}`;
    let g = groups.get(key);
    if (!g) {
      g = { provider, identity, models: new Map(), daily: {}, totals: {} };
      groups.set(key, g);
    }
    return g;
  };
  for (const row of view.rows) {
    if (filters.tool !== undefined && row.provider !== filters.tool) continue;
    if (filters.identity !== undefined && row.identity !== filters.identity) continue;
    const g = groupFor(row.provider, row.identity);
    const provider = g.provider;
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
  // The per-day split: the same window as the totals, so the days add up to the report. Only days with activity appear.
  for (const row of view.daily ?? []) {
    if (filters.tool !== undefined && row.provider !== filters.tool) continue;
    if (filters.identity !== undefined && row.identity !== filters.identity) continue;
    const g = groupFor(row.provider, row.identity);
    g.daily[row.day] = (g.daily[row.day] ?? 0) + row.inputTokens + row.outputTokens;
    addDailyTotals(g.totals, row.day, row.inputTokens, row.outputTokens, row.cacheReadTokens, row.cacheWriteTokens, row.requests, row.estCostUsd);
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
      ...(view.daily ? { dailyUsage: g.daily, dailyTotals: g.totals } : {}),
    });
  }
  return results.sort((a, b) => a.provider.localeCompare(b.provider) || a.identity.name.localeCompare(b.identity.name));
}

/** The public report shape: entries carry no internal `client` provenance, matching the host rows. */
function publicReport(report: TokscaleReport) {
  return { ...report, entries: report.entries.map(({ client: _client, ...entry }) => entry) };
}

/** One identity the gateway manages: its canonical console provider and registry name. */
export interface ManagedUsageAccount {
  provider: string;
  name: string;
}

/**
 * The identities the gateway manages, from the host registries (the same set the host refreshers skip, see
 * identities/gateway-managed.ts): every live identity of a tool the gateway serves, plus its ali browser sessions.
 * The merge needs it when the gateway read fails, because there are no ledger rows to name them then.
 */
export async function listManagedUsageAccounts(): Promise<ManagedUsageAccount[]> {
  const out: ManagedUsageAccount[] = [];
  for (const tool of GATEWAY_REFRESH_TOOLS) {
    for (const identity of await listGatewayManagedAccounts(undefined, tool).catch(() => [])) out.push({ provider: canonicalUsageProvider(PROVIDER_BY_TOOL[tool] ?? tool), name: identity.name });
  }
  for (const identity of await listAliAccounts().catch(() => [])) out.push({ provider: canonicalUsageProvider(PROVIDER_BY_TOOL.ali ?? "ali"), name: identity.name });
  return out;
}

/**
 * The IANA zone the host usage view buckets its days in: the zone pinned in the native Tokscale settings, else the
 * machine's own zone. A zone the gateway would reject falls back to UTC.
 */
export function usageBucketZone(): string {
  const pinned = tokscalePinnedZone(readTokscaleBucketTimezone(aisNativeTokscaleConfigDir()));
  if (pinned) return pinned;
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return TOKSCALE_TIME_ZONE_NAMES.has(local) ? local : "UTC";
}

/** True when the gateway answered the usage read (configured, no error): its rows may replace host rows. */
export function gatewayUsageAnswered(view: GatewayModelUsageView | undefined): view is GatewayModelUsageView {
  return view !== undefined && view.configured && !view.error;
}

const EMPTY_REPORT = (): TokscaleReport => ({ entries: [], totalInput: 0, totalOutput: 0, totalCacheRead: 0, totalCacheWrite: 0, totalMessages: 0, totalCost: 0 });

/**
 * Merges the gateway rows into a host usage payload. The gateway is authoritative for the tokens, cost, messages and
 * per-day figures of the identities it manages: its report, date span and day splits replace the host's, keeping the
 * host's registry entry and overage. A managed identity is one the gateway reported or the host registries list as
 * gateway-managed (the limits merge uses the gateway's rows the same way). Its host numbers never show: with no ledger
 * rows it shows zero, and when the gateway read fails it shows an honest "gateway usage unavailable" error. Host rows
 * for identities the gateway does not manage stay as they are; gateway rows with no host row are added with their
 * registry entry when one exists. An unconfigured gateway leaves the payload unchanged. The tool and identity filters
 * apply to the gateway rows as well.
 */
export async function mergeGatewayUsage(
  payload: unknown,
  view: GatewayModelUsageView,
  filters: { tool?: string; identity?: string } = {},
  loadRegistries: () => Promise<LoadedFile[]> = () => loadAll(),
  loadManaged: () => Promise<ManagedUsageAccount[]> = listManagedUsageAccounts,
): Promise<unknown> {
  if (!view.configured) return payload;
  const results = (payload as { results?: unknown } | null | undefined)?.results;
  if (!Array.isArray(results)) return payload;
  const keyOf = (provider: string, name: string): string => `${canonicalUsageProvider(provider)}\u0000${name}`;
  const managed = new Set((await loadManaged().catch(() => [] as ManagedUsageAccount[])).map((a) => keyOf(a.provider, a.name)));
  const hostKey = (host: UsageResult): string | undefined => (host?.provider && host.identity?.name ? keyOf(host.provider, host.identity.name) : undefined);
  const stripNumbers = ({ report: _report, dateSpan: _dateSpan, dailyUsage: _dailyUsage, dailyTotals: _dailyTotals, error: _error, pending: _pending, ...rest }: UsageResult) => rest;

  if (view.error) {
    const reason = `gateway usage unavailable: ${view.error}`;
    const merged = (results as UsageResult[]).map((host) => {
      const key = hostKey(host);
      return key && managed.has(key) ? { ...stripNumbers(host), error: reason } : host;
    });
    return { ...(payload as object), results: merged };
  }

  const gatewayByKey = new Map<string, UsageResult>();
  for (const row of gatewayUsageResults(view, filters)) gatewayByKey.set(keyOf(row.provider, row.identity.name), row);
  const used = new Set<string>();
  const merged: unknown[] = (results as UsageResult[]).map((host) => {
    const key = hostKey(host);
    if (!key) return host;
    const gateway = gatewayByKey.get(key);
    if (gateway?.report) {
      used.add(key);
      return {
        ...stripNumbers(host),
        report: publicReport(gateway.report),
        ...(gateway.dateSpan ? { dateSpan: gateway.dateSpan } : {}),
        ...(gateway.dailyUsage ? { dailyUsage: gateway.dailyUsage } : {}),
        ...(gateway.dailyTotals ? { dailyTotals: gateway.dailyTotals } : {}),
      };
    }
    // Managed but no ledger rows in the window: zero from the gateway, never the host's figures.
    if (managed.has(key)) return { ...stripNumbers(host), report: EMPTY_REPORT(), dailyUsage: {}, dailyTotals: {} };
    return host;
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
