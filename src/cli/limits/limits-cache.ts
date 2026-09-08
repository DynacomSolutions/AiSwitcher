import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Identity, ToolConfig } from "../../identities/types.ts";
import { aisLimitsCacheFile } from "../../shared/ais-home.ts";
import { canonicalUsageProvider } from "../usage/providers.ts";
import type { LimitWindow, ManualResetInfo, OverageInfo, ToolLimitResult } from "./types.ts";

/**
 * Last-good snapshot store for `ais limits`. Every provider's live read can
 * fail transiently (chatgpt.com load blips under parallel report load are
 * the documented case: 2026-09-03, 2026-09-04, and 2026-09-07 when several
 * codex identities failed in one run while siblings succeeded), and a bare
 * error row is strictly worse than the last known windows. So every
 * successful fetch is written through here, and collect.ts converts a failed
 * fetch into a "cached" result when a snapshot exists. Freshness is never
 * implied: the record keeps the ORIGINAL capture time, which bar.ts's
 * staleSuffix renders as "[as of Xm ago]" on every window row.
 *
 * One JSON file, keyed by `provider:identityName`, written atomically
 * (temp file + rename, mode 0600, same convention as kimi-store.ts). The
 * store is a cache in the strictest sense: any read or parse problem is
 * treated as "no snapshot" rather than an error, and a failed write is
 * swallowed, because a cache must never turn a healthy live fetch into a
 * failure or a failed fetch into a worse one.
 */

export interface CachedLimitsRecord {
  provider: string;
  /** Which tool's fetcher captured the snapshot (collection provenance;
   * the report groups by provider regardless). */
  toolName: ToolConfig["toolName"];
  identityName: string;
  windows: LimitWindow[];
  /** When the snapshot was actually captured (ISO), preserved verbatim
   * across fallback conversions so stale rendering stays honest. */
  capturedAt: string;
  overage?: OverageInfo;
  manualReset?: ManualResetInfo;
}

type LimitsCacheStore = Record<string, CachedLimitsRecord>;

/** Store key for one provider+identity. Provider aliases are canonicalised
 * on BOTH write and lookup (a Z.ai key read through pi is the same account
 * the zai tool queries), so a snapshot recorded under an alias is found by
 * either spelling. */
export function limitsCacheKey(provider: string, identityName: string): string {
  return `${canonicalUsageProvider(provider)}:${identityName}`;
}

function isRecord(value: unknown): value is CachedLimitsRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.provider === "string" &&
    typeof v.toolName === "string" &&
    typeof v.identityName === "string" &&
    Array.isArray(v.windows) &&
    typeof v.capturedAt === "string"
  );
}

/** The whole store, tolerating every failure mode as "empty": a missing
 * file, unreadable JSON, or a shape that is not a key-to-record map (e.g. a
 * hand-edited or truncated file) all mean "no snapshots", never an error.
 * Individual entries that do not look like records are dropped, so one bad
 * row cannot poison the rest. */
async function readStore(path: string): Promise<LimitsCacheStore> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const store: LimitsCacheStore = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (isRecord(value)) store[key] = value;
    }
    return store;
  } catch {
    return {};
  }
}

/** Same atomic-write convention as kimi-store.ts's writeJsonAtomic: temp
 * file in the same directory + rename, mode 0600, so a crash mid-write
 * can't truncate the store. The parent directory is created if missing. */
async function writeStoreAtomic(path: string, store: LimitsCacheStore): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}`;
  await writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

/** Up to MAX_CONCURRENT fetches resolve at once and each write is a
 * read-modify-write of the whole file, so writes are serialised through
 * this in-process queue: without it two writers resolving in the same tick
 * would race the shared temp name and lose each other's record. Across
 * processes the atomic rename keeps the file intact and last-writer-wins
 * is acceptable for a cache whose next successful fetch rewrites it. */
let writeQueue: Promise<unknown> = Promise.resolve();

/** Write one live result through to the store, replacing any older
 * snapshot for the same provider+identity. Never throws and never records
 * a non-live result: a cache write failure must not fail the fetch that
 * just succeeded, and only a genuinely fresh read may overwrite the last
 * good data. */
export async function recordLiveLimitsResult(result: ToolLimitResult, path: string = aisLimitsCacheFile()): Promise<void> {
  if (result.status !== "live") return;
  const record: CachedLimitsRecord = {
    provider: result.provider,
    toolName: result.toolName,
    identityName: result.identity.name,
    windows: result.windows,
    capturedAt: result.capturedAt ?? new Date().toISOString(),
    ...(result.overage ? { overage: result.overage } : {}),
    ...(result.manualReset ? { manualReset: result.manualReset } : {}),
  };
  const write = writeQueue.then(async () => {
    const store = await readStore(path);
    store[limitsCacheKey(record.provider, record.identityName)] = record;
    await writeStoreAtomic(path, store);
  });
  writeQueue = write.catch(() => undefined);
  await write.catch(() => undefined);
}

/** The stored snapshot for one provider+identity, if any. */
export async function lookupCachedLimits(
  provider: string,
  identityName: string,
  path: string = aisLimitsCacheFile(),
): Promise<CachedLimitsRecord | undefined> {
  const store = await readStore(path);
  return store[limitsCacheKey(provider, identityName)];
}

/** Every stored snapshot naming this identity, whichever provider or tool
 * recorded it. This is what collect.ts's `--cached` mode offers the
 * multi-provider clients (pi, opencode): their provider set is only known
 * from their own auth store, so in offline mode the cache itself is the
 * only source of "which providers can this identity answer for". */
export async function cachedLimitsForIdentity(identityName: string, path: string = aisLimitsCacheFile()): Promise<CachedLimitsRecord[]> {
  const store = await readStore(path);
  return Object.values(store).filter((record) => record.identityName === identityName);
}

/** Builds the "cached" result for a stored snapshot. The identity object
 * comes from the current target (the record only keeps the name, so the
 * live registry's label/aliases still apply), capturedAt stays the
 * snapshot's ORIGINAL time, and `error` carries the reason this row is
 * cached at all (the live fetch's failure, or nothing in pure `--cached`
 * mode) so report.ts can show it alongside the stale bars. */
export function cachedLimitsFromRecord(record: CachedLimitsRecord, identity: Identity, error?: string): ToolLimitResult {
  return {
    toolName: record.toolName,
    provider: record.provider,
    identity,
    windows: record.windows,
    status: "cached",
    capturedAt: record.capturedAt,
    ...(record.overage ? { overage: record.overage } : {}),
    ...(record.manualReset ? { manualReset: record.manualReset } : {}),
    ...(error ? { error } : {}),
  };
}
