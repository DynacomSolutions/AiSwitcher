import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { boolFlag, stringFlag, type ParsedArgs } from "../args.ts";
import { CliUsageError } from "../errors.ts";
import { canonicalUsageProvider } from "../usage/providers.ts";
import { usageBucketZone } from "../../server/gateway-usage.ts";
import { aisCacheDir } from "../../shared/ais-home.ts";
import type { UsageHistoryRow } from "../../gateway/types.ts";
import { connect, table, type GatewayCliDeps } from "./apps.ts";

type Flags = ParsedArgs["flags"];

/** Source of the per-model, all-time figures (one row per identity and model, no day). They cover every host provider. */
export const SOURCE_MODELS = "host-snapshot-models";
/** Source of the per-day figures (one row per identity and day, no model). The host snapshot keeps them for some providers only. */
export const SOURCE_DAILY = "host-snapshot-daily";
/** Source of the per-day token counts for results the host has no per-day cost for. Tokens only: the cost is 0 and means "unknown". */
export const SOURCE_DAILY_TOKENS = "host-snapshot-daily-tokens";
/** A host and gateway total that differ by more than this many dollars fail the import. */
export const MISMATCH_USD = 1;
const DEFAULT_BATCH = 500;

/** The console's canonical usage provider to the gateway provider (the tool name), the reverse of PROVIDER_BY_TOOL in server/gateway-usage.ts. */
const GATEWAY_PROVIDER_BY_USAGE: Record<string, string> = {
  anthropic: "claude",
  openai: "codex",
  xai: "grok",
  kimi: "kimi",
  zai: "zai",
  alibaba: "ali",
  "opencode-go": "opencode",
};

/** Maps a host provider to the gateway provider. A provider the gateway has no tool for (AWS Bedrock, mixed labels) keeps its canonical host name, so nothing is dropped or merged. */
export function gatewayProviderForHost(hostProvider: string): string {
  const canonical = canonicalUsageProvider(hostProvider);
  return GATEWAY_PROVIDER_BY_USAGE[canonical] ?? canonical;
}

/** What the host snapshot says one source holds for one provider and identity: the figure the gateway copy must match. It is the sum of the rows this import sends. */
export interface HostTotal {
  source: string;
  provider: string;
  identity: string;
  costUsd: number;
  messages: number;
  /** Input, output and cache tokens added together (the daily-tokens source holds only this). */
  tokens: number;
}

export interface HostHistory {
  rows: UsageHistoryRow[];
  totals: HostTotal[];
  /** Things worth a look that do not fail the import, for example a host report total that differs from the sum of its entries. */
  warnings: string[];
  /** Host results left out because their traffic already went through the gateway ledger. */
  skipped: { provider: string; identity: string }[];
}

export interface HistoryOptions {
  /** The snapshot's generation time, an ISO instant. */
  generation: string;
  /** The IANA zone the host buckets its days in. */
  zone: string;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
const whole = (v: unknown): number => Math.round(num(v));
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A host difference below this many dollars is rounding noise, not a warning. */
const REPORT_NOISE_USD = 0.01;
/** The host label for traffic that went through the gateway: the gateway ledger already holds it. */
const GATEWAY_LABEL = "ais-gateway";

const dayIn = (ms: unknown, zone: string): string | null => {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
};

const tokensOf = (r: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }): number => r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens;

/**
 * Maps the snapshot's merged `aggregateResults` to history rows and host totals.
 * - Models source: per provider, identity and model, all time (every provider has it).
 * - Daily source: per provider, identity and day, from `dailyTotals` ([input, output, cacheRead, cacheWrite, messages, cost]).
 * - Daily-tokens source: per day, tokens only (`dailyUsage`), for results that have no `dailyTotals`. Its cost is 0, not a real cost.
 * Host results labelled "ais-gateway" are skipped: that traffic is in the gateway ledger already.
 * Each row carries the result's own date span and the zone, so a reader can trim the overlap with the ledger.
 * Rows that share a key (two host results that map to one gateway provider and identity) are summed. Errored or empty results add nothing.
 */
export function historyFromSnapshot(aggregateResults: unknown, opts: HistoryOptions): HostHistory {
  const rows = new Map<string, UsageHistoryRow>();
  const reported = new Map<string, { provider: string; identity: string; reportedUsd: number }>();
  const skipped: { provider: string; identity: string }[] = [];
  const addRow = (row: UsageHistoryRow) => {
    const key = [row.source, row.provider, row.identity, row.day ?? "", row.model ?? ""].join("\u0000");
    const old = rows.get(key);
    if (!old) return void rows.set(key, row);
    old.inputTokens += row.inputTokens;
    old.outputTokens += row.outputTokens;
    old.cacheReadTokens += row.cacheReadTokens;
    old.cacheWriteTokens += row.cacheWriteTokens;
    old.messages += row.messages;
    old.estCostUsd += row.estCostUsd;
    if (row.firstDay !== null && (old.firstDay === null || row.firstDay < old.firstDay)) old.firstDay = row.firstDay;
    if (row.lastDay !== null && (old.lastDay === null || row.lastDay > old.lastDay)) old.lastDay = row.lastDay;
  };
  for (const result of Array.isArray(aggregateResults) ? aggregateResults : []) {
    if (!isObj(result) || typeof result.provider !== "string" || !isObj(result.identity) || typeof result.identity.name !== "string") continue;
    const identity = result.identity.name;
    if (result.provider.includes(GATEWAY_LABEL)) {
      skipped.push({ provider: result.provider, identity });
      continue;
    }
    const provider = gatewayProviderForHost(result.provider);
    const span = isObj(result.dateSpan) ? result.dateSpan : {};
    const common = { generation: opts.generation, provider, identity, model: null, firstDay: dayIn(span.firstMs, opts.zone), lastDay: dayIn(span.lastMs, opts.zone), zone: opts.zone };
    const report = isObj(result.report) ? result.report : undefined;
    const entries = Array.isArray(report?.entries) ? (report.entries as unknown[]) : [];
    let entriesCost = 0;
    for (const e of entries) {
      if (!isObj(e)) continue;
      const row: UsageHistoryRow = {
        ...common,
        source: SOURCE_MODELS,
        day: null,
        model: typeof e.model === "string" && e.model !== "" ? e.model : null,
        inputTokens: whole(e.input),
        outputTokens: whole(e.output),
        cacheReadTokens: whole(e.cacheRead),
        cacheWriteTokens: whole(e.cacheWrite),
        messages: whole(e.messageCount),
        estCostUsd: num(e.cost),
      };
      addRow(row);
      entriesCost += row.estCostUsd;
    }
    if (entries.length > 0 && report && typeof report.totalCost === "number") {
      const key = `${provider}\u0000${identity}`;
      const r = reported.get(key) ?? { provider, identity, reportedUsd: 0 };
      r.reportedUsd += num(report.totalCost) - entriesCost;
      reported.set(key, r);
    }
    const daily = isObj(result.dailyTotals) ? Object.entries(result.dailyTotals).filter(([day, v]) => /^\d{4}-\d{2}-\d{2}$/.test(day) && Array.isArray(v)) : [];
    for (const [day, v] of daily) {
      const t = v as unknown[];
      addRow({ ...common, source: SOURCE_DAILY, day, inputTokens: whole(t[0]), outputTokens: whole(t[1]), cacheReadTokens: whole(t[2]), cacheWriteTokens: whole(t[3]), messages: whole(t[4]), estCostUsd: num(t[5]) });
    }
    if (daily.length === 0 && isObj(result.dailyUsage)) {
      for (const [day, tokens] of Object.entries(result.dailyUsage)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || whole(tokens) === 0) continue;
        addRow({ ...common, source: SOURCE_DAILY_TOKENS, day, inputTokens: whole(tokens), outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, messages: 0, estCostUsd: 0 });
      }
    }
  }
  const order = (a: { provider: string; identity: string }, b: { provider: string; identity: string }) => a.provider.localeCompare(b.provider) || a.identity.localeCompare(b.identity);
  const sorted = [...rows.values()].sort((a, b) => a.source.localeCompare(b.source) || order(a, b) || (a.day ?? "").localeCompare(b.day ?? "") || (a.model ?? "").localeCompare(b.model ?? ""));
  const totals = new Map<string, HostTotal>();
  for (const r of sorted) {
    const key = `${r.source}\u0000${r.provider}\u0000${r.identity}`;
    const t = totals.get(key) ?? { source: r.source, provider: r.provider, identity: r.identity, costUsd: 0, messages: 0, tokens: 0 };
    t.costUsd += r.estCostUsd;
    t.messages += r.messages;
    t.tokens += tokensOf(r);
    totals.set(key, t);
  }
  const warnings: string[] = [];
  for (const r of [...reported.values()].sort(order)) {
    if (Math.abs(r.reportedUsd) > REPORT_NOISE_USD) warnings.push(`host report total differs from the sum of its entries by ${usd(r.reportedUsd)} for ${r.provider}/${r.identity}; the entries were imported`);
  }
  const net = [...reported.values()].reduce((n, r) => n + r.reportedUsd, 0);
  if (Math.abs(net) > REPORT_NOISE_USD) warnings.push(`host report totals differ from the sum of the entries by ${usd(net)} in all; the entries were imported`);
  return { rows: sorted, totals: [...totals.values()].sort((a, b) => a.source.localeCompare(b.source) || order(a, b)), warnings, skipped };
}

/** What the gateway holds for one history row, as read back from GET /usage/history. */
export interface HeldRow {
  source: string;
  provider: string;
  identity: string;
  estCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** One line of the verification: the host figure, the gateway figure and whether they agree. */
export interface VerifyLine {
  source: string;
  provider: string;
  identity: string;
  hostUsd: number;
  gatewayUsd: number;
  diffUsd: number;
  hostTokens: number;
  gatewayTokens: number;
  /** Cost agrees within the limit and tokens agree exactly. */
  ok: boolean;
}

export interface Verification {
  lines: VerifyLine[];
  /** Per source: the host and gateway grand totals. */
  grand: VerifyLine[];
  ok: boolean;
}

/** Compares the host totals (the sum of the rows sent) with what the gateway holds now. Tokens must match exactly, cost within the limit. */
export function verifyHistory(totals: HostTotal[], gateway: HeldRow[], limitUsd = MISMATCH_USD): Verification {
  const held = new Map<string, { usd: number; tokens: number }>();
  for (const r of gateway) {
    const key = `${r.source}\u0000${r.provider}\u0000${r.identity}`;
    const h = held.get(key) ?? { usd: 0, tokens: 0 };
    h.usd += r.estCostUsd;
    h.tokens += tokensOf(r);
    held.set(key, h);
  }
  const line = (source: string, provider: string, identity: string, hostUsd: number, hostTokens: number, gatewayUsd: number, gatewayTokens: number): VerifyLine => {
    const diffUsd = gatewayUsd - hostUsd;
    return { source, provider, identity, hostUsd, gatewayUsd, diffUsd, hostTokens, gatewayTokens, ok: Math.abs(diffUsd) <= limitUsd && hostTokens === gatewayTokens };
  };
  const lines = totals.map((t) => {
    const h = held.get(`${t.source}\u0000${t.provider}\u0000${t.identity}`);
    return line(t.source, t.provider, t.identity, t.costUsd, t.tokens, h?.usd ?? 0, h?.tokens ?? 0);
  });
  // A gateway row the host does not list also shows up, against a host figure of zero.
  const known = new Set(totals.map((t) => `${t.source}\u0000${t.provider}\u0000${t.identity}`));
  for (const [key, h] of held) {
    if (known.has(key)) continue;
    const [source, provider, identity] = key.split("\u0000") as [string, string, string];
    lines.push(line(source, provider, identity, 0, 0, h.usd, h.tokens));
  }
  const grand: VerifyLine[] = [];
  for (const source of [...new Set(lines.map((l) => l.source))].sort()) {
    const mine = lines.filter((l) => l.source === source);
    grand.push(line(source, "ALL", "ALL", mine.reduce((n, l) => n + l.hostUsd, 0), mine.reduce((n, l) => n + l.hostTokens, 0), mine.reduce((n, l) => n + l.gatewayUsd, 0), mine.reduce((n, l) => n + l.gatewayTokens, 0)));
  }
  return { lines, grand, ok: lines.every((l) => l.ok) && grand.every((l) => l.ok) };
}

const usd = (n: number): string => `$${n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function formatVerification(v: Verification): string {
  const row = (l: VerifyLine) => [l.source, l.provider, l.identity, usd(l.hostUsd), usd(l.gatewayUsd), usd(l.diffUsd), l.hostTokens.toLocaleString("en-GB"), l.gatewayTokens.toLocaleString("en-GB"), l.ok ? "ok" : "MISMATCH"];
  return table(["SOURCE", "PROVIDER", "IDENTITY", "HOST", "GATEWAY", "DIFF", "HOST TOKENS", "GATEWAY TOKENS", "STATUS"], [...v.lines.map(row), ...v.grand.map(row)]);
}

async function readSnapshot(path: string): Promise<{ results: unknown; generation: string }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    throw new CliUsageError(`cannot read the usage snapshot at ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new CliUsageError(`the usage snapshot at ${path} is not valid JSON`);
  }
  const results = isObj(json) ? json.aggregateResults : undefined;
  if (!Array.isArray(results) || results.length === 0) throw new CliUsageError(`the usage snapshot at ${path} has no aggregateResults`);
  // The generation is when the host built the merged results; the older `generatedAt` is the fallback.
  const stamp = isObj(json) ? (json.aggregateGeneratedAt ?? json.generatedAt) : undefined;
  const at = typeof stamp === "string" ? new Date(stamp) : undefined;
  if (!at || Number.isNaN(at.getTime())) throw new CliUsageError(`the usage snapshot at ${path} has no aggregateGeneratedAt or generatedAt time`);
  return { results, generation: at.toISOString() };
}

const USAGE = "Usage: ais gateway usage-history import [--snapshot=<path>] [--zone=<IANA zone>] [--batch-size=500] [--dry-run] [--verify-only]";

/**
 * `ais gateway usage-history import [--snapshot=<path>] [--zone=<zone>] [--batch-size=500] [--dry-run] [--verify-only]`.
 * Reads the host usage snapshot (never changes it), sends the history to the gateway admin API in batches
 * under the snapshot's generation, reads back that generation of the sources it imported and prints host cost against gateway cost
 * per provider and identity. Fails when a cost differs by more than $1 or a token count differs at all.
 * Importing the same generation again is idempotent; a newer snapshot adds a new generation.
 */
export async function runUsageHistoryCommand(rest: string[], flags: Flags, deps: GatewayCliDeps): Promise<void> {
  if (rest[0] !== "import") throw new CliUsageError(USAGE);
  const path = stringFlag(flags, "snapshot") ?? join(aisCacheDir(), "usage", "snapshot.json");
  const batchRaw = stringFlag(flags, "batch-size");
  const batch = batchRaw === undefined ? DEFAULT_BATCH : Number(batchRaw);
  if (!Number.isInteger(batch) || batch < 1 || batch > 2000) throw new CliUsageError(`--batch-size must be a whole number from 1 to 2000, got "${batchRaw}"`);
  const zone = stringFlag(flags, "zone") ?? usageBucketZone();
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
  } catch {
    throw new CliUsageError(`--zone must be an IANA time zone, got "${zone}"`);
  }
  const { results, generation } = await readSnapshot(path);
  const history = historyFromSnapshot(results, { generation, zone });
  const sources = [...new Set(history.rows.map((r) => r.source))].sort();
  const hostTotal = history.totals.filter((t) => t.source === SOURCE_MODELS).reduce((n, t) => n + t.costUsd, 0);
  deps.out(`host history: generation ${generation}, zone ${zone}, ${history.rows.length} rows, ${history.totals.length} figures, all-time cost ${usd(hostTotal)}`);
  for (const source of sources) deps.out(`  ${source}: ${history.rows.filter((r) => r.source === source).length} rows`);
  for (const s of history.skipped) deps.out(`skipped ${s.provider}/${s.identity}: its traffic is in the gateway ledger already`);
  for (const w of history.warnings) deps.out(`warning: ${w}`);
  if (boolFlag(flags, "dry-run")) {
    deps.out(table(["SOURCE", "PROVIDER", "IDENTITY", "HOST", "TOKENS"], history.totals.map((t) => [t.source, t.provider, t.identity, usd(t.costUsd), t.tokens.toLocaleString("en-GB")])));
    return;
  }
  const { admin } = await connect(deps);
  if (!boolFlag(flags, "verify-only")) {
    let sent = 0;
    for (let i = 0; i < history.rows.length; i += batch) {
      const chunk = history.rows.slice(i, i + batch);
      await admin.call("POST", "/usage/history", { rows: chunk });
      sent += chunk.length;
      deps.out(`imported ${sent} of ${history.rows.length} rows`);
    }
  }
  // Read back only this generation of the sources this run imported, one source at a time (sources are never added together).
  const held: HeldRow[] = [];
  for (const source of sources) {
    const { json } = await admin.call("GET", `/usage/history?source=${encodeURIComponent(source)}&generation=${encodeURIComponent(generation)}`);
    if (Array.isArray(json.history)) held.push(...(json.history as HeldRow[]));
  }
  const verification = verifyHistory(history.totals, held);
  deps.out(formatVerification(verification));
  if (!verification.ok) throw new Error(`usage history verification failed: a host and gateway figure differ by more than ${usd(MISMATCH_USD)}, or a token count differs`);
  deps.out(`verified: host and gateway agree (cost within ${usd(MISMATCH_USD)}, tokens exactly) for every provider and identity`);
}
