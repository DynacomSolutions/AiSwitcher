import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { SwapEvent } from "../../identities/pool/adapter.ts";
import { activeMemberAt, eventsForPool, readSwapEvents } from "../../identities/pool/ledger.ts";
import "../../identities/model-price-source.ts";
import { estimateChatModelTokenCost } from "../../identities/model-pricing.ts";
import type { PoolIdentity } from "../../identities/pool/swap-pool.ts";
import type { Identity } from "../../identities/types.ts";
import { localDateKey } from "../usage/local-day.ts";
import { addDailyTotals, type DailyTotals, type TokscaleEntry } from "../usage/tokscale.ts";
import { aisCacheDir } from "../../shared/ais-home.ts";

/**
 * Per-member split of a swap pool's transcript usage. A pool shares one
 * projects/ folder, so the usual attribution-by-configDir sees only the
 * pool. Each assistant message is attributed to the member that was active
 * at its timestamp according to the claude-swap ledger. Messages before the
 * first ledger event are "(before first swap)". Approximate by design: all
 * sessions of a pool share one active member at any instant.
 */

export interface MemberSplitRow {
  member: string;
  messages: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface PoolUsageSplit {
  pool: string;
  days: number;
  members: MemberSplitRow[];
}

async function* jsonlFiles(dir: string, sinceMs: number): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* jsonlFiles(path, sinceMs);
    else if (entry.name.endsWith(".jsonl")) {
      try {
        if ((await stat(path)).mtimeMs >= sinceMs) yield path;
      } catch {
        // vanished
      }
    }
  }
}

export function attributeLine(
  line: string,
  events: SwapEvent[],
  pool: string,
  sinceMs: number,
): { member: string; at: number; model?: string; id?: string; usage: Omit<MemberSplitRow, "member" | "messages"> } | undefined {
  if (!line.includes('"usage"')) return undefined;
  let parsed: { timestamp?: string; message?: { id?: string; model?: string; usage?: Record<string, number | undefined> } };
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  const usage = parsed.message?.usage;
  const at = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : NaN;
  if (!usage || !Number.isFinite(at) || at < sinceMs) return undefined;
  return {
    member: activeMemberAt(events, pool, at) ?? "(before first swap)",
    at,
    ...(parsed.message?.model ? { model: parsed.message.model } : {}),
    ...(parsed.message?.id ? { id: parsed.message.id } : {}),
    usage: {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
    },
  };
}

type Hit = NonNullable<ReturnType<typeof attributeLine>>;

/** Codex rollouts: `token_count` event_msg lines carry the per-request delta in
 * `payload.info.last_token_usage` (cached/cache-write are subsets of
 * input_tokens, as in shared/local-spend.ts); the model arrives on
 * `turn_context` lines. Stateful per file: build one reader per rollout. */
export function codexLineReader(events: SwapEvent[], pool: string, sinceMs: number): (line: string) => Hit | undefined {
  let model: string | undefined;
  return (line) => {
    if (!line.includes("token_count") && !line.includes("turn_context")) return undefined;
    let parsed: { timestamp?: string; type?: string; payload?: { type?: string; model?: string; info?: { last_token_usage?: Record<string, number | undefined> } } };
    try {
      parsed = JSON.parse(line);
    } catch {
      return undefined;
    }
    if (parsed.type === "turn_context" && typeof parsed.payload?.model === "string") {
      model = parsed.payload.model;
      return undefined;
    }
    const usage = parsed.payload?.info?.last_token_usage;
    const at = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : NaN;
    if (parsed.type !== "event_msg" || parsed.payload?.type !== "token_count" || !usage || !Number.isFinite(at) || at < sinceMs) return undefined;
    const input = usage.input_tokens ?? 0;
    const cacheRead = Math.min(usage.cached_input_tokens ?? 0, input);
    const cacheWrite = Math.min(usage.cache_write_input_tokens ?? 0, input - cacheRead);
    return {
      member: activeMemberAt(events, pool, at) ?? "(before first swap)",
      at,
      ...(model ? { model } : {}),
      usage: { input: input - cacheRead - cacheWrite, output: usage.output_tokens ?? 0, cacheRead, cacheWrite },
    };
  };
}

/** Where a tool keeps the usage logs of a pool folder, and how to read a line. */
const usageSources = {
  claude: { dir: "projects", reader: (events: SwapEvent[], pool: string, sinceMs: number) => (line: string) => attributeLine(line, events, pool, sinceMs) },
  codex: { dir: "sessions", reader: codexLineReader },
} as const;

export async function poolMemberUsageSplit(pool: PoolIdentity, options: { days: number; ledgerPath: string; now?: number; tool?: keyof typeof usageSources }): Promise<PoolUsageSplit> {
  const source = usageSources[options.tool ?? "claude"];
  const events = eventsForPool(await readSwapEvents(options.ledgerPath), pool);
  const sinceMs = (options.now ?? Date.now()) - options.days * 86_400_000;
  const rows = new Map<string, MemberSplitRow>();
  // Transcripts repeat streaming copies of a message; count each id once, as poolMemberModelUsage does.
  const seen = new Set<string>();
  for await (const file of jsonlFiles(join(pool.configDir, source.dir), sinceMs)) {
    const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
    const read = source.reader(events, pool.name, sinceMs);
    for await (const line of rl) {
      const hit = read(line);
      if (!hit) continue;
      if (hit.id) {
        if (seen.has(hit.id)) continue;
        seen.add(hit.id);
      }
      const row = rows.get(hit.member) ?? { member: hit.member, messages: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      row.messages += 1;
      row.input += hit.usage.input;
      row.output += hit.usage.output;
      row.cacheRead += hit.usage.cacheRead;
      row.cacheWrite += hit.usage.cacheWrite;
      rows.set(hit.member, row);
    }
  }
  return { pool: pool.name, days: options.days, members: [...rows.values()].sort((a, b) => b.output - a.output) };
}

export interface PoolMemberUsage {
  /** Registry member name, or undefined when the share cannot be attributed. */
  member: string | undefined;
  entries: TokscaleEntry[];
  firstMs: number;
  lastMs: number;
  dailyUsage: Record<string, number>;
  /** Per model, per day, with list-price cost estimates; callers rescale cost to the figure they report. */
  dailyByModel: Record<string, DailyTotals>;
}

/** Counts per member over the last RECENT_USAGE_DAYS: what `usage --json` serves, scan or snapshot. */
export type RecentMemberSplit = Array<{ member: string; messages: number; input: number; output: number }>;

export const RECENT_USAGE_DAYS = 30;

// A tuple keeps the durable cache substantially smaller than the source JSONL
// rows and avoids storing member attribution or derived pricing.
type CachedUsageHit = [at: number, model: string | null, id: string | null, input: number, output: number, cacheRead: number, cacheWrite: number];

/**
 * One transcript's entry in the attribution cache (schema 2).
 *
 * Transcripts are append-only JSONL and attribution is a pure function of
 * each line, so the hits of `prefix + appended` are the hits of the prefix
 * followed by the hits of the appended bytes. A grown file is therefore read
 * only from `offset` (just past the last newline already parsed) and its new
 * hits are appended to the per-file hits log; a cold scan of the same bytes
 * produces exactly the same hits in the same order.
 *
 * Resume safety is a sampled check, not a full prefix hash: the same device
 * and inode, a size larger than the stored stat and no smaller than `offset`
 * (which can lie past that stat when the file grew during the last read), and
 * SHA-256 digests of the first 4 KiB and of the 64 KiB before `offset`.
 * Re-hashing the whole prefix would re-read multi-GB live transcripts every
 * cycle, which is what this cache exists to avoid. The trade-off: an in-place
 * rewrite that keeps the inode, also grows the file, and leaves both sampled
 * windows intact while changing bytes between them is not detected. Claude Code only ever
 * appends to a session transcript (a rewrite replaces the file or changes its
 * tail), and any other change (a new inode, a truncation, a same-size
 * rewrite, a sample mismatch) falls back to a full re-parse.
 */
interface CachedUsageFile {
  key: string;
  /** dev:ino:size:mtimeNs:ctimeNs when the file was last read. */
  fingerprint: string;
  /** Bytes read so far, up to and including the last newline. */
  offset: number;
  head: string;
  tail: string;
  /** Hits of an unterminated last line; re-read with the next append. */
  pending: CachedUsageHit[];
  /** Hits log under the cache's `.d` directory and its committed length. */
  hitsFile: string;
  hitsBytes: number;
}
interface PoolUsageCache {
  schemaVersion: 2;
  files: CachedUsageFile[];
}
/** The schema-1 cache: one JSON document holding every file's hits. Read once to migrate. */
interface LegacyPoolUsageCache {
  schemaVersion: 1;
  files: Array<{ key: string; fingerprint: string; hits: CachedUsageHit[] }>;
}

/** Test hooks for proving unchanged transcript files are not reopened. */
export interface PoolMemberModelUsageOptions {
  /** The cache index; per-file hits logs live in `${cachePath}.d/`. */
  cachePath?: string;
  /** A schema-1 cache to migrate from when the index is missing. */
  legacyCachePath?: string;
  now?: number;
  /** Receives the recent per-member split, built with the same counting as `poolMemberUsageSplit`. */
  onRecentSplit?: (split: RecentMemberSplit) => void;
  /** Called before a transcript is read, with the byte offset the read starts at (0 for a full parse). */
  onSourceFileRead?: (path: string, offset: number) => void;
  /** Injectable discovery hooks for deterministic race/error tests. */
  readdir?: (path: string) => Promise<Array<{ name: string; isDirectory(): boolean }>>;
  fingerprint?: (path: string) => Promise<string | undefined>;
  writeCache?: (path: string, cache: PoolUsageCache) => Promise<void>;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function poolUsageCacheKey(pool: PoolIdentity): string {
  return createHash("sha256").update(`ais-pool-usage-cache-v1\0${pool.name}\0${pool.configDir}`).digest("hex");
}

function defaultPoolUsageCachePath(pool: PoolIdentity): string {
  return join(aisCacheDir(), "usage", "pool-attribution", `${poolUsageCacheKey(pool)}.v2.json`);
}

function defaultLegacyPoolUsageCachePath(pool: PoolIdentity): string {
  return join(aisCacheDir(), "usage", "pool-attribution", `${poolUsageCacheKey(pool)}.json`);
}

async function sourceFingerprint(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path, { bigint: true });
    return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String).join(":");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
}

/** dev, inode and size out of a fingerprint; undefined for a malformed one. */
function fingerprintParts(fingerprint: string): { file: string; size: number } | undefined {
  const parts = fingerprint.split(":");
  if (parts.length !== 5) return undefined;
  const size = Number(parts[2]);
  return Number.isSafeInteger(size) ? { file: `${parts[0]}:${parts[1]}`, size } : undefined;
}

async function* usageJsonlFiles(
  dir: string,
  root: string,
  rootMissingIsEmpty: boolean,
  options: PoolMemberModelUsageOptions,
): AsyncGenerator<{ path: string; key: string; fingerprint: string }> {
  let entries;
  try {
    entries = options.readdir ? await options.readdir(dir) : await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isErrno(error, "ENOENT") && rootMissingIsEmpty && dir === root) return;
    throw error;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* usageJsonlFiles(path, root, false, options);
    } else if (entry.name.endsWith(".jsonl")) {
      const fingerprint = options.fingerprint ? await options.fingerprint(path) : await sourceFingerprint(path);
      if (fingerprint === undefined) throw new Error("usage source disappeared during discovery");
      const relative = path.slice(root.length + 1);
      const key = createHash("sha256").update(relative).digest("hex");
      yield { path, key, fingerprint };
    }
  }
}

function validHit(hit: unknown): hit is CachedUsageHit {
  return Array.isArray(hit) && hit.length === 7 && typeof hit[0] === "number" && Number.isFinite(hit[0]) &&
    (hit[1] === null || typeof hit[1] === "string") && (hit[2] === null || typeof hit[2] === "string") &&
    hit.slice(3).every((n) => typeof n === "number" && Number.isFinite(n));
}

const HEX = /^[a-f0-9]{64}$/;
const HITS_FILE = /^[a-f0-9]{64}\.[a-f0-9-]{36}\.jsonl$/;

function validPoolUsageCache(value: unknown): value is PoolUsageCache {
  if (!value || typeof value !== "object") return false;
  const cache = value as Partial<PoolUsageCache>;
  return cache.schemaVersion === 2 && Array.isArray(cache.files) && cache.files.every((file) =>
    !!file && typeof file.key === "string" && HEX.test(file.key) && typeof file.fingerprint === "string" &&
    Number.isSafeInteger(file.offset) && file.offset >= 0 && typeof file.head === "string" && typeof file.tail === "string" &&
    Array.isArray(file.pending) && file.pending.every(validHit) &&
    typeof file.hitsFile === "string" && HITS_FILE.test(file.hitsFile) && Number.isSafeInteger(file.hitsBytes) && file.hitsBytes >= 0,
  );
}

function validLegacyPoolUsageCache(value: unknown): value is LegacyPoolUsageCache {
  if (!value || typeof value !== "object") return false;
  const cache = value as Partial<LegacyPoolUsageCache>;
  return cache.schemaVersion === 1 && Array.isArray(cache.files) && cache.files.every((file) =>
    !!file && typeof file.key === "string" && HEX.test(file.key) && typeof file.fingerprint === "string" && Array.isArray(file.hits) && file.hits.every(validHit));
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    // This is an acceleration cache. Any read error falls back to source files.
    return undefined;
  }
}

async function writePoolUsageCache(path: string, cache: PoolUsageCache): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(cache));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

/** Streams `path` from `start`, calling `onLine` for each line exactly as
 * node's readline splits it (`\r\n`, `\n` or a lone `\r`). Returns the offset
 * just past the last `\n` and the text after it, which an append may still
 * complete. Splitting only at `\n` keeps a resumed read line-for-line equal
 * to a read from byte 0. */
async function readJsonlFrom(path: string, start: number, onLine: (line: string) => void): Promise<{ offset: number; rest: string }> {
  const emit = (segment: string) => {
    const body = segment.endsWith("\r") ? segment.slice(0, -1) : segment;
    for (const line of body.split("\r")) onLine(line);
  };
  let carry: Buffer[] = [];
  let carryBytes = 0;
  let offset = start;
  for await (const chunk of createReadStream(path, { start }) as AsyncIterable<Buffer>) {
    let from = 0;
    for (let newline = chunk.indexOf(10, from); newline !== -1; newline = chunk.indexOf(10, from)) {
      const piece = chunk.subarray(from, newline);
      const line = carryBytes ? Buffer.concat([...carry, piece]) : piece;
      offset += carryBytes + piece.length + 1;
      carry = [];
      carryBytes = 0;
      emit(line.toString("utf8"));
      from = newline + 1;
    }
    if (from < chunk.length) {
      carry.push(chunk.subarray(from));
      carryBytes += chunk.length - from;
    }
  }
  return { offset, rest: Buffer.concat(carry).toString("utf8") };
}

async function sampleDigests(path: string, offset: number): Promise<{ head: string; tail: string }> {
  const handle = await open(path, "r");
  try {
    const window = async (start: number, length: number) => {
      const buffer = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const { bytesRead } = await handle.read(buffer, read, length - read, start + read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      return createHash("sha256").update(buffer.subarray(0, read)).update(`\0${start}:${length}:${read}`).digest("hex");
    };
    const headLength = Math.min(HEAD_SAMPLE_BYTES, offset);
    const tailStart = Math.max(0, offset - TAIL_SAMPLE_BYTES);
    return { head: await window(0, headLength), tail: await window(tailStart, offset - tailStart) };
  } finally {
    await handle.close();
  }
}

const HEAD_SAMPLE_BYTES = 4 * 1024;
const TAIL_SAMPLE_BYTES = 64 * 1024;

function hitFor(line: string, events: SwapEvent[], poolName: string): CachedUsageHit | undefined {
  const hit = attributeLine(line, events, poolName, 0);
  if (!hit) return undefined;
  const opaqueId = hit.id ? createHash("sha256").update(hit.id).digest("hex").slice(0, 32) : null;
  return [hit.at, hit.model ?? null, opaqueId, hit.usage.input, hit.usage.output, hit.usage.cacheRead, hit.usage.cacheWrite];
}

function encodeHits(hits: CachedUsageHit[]): string {
  let text = "";
  for (const hit of hits) text += `${JSON.stringify(hit)}\n`;
  return text;
}

/** The committed hits of a cache entry, or undefined when its log is missing or damaged. */
async function readHitsLog(path: string, bytes: number): Promise<CachedUsageHit[] | undefined> {
  if (bytes === 0) return [];
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return undefined;
  }
  try {
    const buffer = Buffer.alloc(bytes);
    let read = 0;
    while (read < bytes) {
      const { bytesRead } = await handle.read(buffer, read, bytes - read, read);
      if (bytesRead === 0) return undefined;
      read += bytesRead;
    }
    const hits: CachedUsageHit[] = [];
    const text = buffer.toString("utf8");
    if (!text.endsWith("\n")) return undefined;
    for (const line of text.slice(0, -1).split("\n")) {
      const hit: unknown = JSON.parse(line);
      if (!validHit(hit)) return undefined;
      hits.push(hit);
    }
    return hits;
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

/** Appends to a hits log after cutting anything past its committed length
 * (an append whose index commit never happened). Returns the new length. */
async function appendHitsLog(path: string, committedBytes: number, text: string): Promise<number> {
  let handle;
  try {
    handle = await open(path, "r+");
  } catch (error) {
    // An entry with no hits yet has no log file.
    if (!isErrno(error, "ENOENT") || committedBytes !== 0) throw error;
    handle = await open(path, "wx", 0o600);
  }
  try {
    await handle.truncate(committedBytes);
    if (text) await handle.write(text, committedBytes, "utf8");
  } finally {
    await handle.close();
  }
  return committedBytes + Buffer.byteLength(text);
}

async function writeNewHitsLog(directory: string, key: string, text: string): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // A fresh name per rewrite: the committed index keeps pointing at the old
  // log until the new index is in place, so a crash never mixes generations.
  const name = `${key}.${randomUUID()}.jsonl`;
  if (!text) return name;
  await writeFile(join(directory, name), text, { mode: 0o600, flag: "wx" });
  return name;
}

/** Parse `path` from `start`, returning the new hits and where the next read resumes. */
async function parseUsageFrom(path: string, start: number, events: SwapEvent[], poolName: string, onSourceFileRead?: (path: string, offset: number) => void) {
  onSourceFileRead?.(path, start);
  const hits: CachedUsageHit[] = [];
  const { offset, rest } = await readJsonlFrom(path, start, (line) => {
    const hit = hitFor(line, events, poolName);
    if (hit) hits.push(hit);
  });
  const pending: CachedUsageHit[] = [];
  if (rest) {
    const segment = rest.endsWith("\r") ? rest.slice(0, -1) : rest;
    for (const line of segment.split("\r")) {
      const hit = hitFor(line, events, poolName);
      if (hit) pending.push(hit);
    }
  }
  return { hits, pending, offset };
}

/** Per-member, per-model usage of a pool's whole transcript history, for
 * `ais usage`: a pool is not an account, so its messages are charged to the
 * member active at each timestamp. Messages before the first ledger event go
 * to the first event's `from` (else `to`), else the pool's active/first
 * member; a member no longer in the pool is reported as unattributed.
 * Costs are list-price estimates; callers with a real figure (tokscale) override them.
 * Messages are de-duplicated by message id, as transcripts repeat them.
 *
 * Unchanged transcripts are never opened, appended ones are read from where
 * the last scan stopped, and only the hits of changed files are written (see
 * CachedUsageFile). The index is rewritten only when an entry changed. */
export async function poolMemberModelUsage(pool: PoolIdentity, members: Identity[], ledgerPath: string, options: PoolMemberModelUsageOptions = {}): Promise<PoolMemberUsage[]> {
  const events = eventsForPool(await readSwapEvents(ledgerPath), pool);
  const fallback = events[0] ? events[0].from ?? events[0].to : pool.swapPool.active ?? pool.swapPool.accounts[0];
  const known = new Set(members.map((m) => m.name));
  const byMember = new Map<string | undefined, PoolMemberUsage>();
  const seen = new Set<string>();
  const recentByMember = new Map<string, RecentMemberSplit[number]>();
  const recentSinceMs = (options.now ?? Date.now()) - RECENT_USAGE_DAYS * 86_400_000;
  const projectsDir = join(pool.configDir, "projects");
  const cachePath = options.cachePath ?? defaultPoolUsageCachePath(pool);
  const legacyCachePath = options.legacyCachePath ?? (options.cachePath === undefined ? defaultLegacyPoolUsageCachePath(pool) : undefined);
  const hitsDirectory = `${cachePath}.d`;
  const indexValue = await readJson(cachePath);
  const previous = validPoolUsageCache(indexValue) ? indexValue : undefined;
  const previousByKey = new Map((previous?.files ?? []).map((file) => [file.key, file]));
  // Without an index, schema-1 hits of files that have not changed since are
  // adopted, so an upgrade does not re-read every transcript once.
  const legacyValue = previous || !legacyCachePath ? undefined : await readJson(legacyCachePath);
  const legacyByKey = new Map((validLegacyPoolUsageCache(legacyValue) ? legacyValue.files : []).map((file) => [file.key, file]));
  const files: CachedUsageFile[] = [];
  let cacheDirty = previous === undefined;

  const add = (raw: CachedUsageHit) => {
    const [at, modelName, messageId, input, output, cacheRead, cacheWrite] = raw;
    if (messageId) {
      if (seen.has(messageId)) return;
      seen.add(messageId);
    }
    const actualName = activeMemberAt(events, pool.name, at) ?? fallback;
    const member = actualName !== undefined && known.has(actualName) ? actualName : undefined;
    const row = byMember.get(member) ?? { member, entries: [], firstMs: at, lastMs: at, dailyUsage: {}, dailyByModel: {} };
    byMember.set(member, row);
    const model = modelName ?? "unknown";
    let entry = row.entries.find((e) => e.model === model);
    if (!entry) {
      entry = { client: "claude", provider: "anthropic", model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, messageCount: 0, cost: 0 };
      row.entries.push(entry);
    }
    entry.input += input;
    entry.output += output;
    entry.cacheRead += cacheRead;
    entry.cacheWrite += cacheWrite;
    entry.messageCount += 1;
    entry.cost += estimateChatModelTokenCost(model, input, output, cacheRead, cacheWrite) ?? 0;
    if (at >= recentSinceMs) {
      // The label a live scan uses: the member active then, "(before first swap)" before the ledger, even for departed members.
      const label = activeMemberAt(events, pool.name, at) ?? "(before first swap)";
      const recent = recentByMember.get(label) ?? { member: label, messages: 0, input: 0, output: 0 };
      recent.messages += 1;
      recent.input += input;
      recent.output += output;
      recentByMember.set(label, recent);
    }
    row.firstMs = Math.min(row.firstMs, at);
    row.lastMs = Math.max(row.lastMs, at);
    const day = localDateKey(at);
    row.dailyUsage[day] = (row.dailyUsage[day] ?? 0) + input + output;
    addDailyTotals(row.dailyByModel[model] ??= {}, day, input, output, cacheRead, cacheWrite, 1, estimateChatModelTokenCost(model, input, output, cacheRead, cacheWrite) ?? 0);
  };

  for await (const source of usageJsonlFiles(projectsDir, projectsDir, true, options)) {
    const cached = previousByKey.get(source.key);
    if (cached?.fingerprint === source.fingerprint) {
      const committed = await readHitsLog(join(hitsDirectory, cached.hitsFile), cached.hitsBytes);
      if (committed) {
        files.push(cached);
        for (const hit of committed) add(hit);
        for (const hit of cached.pending) add(hit);
        continue;
      }
    }
    cacheDirty = true;
    const now = fingerprintParts(source.fingerprint);
    let entry: CachedUsageFile | undefined;
    let hits: CachedUsageHit[] | undefined;

    // Append: same file, grown since the stored stat, not shorter than where
    // the last read stopped, and both sampled windows still match. `offset`
    // may exceed the size in the stored fingerprint: that stat is taken before
    // the read, and a live transcript keeps growing while it is read. A
    // same-size change is never resumed: it is a rewrite, not an append.
    const was = cached ? fingerprintParts(cached.fingerprint) : undefined;
    if (cached && was && now && was.file === now.file && now.size > was.size && now.size >= cached.offset) {
      const samples = await sampleDigests(source.path, cached.offset);
      const committed = samples.head === cached.head && samples.tail === cached.tail
        ? await readHitsLog(join(hitsDirectory, cached.hitsFile), cached.hitsBytes)
        : undefined;
      if (committed) {
        const parsed = await parseUsageFrom(source.path, cached.offset, events, pool.name, options.onSourceFileRead);
        const digests = await sampleDigests(source.path, parsed.offset);
        let hitsBytes = cached.hitsBytes;
        try {
          hitsBytes = await appendHitsLog(join(hitsDirectory, cached.hitsFile), cached.hitsBytes, encodeHits(parsed.hits));
          entry = { ...cached, fingerprint: source.fingerprint, offset: parsed.offset, ...digests, pending: parsed.pending, hitsBytes };
        } catch {
          // An unwritable log only loses the acceleration: count this cycle, re-read next time.
          entry = undefined;
        }
        hits = [...committed, ...parsed.hits, ...parsed.pending];
      }
    }

    // Upgrade: a schema-1 entry for a file unchanged since, ending in a newline.
    const legacy = !cached && !hits ? legacyByKey.get(source.key) : undefined;
    if (legacy && legacy.fingerprint === source.fingerprint && now && await endsWithNewline(source.path, now.size)) {
      const digests = await sampleDigests(source.path, now.size);
      try {
        const hitsFile = await writeNewHitsLog(hitsDirectory, source.key, encodeHits(legacy.hits));
        entry = { key: source.key, fingerprint: source.fingerprint, offset: now.size, ...digests, pending: [], hitsFile, hitsBytes: Buffer.byteLength(encodeHits(legacy.hits)) };
      } catch { /* cache is advisory */ }
      hits = legacy.hits;
    }

    if (!hits) {
      const parsed = await parseUsageFrom(source.path, 0, events, pool.name, options.onSourceFileRead);
      const digests = await sampleDigests(source.path, parsed.offset);
      const text = encodeHits(parsed.hits);
      try {
        const hitsFile = await writeNewHitsLog(hitsDirectory, source.key, text);
        entry = { key: source.key, fingerprint: source.fingerprint, offset: parsed.offset, ...digests, pending: parsed.pending, hitsFile, hitsBytes: Buffer.byteLength(text) };
      } catch { /* cache is advisory */ }
      hits = [...parsed.hits, ...parsed.pending];
    }
    // The fingerprint is the one taken before the read. A file still growing
    // mid-read no longer matches it, so the next cycle reads on from `offset`.
    if (entry) files.push(entry);
    for (const hit of hits) add(hit);
  }
  if (previous && previous.files.length !== files.length) cacheDirty = true;
  if (cacheDirty) {
    try {
      const cache = { schemaVersion: 2 as const, files };
      if (options.writeCache) await options.writeCache(cachePath, cache);
      else await writePoolUsageCache(cachePath, cache);
      await removeUnreferencedHitsLogs(hitsDirectory, new Set(files.map((file) => file.hitsFile)));
      if (legacyCachePath && legacyByKey.size > 0) await unlink(legacyCachePath).catch(() => undefined);
    } catch { /* cache is advisory */ }
  }
  options.onRecentSplit?.([...recentByMember.values()].sort((a, b) => b.output - a.output));
  return [...byMember.values()];
}

async function endsWithNewline(path: string, size: number): Promise<boolean> {
  if (size === 0) return true;
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(1);
    const { bytesRead } = await handle.read(buffer, 0, 1, size - 1);
    return bytesRead === 1 && buffer[0] === 10;
  } finally {
    await handle.close();
  }
}

/** Logs of removed transcripts and superseded generations, after the index that dropped them is committed. */
async function removeUnreferencedHitsLogs(directory: string, referenced: Set<string>): Promise<void> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return;
  }
  for (const name of names) {
    if (HITS_FILE.test(name) && !referenced.has(name)) await unlink(join(directory, name)).catch(() => undefined);
  }
}
