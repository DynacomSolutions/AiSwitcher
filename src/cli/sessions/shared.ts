import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileTextChunks } from "../../shared/local-spend.ts";
import { REPRODUCIBLE_JUNK_DIR_NAMES } from "../../shared/reproducible-paths.ts";

/**
 * Shared plumbing behind the per-tool session-tree/transcript readers
 * (sessions/claude.ts, codex.ts, ...): window maths, the in-progress
 * cutoff, streaming line iteration with real event-loop yields (the #63
 * lesson: never sync-read big JSONL on a hot path) and bounded text
 * clamping for the normalized turns.
 */

export const DEFAULT_TREE_DAYS = 30;
/** mtime within this window => the session is probably still live. */
export const IN_PROGRESS_WINDOW_MS = 60_000;
/** Default/cap for tail-weighted transcript reads. */
export const DEFAULT_TAIL_TURNS = 500;
export const MAX_TAIL_TURNS = 2_000;

export interface WindowOpts {
  /** Scan-time override (tests). Defaults to Date.now(). */
  now?: number;
  /** Lookback window in days; mtime (or the tool's own updated_at) older
   * than the window drops the session from the tree. Default 30. */
  days?: number;
}

export interface TranscriptOpts {
  now?: number;
  /** Maximum turns returned, tail-weighted (newest kept). Default and cap
   * handled by the transcript dispatcher (DEFAULT_TAIL_TURNS / MAX_TAIL). */
  tail?: number;
}

export function windowCutoffMs(opts: WindowOpts = {}): number {
  const now = opts.now ?? Date.now();
  const days = opts.days ?? DEFAULT_TREE_DAYS;
  return now - Math.max(1, days) * 86_400_000;
}

export function isInProgress(mtimeMs: number, opts: WindowOpts = {}): boolean {
  return (opts.now ?? Date.now()) - mtimeMs < IN_PROGRESS_WINDOW_MS;
}

export const TURN_TEXT_MAX_CHARS = 2_000;
export const TURN_ARGS_MAX_CHARS = 400;

/** Collapses a turn's text to the wire cap. Never throws on weird input. */
export function clampText(text: string, max = TURN_TEXT_MAX_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

/** One line of `text` per array element, JSON-serialised and clamped: the
 * argsPreview shape every role=tool turn carries. */
export function argsPreviewFrom(args: unknown): string {
  let serialised: string;
  try {
    serialised = typeof args === "string" ? args : JSON.stringify(args) ?? "";
  } catch {
    serialised = String(args);
  }
  return clampText(serialised, TURN_ARGS_MAX_CHARS);
}

/**
 * Streams a text file LINE BY LINE without ever holding the whole file in
 * memory: fileTextChunks (shared with the usage pipeline) yields bounded
 * decoded pieces with a real macrotask yield between them, and this folds
 * those into complete "\n"-separated lines. `visit` runs once per line in
 * file order. A final partial line (no trailing newline, torn write) is
 * still visited.
 */
export async function forEachLine(path: string, visit: (line: string) => void): Promise<void> {
  let rest = "";
  for await (const chunk of fileTextChunks(path)) {
    rest += chunk;
    let newlineAt = rest.indexOf("\n");
    while (newlineAt !== -1) {
      visit(rest.slice(0, newlineAt));
      rest = rest.slice(newlineAt + 1);
      newlineAt = rest.indexOf("\n");
    }
    // Real macrotask boundary (see fileTextChunks/collectRecordsFromChunks:
    // awaiting the stream alone runs whole-file stretches inside microtasks).
    await Bun.sleep(0);
  }
  if (rest) visit(rest);
}

/**
 * Bounded prefix read: streams lines until `predicate` matches and returns
 * THAT line (or undefined when nothing matches / the file is unreadable).
 * This is the cheap title/header peek every tool's tree scan uses — the
 * match is nearly always within the first few lines, so the rest of a
 * multi-megabyte transcript is never touched.
 */
export async function findFirstLine(
  path: string,
  predicate: (line: string) => boolean,
): Promise<string | undefined> {
  let rest = "";
  for await (const chunk of fileTextChunks(path)) {
    rest += chunk;
    let newlineAt = rest.indexOf("\n");
    while (newlineAt !== -1) {
      const line = rest.slice(0, newlineAt);
      if (predicate(line)) return line;
      rest = rest.slice(newlineAt + 1);
      newlineAt = rest.indexOf("\n");
    }
    await Bun.sleep(0);
  }
  return rest.trim() && predicate(rest) ? rest : undefined;
}

/** First line only, releasing the stream afterwards (session_meta peek).
 * Returns undefined on any read failure, matching codex-resume.ts. */
export async function readFirstLine(path: string): Promise<string | undefined> {
  const reader = Bun.file(path).stream().getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: true });
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex >= 0) return buffer.slice(0, newlineIndex);
      }
      if (done) return buffer.trim() ? buffer : undefined;
    }
  } catch {
    return undefined;
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Best-effort: nothing to do if the underlying resource is already gone.
    }
  }
}

const JUNK_DIR_NAMES = new Set(REPRODUCIBLE_JUNK_DIR_NAMES.map((name) => name.replace(/\/$/, "")));

/**
 * Lists a directory's subdirectory names, pruning the shared reproducible
 * junk-dir conventions (caches, logs, shell snapshots, ...) so tree walks
 * never descend into regenerated payload directories. Non-existent root is
 * an empty result (the common "identity never used this tool" case), not
 * an error.
 */
export async function listSubdirs(dir: string): Promise<string[]> {
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return dirents
    .filter((e) => e.isDirectory() && !JUNK_DIR_NAMES.has(e.name))
    .map((e) => e.name);
}

/** Depth-first walk of `root` collecting .jsonl files, pruning junk dirs,
 * bounded depth headroom like codex-resume's MAX_WALK_DEPTH. */
export async function walkJsonlFiles(root: string, maxDepth = 6): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (JUNK_DIR_NAMES.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
    }
  }
  await walk(root, 0);
  return out;
}

export function safeJsonParse(line: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function parseTimestampMs(raw: unknown): number | undefined {
  if (typeof raw !== "string" && typeof raw !== "number") return undefined;
  const ms = typeof raw === "number" ? raw : Date.parse(raw);
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/** Bounded-concurrency map over a list (tree scans fan out small per-file
 * reads; unbounded Promise.all over thousands of files would stampede the
 * filesystem). Results keep input order; a rejected item rejects the whole
 * map like Promise.all would. */
export async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export function isoOrEpoch(ms: number | undefined): string {
  return ms !== undefined ? new Date(ms).toISOString() : new Date(0).toISOString();
}

/** Extracts the first-string text out of the block-array content shapes
 * every tool uses (claude/pi/kimi/grok user content). */
export function textFromBlocks(blocks: unknown, blockTextKey = "text"): string | undefined {
  if (!Array.isArray(blocks)) return undefined;
  const parts: string[] = [];
  for (const block of blocks) {
    if (block && typeof block === "object") {
      const text = (block as Record<string, unknown>)[blockTextKey];
      if (typeof text === "string" && text.trim()) parts.push(text);
    }
  }
  return parts.length ? parts.join("\n") : undefined;
}
