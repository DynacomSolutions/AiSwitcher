import { join } from "node:path";
import { estimateChatModelTokenCost } from "../../identities/model-pricing.ts";
import type { Identity, ToolConfig } from "../../identities/types.ts";
import { listRecentFiles, type LocalEstimateDeps } from "../../shared/local-spend.ts";
import type { ParsedArgs } from "../args.ts";
import { bold, dim, yellow } from "../colors.ts";
import { runBatched } from "../limits/collect.ts";
import { borderRow, padRow } from "../table.ts";
import { formatCost, formatNumber } from "./report.ts";
import { collectTargets, type UsageTarget } from "./run.ts";

/**
 * Per-identity breakdown of WHAT consumed tokens and estimated cost: built-in
 * tool calls, MCP servers (with per-tool detail), code edits, web tools, and
 * the model turns that carried no tool call at all, aggregated from the same
 * local session logs the usage pipeline reads.
 *
 * THE ATTRIBUTION RULE (one convention, applied to every supported tool):
 *
 *   1. Input, cache-read and cache-write tokens price the PROMPT CONTEXT of a
 *      model turn, not any specific tool, so they always land on the
 *      "conversation" row and never on tool rows.
 *   2. Output tokens are the turn's generation, so they are split EVENLY
 *      across the tool calls that same turn contains (remainder tokens go to
 *      the earlier calls): for Claude, across the message's tool_use blocks;
 *      for Codex, across the response items of the current turn. A turn with
 *      no tool calls keeps its output on the "conversation" row.
 *   3. callCount counts real tool_use blocks / call items only.
 *
 * This is inherently heuristic: the logs record usage per MODEL TURN and tool
 * calls per turn, never per call. Every number shown is an ESTIMATE priced at
 * chat list rates (identities/model-pricing.ts, models.dev catalogue), never
 * real billed spend, same hard convention as `ais usage`'s EST. COST.
 *
 * Only Claude and Codex have readers: their logs carry both per-turn token
 * usage and tool-call names. The other tools' local stores either have no
 * token data at all (grok) or only session/message totals with no per-call
 * signal (see UNAVAILABLE_REASONS): they degrade to an explicit
 * "unavailable" result, never fabricated rows.
 */

export type BreakdownKind = "tool" | "mcp" | "edit" | "web" | "conversation" | "other";

export interface BreakdownCategory {
  kind: BreakdownKind;
  name: string;
  /** MCP server name when kind is "mcp" (e.g. "chrome-devtools"). */
  server?: string;
  callCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estCostUsd: number;
  /** ISO timestamp of the most recent attributed event; null when never seen. */
  lastUsedAt: string | null;
  /** MCP only: per-tool rows inside the server, cost-desc. */
  tools?: BreakdownCategory[];
}

export interface BreakdownResult {
  identity: string;
  tool: ToolConfig["toolName"];
  windowDays: number;
  generatedAt: string;
  filesRead: number;
  /** Sorted estCostUsd-desc. Empty when the identity has no in-window logs. */
  categories: BreakdownCategory[];
  /** Set when the tool's local logs cannot support a per-call breakdown. */
  unavailable?: string;
  /** Non-fatal notes (models with tokens but no list price, and so on). */
  notes?: string[];
}

export interface BreakdownDeps extends LocalEstimateDeps {
  /** Streams one file line by line. Defaults to streaming the real file;
   * injected by tests so collector suites never touch the real home. */
  readLines?: (path: string) => AsyncIterable<string>;
  now?: () => Date;
}

export const DEFAULT_BREAKDOWN_DAYS = 30;
export const MIN_BREAKDOWN_DAYS = 1;
export const MAX_BREAKDOWN_DAYS = 365;

export function clampBreakdownDays(days: number): number {
  if (!Number.isFinite(days)) return DEFAULT_BREAKDOWN_DAYS;
  const floored = Math.floor(days);
  // 0/negative means "no real window given": fall back to the default rather
  // than silently shrinking to a one-day lookback.
  if (floored < MIN_BREAKDOWN_DAYS) return DEFAULT_BREAKDOWN_DAYS;
  return Math.min(MAX_BREAKDOWN_DAYS, floored);
}

/* ------------------------------- naming ---------------------------------- */

/** Built-in tools that write or patch files: grouped as "code edits" in the
 * summary views while each still appears individually in detail lists.
 * Covers both Claude's and Codex's edit tool spellings. */
const EDIT_TOOL_NAMES = new Set([
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
  "ApplyPatch",
  "apply_patch",
  "str_replace_editor",
  "str_replace_based_edit_tool",
]);

const WEB_TOOL_NAMES = new Set(["WebFetch", "WebSearch", "web_search", "fetch", "url_fetch"]);

export interface ClassifiedCall {
  kind: Exclude<BreakdownKind, "other" | "conversation">;
  /** Rollup name: the call name itself, or "mcp:<server>" for MCP calls. */
  name: string;
  server?: string;
  /** Full original call name (=== name for non-MCP calls). */
  detail: string;
}

/** mcp__<server>__<tool> -> kind "mcp", server rollup "mcp:<server>", detail
 * keeps the full original name so per-tool rows stay greppable. */
export function classifyToolCall(rawName: string): ClassifiedCall {
  const parts = rawName.split("__");
  if (parts[0] === "mcp" && parts.length >= 3) {
    const server = parts[1]!;
    return { kind: "mcp", name: `mcp:${server}`, server, detail: rawName };
  }
  if (EDIT_TOOL_NAMES.has(rawName)) return { kind: "edit", name: rawName, detail: rawName };
  if (WEB_TOOL_NAMES.has(rawName)) return { kind: "web", name: rawName, detail: rawName };
  return { kind: "tool", name: rawName, detail: rawName };
}

/* ----------------------------- accumulator -------------------------------- */

interface ModelTally {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface Bucket {
  kind: BreakdownKind;
  name: string;
  server?: string;
  callCount: number;
  lastMs?: number;
  byModel: Map<string, ModelTally>;
}

function tallyOf(bucket: Bucket, model: string): ModelTally {
  let tally = bucket.byModel.get(model);
  if (!tally) bucket.byModel.set(model, (tally = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }));
  return tally;
}

class BreakdownAccumulator {
  private buckets = new Map<string, Bucket>();

  private bucket(kind: BreakdownKind, name: string, server?: string): Bucket {
    const key = `${kind}\u0000${name}`;
    let bucket = this.buckets.get(key);
    if (!bucket) this.buckets.set(key, (bucket = { kind, name, ...(server ? { server } : {}), callCount: 0, byModel: new Map() }));
    return bucket;
  }

  /** Attributes one lot of tokens. `output` must already be split per the
   * attribution rule; input/cache go through here too (callers route them to
   * the conversation bucket). */
  add(
    kind: BreakdownKind,
    name: string,
    model: string,
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number },
    atMs: number | undefined,
    server?: string,
  ): void {
    const bucket = this.bucket(kind, name, server);
    const tally = tallyOf(bucket, model);
    tally.input += tokens.input;
    tally.output += tokens.output;
    tally.cacheRead += tokens.cacheRead;
    tally.cacheWrite += tokens.cacheWrite;
    if (atMs !== undefined && (bucket.lastMs === undefined || atMs > bucket.lastMs)) bucket.lastMs = atMs;
  }

  countCall(kind: BreakdownKind, name: string, atMs: number | undefined, server?: string): void {
    const bucket = this.bucket(kind, name, server);
    bucket.callCount += 1;
    if (atMs !== undefined && (bucket.lastMs === undefined || atMs > bucket.lastMs)) bucket.lastMs = atMs;
  }

  /** Prices every bucket per model (splitting the pricing per model keeps the
   * maths linear and exact), folds MCP detail rows into their server row and
   * sorts cost-desc. */
  finish(): { categories: BreakdownCategory[]; unpricedModels: string[] } {
    const unpriced = new Set<string>();
    const priced = [...this.buckets.values()].map((bucket): BreakdownCategory => {
      let estCostUsd = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheReadTokens = 0;
      let cacheWriteTokens = 0;
      for (const [model, tally] of bucket.byModel) {
        inputTokens += tally.input;
        outputTokens += tally.output;
        cacheReadTokens += tally.cacheRead;
        cacheWriteTokens += tally.cacheWrite;
        if (tally.input + tally.output + tally.cacheRead + tally.cacheWrite === 0) continue;
        const cost = estimateChatModelTokenCost(model, tally.input, tally.output, tally.cacheRead, tally.cacheWrite);
        if (cost === undefined) {
          unpriced.add(model);
          continue;
        }
        estCostUsd += cost;
      }
      return {
        kind: bucket.kind,
        name: bucket.name,
        ...(bucket.server ? { server: bucket.server } : {}),
        callCount: bucket.callCount,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        estCostUsd,
        lastUsedAt: bucket.lastMs !== undefined ? new Date(bucket.lastMs).toISOString() : null,
      };
    });

    const mcpGroups = new Map<string, { rollup: BreakdownCategory; tools: BreakdownCategory[] }>();
    const flat: BreakdownCategory[] = [];
    for (const category of priced) {
      // Detail rows are the per-tool MCP buckets (bucket name === the raw
      // call name); everything else, including conversation and non-MCP
      // calls, passes through flat and the rollups are summed below.
      const isDetail = category.kind === "mcp" && category.server !== undefined && category.name !== `mcp:${category.server}`;
      if (!isDetail) {
        flat.push(category);
        continue;
      }
      const server = category.server!;
      let group = mcpGroups.get(server);
      if (!group) {
        group = {
          rollup: {
            kind: "mcp",
            name: `mcp:${server}`,
            server,
            callCount: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            estCostUsd: 0,
            lastUsedAt: null,
          },
          tools: [],
        };
        mcpGroups.set(server, group);
      }
      group.tools.push(category);
      group.rollup.callCount += category.callCount;
      group.rollup.inputTokens += category.inputTokens;
      group.rollup.outputTokens += category.outputTokens;
      group.rollup.cacheReadTokens += category.cacheReadTokens;
      group.rollup.cacheWriteTokens += category.cacheWriteTokens;
      group.rollup.estCostUsd += category.estCostUsd;
      if (category.lastUsedAt && (!group.rollup.lastUsedAt || category.lastUsedAt > group.rollup.lastUsedAt)) {
        group.rollup.lastUsedAt = category.lastUsedAt;
      }
    }
    for (const group of mcpGroups.values()) {
      group.tools.sort((a, b) => b.estCostUsd - a.estCostUsd || a.name.localeCompare(b.name));
      group.rollup.tools = group.tools;
      flat.push(group.rollup);
    }
    flat.sort((a, b) => b.estCostUsd - a.estCostUsd);
    return { categories: flat, unpricedModels: [...unpriced].sort() };
  }
}

/** Splits `total` into `parts` near-equal integers (earlier parts absorb the
 * remainder) so attributed output always sums back to the real total. */
export function splitEvenly(total: number, parts: number): number[] {
  if (parts <= 0) return [];
  const base = Math.floor(total / parts);
  const remainder = total - base * parts;
  return Array.from({ length: parts }, (_, i) => base + (i < remainder ? 1 : 0));
}

/* ------------------------------ streaming --------------------------------- */

async function* streamLines(path: string): AsyncIterable<string> {
  const reader = Bun.file(path).stream().getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineAt = buffer.indexOf("\n");
      while (newlineAt !== -1) {
        yield buffer.slice(0, newlineAt);
        buffer = buffer.slice(newlineAt + 1);
        newlineAt = buffer.indexOf("\n");
      }
    }
    // A final line without its newline can still be complete JSON; a torn
    // trailing line fails JSON.parse and is skipped by the callers.
    const tail = buffer + decoder.decode();
    if (tail.length > 0) yield tail;
  } finally {
    reader.releaseLock();
  }
}

interface UsageLot {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

function parseTimestampMs(raw: unknown): number | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : undefined;
}

/* ------------------------------- claude ----------------------------------- */

interface ClaudeLine {
  timestamp?: string;
  message?: {
    model?: string;
    content?: unknown;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

function toolUseNames(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const names: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: unknown }).type === "tool_use") {
      const name = (block as { name?: unknown }).name;
      if (typeof name === "string" && name.length > 0) names.push(name);
    }
  }
  return names;
}

async function collectClaudeBreakdown(
  identity: Identity,
  windowStartMs: number,
  deps: BreakdownDeps,
): Promise<{ categories: BreakdownCategory[]; unpricedModels: string[]; filesRead: number; unreadable: boolean }> {
  const { files, unreadable } = listRecentFiles(join(identity.configDir, "projects"), new Date(windowStartMs), deps, false);
  const acc = new BreakdownAccumulator();
  const readLines = deps.readLines ?? streamLines;
  for (const file of files) {
    try {
      for await (const line of readLines(file)) {
        // Cheap pre-filter: only assistant lines carry message.usage.
        if (!line.includes('"usage"')) continue;
        let parsed: ClaudeLine;
        try {
          parsed = JSON.parse(line) as ClaudeLine;
        } catch {
          continue; // torn/truncated line: never sink the breakdown
        }
        const usage = parsed.message?.usage;
        if (!usage) continue;
        const atMs = parseTimestampMs(parsed.timestamp);
        if (atMs !== undefined && atMs < windowStartMs) continue;
        const model = parsed.message?.model ?? "unknown";
        const lot: UsageLot = {
          input: usage.input_tokens ?? 0,
          output: usage.output_tokens ?? 0,
          cacheRead: usage.cache_read_input_tokens ?? 0,
          cacheWrite: usage.cache_creation_input_tokens ?? 0,
        };
        // Rule 1: prompt-side tokens always belong to the conversation row.
        acc.add("conversation", "conversation", model, { ...lot, output: 0 }, atMs);
        acc.countCall("conversation", "conversation", atMs);
        // Rule 2: output splits evenly across this message's tool calls.
        const names = toolUseNames(parsed.message?.content);
        if (names.length === 0) {
          acc.add("conversation", "conversation", model, { input: 0, output: lot.output, cacheRead: 0, cacheWrite: 0 }, atMs);
          continue;
        }
        const shares = splitEvenly(lot.output, names.length);
        names.forEach((rawName, i) => {
          const classified = classifyToolCall(rawName);
          // Bucket MCP calls under their full per-tool name; the rollup row
          // (mcp:<server>) is summed by finish() from these detail rows.
          acc.add(classified.kind, classified.detail, model, { input: 0, output: shares[i] ?? 0, cacheRead: 0, cacheWrite: 0 }, atMs, classified.server);
          acc.countCall(classified.kind, classified.detail, atMs, classified.server);
        });
      }
    } catch {
      // A file that vanished or became unreadable mid-scan: keep the rest.
    }
  }
  const finished = acc.finish();
  return { ...finished, filesRead: files.length, unreadable };
}

/* -------------------------------- codex ----------------------------------- */

interface CodexTokenCountLine {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    info?: {
      last_token_usage?: {
        input_tokens?: number;
        cached_input_tokens?: number;
        cache_write_input_tokens?: number;
        output_tokens?: number;
      };
    };
  };
}

interface CodexCallLine {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    name?: unknown;
    turn_id?: unknown;
    action?: { type?: unknown };
  };
}

/** One turn's buffered state: calls seen in the turn (in-window only) and the
 * output deltas waiting to be split across them. Input/cache sides of a delta
 * are applied immediately; only OUTPUT waits for the turn's full call set. */
interface CodexTurnState {
  key: string;
  calls: Array<{ classified: ClassifiedCall; atMs: number | undefined }>;
  pendingOutput: Array<{ model: string; output: number; atMs: number | undefined }>;
}

async function collectCodexBreakdown(
  identity: Identity,
  windowStartMs: number,
  deps: BreakdownDeps,
): Promise<{ categories: BreakdownCategory[]; unpricedModels: string[]; filesRead: number; unreadable: boolean }> {
  const { files, unreadable } = listRecentFiles(join(identity.configDir, "sessions"), new Date(windowStartMs), deps, true);
  const acc = new BreakdownAccumulator();
  const readLines = deps.readLines ?? streamLines;

  for (const file of files) {
    let model = "unknown";
    let turn: CodexTurnState | undefined;
    const flushTurn = (): void => {
      if (!turn) return;
      // Rule 2, codex flavour: each buffered output delta splits evenly
      // across the turn's observed calls; a call-less turn keeps its output.
      for (const delta of turn.pendingOutput) {
        if (turn.calls.length === 0) {
          acc.add("conversation", "conversation", delta.model, { input: 0, output: delta.output, cacheRead: 0, cacheWrite: 0 }, delta.atMs);
          continue;
        }
        const shares = splitEvenly(delta.output, turn.calls.length);
        turn.calls.forEach((call, i) => {
          acc.add(call.classified.kind, call.classified.detail, delta.model, { input: 0, output: shares[i] ?? 0, cacheRead: 0, cacheWrite: 0 }, delta.atMs, call.classified.server);
        });
      }
      turn = undefined;
    };

    try {
      for await (const line of readLines(file)) {
        if (
          !line.includes("token_count") &&
          !line.includes("turn_context") &&
          !line.includes("function_call") &&
          !line.includes("custom_tool_call") &&
          !line.includes("local_shell_call")
        ) {
          continue;
        }
        let parsed: (CodexTokenCountLine | CodexCallLine) & { type?: string };
        try {
          parsed = JSON.parse(line) as (CodexTokenCountLine | CodexCallLine) & { type?: string };
        } catch {
          continue;
        }
        const atMs = parseTimestampMs(parsed.timestamp);

        if (parsed.type === "turn_context") {
          const payload = (parsed as { payload?: { model?: unknown; turn_id?: unknown } }).payload;
          if (!payload) continue;
          const turnKey = typeof payload.turn_id === "string" ? payload.turn_id : String(parsed.timestamp ?? "");
          if (!turn || turn.key !== turnKey) {
            flushTurn();
            turn = { key: turnKey, calls: [], pendingOutput: [] };
          }
          if (typeof payload.model === "string") model = payload.model;
          continue;
        }

        if (parsed.type === "response_item") {
          const payload = (parsed as CodexCallLine).payload;
          if (!payload) continue;
          const payloadType = payload.type;
          let rawName: string | undefined;
          if (payloadType === "function_call" || payloadType === "custom_tool_call") {
            rawName = typeof payload.name === "string" ? payload.name : undefined;
          } else if (payloadType === "local_shell_call") {
            rawName = typeof payload.action?.type === "string" ? payload.action.type : "exec";
          }
          if (!rawName) continue;
          if (atMs !== undefined && atMs < windowStartMs) continue;
          turn ??= { key: "", calls: [], pendingOutput: [] };
          const classified = classifyToolCall(rawName);
          turn.calls.push({ classified, atMs });
          acc.countCall(classified.kind, classified.detail, atMs, classified.server);
          continue;
        }

        if (parsed.type === "event_msg" && (parsed as CodexTokenCountLine).payload?.type === "token_count") {
          const usage = (parsed as CodexTokenCountLine).payload?.info?.last_token_usage;
          if (!usage) continue;
          if (atMs !== undefined && atMs < windowStartMs) continue;
          const input = usage.input_tokens ?? 0;
          const cached = Math.min(usage.cached_input_tokens ?? 0, input);
          const cacheWrite = Math.min(usage.cache_write_input_tokens ?? 0, input - cached);
          // Rule 1: the prompt side is conversation, exactly like Claude.
          acc.add(
            "conversation",
            "conversation",
            model,
            { input: Math.max(0, input - cached - cacheWrite), output: 0, cacheRead: cached, cacheWrite },
            atMs,
          );
          acc.countCall("conversation", "conversation", atMs);
          turn ??= { key: "", calls: [], pendingOutput: [] };
          turn.pendingOutput.push({ model, output: usage.output_tokens ?? 0, atMs });
        }
      }
    } catch {
      // Unreadable mid-scan: keep the rest of the scan.
    }
    flushTurn();
  }

  const finished = acc.finish();
  return { ...finished, filesRead: files.length, unreadable };
}

/* ------------------------------ unavailable -------------------------------- */

/** Why each non-claude/codex tool cannot answer, verified against each
 * tool's real local store on this machine (2026-09-10): grok's
 * chat_history.jsonl names tool calls but carries zero usage fields; kimi's
 * user-history JSONL and Crush's crush.db (zai/ali) hold session/message
 * totals with no per-call split; Pi's session JSONL and OpenCode's db record
 * per-message provider/token totals without per-tool attribution. */
const UNAVAILABLE_REASONS: Partial<Record<ToolConfig["toolName"], string>> = {
  grok: "local session history records tool names but no token usage, so tokens cannot be attributed per call",
  kimi: "local history stores message totals without per-call token usage",
  zai: "Crush stores session totals only, with no per-call token data",
  ali: "Crush stores session totals only, with no per-call token data",
  pi: "Pi's local logs carry per-message provider totals without per-tool attribution",
  opencode: "OpenCode's local store carries per-message provider totals without per-tool attribution",
};

/* --------------------------------- API ------------------------------------- */

function unpricedNote(models: string[]): string | undefined {
  if (models.length === 0) return undefined;
  return `no list price for: ${models.join(", ")}; their tokens are excluded from estCostUsd`;
}

/** Collects the breakdown for exactly one (tool, identity) pair. */
export async function collectIdentityBreakdown(
  toolName: ToolConfig["toolName"],
  identity: Identity,
  windowDays = DEFAULT_BREAKDOWN_DAYS,
  deps: BreakdownDeps = {},
): Promise<BreakdownResult> {
  const days = clampBreakdownDays(windowDays);
  const now = deps.now?.() ?? new Date();
  const windowStartMs = now.getTime() - days * 86_400_000;
  const meta = {
    identity: identity.name,
    tool: toolName,
    windowDays: days,
    generatedAt: now.toISOString(),
  };

  const unavailable = UNAVAILABLE_REASONS[toolName];
  if (unavailable) return { ...meta, filesRead: 0, categories: [], unavailable };

  const outcome =
    toolName === "claude"
      ? await collectClaudeBreakdown(identity, windowStartMs, deps)
      : toolName === "codex"
        ? await collectCodexBreakdown(identity, windowStartMs, deps)
        : undefined;
  if (!outcome) {
    // A tool added to the registry before this module learned about it.
    return { ...meta, filesRead: 0, categories: [], unavailable: `no breakdown reader for tool "${toolName}"` };
  }
  if (outcome.unreadable) {
    return { ...meta, filesRead: 0, categories: [], unavailable: "no local session logs found for this identity" };
  }
  const note = unpricedNote(outcome.unpricedModels);
  return {
    ...meta,
    filesRead: outcome.filesRead,
    categories: outcome.categories,
    ...(note ? { notes: [note] } : {}),
  };
}

/** CLI/server entry: breakdown for every target (already filtered by
 * --identity/--tool), bounded like the usage pipeline because the scans are
 * disk-bound JSONL streaming. */
export async function collectBreakdownResults(
  targets: UsageTarget[],
  windowDays = DEFAULT_BREAKDOWN_DAYS,
  onItemDone?: (index: number, result: BreakdownResult) => void,
  deps: BreakdownDeps = {},
): Promise<BreakdownResult[]> {
  return runBatched(targets, 4, (target) => collectIdentityBreakdown(target.toolName, target.identity, windowDays, deps), onItemDone);
}

/** Shared flag handling for the CLI command and the server endpoint. */
export interface BreakdownQuery {
  identity?: string;
  tool?: string;
  days: number;
}

export function breakdownQueryFromFlags(flags: ParsedArgs["flags"], positionalIdentity?: string): BreakdownQuery {
  const rawDays = flags.days;
  const parsedDays = typeof rawDays === "string" ? Number.parseInt(rawDays, 10) : NaN;
  return {
    ...(positionalIdentity ? { identity: positionalIdentity } : typeof flags.identity === "string" ? { identity: flags.identity } : {}),
    ...(typeof flags.tool === "string" ? { tool: flags.tool } : {}),
    days: clampBreakdownDays(Number.isFinite(parsedDays) ? parsedDays : DEFAULT_BREAKDOWN_DAYS),
  };
}

export async function runBreakdownQuery(query: BreakdownQuery, deps: BreakdownDeps = {}): Promise<BreakdownResult[]> {
  const flags: ParsedArgs["flags"] = {
    ...(query.identity ? { identity: query.identity } : {}),
    ...(query.tool ? { tool: query.tool } : {}),
  };
  const targets = await collectTargets(flags);
  return collectBreakdownResults(targets, query.days, undefined, deps);
}

/* ------------------------------- rendering --------------------------------- */

const KIND_LABELS: Record<BreakdownKind, string> = {
  conversation: "chat",
  mcp: "mcp",
  edit: "edit",
  web: "web",
  tool: "tool",
  other: "other",
};

function formatDateMs(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function lastUsedCell(category: BreakdownCategory): string {
  if (!category.lastUsedAt) return "-";
  const ms = Date.parse(category.lastUsedAt);
  return Number.isFinite(ms) ? formatDateMs(ms) : "-";
}

const CLI_ROW_LIMIT = 15;

/** Rows for one result: top-level categories cost-desc, MCP rows annotated
 * with their tool count. Detail stays one click away in the web UI. */
function resultRows(result: BreakdownResult): string[][] {
  const rows: string[][] = [];
  for (const category of result.categories.slice(0, CLI_ROW_LIMIT)) {
    rows.push([
      KIND_LABELS[category.kind],
      category.name,
      formatNumber(category.callCount),
      formatNumber(category.inputTokens),
      formatNumber(category.outputTokens),
      formatNumber(category.cacheReadTokens),
      formatCost(category.estCostUsd),
      lastUsedCell(category),
    ]);
  }
  if (result.categories.length > CLI_ROW_LIMIT) {
    rows.push(["", `${result.categories.length - CLI_ROW_LIMIT} more...`, "", "", "", "", "", ""]);
  }
  return rows;
}

const BREAKDOWN_HEADERS = ["KIND", "NAME", "CALLS", "INPUT", "OUTPUT", "CACHE READ", "EST. COST", "LAST USED"];

/** Plain-text render of one or more breakdown results, most expensive rows
 * first, following the usage report's table conventions. */
export function formatBreakdownReport(results: BreakdownResult[]): string {
  if (results.length === 0) return dim("No matching identities found.");

  const lines: string[] = [];
  lines.push(dim("Per-tool token & cost breakdown from local session logs (ESTIMATES: per-call attribution is heuristic, never real billed spend)."));
  lines.push("");

  const answerable = results.filter((r) => !r.unavailable);
  const unavailable = results.filter((r) => r.unavailable);

  const rows = answerable.flatMap((r) => resultRows(r));
  if (rows.length > 0) {
    const widths = BREAKDOWN_HEADERS.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)));
    const numeric = new Set([2, 3, 4, 5, 6]);
    lines.push(borderRow(widths, "┌", "┬", "┐"));
    lines.push(bold(padRow(BREAKDOWN_HEADERS, widths, numeric)));
    lines.push(borderRow(widths, "├", "┼", "┤"));
    for (const row of rows) lines.push(padRow(row, widths, numeric));
    lines.push(borderRow(widths, "└", "┴", "┘"));
  }

  if (unavailable.length > 0) {
    lines.push("");
    lines.push(bold("Unavailable:"));
    for (const r of unavailable) lines.push(`  ${yellow(`${r.tool}/${r.identity}`)}: ${r.unavailable}`);
  }

  const notes = answerable.filter((r) => (r.notes?.length ?? 0) > 0);
  if (notes.length > 0) {
    lines.push("");
    lines.push(bold("Notes:"));
    for (const r of notes) for (const note of r.notes ?? []) lines.push(`  ${dim(`${r.tool}/${r.identity}`)}: ${note}`);
  }

  return lines.join("\n");
}
