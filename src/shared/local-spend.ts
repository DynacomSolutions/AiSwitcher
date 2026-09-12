import { readdirSync, readFileSync, statSync } from "node:fs";
import { readdir as readdirAsync, stat as statAsync } from "node:fs/promises";
import { join } from "node:path";
import type { ToolConfig } from "../identities/types.ts";
import { estimateBedrockTokenCost, unknownBedrockModelFallbackPrice } from "../identities/model-pricing.ts";
import { localDateKey } from "../cli/usage/local-day.ts";

/**
 * The shared local session-log readers for AWS Bedrock spend. Two consumers,
 * one implementation:
 *
 *   - the spend guard (`spend/compute.ts`), whose PRIMARY breach signal is
 *     the fast, fully-offline, token-based cost estimate for one identity
 *     over a budget period — computed DIRECTLY from the same local session
 *     logs the usage pipeline reads, never by spawning tokscale. Measured on
 *     this machine (2026-09-10): a warm tokscale spawn costs ~2.4s for one
 *     codex identity (and its default report has no date filter at all, so
 *     it cannot produce month-to-date), while the direct readers here walk
 *     only period-recent files and finish well under the launch gate's 1.5s
 *     ceiling. tokscale remains the right engine for the interactive `ais
 *     usage` report for non-Bedrock providers; it is simply the wrong shape
 *     for a gate.
 *   - the `ais usage` report (`usage/aws-bedrock-usage.ts`), whose AWS
 *     Bedrock rows show the SAME local month-to-date figures in the normal
 *     token/cost columns (so they reconcile with the guard by construction),
 *     while AWS's own real billing figures render separately as real-cost
 *     sub-rows. The usage pathway reads through readIdentityLocalSpendAsync,
 *     the chunked async twin sharing this file's scanners and reduction
 *     verbatim: the report fans that fetch out concurrently with a live
 *     render, so its reads must yield the event loop (the guard keeps the
 *     sync twin: one identity, off the render's hot path).
 *
 * Readers exist for the two identity kinds that can be Bedrock-backed (see
 * identities/aws-profile.ts): codex (config.toml model_provider =
 * "amazon-bedrock", rollout JSONL under <configDir>/sessions) and claude
 * (CLAUDE_CODE_USE_BEDROCK, usage JSONL under <configDir>/projects). Other
 * tools contribute 0 with a note: no Bedrock-backed identity exists for them
 * on this machine, and the max(local, real) blend catches the gap via Cost
 * Explorer within hours.
 *
 * Valuation uses AWS_BEDROCK_MODEL_PRICES (Bedrock on-demand rates). A model
 * missing from the table is valued at the table's element-wise max rate —
 * deliberately the SAFE direction for a guard (never free), and documented
 * as an estimate: real pricing may differ.
 */

export interface LocalSpendResult {
  /** Estimated dollars for the period, including unknownModelUsd. */
  usd: number;
  /** The portion valued at the conservative unknown-model fallback, kept
   * separate so the honest "estimates are estimates" caveat can be surfaced
   * when it is material. */
  unknownModelUsd: number;
  filesRead: number;
  /** Non-fatal notes (a reader missing for the tool, etc.). Unreadable
   * files and missing session dirs are simply zero contribution. */
  notes: string[];
}

/** Per-model token/cost totals for one identity's period: feeds the usage
 * report's per-model entries (model, provider, tokens, estimate). */
export interface LocalSpendModelTotals {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  messageCount: number;
  /** Period estimate for this model, including unknown-model fallback
   * valuation when the model is missing from the price table. */
  usd: number;
}

/** Everything the usage report and the guard need from one identity's local
 * logs over a period, from a single walk of the period-recent files. Token
 * totals count the SAME records the usd estimate values, so an
 * identity's local figures reconcile with the spend guard's estimate by
 * construction. */
export interface LocalSpendRead extends LocalSpendResult {
  messages: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  models: LocalSpendModelTotals[];
  /** Local "YYYY-MM-DD" (see usage/local-day.ts) -> input+output tokens that
   * day, for the shared contribution graph. Only days with activity. */
  dailyTokens: Record<string, number>;
  /** Span of timestamped records (records with no parsable timestamp still
   * COUNT towards the totals, since an under-count defeats the guard; they
   * just cannot widen a display range they cannot be placed in). */
  firstMs?: number;
  lastMs?: number;
}

export interface LocalEstimateDeps {
  readdir?: (path: string) => string[];
  readText?: (path: string) => string;
  mtimeMs?: (path: string) => number;
  isDirectory?: (path: string) => boolean;
}

function defaultReaddir(path: string): string[] {
  return readdirSync(path);
}

function defaultReadText(path: string): string {
  return readFileSync(path, "utf8");
}

function defaultMtimeMs(path: string): number {
  return statSync(path).mtimeMs;
}

function defaultIsDirectory(path: string): boolean {
  return statSync(path).isDirectory();
}

interface UsageRecord {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Epoch ms of the event; undefined when the line carried no parsable
   * timestamp (such records are COUNTED, never dropped: an estimate that
   * under-counts defeats the guard, one that slightly over-counts blocks a
   * little early). */
  atMs?: number;
}

function valueRecords(records: UsageRecord[]): { usd: number; unknownModelUsd: number } {
  const fallback = unknownBedrockModelFallbackPrice();
  let usd = 0;
  let unknownModelUsd = 0;
  for (const r of records) {
    const priced = estimateBedrockTokenCost(r.model, r.input, r.output, r.cacheRead, r.cacheWrite);
    if (priced !== undefined) {
      usd += priced;
      continue;
    }
    const valued =
      (r.input * fallback.usdPer1mInput +
        r.output * fallback.usdPer1mOutput +
        r.cacheRead * fallback.usdPer1mCacheRead +
        r.cacheWrite * fallback.usdPer1mCacheWrite) /
      1_000_000;
    usd += valued;
    unknownModelUsd += valued;
  }
  return { usd, unknownModelUsd };
}

/** Recursively lists .jsonl files under `root`, pruning directory branches
 * that cannot contain period data. For the codex layout
 * (sessions/YYYY/MM/DD/...) whole year/month/day directories before the
 * period start are skipped by PATH date; every file is additionally
 * mtime-pruned, which is the correct filter for a long-running session whose
 * path day predates the period but which kept appending into it (a file last
 * written before the period cannot hold events from inside it). Exported for
 * tests. */
export function listRecentFiles(
  root: string,
  periodStart: Date,
  deps: LocalEstimateDeps = {},
  prunePathDate: boolean,
): { files: string[]; unreadable: boolean } {
  const readdir = deps.readdir ?? defaultReaddir;
  const mtimeMs = deps.mtimeMs ?? defaultMtimeMs;
  const isDirectory = deps.isDirectory ?? defaultIsDirectory;
  try {
    readdir(root);
  } catch {
    return { files: [], unreadable: true };
  }

  const startYear = periodStart.getFullYear();
  const startMonth = periodStart.getMonth() + 1;
  const startDay = periodStart.getDate();
  const files: string[] = [];

  const walk = (dir: string, depth: number): void => {
    let entries: string[];
    try {
      entries = readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      // `depth` is the parent's level, so year/month/day entries sit at
      // depth+1 = 1/2/3 under the codex sessions/YYYY/MM/DD layout.
      const level = depth + 1;
      if (prunePathDate && level >= 1 && level <= 3 && /^\d+$/.test(entry)) {
        const n = Number.parseInt(entry, 10);
        if (level === 1 && n < startYear) continue;
        if (level === 2 && pathYear(dir) <= startYear && n < startMonth) continue;
        if (level === 3 && pathYearMonth(dir) <= startYear * 12 + startMonth && n < startDay) continue;
      }
      let isDir = false;
      let fresh = true;
      try {
        isDir = isDirectory(full);
        fresh = mtimeMs(full) >= periodStart.getTime();
      } catch {
        continue;
      }
      if (isDir) walk(full, level);
      else if (fresh && entry.endsWith(".jsonl")) files.push(full);
    }
  };
  walk(root, 0);
  return { files, unreadable: false };
}

/** sessions/<year>/... -> year; sessions/<year>/<month>/... -> year*12+month
 * (numeric segments only; anything else prunes nothing). */
function pathYear(dir: string): number {
  const segments = dir.split(/[\\/]/).filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i--) {
    if (/^\d{4}$/.test(segments[i]!)) return Number.parseInt(segments[i]!, 10);
  }
  return Number.MAX_SAFE_INTEGER;
}

function pathYearMonth(dir: string): number {
  const segments = dir.split(/[\\/]/).filter(Boolean);
  let year: number | undefined;
  let month: number | undefined;
  for (let i = segments.length - 1; i >= 0; i--) {
    if (month === undefined && /^\d{1,2}$/.test(segments[i]!)) month = Number.parseInt(segments[i]!, 10);
    else if (/^\d{4}$/.test(segments[i]!)) {
      year = Number.parseInt(segments[i]!, 10);
      break;
    }
  }
  return year !== undefined && month !== undefined ? year * 12 + month : Number.MAX_SAFE_INTEGER;
}

/** codex rollout JSONL: `token_count` event_msg lines carry
 * `payload.info.last_token_usage` — the DELTA for that event, with
 * input_tokens covering cached subsets (codex's own total is
 * input + output, so cached_input_tokens and cache_write_input_tokens are
 * PARTITIONS of input_tokens, not additions). The active model arrives via
 * `turn_context` lines (payload.model) — token_count lines carry no model —
 * so the reader tracks the most recent turn_context model and applies it to
 * subsequent token_count events. The per-line logic lives in a stateful
 * scanner (shared verbatim by the whole-text reader below and the async
 * chunked reader, so both paths produce identical records); this whole-text
 * entry point is the historical/tested surface. Exported for tests. */
export function recordsFromCodexRollout(text: string): UsageRecord[] {
  const scanner = codexRolloutScanner();
  for (const line of text.split("\n")) scanner.push(line);
  return scanner.records;
}

/** One line of codex rollout fed in isolation, carrying the reader's
 * running state (the most recent turn_context model). `push` must be
 * called once per "\n"-separated line, in order, INCLUDING a final empty
 * string for newline-terminated text (a no-op, matching split("\n")). */
interface LineScanner {
  push(line: string): void;
  readonly records: UsageRecord[];
}

function codexRolloutScanner(): LineScanner {
  const records: UsageRecord[] = [];
  let model = "unknown";
  return {
    records,
    push(line: string): void {
      if (!line.includes("token_count") && !line.includes("turn_context")) return;
      let parsed: {
        timestamp?: string;
        type?: string;
        payload?: {
          type?: string;
          model?: string;
          info?: {
            last_token_usage?: {
              input_tokens?: number;
              cached_input_tokens?: number;
              cache_write_input_tokens?: number;
              output_tokens?: number;
            };
          };
        };
      };
      try {
        parsed = JSON.parse(line);
      } catch {
        return; // a torn/truncated trailing line must not sink the estimate
      }
      if (parsed.type === "turn_context" && typeof parsed.payload?.model === "string") {
        model = parsed.payload.model;
        return;
      }
      if (parsed.type !== "event_msg" || parsed.payload?.type !== "token_count") return;
      const usage = parsed.payload.info?.last_token_usage;
      if (!usage) return;
      const input = usage.input_tokens ?? 0;
      const cached = Math.min(usage.cached_input_tokens ?? 0, input);
      const cacheWrite = Math.min(usage.cache_write_input_tokens ?? 0, input - cached);
      records.push({
        model,
        input: Math.max(0, input - cached - cacheWrite),
        output: usage.output_tokens ?? 0,
        cacheRead: cached,
        cacheWrite,
        atMs: parseTimestamp(parsed.timestamp),
      });
    },
  };
}

/** claude projects JSONL: assistant lines carry `message.usage` with
 * input_tokens (UNCACHED new input here — claude's fields are independent,
 * not subsets), cache_creation_input_tokens (writes) and
 * cache_read_input_tokens (reads). Exported for tests. */
export function recordsFromClaudeProjectLog(text: string): UsageRecord[] {
  const scanner = claudeProjectScanner();
  for (const line of text.split("\n")) scanner.push(line);
  return scanner.records;
}

function claudeProjectScanner(): LineScanner {
  const records: UsageRecord[] = [];
  return {
    records,
    push(line: string): void {
      if (!line.includes('"usage"')) return;
      let parsed: {
        timestamp?: string;
        message?: {
          model?: string;
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_creation_input_tokens?: number;
            cache_read_input_tokens?: number;
          };
        };
      };
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }
      const usage = parsed.message?.usage;
      if (!usage) return;
      records.push({
        model: parsed.message?.model ?? "unknown",
        input: usage.input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
        cacheRead: usage.cache_read_input_tokens ?? 0,
        cacheWrite: usage.cache_creation_input_tokens ?? 0,
        atMs: parseTimestamp(parsed.timestamp),
      });
    },
  };
}

function parseTimestamp(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : undefined;
}

const SCANNERS: Partial<Record<ToolConfig["toolName"], () => LineScanner>> = {
  codex: codexRolloutScanner,
  claude: claudeProjectScanner,
};

const SESSION_ROOTS: Partial<Record<ToolConfig["toolName"], string>> = {
  codex: "sessions",
  claude: "projects",
};

/** The period filter shared by both read paths: records with no parsable
 * timestamp COUNT (an under-count defeats the guard), timestamped ones must
 * fall inside the period. Order-preserving, so both paths yield records in
 * the same file/file-line order. */
function filterPeriod(records: UsageRecord[], periodStartMs: number): UsageRecord[] {
  return records.filter((r) => r.atMs === undefined || r.atMs >= periodStartMs);
}

/** The zero-contribution result shapes shared by both read paths. */
function emptyRead(notes: string[]): LocalSpendRead {
  return {
    usd: 0,
    unknownModelUsd: 0,
    filesRead: 0,
    notes,
    messages: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    models: [],
    dailyTokens: {},
  };
}

/**
 * Reads one identity's local Bedrock usage over the period starting at
 * `periodStart` (month-to-date for a MONTHLY budget, and so on): the same
 * records, filters and valuation the guard's estimate uses, plus the token
 * totals and breakdowns the usage report renders. Records with no parsable
 * timestamp are counted (see UsageRecord.atMs); records timestamped BEFORE
 * the period are skipped, so a session file spanning the period boundary
 * contributes only its in-period deltas. Returns 0 with a note (not an
 * error) for tools with no reader and for identities with no session data:
 * "nothing logged this period" is a normal offline state, never a failure.
 */
export function readIdentityLocalSpend(
  toolName: ToolConfig["toolName"],
  configDir: string,
  periodStart: Date,
  deps: LocalEstimateDeps = {},
): LocalSpendRead {
  const scanner = SCANNERS[toolName];
  const rootName = SESSION_ROOTS[toolName];
  if (!scanner || !rootName) {
    return emptyRead([`no local session reader for tool "${toolName}"`]);
  }
  const { files, unreadable } = listRecentFiles(join(configDir, rootName), periodStart, deps, toolName === "codex");
  if (unreadable) {
    return emptyRead([]);
  }

  const readText = deps.readText ?? defaultReadText;
  const periodStartMs = periodStart.getTime();
  const records: UsageRecord[] = [];
  for (const file of files) {
    try {
      const lineScanner = scanner();
      for (const line of readText(file).split("\n")) lineScanner.push(line);
      records.push(...filterPeriod(lineScanner.records, periodStartMs));
    } catch {
      // A file that vanished or became unreadable mid-read still leaves the
      // rest of the estimate intact.
    }
  }
  return reduceLocalSpendRead(records, files.length);
}

/** Per-model and per-day rollups shared verbatim by the sync and async read
 * paths (so their outputs are byte-identical by construction): the dollar
 * total stays the record-order sum, identical to the guard's own
 * accumulation, and the models/dailyTokens/dateSpan rollups feed the usage
 * report's entries, token columns, contribution graph and date span. */
function reduceLocalSpendRead(records: UsageRecord[], filesRead: number): LocalSpendRead {
  const valued = valueRecords(records);

  const models = new Map<string, LocalSpendModelTotals>();
  const dailyTokens: Record<string, number> = {};
  let firstMs: number | undefined;
  let lastMs: number | undefined;
  let messages = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  for (const r of records) {
    messages += 1;
    input += r.input;
    output += r.output;
    cacheRead += r.cacheRead;
    cacheWrite += r.cacheWrite;
    let bucket = models.get(r.model);
    if (!bucket) models.set(r.model, (bucket = { model: r.model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messageCount: 0, usd: 0 }));
    bucket.input += r.input;
    bucket.output += r.output;
    bucket.cacheRead += r.cacheRead;
    bucket.cacheWrite += r.cacheWrite;
    bucket.messageCount += 1;
    const priced = estimateBedrockTokenCost(r.model, r.input, r.output, r.cacheRead, r.cacheWrite);
    if (priced !== undefined) {
      bucket.usd += priced;
    } else {
      const fallback = unknownBedrockModelFallbackPrice();
      bucket.usd +=
        (r.input * fallback.usdPer1mInput +
          r.output * fallback.usdPer1mOutput +
          r.cacheRead * fallback.usdPer1mCacheRead +
          r.cacheWrite * fallback.usdPer1mCacheWrite) /
        1_000_000;
    }
    if (r.atMs !== undefined) {
      const day = localDateKey(r.atMs);
      dailyTokens[day] = (dailyTokens[day] ?? 0) + r.input + r.output;
      firstMs = firstMs === undefined ? r.atMs : Math.min(firstMs, r.atMs);
      lastMs = lastMs === undefined ? r.atMs : Math.max(lastMs, r.atMs);
    }
  }

  return {
    usd: valued.usd,
    unknownModelUsd: valued.unknownModelUsd,
    filesRead,
    notes: [],
    messages,
    input,
    output,
    cacheRead,
    cacheWrite,
    models: [...models.values()],
    dailyTokens,
    ...(firstMs !== undefined && lastMs !== undefined ? { firstMs, lastMs } : {}),
  };
}

/** Injectable fs layer for the async read path (tests). `readTextChunks`
 * yields the file's text in arbitrary chunks; chunk boundaries may split
 * multi-byte characters and lines freely, exactly like a real byte stream. */
export interface AsyncLocalEstimateDeps {
  readdir?: (path: string) => Promise<string[]>;
  mtimeMs?: (path: string) => Promise<number>;
  isDirectory?: (path: string) => Promise<boolean>;
  readTextChunks?: (path: string) => AsyncIterable<string>;
}

function defaultReaddirAsync(path: string): Promise<string[]> {
  return readdirAsync(path);
}

function defaultMtimeMsAsync(path: string): Promise<number> {
  return statAsync(path).then((s) => s.mtimeMs);
}

function defaultIsDirectoryAsync(path: string): Promise<boolean> {
  return statAsync(path).then((s) => s.isDirectory());
}

/** Async counterpart of listRecentFiles: same recursive listing, same path
 * date and mtime pruning, same file order (readdir order), just off the
 * event loop. Exported for tests. */
export async function listRecentFilesAsync(
  root: string,
  periodStart: Date,
  deps: AsyncLocalEstimateDeps = {},
  prunePathDate: boolean,
): Promise<{ files: string[]; unreadable: boolean }> {
  const readdir = deps.readdir ?? defaultReaddirAsync;
  const mtimeMs = deps.mtimeMs ?? defaultMtimeMsAsync;
  const isDirectory = deps.isDirectory ?? defaultIsDirectoryAsync;
  try {
    await readdir(root);
  } catch {
    return { files: [], unreadable: true };
  }

  const startYear = periodStart.getFullYear();
  const startMonth = periodStart.getMonth() + 1;
  const startDay = periodStart.getDate();
  const files: string[] = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      // `depth` is the parent's level, so year/month/day entries sit at
      // depth+1 = 1/2/3 under the codex sessions/YYYY/MM/DD layout.
      const level = depth + 1;
      if (prunePathDate && level >= 1 && level <= 3 && /^\d+$/.test(entry)) {
        const n = Number.parseInt(entry, 10);
        if (level === 1 && n < startYear) continue;
        if (level === 2 && pathYear(dir) <= startYear && n < startMonth) continue;
        if (level === 3 && pathYearMonth(dir) <= startYear * 12 + startMonth && n < startDay) continue;
      }
      let isDir = false;
      let fresh = true;
      try {
        isDir = await isDirectory(full);
        fresh = (await mtimeMs(full)) >= periodStart.getTime();
      } catch {
        continue;
      }
      if (isDir) await walk(full, level);
      else if (fresh && entry.endsWith(".jsonl")) files.push(full);
    }
  };
  await walk(root, 0);
  return { files, unreadable: false };
}

/** Upper bound on decoded text handed to the scanners per await: Bun's file
 * stream can deliver multi-megabyte buffers (or coalesce them), and a
 * whole-file chunk would turn the line scan back into one long synchronous
 * job. 256KiB of text scans in single-digit milliseconds, keeping every
 * event-loop visit short. */
const FILE_TEXT_PIECE_UNITS = 1 << 18;

/** Streams one file's text as bounded pieces WITHOUT ever holding the whole
 * file (or blocking the event loop on one giant read): Bun's file stream
 * performs async reads while a streaming TextDecoder bridges chunk
 * boundaries inside multi-byte characters; large buffers are re-split into
 * FILE_TEXT_PIECE_UNITS-sized pieces. The trailing decode() flush mirrors
 * readFileSync's replacement of a truncated final character. Exported so
 * tests can pin the chunked (never whole-file) reading. */
export async function* fileTextChunks(path: string): AsyncIterable<string> {
  const decoder = new TextDecoder();
  for await (const blob of Bun.file(path).stream()) {
    const text = decoder.decode(blob, { stream: true });
    for (let i = 0; i < text.length; i += FILE_TEXT_PIECE_UNITS) {
      yield text.slice(i, i + FILE_TEXT_PIECE_UNITS);
    }
  }
  const tail = decoder.decode();
  if (tail) yield tail;
}

/** Chunks -> whole lines, verbatim: every complete "\n"-terminated line is
 * pushed in order, and the remainder after the final newline is pushed too
 * (the empty string for newline-terminated text), exactly the line
 * sequence text.split("\n") produces, so the scanners see identical input
 * whichever read path ran. */
async function collectRecordsFromChunks(
  path: string,
  scanner: () => LineScanner,
  readTextChunks: (path: string) => AsyncIterable<string>,
): Promise<UsageRecord[]> {
  const lineScanner = scanner();
  let rest = "";
  for await (const chunk of readTextChunks(path)) {
    rest += chunk;
    let newlineAt = rest.indexOf("\n");
    while (newlineAt !== -1) {
      lineScanner.push(rest.slice(0, newlineAt));
      rest = rest.slice(newlineAt + 1);
      newlineAt = rest.indexOf("\n");
    }
    // Real macrotask boundary between pieces: awaiting the stream alone
    // turned out to run whole-file stretches inside microtasks (measured
    // 2026-09-12: a 1ms timer fired ZERO times during a 3.2s Bun-stream
    // read of ~1.1GB), so the live render still starved. Bun.sleep(0) is
    // the same yield the opencode.db reader uses every 500 rows.
    await Bun.sleep(0);
  }
  lineScanner.push(rest);
  return lineScanner.records;
}

/**
 * Async twin of readIdentityLocalSpend: same records, same filters, same
 * valuation and rollups (the reduction is shared verbatim), but every file
 * is read in CHUNKS off the event loop instead of one blocking readFileSync.
 * This is the path the usage pipeline fans out with: a multi-gigabyte
 * month-to-date log set must never stop the live render or the other
 * concurrent fetchers, which is exactly what the sync path did (a ~1 GB
 * month-to-date scan froze the loop for ~4-6 seconds per Bedrock identity,
 * measured 2026-09-12).
 */
export async function readIdentityLocalSpendAsync(
  toolName: ToolConfig["toolName"],
  configDir: string,
  periodStart: Date,
  deps: AsyncLocalEstimateDeps = {},
): Promise<LocalSpendRead> {
  const scanner = SCANNERS[toolName];
  const rootName = SESSION_ROOTS[toolName];
  if (!scanner || !rootName) {
    return emptyRead([`no local session reader for tool "${toolName}"`]);
  }
  const { files, unreadable } = await listRecentFilesAsync(join(configDir, rootName), periodStart, deps, toolName === "codex");
  if (unreadable) {
    return emptyRead([]);
  }

  const readTextChunks = deps.readTextChunks ?? fileTextChunks;
  const periodStartMs = periodStart.getTime();
  const records: UsageRecord[] = [];
  for (const file of files) {
    try {
      records.push(...filterPeriod(await collectRecordsFromChunks(file, scanner, readTextChunks), periodStartMs));
    } catch {
      // A file that vanished or became unreadable mid-read still leaves the
      // rest of the estimate intact.
    }
  }
  return reduceLocalSpendRead(records, files.length);
}

/** The guard's estimate: the same read, reduced to the four fields the
 * enforcement decision consumes. Kept as its own named export so the
 * guard's contract (and tests) are untouched by the usage side's needs. */
export function estimateIdentityLocalSpend(
  toolName: ToolConfig["toolName"],
  configDir: string,
  periodStart: Date,
  deps: LocalEstimateDeps = {},
): LocalSpendResult {
  const read = readIdentityLocalSpend(toolName, configDir, periodStart, deps);
  return { usd: read.usd, unknownModelUsd: read.unknownModelUsd, filesRead: read.filesRead, notes: read.notes };
}
