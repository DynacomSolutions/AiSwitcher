import { canonicalUsageProvider } from "../cli/usage/providers.ts";
import type { UsageResult } from "../cli/usage/run.ts";
import type { TokscaleEntry, TokscaleReport } from "../cli/usage/tokscale.ts";
import { loadAll, type LoadedFile } from "../cli/identities/resolve-tool.ts";
import { aisNativeTokscaleConfigDir, readTokscaleBucketTimezone, tokscalePinnedZone, addDailyTotals, mergeDailyTotals, type DailyTotals } from "../cli/usage/tokscale.ts";
import { TOKSCALE_TIME_ZONE_NAMES } from "../cli/usage/tokscale-zones.ts";
import { GATEWAY_REFRESH_TOOLS, listAliAccounts, listGatewayManagedAccounts } from "../identities/gateway-managed.ts";
import { findIdentityByNameOrAlias } from "../identities/store.ts";
import type { GatewayModelUsageView } from "../gateway/usage-view.ts";

/**
 * The cluster gateway ledger is the source of truth for the token usage of the identities it manages.
 * The console reads the gateway admin routes `GET /usage/models` and `GET /usage/models/daily` server-side
 * (the admin token never reaches the page) and merges them over the host transcript scan, so a pod with stale
 * or missing local history still shows the real figures. History is never deleted: host history the ledger does
 * not cover stays, also when the gateway read fails (the row then carries an error next to the host numbers).
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

/** The gateway's own provider label on host rows; it is a transport, never a usage provider. */
const GATEWAY_TRANSPORT_PROVIDER = "ais-gateway";

/** The ledger identity for requests the gateway answered without picking a member (for example 429 refusals). */
const NO_ACCOUNT_LEDGER_IDENTITY = "-";
/** The row name that replaces it: one clearly labelled row per provider, with the counts kept. */
export const GATEWAY_NO_ACCOUNT_NAME = "Gateway (no account)";

/**
 * The provider a host row counts as for the merge. The host scan labels gateway-routed Codex rows "ais-gateway, openai":
 * dropping the transport label leaves the one real provider, so the row meets its gateway row. Other labels keep
 * their canonical form.
 */
export function mergeProviderKey(provider: string): string {
  const parts = [...new Set(provider.split(",").map((part) => canonicalUsageProvider(part)).filter((part) => part !== "unattributed" && part !== GATEWAY_TRANSPORT_PROVIDER))];
  return parts.length === 1 ? parts[0]! : canonicalUsageProvider(provider);
}

/**
 * Builds one usage row per provider and identity from the ledger's per-model rows, summing each model
 * across apps. The tool and identity filters apply here, so a filtered read never gains rows outside its
 * filter. A null model becomes an "(unknown)" bucket: its tokens are never dropped. Returns nothing when
 * the gateway is unconfigured or errored.
 */
export function gatewayUsageResults(view: GatewayModelUsageView, filters: { tool?: string; identity?: string } = {}): UsageResult[] {
  if (!view.configured || view.error) return [];
  const groups = new Map<string, { provider: string; identity: string; models: Map<string, TokscaleEntry>; firstMs?: number; lastMs?: number; daily: Record<string, number>; totals: DailyTotals }>();
  const groupFor = (rawProvider: string, ledgerIdentity: string) => {
    const identity = ledgerIdentity === NO_ACCOUNT_LEDGER_IDENTITY ? GATEWAY_NO_ACCOUNT_NAME : ledgerIdentity;
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

/** The "YYYY-MM-DD" day of an instant in the given IANA zone. */
function dayInZone(ms: number, zone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

/**
 * Splices one host row and its gateway row by day. The ledger only starts when the gateway went live, so the host
 * transcript history before that day is the only record and must stay. Coverage start is the first gateway day (the
 * first daily row, else the first ledger instant in the bucket zone). Days before it come from the host; days on or
 * after it come from the gateway only, so no day counts twice.
 *
 * The host report has per-model totals but no per-day per-model split, so the pre-coverage model figures are an
 * honest proportional share: each host model entry is scaled, field by field, by (host days before coverage) / (all
 * host days) taken from host dailyTotals. The model entries then add up exactly to the pre-coverage day totals.
 * Without host dailyTotals the host cannot be split, so the gateway row stands alone.
 */
export function spliceHostWithGateway(host: UsageResult, gateway: UsageResult, zone: string = usageBucketZone()): Pick<UsageResult, "report" | "dateSpan" | "dailyUsage" | "dailyTotals"> {
  const gw = gateway.report!;
  const gwDays = Object.keys(gateway.dailyTotals ?? {}).sort();
  const start = gwDays[0] ?? (gateway.dateSpan ? dayInZone(gateway.dateSpan.firstMs, zone) : undefined);
  const hostTotals = host.dailyTotals;
  const gatewayOnly = { report: gw, ...(gateway.dateSpan ? { dateSpan: gateway.dateSpan } : {}), ...(gateway.dailyUsage ? { dailyUsage: gateway.dailyUsage } : {}), ...(gateway.dailyTotals ? { dailyTotals: gateway.dailyTotals } : {}) };
  if (!start || !host.report || !hostTotals) return gatewayOnly;
  const preTotals: DailyTotals = {};
  const hostAll = [0, 0, 0, 0, 0, 0];
  const pre = [0, 0, 0, 0, 0, 0];
  for (const [day, v] of Object.entries(hostTotals)) {
    for (let i = 0; i < 6; i++) hostAll[i]! += v[i]!;
    if (day < start) {
      preTotals[day] = [...v];
      for (let i = 0; i < 6; i++) pre[i]! += v[i]!;
    }
  }
  if (Object.keys(preTotals).length === 0) return gatewayOnly;
  const preDailyUsage: Record<string, number> = {};
  for (const [day, tokens] of Object.entries(host.dailyUsage ?? {})) if (day < start) preDailyUsage[day] = tokens;
  const ratio = (i: number) => (hostAll[i]! > 0 ? Math.min(1, pre[i]! / hostAll[i]!) : 0);
  const [rIn, rOut, rCr, rCw, rMsg, rCost] = [0, 1, 2, 3, 4, 5].map(ratio) as [number, number, number, number, number, number];
  const models = new Map<string, TokscaleEntry>();
  for (const e of host.report.entries) {
    const scaled: TokscaleEntry = { ...e, input: e.input * rIn, output: e.output * rOut, cacheRead: e.cacheRead * rCr, cacheWrite: e.cacheWrite * rCw, messageCount: e.messageCount * rMsg, cost: e.cost * rCost };
    const have = models.get(e.model);
    if (!have) { models.set(e.model, scaled); continue; }
    have.input += scaled.input; have.output += scaled.output; have.cacheRead += scaled.cacheRead; have.cacheWrite += scaled.cacheWrite; have.messageCount += scaled.messageCount; have.cost += scaled.cost;
  }
  for (const e of gw.entries) {
    const have = models.get(e.model);
    if (!have) { models.set(e.model, { ...e }); continue; }
    have.input += e.input; have.output += e.output; have.cacheRead += e.cacheRead; have.cacheWrite += e.cacheWrite; have.messageCount += e.messageCount; have.cost += e.cost;
  }
  const entries = [...models.values()].filter((e) => e.input + e.output + e.cacheRead + e.cacheWrite + e.messageCount + e.cost > 0).sort((a, b) => b.cost - a.cost || a.model.localeCompare(b.model));
  const report: TokscaleReport = {
    entries,
    totalInput: entries.reduce((x, e) => x + e.input, 0),
    totalOutput: entries.reduce((x, e) => x + e.output, 0),
    totalCacheRead: entries.reduce((x, e) => x + e.cacheRead, 0),
    totalCacheWrite: entries.reduce((x, e) => x + e.cacheWrite, 0),
    totalMessages: entries.reduce((x, e) => x + e.messageCount, 0),
    totalCost: entries.reduce((x, e) => x + e.cost, 0),
  };
  const dailyTotals = mergeDailyTotals(preTotals, gateway.dailyTotals) ?? {};
  const dailyUsage: Record<string, number> = { ...preDailyUsage, ...(gateway.dailyUsage ?? {}) };
  const firstMs = Math.min(host.dateSpan?.firstMs ?? Number.POSITIVE_INFINITY, gateway.dateSpan?.firstMs ?? Number.POSITIVE_INFINITY);
  const lastMs = gateway.dateSpan?.lastMs ?? host.dateSpan?.lastMs;
  return {
    report,
    ...(Number.isFinite(firstMs) && lastMs !== undefined ? { dateSpan: { firstMs, lastMs } } : {}),
    dailyUsage,
    dailyTotals,
  };
}

const NUMERIC_ENTRY_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "reasoning", "messageCount", "cost"] as const;

/**
 * Combines host rows that share one managed key into one row, so no host history is dropped. Report entries are
 * summed by model (every numeric field) and the report totals are recomputed. dailyUsage and dailyTotals are summed
 * per day, and dateSpan widens to the earliest first and the latest last instant. The first row keeps its identity
 * and every other field.
 */
export function combineHostRows(rows: UsageResult[]): UsageResult {
  const first = rows[0]!;
  if (rows.length === 1) return first;
  const withReport = rows.filter((r) => r.report);
  const models = new Map<string, TokscaleEntry>();
  for (const r of withReport) {
    for (const e of r.report!.entries) {
      const have = models.get(e.model);
      if (!have) { models.set(e.model, { ...e }); continue; }
      for (const f of NUMERIC_ENTRY_FIELDS) have[f] += e[f];
    }
  }
  const entries = [...models.values()];
  const report: TokscaleReport | undefined = withReport.length === 0 ? undefined : {
    entries,
    totalInput: entries.reduce((x, e) => x + e.input, 0),
    totalOutput: entries.reduce((x, e) => x + e.output, 0),
    totalCacheRead: entries.reduce((x, e) => x + e.cacheRead, 0),
    totalCacheWrite: entries.reduce((x, e) => x + e.cacheWrite, 0),
    totalMessages: entries.reduce((x, e) => x + e.messageCount, 0),
    totalCost: entries.reduce((x, e) => x + e.cost, 0),
  };
  let dailyUsage: Record<string, number> | undefined;
  let dailyTotals: DailyTotals | undefined;
  for (const r of rows) {
    if (r.dailyUsage) {
      dailyUsage ??= {};
      for (const [d, v] of Object.entries(r.dailyUsage)) dailyUsage[d] = (dailyUsage[d] ?? 0) + v;
    }
    if (r.dailyTotals) {
      dailyTotals ??= {};
      for (const [d, v] of Object.entries(r.dailyTotals)) {
        const have = dailyTotals[d];
        dailyTotals[d] = have ? (have.map((x, i) => x + v[i]!) as DailyTotals[string]) : [...v];
      }
    }
  }
  const spans = rows.flatMap((r) => (r.dateSpan ? [r.dateSpan] : []));
  const dateSpan = spans.length === 0 ? undefined : { firstMs: Math.min(...spans.map((x) => x.firstMs)), lastMs: Math.max(...spans.map((x) => x.lastMs)) };
  return {
    ...first,
    ...(report ? { report } : {}),
    ...(dailyUsage ? { dailyUsage } : {}),
    ...(dailyTotals ? { dailyTotals } : {}),
    ...(dateSpan ? { dateSpan } : {}),
  };
}

/**
 * Merges the gateway rows into a host usage payload. History is never deleted. The gateway is authoritative for the
 * tokens, cost, messages and per-day figures of the identities it manages from its first ledger day on. Host days
 * before that day stay (see spliceHostWithGateway), so all-time totals keep the history from before the gateway
 * existed. Host rows that share one managed key (another provider label) are combined first (see combineHostRows),
 * never dropped. The host's registry entry and overage stay. A managed identity is one the gateway reported or the
 * host registries list as gateway-managed. With no ledger rows in the window the combined host row stays as it is,
 * because host history is then the only record. When the gateway read fails the host numbers stay and the row gains a
 * "gateway usage unavailable" error. Host rows for identities the gateway does not manage stay as they are; gateway
 * rows with no host row are added with their registry entry when one exists. An unconfigured gateway leaves the
 * payload unchanged. The tool and identity filters apply to the gateway rows as well.
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
  const keyOf = (provider: string, name: string): string => `${mergeProviderKey(provider)}\u0000${name}`;
  const managed = new Set((await loadManaged().catch(() => [] as ManagedUsageAccount[])).map((a) => keyOf(a.provider, a.name)));
  const hostKey = (host: UsageResult): string | undefined => (host?.provider && host.identity?.name ? keyOf(host.provider, host.identity.name) : undefined);
  const stripNumbers = ({ report: _report, dateSpan: _dateSpan, dailyUsage: _dailyUsage, dailyTotals: _dailyTotals, error: _error, pending: _pending, ...rest }: UsageResult) => rest;
  const gatewayByKey = new Map<string, UsageResult>();
  if (!view.error) for (const row of gatewayUsageResults(view, filters)) gatewayByKey.set(keyOf(row.provider, row.identity.name), row);
  const isManaged = (key: string): boolean => managed.has(key) || gatewayByKey.get(key)?.report !== undefined;
  // Host rows of one managed key combine into one row at the first row's position: no host history is dropped.
  const groups = new Map<string, UsageResult[]>();
  for (const host of results as UsageResult[]) {
    const key = hostKey(host);
    if (key && isManaged(key)) groups.set(key, [...(groups.get(key) ?? []), host]);
  }
  const combined = new Map<string, UsageResult>([...groups].map(([key, rows]) => [key, combineHostRows(rows)]));
  const seenManaged = new Set<string>();

  if (view.error) {
    const reason = `gateway usage unavailable: ${view.error}`;
    const out = (results as UsageResult[]).flatMap((host) => {
      const key = hostKey(host);
      if (!key || !combined.has(key)) return [host];
      if (seenManaged.has(key)) return [];
      seenManaged.add(key);
      const row = combined.get(key)!;
      return [{ ...row, provider: mergeProviderKey(row.provider), error: reason }];
    });
    return { ...(payload as object), results: out };
  }

  const used = new Set<string>();
  const merged: unknown[] = (results as UsageResult[]).flatMap((host): unknown[] => {
    const key = hostKey(host);
    if (!key) return [host];
    const row = combined.get(key);
    if (!row) return [host];
    if (seenManaged.has(key)) return [];
    seenManaged.add(key);
    const provider = mergeProviderKey(row.provider);
    const gateway = gatewayByKey.get(key);
    if (gateway?.report) {
      used.add(key);
      const spliced = spliceHostWithGateway(row, gateway);
      return [{
        ...stripNumbers(row),
        provider,
        report: publicReport(spliced.report!),
        ...(spliced.dateSpan ? { dateSpan: spliced.dateSpan } : {}),
        ...(spliced.dailyUsage ? { dailyUsage: spliced.dailyUsage } : {}),
        ...(spliced.dailyTotals ? { dailyTotals: spliced.dailyTotals } : {}),
      }];
    }
    // Managed but no ledger rows in the window: the gateway has no record, so host history is the only record.
    return [{ ...row, provider }];
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
