import { PollCache } from "./expensive.ts";

/** Widget panels: small, read-only summaries of console data for dashboards
 * (the Headlamp widget panel API). Each panel maps the output of an existing
 * engine to one model. No data is collected here and no panel cache is kept
 * outside `WidgetService`. */

// The types below copy the widget panel contract. Do not add fields.

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
}

export interface Series {
  label: string;
  points: number[];
}

export interface PanelBody {
  status: PanelStatus;
  summary: string;
  stats: Stat[];
  rows: Row[];
  series?: Series[];
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

export const PLUGIN_NAME = "AIS Console";
export const MAX_ROWS = 50;

/** What the panels read. Each source is the same engine call as the matching `/api/*` route. */
export interface WidgetSources {
  /** The `/api/limits` payload (`{ results: ToolLimitResult[] }`). */
  limits(): Promise<unknown>;
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
  identity: string | null;
  startedAt: string | null;
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

/** Masks email-shaped values and long token-shaped runs in every string of a value. */
export function maskDeep<T>(value: T): T {
  if (typeof value === "string") return value.replace(EMAIL, MASK).replace(LONG_TOKEN, MASK) as T;
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

function countLine(parts: Array<[number, string]>): string {
  return parts.filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`).join(", ");
}

/* --------------------------------- limits --------------------------------- */

async function limitsPanel(sources: WidgetSources): Promise<PanelBody> {
  const payload = (await sources.limits()) as Obj | undefined;
  const rows: Row[] = [];
  for (const result of asList(payload?.results)) {
    const provider = asString(result.provider) || asString(result.toolName) || "unknown";
    const identity = asString((result.identity as Obj | undefined)?.name) || "unknown";
    const label = `${provider} / ${identity}`;
    const windows = asList(result.windows);
    const entries: Array<{ name: string; used: number }> = [];
    const best = (kind: string, predicate: (w: Obj) => boolean, name: string): void => {
      const used = windows
        .filter((w) => w.category === kind && predicate(w))
        .map((w) => asNumber(w.usedPercent))
        .filter((n): n is number => n !== undefined);
      if (used.length > 0) entries.push({ name, used: Math.max(...used) });
    };
    best("session", () => true, "5-hour");
    best("week", (w) => !w.model, "Weekly");
    for (const w of windows) {
      const used = asNumber(w.usedPercent);
      if (w.category === "week" && typeof w.model === "string" && w.model !== "" && used !== undefined) {
        entries.push({ name: `Weekly (${w.model})`, used });
      }
    }
    if (result.status === "unavailable" || entries.length === 0) {
      rows.push({ label, detail: "No limit data", value: "-", status: "unknown" });
      continue;
    }
    for (const entry of entries) {
      const fraction = clamp01(entry.used / 100);
      rows.push({ label, detail: entry.name, value: pct(fraction), fraction, status: levelOfFraction(fraction) });
    }
  }
  const count = (s: PanelStatus) => rows.filter((r) => r.status === s).length;
  const crit = count("crit");
  const warn = count("warn");
  const unknown = count("unknown");
  return {
    status: rows.length === 0 ? "unknown" : worst(rows.map((r) => r.status)),
    summary:
      rows.length === 0
        ? "No limit data"
        : `${rows.length} windows: ${countLine([[crit, "critical"], [warn, "high"], [unknown, "unknown"], [count("ok"), "ok"]])}`,
    stats: [stat("Windows", rows.length), stat("Critical", crit, crit ? "crit" : "ok"), stat("High", warn, warn ? "warn" : "ok"), stat("Unknown", unknown, unknown ? "unknown" : "ok")],
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

async function identitiesPanel(sources: WidgetSources): Promise<PanelBody> {
  const { entries } = await sources.auth();
  // Retired identities and swap pools (state "gateway") hold no login of their own.
  const live = entries.filter((e) => e.state !== "retired" && e.state !== "gateway");
  const rows: Row[] = live.map((e) => {
    const state = LOGIN_STATES[e.state] ?? LOGIN_STATES.unknown!;
    return {
      label: `${e.toolName} / ${e.identity}`,
      detail: e.expiresAt && (e.state === "ok" || e.state === "expiring") ? `Expires ${e.expiresAt}` : state.text,
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

async function agentsPanel(sources: WidgetSources, now: Date): Promise<PanelBody> {
  const { processes } = await sources.processes();
  const byTool = new Map<string, number>();
  for (const p of processes) byTool.set(p.tool ?? "other", (byTool.get(p.tool ?? "other") ?? 0) + 1);
  const ranked = [...byTool.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shown = ranked.length > 4 ? ranked.slice(0, 3) : ranked;
  const stats = shown.map(([tool, n]) => stat(tool, n));
  if (ranked.length > 4) stats.push(stat("Other", ranked.slice(3).reduce((sum, [, n]) => sum + n, 0)));
  // Only the tool, identity name and age leave this panel: no cwd, no command line, no pid.
  const rows: Row[] = processes.map((p) => ({
    label: p.tool ?? "agent",
    detail: p.identity ?? "unknown identity",
    value: ageText(p.startedAt, now),
    status: "ok" as const,
  }));
  return {
    status: "ok",
    summary: processes.length === 0 ? "No agents running" : `${processes.length} agents running`,
    stats: stats.length > 0 ? stats : [stat("Running", 0)],
    rows,
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
      detail: `${r.provider || "unknown"}, ${r.days || GATEWAY_DAYS} days`,
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

async function claudeSwapPanel(sources: WidgetSources): Promise<PanelBody> {
  const pools = await sources.claudeSwap?.();
  if (!pools || pools.length === 0) return { status: "unknown", summary: "No swap pool", stats: [], rows: [] };
  const rows: Row[] = [];
  for (const pool of pools) {
    for (const member of pool.rows) {
      const label = `${pool.pool} / ${member.name}`;
      const role = member.active ? "Active" : member.allowed ? "Standby" : "Not allowed";
      const max = asNumber(member.usage?.maxUtilization);
      if (member.usage?.status !== "live" || max === undefined) {
        rows.push({ label, detail: `${role}, no usage data`, value: "-", status: "unknown" });
        continue;
      }
      const fraction = clamp01(max / 100);
      rows.push({ label, detail: role, value: pct(fraction), fraction, status: levelOfFraction(fraction) });
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
    const label = a.identities.length > 0 ? a.identities.slice(0, 2).join(", ") : `Account ${i + 1}`;
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
  panel("identities", "Identities", "Login state of each identity", "/auth", 300, (s) => identitiesPanel(s)),
  panel("agents", "Agents", "Agent sessions running now", "/sessions", 60, (s, now) => agentsPanel(s, now)),
  panel("gateway-usage", "Gateway usage", "Gateway tokens per app and provider over 7 days", "/gateway", 300, (s) => gatewayUsagePanel(s)),
  panel("claude-swap", "Claude swap", "Claude swap pool members and their usage", "/limits", 300, (s) => claudeSwapPanel(s)),
  panel("spend-guard", "Spend guard", "Cloud budget use per account", "", 300, (s) => spendGuardPanel(s)),
];

export type WidgetResult = { status: 200; body: unknown } | { status: 404 | 502; body: { error: string } };

/** Builds, caches and serves the panels. One instance serves every listener. */
export class WidgetService {
  private readonly cache = new PollCache(60_000);

  constructor(
    private readonly sources: WidgetSources,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** The panel list, in the same wrapper the agent API uses. */
  list(): { version: 1; panels: PanelInfo[] } {
    return { version: 1, panels: PANELS.map(({ build: _build, ...info }) => info) };
  }

  /** One panel model. Cached for the panel's refreshSeconds. Concurrent calls share one build. */
  async get(id: string): Promise<WidgetResult> {
    const def = PANELS.find((p) => p.id === id);
    if (!def) return { status: 404, body: { error: "unknown panel" } };
    try {
      const { value } = await this.cache.get(def.id, () => this.build(def), def.refreshSeconds * 1000);
      return { status: 200, body: value };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { status: 502, body: { error: maskDeep(message).slice(0, 200) } };
    }
  }

  private async build(def: PanelDefinition): Promise<PanelModel> {
    const now = this.now();
    const body = await def.build(this.sources, now);
    return maskDeep({
      version: 1,
      id: def.id,
      title: def.title,
      generatedAt: now.toISOString(),
      link: def.link,
      status: body.status,
      summary: body.summary,
      stats: body.stats.slice(0, 4),
      rows: body.rows.slice(0, MAX_ROWS).map((r) => ({ ...r, link: r.link ?? def.link })),
      ...(body.series?.length ? { series: body.series.slice(0, 2).map((s) => ({ label: s.label, points: s.points.slice(-48) })) } : {}),
    } satisfies PanelModel);
  }
}

/** Request handler of the separate read-only widgets listener. It serves
 * `GET`/`HEAD` on the widget routes and the health route only. No auth and no
 * CORS headers: see docs/agents/console-web.md. */
export async function widgetsListenerFetch(service: WidgetService, req: Request): Promise<Response> {
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
