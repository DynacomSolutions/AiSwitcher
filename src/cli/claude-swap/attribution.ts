import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { SwapEvent } from "../../identities/pool/adapter.ts";
import { activeMemberAt, eventsForPool, readSwapEvents } from "../../identities/pool/ledger.ts";
import { estimateChatModelTokenCost } from "../../identities/model-pricing.ts";
import type { PoolIdentity } from "../../identities/pool/swap-pool.ts";
import type { Identity } from "../../identities/types.ts";
import { localDateKey } from "../usage/local-day.ts";
import type { TokscaleEntry } from "../usage/tokscale.ts";
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
}

/** Counts per member over the last RECENT_USAGE_DAYS: what `usage --json` serves, scan or snapshot. */
export type RecentMemberSplit = Array<{ member: string; messages: number; input: number; output: number }>;

export const RECENT_USAGE_DAYS = 30;

// A tuple keeps the durable cache substantially smaller than the source JSONL
// rows and avoids storing member attribution or derived pricing.
type CachedUsageHit = [at: number, model: string | null, id: string | null, input: number, output: number, cacheRead: number, cacheWrite: number];
interface CachedUsageFile {
  key: string;
  fingerprint: string;
  hits: CachedUsageHit[];
}
interface PoolUsageCache {
  schemaVersion: 1;
  files: CachedUsageFile[];
}

/** Test hooks for proving unchanged transcript files are not reopened. */
export interface PoolMemberModelUsageOptions {
  cachePath?: string;
  now?: number;
  /** Receives the recent per-member split, built with the same counting as `poolMemberUsageSplit`. */
  onRecentSplit?: (split: RecentMemberSplit) => void;
  onSourceFileRead?: (path: string) => void;
  /** Injectable discovery hooks for deterministic race/error tests. */
  readdir?: (path: string) => Promise<Array<{ name: string; isDirectory(): boolean }>>;
  fingerprint?: (path: string) => Promise<string | undefined>;
  writeCache?: (path: string, cache: PoolUsageCache) => Promise<void>;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function defaultPoolUsageCachePath(pool: PoolIdentity): string {
  const key = createHash("sha256").update(`ais-pool-usage-cache-v1\0${pool.name}\0${pool.configDir}`).digest("hex");
  return join(aisCacheDir(), "usage", "pool-attribution", `${key}.json`);
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

function validPoolUsageCache(value: unknown): value is PoolUsageCache {
  if (!value || typeof value !== "object") return false;
  const cache = value as Partial<PoolUsageCache>;
  return cache.schemaVersion === 1 && Array.isArray(cache.files) && cache.files.every((file) =>
    !!file && typeof file.key === "string" && typeof file.fingerprint === "string" && Array.isArray(file.hits) && file.hits.every((hit) =>
      Array.isArray(hit) && hit.length === 7 && typeof hit[0] === "number" && Number.isFinite(hit[0]) &&
      (hit[1] === null || typeof hit[1] === "string") && (hit[2] === null || typeof hit[2] === "string") &&
      hit.slice(3).every((n) => typeof n === "number" && Number.isFinite(n)),
    ),
  );
}

async function readPoolUsageCache(path: string): Promise<PoolUsageCache | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    // This is an acceleration cache. Any read error falls back to source files.
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return validPoolUsageCache(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function writePoolUsageCache(path: string, cache: PoolUsageCache): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  let pending = "";
  const append = async (value: string) => {
    pending += value;
    if (pending.length >= 64 * 1024) {
      await handle.writeFile(pending);
      pending = "";
    }
  };
  try {
    try {
      await append('{"schemaVersion":1,"files":[');
      for (let fileIndex = 0; fileIndex < cache.files.length; fileIndex += 1) {
        const file = cache.files[fileIndex]!;
        if (fileIndex > 0) await append(",");
        await append(`{"key":${JSON.stringify(file.key)},"fingerprint":${JSON.stringify(file.fingerprint)},"hits":[`);
        for (let hitIndex = 0; hitIndex < file.hits.length; hitIndex += 1) {
          if (hitIndex > 0) await append(",");
          await append(JSON.stringify(file.hits[hitIndex]));
        }
        await append("]}");
      }
      await append("]}");
      if (pending) await handle.writeFile(pending);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function parseUsageFile(path: string, events: SwapEvent[], poolName: string, onSourceFileRead?: (path: string) => void): Promise<CachedUsageHit[]> {
  onSourceFileRead?.(path);
  const hits: CachedUsageHit[] = [];
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    const hit = attributeLine(line, events, poolName, 0);
    if (hit) {
      const opaqueId = hit.id ? createHash("sha256").update(hit.id).digest("hex").slice(0, 32) : null;
      hits.push([hit.at, hit.model ?? null, opaqueId, hit.usage.input, hit.usage.output, hit.usage.cacheRead, hit.usage.cacheWrite]);
    }
  }
  return hits;
}

/** Per-member, per-model usage of a pool's whole transcript history, for
 * `ais usage`: a pool is not an account, so its messages are charged to the
 * member active at each timestamp. Messages before the first ledger event go
 * to the first event's `from` (else `to`), else the pool's active/first
 * member; a member no longer in the pool is reported as unattributed.
 * Costs are list-price estimates; callers with a real figure (tokscale) override them.
 * Messages are de-duplicated by message id, as transcripts repeat them. */
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
  const previous = await readPoolUsageCache(cachePath);
  const previousByKey = new Map((previous?.files ?? []).map((file) => [file.key, file]));
  const files: CachedUsageFile[] = [];
  let cacheDirty = previous === undefined;
  for await (const source of usageJsonlFiles(projectsDir, projectsDir, true, options)) {
    const cached = previousByKey.get(source.key);
    if (cached?.fingerprint === source.fingerprint) {
      files.push(cached);
      continue;
    }
    cacheDirty = true;
    let fingerprint = source.fingerprint;
    let hits: CachedUsageHit[] | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      hits = await parseUsageFile(source.path, events, pool.name, options.onSourceFileRead);
      const fingerprintAfterRead = await sourceFingerprint(source.path);
      if (fingerprintAfterRead === undefined) {
        throw new Error("usage source changed during attribution scan");
      }
      if (fingerprintAfterRead === fingerprint) break;
      if (attempt === 1) throw new Error("usage source changed during attribution scan");
      fingerprint = fingerprintAfterRead;
    }
    if (!hits) throw new Error("usage source could not be read");
    if (cached) {
      cached.fingerprint = fingerprint;
      cached.hits = hits;
      files.push(cached);
    } else {
      files.push({ key: source.key, fingerprint, hits });
    }
  }
  if (previous && previous.files.length !== files.length) cacheDirty = true;
  if (cacheDirty) {
    try {
      const cache = { schemaVersion: 1 as const, files };
      if (options.writeCache) await options.writeCache(cachePath, cache);
      else await writePoolUsageCache(cachePath, cache);
    } catch { /* cache is advisory */ }
  }
  for (const file of files) {
    for (const raw of file.hits) {
      const [at, modelName, messageId, input, output, cacheRead, cacheWrite] = raw;
      if (messageId) {
        if (seen.has(messageId)) continue;
        seen.add(messageId);
      }
      const actualName = activeMemberAt(events, pool.name, at) ?? fallback;
      const member = actualName !== undefined && known.has(actualName) ? actualName : undefined;
      const row = byMember.get(member) ?? { member, entries: [], firstMs: at, lastMs: at, dailyUsage: {} };
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
    }
  }
  options.onRecentSplit?.([...recentByMember.values()].sort((a, b) => b.output - a.output));
  return [...byMember.values()];
}
