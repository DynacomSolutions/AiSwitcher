import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ToolConfig } from "../identities/types.ts";
import { estimateBedrockTokenCost, unknownBedrockModelFallbackPrice } from "../identities/model-pricing.ts";

/**
 * The spend guard's PRIMARY signal: a fast, fully-offline, token-based cost
 * estimate for one identity over a budget period, computed DIRECTLY from the
 * same local session logs the usage pipeline reads — never by spawning
 * tokscale. Measured on this machine (2026-09-10): a warm tokscale spawn
 * costs ~2.4s for one codex identity (and its default report has no date
 * filter at all, so it cannot produce month-to-date), while the direct
 * readers here walk only period-recent files and finish well under the
 * launch gate's 1.5s ceiling. tokscale remains the right engine for the
 * interactive `ais usage` report; it is simply the wrong shape for a gate.
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
 * subsequent token_count events. Exported for tests. */
export function recordsFromCodexRollout(text: string): UsageRecord[] {
  const records: UsageRecord[] = [];
  let model = "unknown";
  for (const line of text.split("\n")) {
    if (!line.includes("token_count") && !line.includes("turn_context")) continue;
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
      continue; // a torn/truncated trailing line must not sink the estimate
    }
    if (parsed.type === "turn_context" && typeof parsed.payload?.model === "string") {
      model = parsed.payload.model;
      continue;
    }
    if (parsed.type !== "event_msg" || parsed.payload?.type !== "token_count") continue;
    const usage = parsed.payload.info?.last_token_usage;
    if (!usage) continue;
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
  }
  return records;
}

/** claude projects JSONL: assistant lines carry `message.usage` with
 * input_tokens (UNCACHED new input here — claude's fields are independent,
 * not subsets), cache_creation_input_tokens (writes) and
 * cache_read_input_tokens (reads). Exported for tests. */
export function recordsFromClaudeProjectLog(text: string): UsageRecord[] {
  const records: UsageRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes('"usage"')) continue;
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
      continue;
    }
    const usage = parsed.message?.usage;
    if (!usage) continue;
    records.push({
      model: parsed.message?.model ?? "unknown",
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
      atMs: parseTimestamp(parsed.timestamp),
    });
  }
  return records;
}

function parseTimestamp(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : undefined;
}

const READERS: Partial<Record<ToolConfig["toolName"], (text: string) => UsageRecord[]>> = {
  codex: recordsFromCodexRollout,
  claude: recordsFromClaudeProjectLog,
};

const SESSION_ROOTS: Partial<Record<ToolConfig["toolName"], string>> = {
  codex: "sessions",
  claude: "projects",
};

/**
 * Estimates one identity's Bedrock-priced local spend over the period
 * starting at `periodStart` (the budget's own current period — month-to-date
 * for a MONTHLY budget, and so on). Records with no parsable timestamp are
 * counted (see UsageRecord.atMs); records timestamped BEFORE the period are
 * skipped, so a session file spanning the period boundary contributes only
 * its in-period deltas. Returns 0 with a note (not an error) for tools with
 * no reader and for identities with no session data: "nothing logged this
 * period" is a normal offline state, never a failure.
 */
export function estimateIdentityLocalSpend(
  toolName: ToolConfig["toolName"],
  configDir: string,
  periodStart: Date,
  deps: LocalEstimateDeps = {},
): LocalSpendResult {
  const reader = READERS[toolName];
  const rootName = SESSION_ROOTS[toolName];
  if (!reader || !rootName) {
    return { usd: 0, unknownModelUsd: 0, filesRead: 0, notes: [`no local session reader for tool "${toolName}"`] };
  }
  const { files, unreadable } = listRecentFiles(join(configDir, rootName), periodStart, deps, toolName === "codex");
  if (unreadable) return { usd: 0, unknownModelUsd: 0, filesRead: 0, notes: [] };

  const readText = deps.readText ?? defaultReadText;
  const periodStartMs = periodStart.getTime();
  const records: UsageRecord[] = [];
  for (const file of files) {
    try {
      records.push(...reader(readText(file)).filter((r) => r.atMs === undefined || r.atMs >= periodStartMs));
    } catch {
      // A file that vanished or became unreadable mid-read still leaves the
      // rest of the estimate intact.
    }
  }
  const valued = valueRecords(records);
  return { usd: valued.usd, unknownModelUsd: valued.unknownModelUsd, filesRead: files.length, notes: [] };
}
