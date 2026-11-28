import type { SessionUsage } from "../../gateway/types.ts";
import { table } from "./apps.ts";

/**
 * Cost per session from the gateway ledger, for `ais gateway usage sessions`.
 *
 * The ledger keeps the client's own session id as `sessionKey` (Claude Code `x-claude-code-session-id`, Codex `session-id`).
 * It is a plain id, not a task or T3 thread id. A "task" is therefore a set of sessions: pick it with `--session=<id,id>` or
 * with `--prefix=<text>` (the sessions whose key starts with that text), and the output ends with one task total. The
 * ledger holds no prompt, answer, tool input or tool result: only counts, model names and ids.
 *
 * Cost is an ESTIMATE from tokens and the price table, never a bill, and never added to real spend figures.
 * A request with tokens but no price makes the figure a floor (marked `+`). Failed requests are counted, not priced.
 */

export interface SessionCostRow {
  provider: string;
  identity: string;
  sessionKey: string;
  models: string[];
  requests: number;
  failedRequests: number;
  tokens: number;
  estCostUsd: number;
  unpricedRequests: number;
  toolCalls: number;
  toolErrors: number;
  firstTs: string;
  lastTs: string;
}

export interface CostTotal {
  sessions: number;
  requests: number;
  failedRequests: number;
  tokens: number;
  estCostUsd: number;
  unpricedRequests: number;
  toolCalls: number;
  toolErrors: number;
}

export interface SessionCostReport {
  rows: SessionCostRow[];
  /** One total for each provider, in provider order. Providers are never merged into one figure unless `all` is asked for. */
  byProvider: Array<{ provider: string } & CostTotal>;
  all: CostTotal;
}

const emptyTotal = (): CostTotal => ({ sessions: 0, requests: 0, failedRequests: 0, tokens: 0, estCostUsd: 0, unpricedRequests: 0, toolCalls: 0, toolErrors: 0 });

/** One row for each session, provider and account, newest session first inside a provider. A session on two accounts gives two rows. */
export function buildSessionCost(sessions: SessionUsage[]): SessionCostReport {
  const rows: SessionCostRow[] = [];
  for (const s of sessions) {
    for (const i of s.identities) {
      rows.push({
        provider: s.provider,
        identity: i.identity,
        sessionKey: s.sessionKey,
        models: i.models,
        requests: i.turns,
        failedRequests: i.failedRequests,
        tokens: i.inputTokens + i.outputTokens + i.cacheReadTokens + i.cacheWriteTokens,
        estCostUsd: i.estCostUsd,
        unpricedRequests: i.unpricedRequests,
        toolCalls: i.toolCalls,
        toolErrors: i.toolErrors,
        firstTs: i.firstTs,
        lastTs: i.lastTs,
      });
    }
  }
  rows.sort((a, b) => a.provider.localeCompare(b.provider) || Date.parse(b.lastTs) - Date.parse(a.lastTs) || a.sessionKey.localeCompare(b.sessionKey) || a.identity.localeCompare(b.identity));
  const add = (t: CostTotal, r: SessionCostRow): void => {
    t.requests += r.requests;
    t.failedRequests += r.failedRequests;
    t.tokens += r.tokens;
    t.estCostUsd += r.estCostUsd;
    t.unpricedRequests += r.unpricedRequests;
    t.toolCalls += r.toolCalls;
    t.toolErrors += r.toolErrors;
  };
  const by = new Map<string, CostTotal>();
  const all = emptyTotal();
  all.sessions = new Set(rows.map((r) => `${r.provider}\u0000${r.sessionKey}`)).size;
  for (const r of rows) {
    let t = by.get(r.provider);
    if (!t) {
      t = emptyTotal();
      by.set(r.provider, t);
    }
    add(t, r);
    add(all, r);
  }
  for (const [provider, t] of by) t.sessions = new Set(rows.filter((r) => r.provider === provider).map((r) => r.sessionKey)).size;
  return { rows, byProvider: [...by].map(([provider, t]) => ({ provider, ...t })), all };
}

const num = (n: number): string => n.toLocaleString("en-GB");
/** Cost with four decimals; `+` marks a floor (some request had no price). */
export const cost = (usd: number, unpriced: number): string => `${usd.toFixed(4)}${unpriced > 0 ? "+" : ""}`;
const minute = (iso: string): string => iso.slice(0, 16).replace("T", " ");

/** The text report: one table, then a total for each provider, a task total when `task` is set, and the notes that keep it honest. */
export function formatSessionCost(report: SessionCostReport, opts: { limit: number; task: boolean }): string {
  if (report.rows.length === 0) return "no sessions with a session id in this window";
  const shown = report.rows.slice(0, opts.limit);
  const lines = [
    table(
      ["PROVIDER", "IDENTITY", "SESSION", "MODELS", "REQ", "FAILED", "TOKENS", "EST COST USD", "TOOLS", "TOOL ERR", "FIRST (UTC)", "LAST (UTC)"],
      shown.map((r) => [r.provider, r.identity, r.sessionKey, r.models.join(",") || "-", num(r.requests), num(r.failedRequests), num(r.tokens), cost(r.estCostUsd, r.unpricedRequests), num(r.toolCalls), num(r.toolErrors), minute(r.firstTs), minute(r.lastTs)]),
    ),
  ];
  if (shown.length < report.rows.length) lines.push(`showing ${shown.length} of ${report.rows.length} rows (--limit=N); totals cover every row`);
  const totalLine = (label: string, t: CostTotal): string => `${label}: ${t.sessions} session(s), ${num(t.requests)} request(s), ${num(t.failedRequests)} failed, ${num(t.tokens)} tokens, est. cost USD ${cost(t.estCostUsd, t.unpricedRequests)}, ${num(t.toolCalls)} tool call(s), ${num(t.toolErrors)} tool error(s)`;
  lines.push("");
  for (const p of report.byProvider) lines.push(totalLine(`total ${p.provider}`, p));
  if (report.byProvider.length > 1 || opts.task) lines.push(totalLine(opts.task ? "task total" : "total all providers", report.all));
  lines.push("", "Cost is an ESTIMATE from tokens and the price table, not a bill. `+` marks a floor: a request with tokens had no price.", "Failed requests count in FAILED only: their tokens and cost are not in the figures.");
  return lines.join("\n");
}
