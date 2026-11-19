import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { boolFlag, stringFlag, type ParsedArgs } from "../args.ts";
import { CliUsageError } from "../errors.ts";
import { canonicalUsageProvider } from "../usage/providers.ts";
import { aisCacheDir } from "../../shared/ais-home.ts";
import type { UsageHistoryRow } from "../../gateway/types.ts";
import { connect, table, type GatewayCliDeps } from "./apps.ts";

type Flags = ParsedArgs["flags"];

/** Source of the per-model, all-time figures (one row per identity and model, no day). They cover every host provider. */
export const SOURCE_MODELS = "host-snapshot-models";
/** Source of the per-day figures (one row per identity and day, no model). The host snapshot keeps them for some providers only. */
export const SOURCE_DAILY = "host-snapshot-daily";
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

/** What the host snapshot says one source holds for one provider and identity: the figure the gateway copy must match. */
export interface HostTotal {
  source: string;
  provider: string;
  identity: string;
  costUsd: number;
  messages: number;
}

export interface HostHistory {
  rows: UsageHistoryRow[];
  totals: HostTotal[];
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
const whole = (v: unknown): number => Math.round(num(v));
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Maps the snapshot's merged `aggregateResults` to history rows and host totals.
 * - Models source: per provider, identity and model, all time (every provider has it).
 * - Daily source: per provider, identity and day, from `dailyTotals` ([input, output, cacheRead, cacheWrite, messages, cost]).
 * Rows that share a key (two host results that map to one gateway provider and identity) are summed. Errored or empty results add nothing.
 */
export function historyFromSnapshot(aggregateResults: unknown): HostHistory {
  const rows = new Map<string, UsageHistoryRow>();
  const totals = new Map<string, HostTotal>();
  const addTotal = (source: string, provider: string, identity: string, cost: number, messages: number) => {
    const key = `${source}\u0000${provider}\u0000${identity}`;
    const t = totals.get(key) ?? { source, provider, identity, costUsd: 0, messages: 0 };
    t.costUsd += cost;
    t.messages += messages;
    totals.set(key, t);
  };
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
  };
  for (const result of Array.isArray(aggregateResults) ? aggregateResults : []) {
    if (!isObj(result) || typeof result.provider !== "string" || !isObj(result.identity) || typeof result.identity.name !== "string") continue;
    const provider = gatewayProviderForHost(result.provider);
    const identity = result.identity.name;
    const report = isObj(result.report) ? result.report : undefined;
    const entries = Array.isArray(report?.entries) ? (report.entries as unknown[]) : [];
    let modelsCost = 0;
    let modelsMessages = 0;
    for (const e of entries) {
      if (!isObj(e)) continue;
      const row: UsageHistoryRow = {
        source: SOURCE_MODELS,
        provider,
        identity,
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
      modelsCost += row.estCostUsd;
      modelsMessages += row.messages;
    }
    // The host figure is the report total when the host states one, else the sum of its entries.
    if (entries.length > 0) addTotal(SOURCE_MODELS, provider, identity, report && typeof report.totalCost === "number" ? num(report.totalCost) : modelsCost, report && typeof report.totalMessages === "number" ? whole(report.totalMessages) : modelsMessages);
    const daily = isObj(result.dailyTotals) ? result.dailyTotals : {};
    for (const [day, v] of Object.entries(daily)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Array.isArray(v)) continue;
      const row: UsageHistoryRow = { source: SOURCE_DAILY, provider, identity, day, model: null, inputTokens: whole(v[0]), outputTokens: whole(v[1]), cacheReadTokens: whole(v[2]), cacheWriteTokens: whole(v[3]), messages: whole(v[4]), estCostUsd: num(v[5]) };
      addRow(row);
      addTotal(SOURCE_DAILY, provider, identity, row.estCostUsd, row.messages);
    }
  }
  const order = (a: { provider: string; identity: string }, b: { provider: string; identity: string }) => a.provider.localeCompare(b.provider) || a.identity.localeCompare(b.identity);
  return {
    rows: [...rows.values()].sort((a, b) => a.source.localeCompare(b.source) || order(a, b) || (a.day ?? "").localeCompare(b.day ?? "") || (a.model ?? "").localeCompare(b.model ?? "")),
    totals: [...totals.values()].sort((a, b) => a.source.localeCompare(b.source) || order(a, b)),
  };
}

/** One line of the verification: the host figure, the gateway figure and whether they agree. */
export interface VerifyLine {
  source: string;
  provider: string;
  identity: string;
  hostUsd: number;
  gatewayUsd: number;
  diffUsd: number;
  ok: boolean;
}

export interface Verification {
  lines: VerifyLine[];
  /** Per source: the host and gateway grand totals. */
  grand: VerifyLine[];
  ok: boolean;
}

/** Compares the host totals with what the gateway holds now (rows read back from GET /usage/history). */
export function verifyHistory(totals: HostTotal[], gateway: { source: string; provider: string; identity: string; estCostUsd: number }[], limitUsd = MISMATCH_USD): Verification {
  const held = new Map<string, number>();
  for (const r of gateway) {
    const key = `${r.source}\u0000${r.provider}\u0000${r.identity}`;
    held.set(key, (held.get(key) ?? 0) + r.estCostUsd);
  }
  const line = (source: string, provider: string, identity: string, hostUsd: number, gatewayUsd: number): VerifyLine => {
    const diffUsd = gatewayUsd - hostUsd;
    return { source, provider, identity, hostUsd, gatewayUsd, diffUsd, ok: Math.abs(diffUsd) <= limitUsd };
  };
  const lines = totals.map((t) => line(t.source, t.provider, t.identity, t.costUsd, held.get(`${t.source}\u0000${t.provider}\u0000${t.identity}`) ?? 0));
  // A gateway row the host does not list also shows up, against a host figure of zero.
  const known = new Set(totals.map((t) => `${t.source}\u0000${t.provider}\u0000${t.identity}`));
  for (const [key, usd] of held) {
    if (known.has(key)) continue;
    const [source, provider, identity] = key.split("\u0000") as [string, string, string];
    lines.push(line(source, provider, identity, 0, usd));
  }
  const grand: VerifyLine[] = [];
  for (const source of [...new Set(lines.map((l) => l.source))].sort()) {
    const mine = lines.filter((l) => l.source === source);
    grand.push(line(source, "ALL", "ALL", mine.reduce((n, l) => n + l.hostUsd, 0), mine.reduce((n, l) => n + l.gatewayUsd, 0)));
  }
  return { lines, grand, ok: lines.every((l) => l.ok) && grand.every((l) => l.ok) };
}

const usd = (n: number): string => `$${n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function formatVerification(v: Verification): string {
  const row = (l: VerifyLine) => [l.source, l.provider, l.identity, usd(l.hostUsd), usd(l.gatewayUsd), usd(l.diffUsd), l.ok ? "ok" : "MISMATCH"];
  return table(["SOURCE", "PROVIDER", "IDENTITY", "HOST", "GATEWAY", "DIFF", "STATUS"], [...v.lines.map(row), ...v.grand.map(row)]);
}

async function readSnapshotResults(path: string): Promise<unknown> {
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
  return results;
}

/**
 * `ais gateway usage-history import [--snapshot=<path>] [--batch-size=500] [--dry-run] [--verify-only]`.
 * Reads the host usage snapshot (never changes it), sends the history to the gateway admin API in batches,
 * reads it back and prints host cost against gateway cost per provider and identity. Fails when any figure
 * differs by more than $1.
 */
export async function runUsageHistoryCommand(rest: string[], flags: Flags, deps: GatewayCliDeps): Promise<void> {
  if (rest[0] !== "import") throw new CliUsageError("Usage: ais gateway usage-history import [--snapshot=<path>] [--batch-size=500] [--dry-run] [--verify-only]");
  const path = stringFlag(flags, "snapshot") ?? join(aisCacheDir(), "usage", "snapshot.json");
  const batchRaw = stringFlag(flags, "batch-size");
  const batch = batchRaw === undefined ? DEFAULT_BATCH : Number(batchRaw);
  if (!Number.isInteger(batch) || batch < 1 || batch > 2000) throw new CliUsageError(`--batch-size must be a whole number from 1 to 2000, got "${batchRaw}"`);
  const history = historyFromSnapshot(await readSnapshotResults(path));
  const hostTotal = history.totals.filter((t) => t.source === SOURCE_MODELS).reduce((n, t) => n + t.costUsd, 0);
  deps.out(`host history: ${history.rows.length} rows, ${history.totals.length} figures, all-time cost ${usd(hostTotal)}`);
  if (boolFlag(flags, "dry-run")) {
    deps.out(table(["SOURCE", "PROVIDER", "IDENTITY", "HOST"], history.totals.map((t) => [t.source, t.provider, t.identity, usd(t.costUsd)])));
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
  const { json } = await admin.call("GET", "/usage/history");
  const held = Array.isArray(json.history) ? (json.history as { source: string; provider: string; identity: string; estCostUsd: number }[]) : [];
  const verification = verifyHistory(history.totals, held);
  deps.out(formatVerification(verification));
  if (!verification.ok) throw new Error(`usage history verification failed: a host and gateway figure differ by more than ${usd(MISMATCH_USD)}`);
  deps.out(`verified: host and gateway agree within ${usd(MISMATCH_USD)} for every provider and identity`);
}
