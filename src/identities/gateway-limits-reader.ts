import { readSecretsKey } from "../cli/gateway/secrets-file.ts";
import { categorizeByLabel, categorizeByMinutes } from "../cli/limits/bucket.ts";
import type { ExtraUsageInfo, LimitCategory, LimitWindow, ManualResetInfo, OverageInfo, ResetGrant, ToolLimitResult } from "../cli/limits/types.ts";
import { providerForTool } from "../cli/usage/providers.ts";
import { claudePlanLabel, resetGrantKind } from "./claude-usage-api.ts";
import type { Identity, ToolConfig } from "./types.ts";

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
  /** Claude: the profile plan the gateway reads hourly (type and rate-limit tier). */
  plan?: { type: string; tier?: string; checkedAt?: string; stale?: boolean };
  /** Other providers: the short plan display label from the limits fetch. */
  planLabel?: string;
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
const LIMIT_TOOLS = new Set<string>(["claude", "codex", "kimi", "grok", "zai", "ali", "opencode"]);

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

/** Defensive read of the reset-grant block the gateway poll carries (claude cedar_ember). */
function parseManualReset(raw: unknown): ManualResetInfo | undefined {
  const m = raw as Record<string, unknown> | null;
  if (!m || typeof m !== "object" || typeof m.availableCount !== "number" || !Number.isFinite(m.availableCount)) return undefined;
  const grants: ResetGrant[] = [];
  for (const rawGrant of Array.isArray(m.grants) ? m.grants : []) {
    const g = rawGrant as Record<string, unknown> | null;
    if (!g || typeof g.id !== "string" || g.id === "") continue;
    const label = typeof g.label === "string" && g.label ? g.label : undefined;
    const kind = g.kind === "full" || g.kind === "fable" || g.kind === "other" ? g.kind : resetGrantKind(g.id, label);
    grants.push({
      id: g.id,
      ...(label ? { label } : {}),
      kind,
      resetsLeft: typeof g.resetsLeft === "number" && Number.isFinite(g.resetsLeft) ? g.resetsLeft : 0,
      usableNow: g.usableNow === true,
      paused: g.paused === true,
      ...(typeof g.endsAt === "string" ? { endsAt: g.endsAt } : {}),
    });
  }
  return {
    availableCount: m.availableCount,
    ...(typeof m.label === "string" ? { label: m.label } : {}),
    ...(typeof m.expiresAt === "string" ? { expiresAt: m.expiresAt } : {}),
    ...(Array.isArray(m.grants) ? { grants } : {}),
    ...(typeof m.cooldownUntil === "string" ? { cooldownUntil: m.cooldownUntil } : {}),
    ...(typeof m.grantsCapturedAt === "string" ? { grantsCapturedAt: m.grantsCapturedAt } : {}),
    ...(Array.isArray(m.creditExpiries) ? { creditExpiries: m.creditExpiries.flatMap((v) => {
      const c = v as Record<string, unknown> | null;
      return c && typeof c.id === "string" && typeof c.endsAt === "string" && Number.isFinite(Date.parse(c.endsAt))
        ? [{ id: c.id, ...(typeof c.label === "string" ? { label: c.label } : {}), endsAt: new Date(c.endsAt).toISOString() }]
        : [];
    }) } : {}),
    ...(m.stale === true ? { stale: true } : {}),
  };
}

/** Codex reset credits have a different wire shape from Claude grants. Keep only provider-reported fields. */
function parseCodexReset(raw: unknown): ManualResetInfo | undefined {
  const m = raw as Record<string, unknown> | null;
  if (!m || typeof m !== "object" || typeof m.availableCount !== "number" || !Number.isFinite(m.availableCount) || m.availableCount < 0) return undefined;
  const creditExpiries = Array.isArray(m.creditExpiries) ? m.creditExpiries.flatMap((v) => {
    const c = v as Record<string, unknown> | null;
    return c && typeof c.id === "string" && typeof c.endsAt === "string" && Number.isFinite(Date.parse(c.endsAt))
      ? [{ id: c.id, ...(typeof c.label === "string" ? { label: c.label } : {}), endsAt: new Date(c.endsAt).toISOString() }]
      : [];
  }) : undefined;
  return {
    availableCount: Math.floor(m.availableCount),
    ...(typeof m.label === "string" ? { label: m.label } : {}),
    ...(typeof m.expiresAt === "string" ? { expiresAt: m.expiresAt } : {}),
    ...(creditExpiries ? { creditExpiries } : {}),
    ...(m.stale === true ? { stale: true } : {}),
  };
}

/** The claude adapter's overage semantics, from the extra-usage block: the available flag decides, confirmed-zero states carry $0. */
function overageFromExtraUsage(extra: ExtraUsageInfo): OverageInfo {
  if (!extra.enabled) return { active: false, label: "subscription only", spentUsd: 0 };
  return extra.available ? { active: true, label: "using extra usage" } : { active: false, label: "out of extra usage" };
}

/** Plan display label of a gateway row: claude's profile plan object, or the
 * short label the other providers' adapters carry. Absent stays absent. */
function rowPlanLabel(r: Record<string, unknown>): string | undefined {
  if (r.provider === "claude") {
    const p = r.plan as { type?: unknown; tier?: unknown } | null | undefined;
    if (!p || typeof p.type !== "string" || p.type === "") return undefined;
    return claudePlanLabel({ type: p.type, ...(typeof p.tier === "string" ? { tier: p.tier } : {}) });
  }
  return typeof r.planLabel === "string" && r.planLabel !== "" ? r.planLabel : undefined;
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
  const base = { toolName, provider: providerForTool(toolName), identity, gatewayManaged: true };
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
  const plan = rowPlanLabel(r);
  if (r.status === "unavailable" || windows.length === 0) {
    const resetOnly = r.provider === "claude" ? parseManualReset(r.manualReset) : r.provider === "codex" ? parseCodexReset(r.manualReset) : undefined;
    return {
      ...base,
      windows: [],
      ...(resetOnly ? { manualReset: resetOnly } : {}),
      status: "unavailable",
      error: typeof r.error === "string" && r.error ? r.error : "no usage reading from the gateway yet",
      ...(capturedAt ? { capturedAt } : {}),
      ...(plan ? { plan } : {}),
    };
  }
  const extraUsage = parseExtraUsage(r.extraUsage);
  const manualReset = r.provider === "claude" ? parseManualReset(r.manualReset) : r.provider === "codex" ? parseCodexReset(r.manualReset) : undefined;
  return {
    ...base,
    windows,
    ...(manualReset ? { manualReset } : {}),
    ...(plan ? { plan } : {}),
    // "rate-limited" with a figure is a live reading at 100% (codex/kimi/zai) or a stale claude backoff (stale: true).
    status: r.stale === true ? "cached" : "live",
    // A cached reading says why it is not fresh (the gateway's newest failed read), so the card does not hide it.
    ...(r.stale === true && typeof r.error === "string" && r.error ? { error: r.error } : {}),
    ...(capturedAt ? { capturedAt } : {}),
    ...(extraUsage ? { extraUsage, ...(r.provider === "codex" ? {} : { overage: overageFromExtraUsage(extraUsage) }) } : {}),
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
  /** Narrows the admin read to one provider (`?provider=`). */
  provider?: string;
  /** Narrows the admin read to one identity (`?identity=`). */
  identity?: string;
  /** Requests a read-only, account-scoped usage refresh (`?fresh=1`). */
  fresh?: boolean;
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
    const query = new URLSearchParams();
    if (deps.provider) query.set("provider", deps.provider);
    if (deps.identity) query.set("identity", deps.identity);
    if (deps.fresh) query.set("fresh", "1");
    const qs = query.size > 0 ? `?${query}` : "";
    const res = await doFetch(`${url.replace(/\/+$/, "")}/limits${qs}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000),
    });
    if (!res.ok) return { configured: true, rows: [], error: res.status === 404 ? "gateway admin has no limits route yet (older version)" : `admin answered ${res.status}` };
    return { configured: true, rows: mapGatewayLimits(await res.json()) };
  } catch {
    return { configured: true, rows: [], error: "admin unreachable" };
  }
}
