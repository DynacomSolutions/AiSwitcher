import type { GatewayPeriod, LimitWindow, PoolRef, PoolsUsageResponse, ToolLimitResult, UsageResult } from "../types/api";

/** The usage provider each pool tool's native figures are filed under. */
const USAGE_PROVIDER: Record<string, string> = { claude: "anthropic", codex: "openai", kimi: "kimi" };
/** The provider name the gateway ledger uses for the same tool. */
const GATEWAY_PROVIDER: Record<string, string> = { claude: "claude", codex: "codex", kimi: "kimi" };

export type PeriodName = "today" | "week";

export interface Figure {
  tokens: number;
  costUsd: number;
}

export interface MemberPeriod {
  /** Known native figure, or the reason it is missing. */
  native: Figure | { missing: string };
  /** Known gateway ledger figure (a member absent from a reachable ledger is a real zero), or the reason it is missing. */
  gateway: (Figure & { unpricedRequests: number }) | { missing: string };
}

export interface MemberUsage {
  name: string;
  allowed: boolean;
  today: MemberPeriod;
  week: MemberPeriod;
  /** Worst window utilisation over the member's limit windows, or why there is none. */
  worstPercent?: number;
  worstLabel?: string;
  limitMissing?: string;
}

export interface PeriodTotal {
  tokens: number;
  costUsd: number;
  nativeTokens: number;
  gatewayTokens: number;
  /** Gateway requests whose model has no price: the cost is a floor when above zero. */
  unpricedRequests: number;
  /** Members whose every source is known. */
  covered: number;
  total: number;
  missing: Array<{ member: string; reason: string }>;
}

export interface PoolWindow {
  label: string;
  worstPercent: number;
  meanPercent: number;
  reporting: number;
  total: number;
}

export interface PoolSummary {
  key: string;
  tool: string;
  name: string;
  active?: string;
  members: MemberUsage[];
  today: PeriodTotal;
  week: PeriodTotal;
  windows: PoolWindow[];
}

const isMissing = (v: object): v is { missing: string } => "missing" in v;

function dayFigure(result: UsageResult | undefined, from: string, to: string): Figure | { missing: string } {
  if (!result) return { missing: "no native usage record" };
  if (result.pending) return { missing: "native usage still scanning" };
  if (result.error) return { missing: "native usage failed" };
  if (!result.report) return { missing: "no native usage report" };
  if (!result.dailyTotals) return { missing: "native usage has no per-day figures" };
  let tokens = 0;
  let costUsd = 0;
  for (const [day, v] of Object.entries(result.dailyTotals)) {
    if (day < from || day > to) continue;
    tokens += v[0] + v[1] + v[2] + v[3];
    costUsd += v[5];
  }
  return { tokens, costUsd };
}

function gatewayFigure(period: GatewayPeriod, provider: string, member: string): MemberPeriod["gateway"] {
  if (!period.configured) return { missing: "gateway ledger not configured" };
  if (period.error) return { missing: `gateway ledger unavailable (${period.error})` };
  let tokens = 0;
  let costUsd = 0;
  let unpricedRequests = 0;
  for (const r of period.rows) {
    if (r.identity !== member || r.provider !== provider) continue;
    tokens += r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens;
    costUsd += r.estCostUsd;
    unpricedRequests += r.unpricedRequests;
  }
  return { tokens, costUsd, unpricedRequests };
}

function total(members: MemberUsage[], period: PeriodName): PeriodTotal {
  const t: PeriodTotal = { tokens: 0, costUsd: 0, nativeTokens: 0, gatewayTokens: 0, unpricedRequests: 0, covered: 0, total: members.length, missing: [] };
  for (const m of members) {
    const p = m[period];
    const reasons: string[] = [];
    if (isMissing(p.native)) reasons.push(p.native.missing);
    else {
      t.nativeTokens += p.native.tokens;
      t.tokens += p.native.tokens;
      t.costUsd += p.native.costUsd;
    }
    if (isMissing(p.gateway)) reasons.push(p.gateway.missing);
    else {
      t.gatewayTokens += p.gateway.tokens;
      t.tokens += p.gateway.tokens;
      t.costUsd += p.gateway.costUsd;
      t.unpricedRequests += p.gateway.unpricedRequests;
    }
    if (reasons.length === 0) t.covered += 1;
    else t.missing.push({ member: m.name, reason: reasons.join("; ") });
  }
  return t;
}

function limitsFor(tool: string, member: string, limits: ToolLimitResult[]): { windows: LimitWindow[] } | { missing: string } {
  const r = limits.find((l) => l.toolName === tool && l.identity.name === member);
  if (!r) return { missing: "no limits record" };
  if (r.status === "pending") return { missing: "limits still loading" };
  if (r.windows.length === 0) return { missing: r.status === "unavailable" ? "limits unavailable" : "no limit windows reported" };
  return { windows: r.windows };
}

/** Sums each pool's members: native usage (daily figures), gateway ledger usage attributed by identity, and limit windows.
 * A member with a missing figure is listed with its reason and lowers `covered`; it never counts as zero. */
export function summarisePools(pools: PoolRef[], usage: UsageResult[], limits: ToolLimitResult[], resp: Pick<PoolsUsageResponse, "todayKey" | "weekStartKey" | "gateway">): PoolSummary[] {
  return pools.map((pool) => {
    const usageProvider = USAGE_PROVIDER[pool.tool] ?? pool.tool;
    const gwProvider = GATEWAY_PROVIDER[pool.tool] ?? pool.tool;
    const perWindow = new Map<string, number[]>();
    const members: MemberUsage[] = pool.members.map((m) => {
      const result = usage.find((u) => u.provider === usageProvider && u.identity.name === m.name);
      const period = (name: PeriodName): MemberPeriod => ({
        native: dayFigure(result, name === "today" ? resp.todayKey : resp.weekStartKey, resp.todayKey),
        gateway: gatewayFigure(resp.gateway[name], gwProvider, m.name),
      });
      const out: MemberUsage = { name: m.name, allowed: m.allowed, today: period("today"), week: period("week") };
      const lim = limitsFor(pool.tool, m.name, limits);
      if ("missing" in lim) out.limitMissing = lim.missing;
      else {
        let worst = lim.windows[0]!;
        for (const w of lim.windows) {
          if (w.usedPercent > worst.usedPercent) worst = w;
          perWindow.set(w.label, [...(perWindow.get(w.label) ?? []), w.usedPercent]);
        }
        out.worstPercent = worst.usedPercent;
        out.worstLabel = worst.label;
      }
      return out;
    });
    const windows: PoolWindow[] = [...perWindow.entries()].map(([label, values]) => ({
      label,
      worstPercent: Math.max(...values),
      meanPercent: values.reduce((a, b) => a + b, 0) / values.length,
      reporting: values.length,
      total: members.length,
    }));
    return {
      key: `${pool.tool}/${pool.name}`,
      tool: pool.tool,
      name: pool.name,
      ...(pool.active ? { active: pool.active } : {}),
      members,
      today: total(members, "today"),
      week: total(members, "week"),
      windows,
    };
  });
}

/** "partial (n of m members)" text for an incomplete total, or undefined when every member is covered. */
export function partialLabel(t: PeriodTotal): string | undefined {
  return t.covered === t.total ? undefined : `partial (${t.covered} of ${t.total} members)`;
}
