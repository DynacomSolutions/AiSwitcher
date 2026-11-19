import { readSecretsKey } from "../cli/gateway/secrets-file.ts";
import { categorizeByLabel, categorizeByMinutes } from "../cli/limits/bucket.ts";
import type { ExtraUsageInfo, LimitCategory, LimitWindow, ManualResetInfo, OverageInfo, ResetGrant, ToolLimitResult } from "../cli/limits/types.ts";
import { providerForTool } from "../cli/usage/providers.ts";
import { loadAll, type LoadedFile } from "../cli/identities/resolve-tool.ts";
import { findIdentityByNameOrAlias } from "../identities/store.ts";
import type { Identity, ToolConfig } from "../identities/types.ts";

/**
 * The cluster gateway is the source of truth for the subscription limits of the identities it manages.
 * The console reads the gateway admin route `GET /limits` server-side (the admin token never reaches the
 * page) and merges its rows over the host scan, so a pod with stale credential files still shows live
 * utilisation windows and reset times.
 */

/** One row of the admin `GET /limits` answer: the gateway usage source's reading of one managed identity. */
export interface GatewayLimitRow {
  provider: string;
  identity: string;
  status: "live" | "rate-limited" | "unavailable";
  capturedAt?: string;
  stale?: boolean;
  maxUtilization?: number;
  windows?: Array<{ label: string; utilization: number; resetsAt?: string; model?: string }>;
  extraUsage?: ExtraUsageInfo;
  manualReset?: ManualResetInfo;
  error?: string;
}

export interface GatewayLimitsView {
  /** False when no admin URL and token are available to this process. */
  configured: boolean;
  rows: ToolLimitResult[];
  /** Short reason when the admin API could not be read; never carries a token. */
  error?: string;
}

/** The providers whose subscription windows the gateway usage source reads. */
const LIMIT_TOOLS = new Set<string>(["claude", "codex", "kimi", "zai"]);

/**
 * The console label and category of a gateway window, identical to the host adapters' rows.
 * The claude pool adapter names its windows five-hour / seven-day / seven-day (<model>); the console
 * shows session (5h) / week (all) / week (<model>). codex, kimi and zai keep the host adapter's label;
 * their category is rebuilt here because the PoolUsage mapping carries the label only.
 */
function windowDisplay(provider: string, label: string, model?: string): { label: string; category: LimitCategory; model?: string } {
  if (provider === "claude") {
    if (label === "five-hour") return { label: "session (5h)", category: "session" };
    if (label === "seven-day") return { label: "week (all)", category: "week" };
    const scoped = /^seven-day \((.+)\)$/.exec(label);
    const name = model ?? scoped?.[1];
    if (scoped || model) return { label: `week (${name ?? "scoped"})`, category: "week", ...(name ? { model: name } : {}) };
    return { label, category: categorizeByLabel(label) };
  }
  const approx = /^~(\d+)([dh])$/.exec(label);
  if (approx) return { label, category: categorizeByMinutes(Number(approx[1]) * (approx[2] === "d" ? 1440 : 60)) };
  return { label, category: categorizeByLabel(label), ...(model ? { model } : {}) };
}

/** The same human reset format the host adapters use, plus the exact epoch. */
function humanReset(iso: string | undefined): { resetsAt?: string; resetsAtMs?: number } {
  const ms = typeof iso === "string" ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(ms)) return {};
  return { resetsAt: new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }), resetsAtMs: ms };
}

/** Defensive read of the usage source's extra-usage block. */
function parseExtraUsage(raw: unknown): ExtraUsageInfo | undefined {
  const e = raw as Record<string, unknown> | null;
  if (!e || typeof e !== "object" || typeof e.enabled !== "boolean" || typeof e.available !== "boolean" || typeof e.label !== "string") return undefined;
  return {
    enabled: e.enabled,
    available: e.available,
    label: e.label,
    ...(typeof e.usedPercent === "number" && Number.isFinite(e.usedPercent) ? { usedPercent: e.usedPercent } : {}),
    ...(e.stale === true ? { stale: true } : {}),
    ...(typeof e.capturedAt === "string" ? { capturedAt: e.capturedAt } : {}),
  };
}

/** Defensive read of one reset grant; a malformed entry is skipped, never guessed. */
function parseResetGrant(raw: unknown): ResetGrant | undefined {
  const g = raw as Record<string, unknown> | null;
  if (!g || typeof g !== "object" || typeof g.id !== "string" || !g.id) return undefined;
  if (g.kind !== "full" && g.kind !== "fable" && g.kind !== "other") return undefined;
  if (typeof g.resetsLeft !== "number" || !Number.isFinite(g.resetsLeft) || typeof g.usableNow !== "boolean" || typeof g.paused !== "boolean") return undefined;
  return {
    id: g.id,
    kind: g.kind,
    resetsLeft: g.resetsLeft,
    usableNow: g.usableNow,
    paused: g.paused,
    ...(typeof g.label === "string" && g.label ? { label: g.label } : {}),
    ...(typeof g.endsAt === "string" && g.endsAt ? { endsAt: g.endsAt } : {}),
  };
}

/** Defensive read of the usage source's manual-reset block (claude grants, codex reset credits). */
function parseManualReset(raw: unknown): ManualResetInfo | undefined {
  const m = raw as Record<string, unknown> | null;
  if (!m || typeof m !== "object" || typeof m.availableCount !== "number" || !Number.isFinite(m.availableCount)) return undefined;
  const grants = Array.isArray(m.grants) ? m.grants.flatMap((g) => parseResetGrant(g) ?? []) : undefined;
  const creditExpiries = Array.isArray(m.creditExpiries)
    ? m.creditExpiries.flatMap((rawCredit) => {
        const c = rawCredit as Record<string, unknown> | null;
        if (!c || typeof c !== "object" || typeof c.id !== "string" || !c.id || typeof c.endsAt !== "string" || !c.endsAt) return [];
        return [{ id: c.id, ...(typeof c.label === "string" && c.label ? { label: c.label } : {}), endsAt: c.endsAt }];
      })
    : undefined;
  return {
    availableCount: m.availableCount,
    ...(typeof m.label === "string" && m.label ? { label: m.label } : {}),
    ...(typeof m.expiresAt === "string" && m.expiresAt ? { expiresAt: m.expiresAt } : {}),
    ...(grants ? { grants } : {}),
    ...(typeof m.cooldownUntil === "string" && m.cooldownUntil ? { cooldownUntil: m.cooldownUntil } : {}),
    ...(typeof m.grantsCapturedAt === "string" && m.grantsCapturedAt ? { grantsCapturedAt: m.grantsCapturedAt } : {}),
    ...(m.stale === true ? { stale: true } : {}),
    ...(creditExpiries && creditExpiries.length > 0 ? { creditExpiries } : {}),
  };
}

/** The claude adapter's overage semantics, from the extra-usage block: the available flag decides, confirmed-zero states carry $0. */
function overageFromExtraUsage(extra: ExtraUsageInfo): OverageInfo {
  if (!extra.enabled) return { active: false, label: "subscription only", spentUsd: 0 };
  return extra.available ? { active: true, label: "using extra usage" } : { active: false, label: "out of extra usage" };
}

/**
 * Maps one admin limits row to the console's ToolLimitResult shape. A stale reading shows as "cached";
 * a reading with no figure shows as "unavailable" with an honest reason. The identity carries the name
 * only here; the merge fills the registry entry in when the host scan has none.
 */
export function mapGatewayLimitRow(raw: unknown): ToolLimitResult | undefined {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r.provider !== "string" || !LIMIT_TOOLS.has(r.provider) || typeof r.identity !== "string" || r.identity === "") return undefined;
  const toolName = r.provider as ToolConfig["toolName"];
  const identity: Identity = { name: r.identity, label: r.identity, configDir: "" };
  const base = { toolName, provider: providerForTool(toolName), identity };
  const windows: LimitWindow[] = [];
  for (const rawWindow of Array.isArray(r.windows) ? r.windows : []) {
    const w = rawWindow as Record<string, unknown> | null;
    if (!w || typeof w.label !== "string" || typeof w.utilization !== "number" || !Number.isFinite(w.utilization)) continue;
    const model = typeof w.model === "string" && w.model ? w.model : undefined;
    const display = windowDisplay(r.provider, w.label, model);
    windows.push({
      label: display.label,
      category: display.category,
      usedPercent: w.utilization,
      ...humanReset(typeof w.resetsAt === "string" ? w.resetsAt : undefined),
      ...(display.model ? { model: display.model } : {}),
    });
  }
  const capturedAt = typeof r.capturedAt === "string" ? r.capturedAt : undefined;
  if (r.status === "unavailable" || windows.length === 0) {
    return {
      ...base,
      windows: [],
      status: "unavailable",
      error: typeof r.error === "string" && r.error ? r.error : "no usage reading from the gateway yet",
      ...(capturedAt ? { capturedAt } : {}),
    };
  }
  const extraUsage = parseExtraUsage(r.extraUsage);
  const manualReset = parseManualReset(r.manualReset);
  return {
    ...base,
    windows,
    // "rate-limited" with a figure is a live reading at 100% (codex/kimi/zai) or a stale claude backoff (stale: true).
    status: r.stale === true ? "cached" : "live",
    ...(capturedAt ? { capturedAt } : {}),
    ...(extraUsage ? { extraUsage, overage: overageFromExtraUsage(extraUsage) } : {}),
    ...(manualReset ? { manualReset } : {}),
  };
}

/** Maps the admin `GET /limits` body to console rows, dropping malformed entries. */
export function mapGatewayLimits(json: unknown): ToolLimitResult[] {
  const list = (json as { limits?: unknown } | null | undefined)?.limits;
  if (!Array.isArray(list)) return [];
  return list.flatMap((raw) => mapGatewayLimitRow(raw) ?? []);
}

export interface LoadGatewayLimitsDeps {
  fetch?: typeof fetch;
  secretsPath?: string;
  timeoutMs?: number;
}

/**
 * Reads the subscription limits from the gateway admin API. Credentials come from ~/.secrets
 * (AIS_GATEWAY_ADMIN_URL, AIS_GATEWAY_ADMIN_TOKEN) or the same env names, exactly as loadGatewayUsage.
 * Failures come back as a short `error`, never thrown, so a down gateway cannot blank the Limits page.
 */
export async function loadGatewayLimits(deps: LoadGatewayLimitsDeps = {}): Promise<GatewayLimitsView> {
  const url = (await readSecretsKey("AIS_GATEWAY_ADMIN_URL", deps.secretsPath)) ?? process.env.AIS_GATEWAY_ADMIN_URL;
  const token = (await readSecretsKey("AIS_GATEWAY_ADMIN_TOKEN", deps.secretsPath)) ?? process.env.AIS_GATEWAY_ADMIN_TOKEN;
  if (!url || !token) return { configured: false, rows: [] };
  const doFetch = deps.fetch ?? fetch;
  try {
    const res = await doFetch(`${url.replace(/\/+$/, "")}/limits`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000),
    });
    if (!res.ok) return { configured: true, rows: [], error: res.status === 404 ? "gateway admin has no limits route yet (older version)" : `admin answered ${res.status}` };
    return { configured: true, rows: mapGatewayLimits(await res.json()) };
  } catch {
    return { configured: true, rows: [], error: "admin unreachable" };
  }
}

/**
 * Merges the gateway rows into a host limits payload. The gateway is authoritative for the identities it
 * manages: its row replaces the host row of the same tool and identity, keeping the host's registry entry.
 * Its reset grants are authoritative too; the host's manualReset survives only when the gateway row genuinely
 * carries none (no reading yet, or a read that never saw grants). Host rows the gateway does not cover stay
 * as they are; gateway rows with no host row are added with their registry entry when one exists. An
 * unconfigured or failed gateway read leaves the payload unchanged. The tool and identity filters apply to
 * the gateway rows as well, so a filtered read never gains rows outside its filter.
 */
export async function mergeGatewayLimits(
  payload: unknown,
  view: GatewayLimitsView,
  filters: { tool?: string; identity?: string } = {},
  loadRegistries: () => Promise<LoadedFile[]> = () => loadAll(),
): Promise<unknown> {
  if (!view.configured || view.error) return payload;
  const results = (payload as { results?: unknown } | null | undefined)?.results;
  if (!Array.isArray(results)) return payload;
  const keyOf = (tool: string, name: string): string => `${tool}\u0000${name}`;
  const gatewayByKey = new Map<string, ToolLimitResult>();
  for (const row of view.rows) {
    if (filters.tool !== undefined && row.toolName !== filters.tool) continue;
    if (filters.identity !== undefined && row.identity.name !== filters.identity) continue;
    gatewayByKey.set(keyOf(row.toolName, row.identity.name), row);
  }
  const hostRows = results as ToolLimitResult[];
  const used = new Set<string>();
  const merged = hostRows.map((host) => {
    const key = host?.toolName && host.identity?.name ? keyOf(host.toolName, host.identity.name) : undefined;
    const gateway = key ? gatewayByKey.get(key) : undefined;
    if (!key || !gateway) return host;
    used.add(key);
    return { ...gateway, identity: host.identity, ...(host.manualReset && !gateway.manualReset ? { manualReset: host.manualReset } : {}) };
  });
  const added = [...gatewayByKey.entries()].filter(([key]) => !used.has(key)).map(([, row]) => row);
  if (added.length > 0) {
    // A managed identity the host scan did not return still deserves its real registry entry (label, aliases).
    const registries = await loadRegistries().catch(() => [] as LoadedFile[]);
    for (const row of added) {
      const file = registries.find((r) => r.cfg.toolName === row.toolName)?.file;
      const found = file ? findIdentityByNameOrAlias(file.identities, row.identity.name) : undefined;
      if (found) row.identity = found;
    }
    added.sort((a, b) => a.toolName.localeCompare(b.toolName) || a.identity.name.localeCompare(b.identity.name));
    merged.push(...added);
  }
  return { ...(payload as object), results: merged };
}