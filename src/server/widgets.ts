import { isIP } from "node:net";
import { usageProviderLabel } from "../cli/usage/providers.ts";
import { PollCache } from "./expensive.ts";

/** Widget panels: small, read-only summaries of console data for dashboards
 * (the Headlamp widget panel API). Each panel maps the output of an existing
 * engine to one model. No data is collected here and no panel cache is kept
 * outside `WidgetService`. */

// The types below copy the widget panel contract. Do not add fields, except the optional agent fields on `Row`
// (`tool`, `pool`, `identity`, `identitySource`, `sessionId`, `activeIdentity`, `identities`) and the optional `meta.resetsAt` on `Row`.
// The dashboard needs `meta.resetsAt` (ISO 8601 UTC) to draw a reset countdown on each limit bar. A reader that does not know a field ignores it.

export type PanelStatus = "ok" | "warn" | "crit" | "unknown";

export interface Stat {
  label: string;
  value: string;
  status: PanelStatus;
}

export interface Row {
  label: string;
  detail: string;
  value: string;
  fraction?: number;
  status: PanelStatus;
  link?: string;
  /** Agent rows only: the tool, the swap pool it runs through (null for a direct login), the real login now and how it was found. */
  tool?: string;
  pool?: string | null;
  identity?: string | null;
  identitySource?: string;
  /** Agent rows only: the session id, the account that served its latest request, and every account it used with turns and tokens by type. */
  sessionId?: string | null;
  activeIdentity?: string | null;
  identities?: AgentIdentityLike[];
  /** Limit rows only: when the window resets, as an ISO 8601 UTC string. Absent when the source gives no reset. */
  meta?: { resetsAt?: string };
}

export interface AgentIdentityLike {
  identity: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  firstSeen: string;
  lastSeen: string;
}

export interface Series {
  label: string;
  points: number[];
}

/** The optional v1 `tables` extension (the Headlamp dashboard parses it): a titled table with its own columns. */
export interface PanelTable {
  title: string;
  columns: Array<{ key: string; label: string; align: "left" | "right" }>;
  rows: Array<Record<string, string | number>>;
}

export interface PanelBody {
  status: PanelStatus;
  summary: string;
  stats: Stat[];
  rows: Row[];
  series?: Series[];
  tables?: PanelTable[];
}

export interface PanelModel extends PanelBody {
  version: 1;
  id: string;
  title: string;
  generatedAt: string;
  link: string;
}

export interface PanelInfo {
  id: string;
  title: string;
  description: string;
  plugin: string;
  link: string;
  refreshSeconds: number;
}

/** A backend failed. The message is short and safe to show. */
export class PanelError extends Error {}

/** How long a panel built from a failed gateway read is kept. */
export const DEGRADED_PANEL_TTL_MS = 30_000;

export const PLUGIN_NAME = "AIS Console";

/** What the panels read. Each source is the same engine call as the matching `/api/*` route. */
export interface WidgetSources {
  /** The `/api/limits` payload (`{ results: ToolLimitResult[] }`). */
  limits(): Promise<unknown>;
  /** True when the last limits read had no gateway part because the gateway failed. The panel is then cached for a short time only. */
  limitsDegraded?(): boolean;
  /** The `/api/auth` payload (`{ entries }`). */
  auth(): Promise<{ entries: AuthEntryLike[] }>;
  /** The `/api/processes` payload. */
  processes(): Promise<{ processes: ProcessLike[] }>;
  /** The `/api/gateway/usage` payload for a window of days. */
  gatewayUsage(days: number): Promise<GatewayUsageLike>;
  /** Claude swap pools with live usage, or undefined when no pool exists. */
  claudeSwap?(): Promise<SwapPoolLike[] | undefined>;
  /** The spend guard status, or undefined when its scheduler is not running. */
  spendGuard?(): SpendGuardLike | undefined;
}

export interface AuthEntryLike {
  toolName: string;
  identity: string;
  state: string;
  expiresAt?: string;
}
export interface ProcessLike {
  tool: string | null;
  /** The wrapper's session marker (the old field). */
  identity: string | null;
  startedAt: string | null;
  /** From the agent scan (`server/agent-identity.ts`). Absent from an older source. */
  pool?: string | null;
  sessionIdentity?: string | null;
  identitySource?: string;
  sessionId?: string | null;
  activeIdentity?: string | null;
  identities?: AgentIdentityLike[];
}
export interface GatewayUsageLike {
  configured: boolean;
  error?: string;
  rows: Array<{ app: string; provider: string; days: number; tokens: number }>;
}
export interface SwapPoolLike {
  pool: string;
  rows: Array<{
    name: string;
    active: boolean;
    allowed: boolean;
    usage?: { status: string; maxUtilization?: number; fiveHour?: { utilization?: number }; sevenDay?: { utilization?: number } };
  }>;
}
export interface SpendGuardLike {
  running: boolean;
  accounts: Array<{
    budgetLimitUsd?: number;
    effectiveUsd: number;
    breached: boolean;
    degraded: boolean;
    identities: string[];
  }>;
}

interface PanelDefinition extends PanelInfo {
  build(sources: WidgetSources, now: Date): Promise<PanelBody>;
}

/* --------------------------------- helpers -------------------------------- */

const RANK: Record<PanelStatus, number> = { crit: 0, warn: 1, unknown: 2, ok: 3 };

function worst(statuses: PanelStatus[]): PanelStatus {
  if (statuses.length === 0) return "unknown";
  return statuses.reduce((a, b) => (RANK[b] < RANK[a] ? b : a));
}

/** Worst first. The sort is stable, so a panel's own order holds inside a group. */
function sortRows(rows: Row[]): Row[] {
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => RANK[a.row.status] - RANK[b.row.status] || a.i - b.i)
    .map((x) => x.row);
}

function stat(label: string, value: string | number, status: PanelStatus = "ok"): Stat {
  return { label: label.slice(0, 12), value: String(value).slice(0, 8), status };
}

const clamp01 = (n: number): number => Math.round(Math.min(1, Math.max(0, n)) * 10000) / 10000;

/** Utilisation as a 0..1 fraction: warn at 0.8 and above, crit at 0.95 and above. */
export function levelOfFraction(fraction: number): PanelStatus {
  return fraction >= 0.95 ? "crit" : fraction >= 0.8 ? "warn" : "ok";
}

const pct = (fraction: number): string => `${Math.round(fraction * 1000) / 10}%`;

export function compactNumber(n: number): string {
  if (n >= 1e9) return `${Math.round(n / 1e8) / 10}B`;
  if (n >= 1e6) return `${Math.round(n / 1e5) / 10}M`;
  if (n >= 1e3) return `${Math.round(n / 1e2) / 10}K`;
  return String(Math.round(n));
}

export function ageText(startedAt: string | null, now: Date): string {
  const started = startedAt ? Date.parse(startedAt) : Number.NaN;
  if (!Number.isFinite(started)) return "-";
  const minutes = Math.max(0, Math.floor((now.getTime() - started) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const LONG_TOKEN = /\b[A-Za-z0-9_-]{32,}\b/g;
const MASK = "[masked]";
/** A session id (a UUID) names a conversation, not a login: it is the one long run that stays readable, so a panel can show which session a row is. */
const UUID_ONLY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Masks email-shaped values and long token-shaped runs in every string of a value. */
export function maskDeep<T>(value: T): T {
  if (typeof value === "string") return value.replace(EMAIL, MASK).replace(LONG_TOKEN, (m) => (UUID_ONLY.test(m) ? m : MASK)) as T;
  if (Array.isArray(value)) return value.map((v) => maskDeep(v)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskDeep(v)])) as T;
  }
  return value;
}

type Obj = Record<string, unknown>;
const asList = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]) : []);
const asNumber = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const asString = (v: unknown): string => (typeof v === "string" ? v : "");

/** The reset time of a limit window in epoch milliseconds, from `resetsAtMs` or an ISO `resetsAt`. */
function resetMs(w: Obj): number | undefined {
  const ms = asNumber(w.resetsAtMs);
  if (ms !== undefined) return Number.isFinite(new Date(ms).getTime()) ? ms : undefined;
  if (typeof w.resetsAt === "string") {
    const parsed = Date.parse(w.resetsAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function countLine(parts: Array<[number, string]>): string {
  return parts.filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`).join(", ");
}

/* --------------------------------- limits --------------------------------- */

async function limitsPanel(sources: WidgetSources): Promise<PanelBody> {
  const payload = (await sources.limits()) as Obj | undefined;
  const rows: Row[] = [];
  for (const result of asList(payload?.results)) {
    // Pools and retired identities hold no limits of their own (same filter as the reset-expiry push).
    const owner = result.identity as Obj | undefined;
    if (owner?.swapPool !== undefined || owner?.retired) continue;
    const provider = usageProviderLabel(asString(result.provider) || asString(result.toolName) || "unknown");
    const identity = asString((result.identity as Obj | undefined)?.name) || "unknown";
    const label = `${provider} / ${identity}`;
    const windows = asList(result.windows);
    const entries: Array<{ name: string; used: number; resetMs?: number }> = [];
    const best = (kind: string, predicate: (w: Obj) => boolean, name: string): void => {
      const matching = windows.filter((w) => w.category === kind && predicate(w));
      const used = matching.map((w) => asNumber(w.usedPercent)).filter((n): n is number => n !== undefined);
      if (used.length === 0) return;
      const max = Math.max(...used);
      // The reset of the fullest window. If it has none, the earliest reset of the matching windows.
      const fullest = matching.find((w) => asNumber(w.usedPercent) === max);
      const resets = matching.map(resetMs).filter((n): n is number => n !== undefined);
      const reset = (fullest ? resetMs(fullest) : undefined) ?? (resets.length > 0 ? Math.min(...resets) : undefined);
      entries.push({ name, used: max, ...(reset !== undefined ? { resetMs: reset } : {}) });
    };
    best("session", () => true, "5-hour");
    best("week", (w) => !w.model, "Weekly");
    best("month", () => true, "Monthly");
    for (const w of windows) {
      const used = asNumber(w.usedPercent);
      if (w.category === "week" && typeof w.model === "string" && w.model !== "" && used !== undefined) {
        entries.push({ name: `Weekly (${w.model})`, used, resetMs: resetMs(w) });
      }
      if (w.category === "other" && used !== undefined) entries.push({ name: `Other (${asString(w.label).slice(0, 40)})`, used, resetMs: resetMs(w) });
    }
    if (result.status === "unavailable" || entries.length === 0) {
      rows.push({ label, detail: "No limit data", value: "-", status: "unknown" });
      continue;
    }
    for (const entry of entries) {
      const fraction = clamp01(entry.used / 100);
      rows.push({
        label,
        detail: entry.name,
        value: pct(fraction),
        fraction,
        status: levelOfFraction(fraction),
        ...(entry.resetMs !== undefined ? { meta: { resetsAt: new Date(entry.resetMs).toISOString() } } : {}),
      });
    }
  }
  const count = (s: PanelStatus) => rows.filter((r) => r.status === s).length;
  const crit = count("crit");
  const warn = count("warn");
  const unknown = count("unknown");
  const withData = rows.length - unknown;
  return {
    status: rows.length === 0 ? "unknown" : worst(rows.map((r) => r.status)),
    summary:
      rows.length === 0
        ? "No limit data"
        : `${withData} windows: ${countLine([[crit, "critical"], [warn, "high"], [count("ok"), "ok"]])}${unknown ? `, ${unknown} without data` : ""}`,
    stats: [stat("Windows", withData), stat("Critical", crit, crit ? "crit" : "ok"), stat("High", warn, warn ? "warn" : "ok"), stat("Unknown", unknown, unknown ? "unknown" : "ok")],
    rows: [...rows].sort((a, b) => RANK[a.status] - RANK[b.status] || (b.fraction ?? -1) - (a.fraction ?? -1)),
  };
}

/* ------------------------------- identities ------------------------------- */

const LOGIN_STATES: Record<string, { text: string; status: PanelStatus }> = {
  ok: { text: "Logged in", status: "ok" },
  expiring: { text: "Expiring", status: "warn" },
  expired: { text: "Expired", status: "crit" },
  missing: { text: "Not logged in", status: "crit" },
  unknown: { text: "Unknown", status: "unknown" },
};

async function identitiesPanel(sources: WidgetSources, now: Date): Promise<PanelBody> {
  const { entries } = await sources.auth();
  // Retired identities and swap pools (state "gateway") hold no login of their own.
  const live = entries.filter((e) => e.state !== "retired" && e.state !== "gateway");
  const rows: Row[] = live.map((e) => {
    const state = LOGIN_STATES[e.state] ?? LOGIN_STATES.unknown!;
    return {
      label: `${e.toolName} / ${e.identity}`,
      // A past expiry on a logged-in identity means a self-refreshing login: show the state without the date.
      detail: e.expiresAt && (e.state === "ok" || e.state === "expiring") && Date.parse(e.expiresAt) > now.getTime() ? `Expires ${e.expiresAt}` : state.text,
      value: state.text,
      status: state.status,
    };
  });
  const count = (state: string) => live.filter((e) => e.state === state).length;
  const [ok, expiring, expired, missing, unknown] = ["ok", "expiring", "expired", "missing", "unknown"].map(count) as [number, number, number, number, number];
  return {
    status: rows.length === 0 ? "unknown" : worst(rows.map((r) => r.status)),
    summary: rows.length === 0 ? "No identities" : `${rows.length} identities: ${countLine([[ok, "logged in"], [expiring, "expiring"], [expired, "expired"], [missing, "not logged in"], [unknown, "unknown"]])}`,
    stats: [stat("Logged in", ok), stat("Expiring", expiring, expiring ? "warn" : "ok"), stat("Expired", expired, expired ? "crit" : "ok"), stat("Logged out", missing, missing ? "crit" : "ok")],
    rows: sortRows(rows),
  };
}

/* --------------------------------- agents --------------------------------- */

/** "alice 12 turns, bob 3 turns": the accounts of one session with their turns, newest first. Empty when the gateway holds none. */
function accountsText(list: AgentIdentityLike[]): string {
  return list.map((i) => `${i.identity} ${i.turns} ${i.turns === 1 ? "turn" : "turns"}`).join(", ");
}

async function agentsPanel(sources: WidgetSources, now: Date): Promise<PanelBody> {
  const { processes } = await sources.processes();
  const byTool = new Map<string, number>();
  for (const p of processes) byTool.set(p.tool ?? "other", (byTool.get(p.tool ?? "other") ?? 0) + 1);
  const ranked = [...byTool.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const stats = ranked.map(([tool, n]) => stat(tool, n));
  // Only the tool, pool, login and age leave this panel: no cwd, no command line, no pid.
  // `identity` of a ProcessLike from the agent scan is the real login now; an older source sends the marker there.
  const rows: Row[] = processes.map((p) => {
    const pool = p.pool ?? null;
    const identity = p.identity;
    return {
      label: p.tool ?? "agent",
      detail: identity === null ? "unknown identity" : pool ? `${pool} / ${identity}` : identity,
      value: ageText(p.startedAt, now),
      status: "ok" as const,
      tool: p.tool ?? "agent",
      pool,
      identity,
      identitySource: p.identitySource ?? (identity === null ? "unresolved" : "session-marker"),
      sessionId: p.sessionId ?? null,
      activeIdentity: p.activeIdentity ?? null,
      identities: p.identities ?? [],
    };
  });
  return {
    status: "ok",
    summary: processes.length === 0 ? "No agents running" : `${processes.length} agents running`,
    stats: stats.length > 0 ? stats : [stat("Running", 0)],
    rows,
    // One table row per agent, so a reader that parses `tables` (the Headlamp dashboard) gets pool, login and tool as columns.
    tables: [{
      title: "Agents",
      columns: [
        { key: "pool", label: "Pool", align: "left" },
        { key: "identity", label: "Identity", align: "left" },
        { key: "tool", label: "Tool", align: "left" },
        { key: "identitySource", label: "Source", align: "left" },
        { key: "accounts", label: "Accounts", align: "left" },
        { key: "age", label: "Age", align: "right" },
      ],
      rows: rows.map((r) => ({ pool: r.pool ?? "", identity: r.identity ?? "", tool: r.tool ?? r.label, identitySource: r.identitySource ?? "", accounts: accountsText(r.identities ?? []), age: r.value })),
    }],
  };
}

/* ----------------------------- gateway usage ------------------------------ */

const GATEWAY_DAYS = 7;

async function gatewayUsagePanel(sources: WidgetSources): Promise<PanelBody> {
  const view = await sources.gatewayUsage(GATEWAY_DAYS);
  if (!view.configured) {
    return { status: "unknown", summary: "Gateway not configured", stats: [], rows: [] };
  }
  if (view.error) throw new PanelError("gateway usage unavailable");
  const total = view.rows.reduce((sum, r) => sum + r.tokens, 0);
  const rows: Row[] = [...view.rows]
    .sort((a, b) => b.tokens - a.tokens)
    .map((r) => ({
      label: r.app,
      detail: `${r.provider ? usageProviderLabel(r.provider) : "unknown"}, ${r.days || GATEWAY_DAYS} days`,
      value: compactNumber(r.tokens),
      ...(total > 0 ? { fraction: clamp01(r.tokens / total) } : {}),
      status: "ok" as const,
    }));
  return {
    status: rows.length === 0 ? "unknown" : "ok",
    summary: rows.length === 0 ? `No gateway usage in ${GATEWAY_DAYS} days` : `${compactNumber(total)} tokens in ${GATEWAY_DAYS} days across ${rows.length} app rows`,
    stats: [stat("Apps", new Set(view.rows.map((r) => r.app)).size), stat("Tokens", compactNumber(total))],
    rows,
  };
}

/* ------------------------------- claude swap ------------------------------ */

/** Highest 5-hour or weekly fraction (0..100) per Claude identity in the limits payload. Per-model windows are left out, as in `maxUtilization`. */
function claudeLimitsByIdentity(payload: unknown): Map<string, { used: number; window: string }> {
  const out = new Map<string, { used: number; window: string }>();
  for (const result of asList((payload as Obj | undefined)?.results)) {
    if (asString(result.toolName) !== "claude") continue;
    const name = asString((result.identity as Obj | undefined)?.name);
    if (name === "" || result.status === "unavailable") continue;
    for (const w of asList(result.windows)) {
      const used = asNumber(w.usedPercent);
      const window = w.category === "session" ? "5-hour" : w.category === "week" && !w.model ? "weekly" : "";
      if (used === undefined || window === "") continue;
      const known = out.get(name);
      if (!known || used > known.used) out.set(name, { used, window });
    }
  }
  return out;
}

async function claudeSwapPanel(sources: WidgetSources): Promise<PanelBody> {
  const pools = await sources.claudeSwap?.();
  if (!pools || pools.length === 0) return { status: "unknown", summary: "No swap pool", stats: [], rows: [] };
  // The console cannot read gateway logins, so members without direct usage use the shared limits data.
  const needsLimits = pools.some((p) => p.rows.some((m) => asNumber(m.usage?.maxUtilization) === undefined));
  const limits = needsLimits ? claudeLimitsByIdentity(await sources.limits().catch(() => undefined)) : new Map<string, { used: number; window: string }>();
  const rows: Row[] = [];
  for (const pool of pools) {
    for (const member of pool.rows) {
      const label = `${pool.pool} / ${member.name}`;
      const role = member.active ? "Active" : member.allowed ? "Standby" : "Not allowed";
      const direct = asNumber(member.usage?.maxUtilization);
      const fromLimits = direct === undefined ? limits.get(member.name) : undefined;
      const max = direct ?? fromLimits?.used;
      if (max === undefined) {
        const word = member.usage?.status && /^[a-z-]{1,24}$/.test(member.usage.status) ? member.usage.status : "unavailable";
        rows.push({ label, detail: `${role}, usage ${word}`, value: "-", status: "unknown" });
        continue;
      }
      const fraction = clamp01(max / 100);
      rows.push({ label, detail: fromLimits ? `${role}, ${fromLimits.window}` : role, value: pct(fraction), fraction, status: levelOfFraction(fraction) });
    }
  }
  const active = pools.flatMap((p) => p.rows).filter((m) => m.active).length;
  return {
    status: rows.length === 0 ? "unknown" : worst(rows.map((r) => r.status)),
    summary: `${pools.length} pools, ${rows.length} members, ${active} active`,
    stats: [stat("Pools", pools.length), stat("Members", rows.length), stat("Active", active)],
    rows: sortRows(rows),
  };
}

/* ------------------------------- spend guard ------------------------------ */

async function spendGuardPanel(sources: WidgetSources): Promise<PanelBody> {
  const guard = sources.spendGuard?.();
  if (!guard || !guard.running) return { status: "unknown", summary: "Spend guard not running", stats: [], rows: [] };
  // Account ids, profile names and budget names stay out: rows are named by identity.
  const rows: Row[] = guard.accounts.map((a, i) => {
    const label = a.identities.length > 0 ? a.identities.join(", ") : `Account ${i + 1}`;
    const limit = a.budgetLimitUsd;
    if (a.degraded || limit === undefined || limit <= 0) {
      return { label, detail: "No budget cap", value: "-", status: "unknown" as const };
    }
    const fraction = clamp01(a.effectiveUsd / limit);
    return {
      label,
      detail: a.breached ? "Over budget" : "Budget",
      value: pct(a.effectiveUsd / limit),
      fraction,
      status: a.breached ? ("crit" as const) : levelOfFraction(fraction),
    };
  });
  const breached = guard.accounts.filter((a) => a.breached).length;
  return {
    status: rows.length === 0 ? "unknown" : worst(rows.map((r) => r.status)),
    summary: rows.length === 0 ? "No budget accounts" : `${rows.length} budget accounts, ${breached} over budget`,
    stats: [stat("Accounts", rows.length), stat("Over budget", breached, breached ? "crit" : "ok")],
    rows: sortRows(rows),
  };
}

/* ---------------------------------- panels -------------------------------- */

const panel = (id: string, title: string, description: string, link: string, refreshSeconds: number, build: PanelDefinition["build"]): PanelDefinition => ({
  id, title, description, plugin: PLUGIN_NAME, link, refreshSeconds, build,
});

export const PANELS: readonly PanelDefinition[] = [
  panel("limits", "Limits", "5-hour and weekly usage windows per provider and identity", "/limits", 300, (s) => limitsPanel(s)),
  panel("identities", "Identities", "Login state of each identity", "/auth", 300, (s, now) => identitiesPanel(s, now)),
  panel("agents", "Agents", "Agent sessions running now", "/dashboard", 60, (s, now) => agentsPanel(s, now)),
  panel("gateway-usage", "Gateway usage", "Gateway tokens per app and provider over 7 days", "/gateway", 300, (s) => gatewayUsagePanel(s)),
  panel("claude-swap", "Claude swap", "Claude swap pool members and their usage", "/limits", 300, (s) => claudeSwapPanel(s)),
  panel("spend-guard", "Spend guard", "Cloud budget use per account", "", 300, (s) => spendGuardPanel(s)),
];

export type WidgetResult = { status: 200; body: unknown } | { status: 404 | 502; body: { error: string } };

/** Builds, caches and serves the panels. One instance serves every listener. */
export class WidgetService {
  private readonly cache = new PollCache(60_000);
  private readonly lastGood = new Map<string, PanelModel>();
  private readonly failures = new Map<string, { at: number; message: string }>();

  /** `linkBase`: absolute http(s) URL without a trailing slash. Without it every `link` is an empty string. */
  constructor(
    private readonly sources: WidgetSources,
    private readonly now: () => Date = () => new Date(),
    private readonly linkBase?: string,
  ) {}

  private linkFor(path: string): string {
    return this.linkBase && path ? `${this.linkBase}${path}` : "";
  }

  /** The panel list, in the same wrapper the agent API uses. */
  list(): { version: 1; panels: PanelInfo[] } {
    return { version: 1, panels: PANELS.map(({ build: _build, ...info }) => ({ ...info, link: this.linkFor(info.link) })) };
  }

  /** One panel model. Cached for the panel's refreshSeconds. Concurrent calls share one build.
   * A failed build is remembered for min(refreshSeconds, 60) seconds. While it is, the last good model
   * is served (stale). Without a good model the answer is 502. */
  async get(id: string): Promise<WidgetResult> {
    const def = PANELS.find((p) => p.id === id);
    if (!def) return { status: 404, body: { error: "unknown panel" } };
    const failure = this.failures.get(def.id);
    if (failure && Date.now() - failure.at < Math.min(def.refreshSeconds, 60) * 1000) return this.fallback(def.id, failure.message);
    try {
      // A limits panel built without the gateway part must not stay for the whole refresh period.
      const degraded = def.id === "limits" && this.sources.limitsDegraded?.() === true;
      const { value } = await this.cache.get(def.id, () => this.build(def), degraded ? DEGRADED_PANEL_TTL_MS : def.refreshSeconds * 1000);
      this.lastGood.set(def.id, value);
      this.failures.delete(def.id);
      return { status: 200, body: value };
    } catch (error) {
      // Only the texts this module writes (PanelError) leave the server. Other messages stay in the log.
      const message = error instanceof PanelError ? maskDeep(error.message).slice(0, 200) : `${def.id} backend unavailable`;
      if (!(error instanceof PanelError)) console.error(`[ais] widget panel ${def.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      this.failures.set(def.id, { at: Date.now(), message });
      return this.fallback(def.id, message);
    }
  }

  /** Fills the cache entry a later `get(id)` reads. A failed build counts as warmed: it is remembered like any failure. */
  async warm(id: string): Promise<void> {
    await this.get(id);
  }

  private fallback(id: string, message: string): WidgetResult {
    const good = this.lastGood.get(id);
    return good ? { status: 200, body: good } : { status: 502, body: { error: message } };
  }

  private async build(def: PanelDefinition): Promise<PanelModel> {
    const now = this.now();
    const body = await def.build(this.sources, now);
    const link = this.linkFor(def.link);
    return maskDeep({
      version: 1,
      id: def.id,
      title: def.title,
      generatedAt: now.toISOString(),
      link,
      status: body.status,
      summary: body.summary,
      stats: body.stats,
      rows: body.rows.map((r) => ({ ...r, link })),
      ...(body.tables?.length ? { tables: body.tables } : {}),
      ...(body.series?.length ? { series: body.series.slice(0, 2).map((s) => ({ label: s.label, points: s.points.slice(-48) })) } : {}),
    } satisfies PanelModel);
  }
}

/** True when the Host header is an IP literal (v4, or bracketed v6) with an optional port, a loopback name or an allowed vhost.
 * This stops DNS rebinding: a rebound hostname is none of these. */
export function widgetsHostAllowed(hostHeader: string | null, extraHosts: ReadonlySet<string> = new Set()): boolean {
  if (!hostHeader) return false;
  const m = /^(?:\[([^\]]+)\]|([^:[\]]+))(?::(\d{1,5}))?$/.exec(hostHeader.trim().toLowerCase());
  if (!m) return false;
  if (m[1] !== undefined) return isIP(m[1]) === 6;
  const bare = m[2]!;
  return isIP(bare) === 4 || bare === "localhost" || extraHosts.has(bare);
}

/** Validates AIS_WIDGETS_LINK_BASE: an absolute http(s) URL. Returns it without a trailing slash, or an error text. */
export function parseWidgetsLinkBase(raw: string | undefined): { base?: string; error?: string } {
  if (raw === undefined || raw.trim() === "") return {};
  try {
    const url = new URL(raw.trim());
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) throw new Error("bad");
    return { base: url.href.replace(/\/+$/, "") };
  } catch {
    return { error: "AIS_WIDGETS_LINK_BASE must be an absolute http or https URL without credentials, query or fragment" };
  }
}

/** Request handler of the separate read-only widgets listener. It serves
 * `GET`/`HEAD` on the widget routes and the health route only. No auth and no
 * CORS headers: see docs/agents/console-web.md. */
export async function widgetsListenerFetch(service: WidgetService, req: Request, allowedHosts: ReadonlySet<string> = new Set()): Promise<Response> {
  if (!widgetsHostAllowed(req.headers.get("host"), allowedHosts)) return Response.json({ error: "host not allowed" }, { status: 403 });
  const pathname = new URL(req.url).pathname;
  const isWidgetRoute = pathname === "/api/widgets" || pathname === "/api/widgets-health" || /^\/api\/widgets\/[^/]+$/.test(pathname);
  if (!isWidgetRoute) return Response.json({ error: "not found" }, { status: 404 });
  if (req.method !== "GET" && req.method !== "HEAD") {
    return Response.json({ error: "method not allowed" }, { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  let response: Response;
  if (pathname === "/api/widgets-health") response = Response.json({ ok: true });
  else if (pathname === "/api/widgets") response = Response.json(service.list());
  else {
    let id = pathname.slice("/api/widgets/".length);
    try {
      id = decodeURIComponent(id);
    } catch {
      // keep the raw id: it matches no panel and answers 404
    }
    const result = await service.get(id);
    response = Response.json(result.body, { status: result.status });
  }
  return req.method === "HEAD" ? new Response(null, { status: response.status, headers: response.headers }) : response;
}

/** Strict parse of AIS_WIDGETS_PORT. Returns a port, `undefined` when unset or blank, or an error text. */
export function parseWidgetsPort(raw: string | undefined, mainPort: number): { port?: number; error?: string } {
  if (raw === undefined || raw.trim() === "") return {};
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return { error: `AIS_WIDGETS_PORT must be a whole number from 1 to 65535` };
  const port = Number(text);
  if (port < 1 || port > 65535) return { error: `AIS_WIDGETS_PORT must be a whole number from 1 to 65535` };
  if (port === mainPort) return { error: `AIS_WIDGETS_PORT must differ from the console port ${mainPort}` };
  return { port };
}
