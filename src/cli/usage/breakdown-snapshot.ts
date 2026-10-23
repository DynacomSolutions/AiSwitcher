import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isKnownToolName } from "../identities/resolve-tool.ts";
import type { ToolConfig } from "../../identities/types.ts";
import { aisCacheDir } from "../../shared/ais-home.ts";
import { clampBreakdownDays, DEFAULT_BREAKDOWN_DAYS, runBreakdownQuery, type BreakdownQuery, type BreakdownResult } from "./breakdown.ts";

export const USAGE_BREAKDOWN_TTL_MS = 15 * 60_000;
const DEFAULT_ROOT = join(aisCacheDir(), "usage", "breakdown");
const SCHEMA_VERSION = 1;

export interface UsageBreakdownRequest {
  tool?: string;
  identity?: string;
  days?: number;
}

export interface NormalizedUsageBreakdownRequest {
  tool?: ToolConfig["toolName"];
  identity?: string;
  days: number;
}

export interface UsageBreakdownEnvelope {
  results: BreakdownResult[];
  generatedAt?: string;
  lastSuccessAt?: string;
  pending: boolean;
  stale: boolean;
  error?: { category: "source-error"; at: string };
}

export interface BreakdownSnapshotDeps {
  /** Cache root override for isolated fixture tests. */
  root?: string;
  now?: () => number;
  ttlMs?: number;
}

interface CachedBreakdown {
  schemaVersion: 1;
  key: string;
  /** Stored so source-dirty events can refresh known queries without history scans. */
  query: NormalizedUsageBreakdownRequest;
  results: BreakdownResult[];
  generatedAt: string;
  lastSuccessAt: string;
}

interface QueuedRequest {
  schemaVersion: 1;
  key: string;
  requestId: string;
  query: NormalizedUsageBreakdownRequest;
  requestedAt: string;
}

interface RequestStatus {
  schemaVersion: 1;
  key: string;
  lastError?: { category: "source-error"; at: string };
}

export function normalizeUsageBreakdownRequest(query: BreakdownQuery | UsageBreakdownRequest): NormalizedUsageBreakdownRequest {
  const rawTool = query.tool?.normalize("NFC").trim().toLowerCase();
  if (query.tool !== undefined && !rawTool) throw new Error("invalid-breakdown-tool");
  if (rawTool && !isKnownToolName(rawTool)) throw new Error("invalid-breakdown-tool");

  let identity: string | undefined;
  if (query.identity !== undefined) {
    identity = query.identity.normalize("NFC").trim();
    if (!identity || identity.length > 256 || /[\u0000-\u001f\u007f]/u.test(identity)) {
      throw new Error("invalid-breakdown-identity");
    }
  }

  return {
    ...(rawTool ? { tool: rawTool as ToolConfig["toolName"] } : {}),
    ...(identity ? { identity } : {}),
    days: clampBreakdownDays(query.days ?? DEFAULT_BREAKDOWN_DAYS),
  };
}

function requestKey(query: NormalizedUsageBreakdownRequest): string {
  return createHash("sha256").update(`ais-usage-breakdown-v1\0${JSON.stringify(query)}`).digest("hex");
}

function directories(root: string) {
  return {
    cache: join(root, "cache"),
    requests: join(root, "requests"),
    status: join(root, "status"),
  };
}

function atomicWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8");
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* best-effort temp cleanup */ }
    throw error;
  }
}

function parseJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function loadCache(path: string, key: string): CachedBreakdown | undefined {
  const value = parseJson(path) as Partial<CachedBreakdown> | undefined;
  if (!value || value.schemaVersion !== SCHEMA_VERSION || value.key !== key || !Array.isArray(value.results) ||
      typeof value.generatedAt !== "string" || !Number.isFinite(Date.parse(value.generatedAt)) ||
      typeof value.lastSuccessAt !== "string" || !Number.isFinite(Date.parse(value.lastSuccessAt))) return undefined;
  return value as CachedBreakdown;
}

function loadCacheQuery(path: string, key: string): NormalizedUsageBreakdownRequest | undefined {
  const value = loadCache(path, key) as (CachedBreakdown & { query?: unknown }) | undefined;
  if (!value?.query) return undefined;
  try {
    const query = normalizeUsageBreakdownRequest(value.query as UsageBreakdownRequest);
    return requestKey(query) === key ? query : undefined;
  } catch {
    return undefined;
  }
}

function loadStatus(path: string, key: string): RequestStatus | undefined {
  const value = parseJson(path) as Partial<RequestStatus> | undefined;
  if (!value || value.schemaVersion !== SCHEMA_VERSION || value.key !== key) return undefined;
  if (value.lastError?.category !== "source-error" || !Number.isFinite(Date.parse(value.lastError.at))) {
    return { schemaVersion: SCHEMA_VERSION, key };
  }
  return { schemaVersion: SCHEMA_VERSION, key, lastError: value.lastError };
}

function loadRequest(path: string, key: string): QueuedRequest | undefined {
  const value = parseJson(path) as Partial<QueuedRequest> | undefined;
  if (!value || value.schemaVersion !== SCHEMA_VERSION || value.key !== key || typeof value.requestId !== "string" ||
      typeof value.requestedAt !== "string" || !Number.isFinite(Date.parse(value.requestedAt)) || !value.query) return undefined;
  try {
    const query = normalizeUsageBreakdownRequest(value.query);
    if (requestKey(query) !== key) return undefined;
    return { schemaVersion: SCHEMA_VERSION, key, requestId: value.requestId, query, requestedAt: value.requestedAt };
  } catch {
    return undefined;
  }
}

export function readUsageBreakdownEnvelope(
  input: BreakdownQuery | UsageBreakdownRequest,
  deps: BreakdownSnapshotDeps = {},
): UsageBreakdownEnvelope {
  const query = normalizeUsageBreakdownRequest(input);
  const key = requestKey(query);
  const dirs = directories(deps.root ?? DEFAULT_ROOT);
  const cached = loadCache(join(dirs.cache, `${key}.json`), key);
  const status = loadStatus(join(dirs.status, `${key}.json`), key);
  const pending = existsSync(join(dirs.requests, `${key}.json`));
  const now = deps.now?.() ?? Date.now();
  const generatedAt = cached?.generatedAt;
  const stale = !cached || now - Date.parse(cached.lastSuccessAt) > (deps.ttlMs ?? USAGE_BREAKDOWN_TTL_MS) || pending || !!status?.lastError;
  return {
    results: cached?.results ?? [],
    ...(generatedAt ? { generatedAt, lastSuccessAt: cached!.lastSuccessAt } : {}),
    pending,
    stale,
    ...(status?.lastError ? { error: status.lastError } : {}),
  };
}

/** Atomically enqueue a coalesced refresh request. This function never reads session history. */
export function requestUsageBreakdownRefresh(
  input: BreakdownQuery | UsageBreakdownRequest,
  deps: BreakdownSnapshotDeps = {},
): NormalizedUsageBreakdownRequest {
  const query = normalizeUsageBreakdownRequest(input);
  const key = requestKey(query);
  const requestDirectory = directories(deps.root ?? DEFAULT_ROOT).requests;
  const requestPath = join(requestDirectory, `${key}.json`);
  mkdirSync(requestDirectory, { recursive: true, mode: 0o700 });
  if (!loadRequest(requestPath, key)) {
    atomicWrite(requestPath, {
      schemaVersion: SCHEMA_VERSION,
      key,
      requestId: randomUUID(),
      query,
      requestedAt: new Date(deps.now?.() ?? Date.now()).toISOString(),
    } satisfies QueuedRequest);
  }
  return query;
}

/** Queue the default 30-day view when it has no successful snapshot or needs TTL/error refresh. */
export function requestStaleUsageBreakdowns(deps: BreakdownSnapshotDeps = {}): boolean {
  const query = normalizeUsageBreakdownRequest({ days: DEFAULT_BREAKDOWN_DAYS });
  const envelope = readUsageBreakdownEnvelope(query, deps);
  const now = deps.now?.() ?? Date.now();
  const retryCooldownMs = deps.ttlMs ?? USAGE_BREAKDOWN_TTL_MS;
  if (!envelope.stale || envelope.pending || (envelope.error && now - Date.parse(envelope.error.at) < retryCooldownMs)) return false;
  requestUsageBreakdownRefresh(query, deps);
  return true;
}

/** Requeue known cached and pending query keys after a source-dirty event. */
export function requestKnownUsageBreakdownsRefresh(deps: BreakdownSnapshotDeps = {}): number {
  const dirs = directories(deps.root ?? DEFAULT_ROOT);
  const known = new Map<string, NormalizedUsageBreakdownRequest>();
  const cacheNames = existsSync(dirs.cache)
    ? readdirSync(dirs.cache, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name)
    : [];
  for (const name of cacheNames) {
    if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue;
    const key = name.slice(0, -5);
    const query = loadCacheQuery(join(dirs.cache, name), key);
    if (query) known.set(key, query);
  }
  const requestNames = existsSync(dirs.requests)
    ? readdirSync(dirs.requests, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name)
    : [];
  for (const name of requestNames) {
    if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue;
    const key = name.slice(0, -5);
    const request = loadRequest(join(dirs.requests, name), key);
    if (request) known.set(key, request.query);
  }
  for (const query of known.values()) requestUsageBreakdownRefresh(query, deps);
  return known.size;
}

function removeRequestIfUnchanged(path: string, expectedRequestId: string): void {
  const request = loadRequest(path, basenameWithoutJson(path));
  if (request?.requestId === expectedRequestId) {
    try { unlinkSync(path); } catch { /* another request or cleanup won the race */ }
  }
}

function basenameWithoutJson(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.endsWith(".json") ? name.slice(0, -5) : name;
}

let activeDrain: Promise<number> | undefined;

/** Collector-only producer. Requests are drained serially and readers never call this implicitly. */
export function refreshQueuedUsageBreakdowns(
  run: (query: BreakdownQuery) => Promise<BreakdownResult[]> = runBreakdownQuery,
  deps: BreakdownSnapshotDeps = {},
): Promise<number> {
  if (activeDrain) return activeDrain;
  const root = deps.root ?? DEFAULT_ROOT;
  const dirs = directories(root);
  activeDrain = (async () => {
    mkdirSync(dirs.requests, { recursive: true, mode: 0o700 });
    const names = readdirSync(dirs.requests).filter((name) => /^[a-f0-9]{64}\.json$/u.test(name)).sort();
    let completed = 0;
    for (const name of names) {
      const path = join(dirs.requests, name);
      const key = name.slice(0, -5);
      const request = loadRequest(path, key);
      if (!request) {
        try { unlinkSync(path); } catch { /* malformed marker already removed */ }
        continue;
      }
      try {
        const results = await run(request.query);
        if (!Array.isArray(results)) throw new Error("invalid-breakdown-result");
        if (results.some((result) => result.sourceError === "source-error")) {
          throw new Error("incomplete-breakdown-source");
        }
        const generatedAt = new Date(deps.now?.() ?? Date.now()).toISOString();
        const cachePath = join(dirs.cache, `${key}.json`);
        atomicWrite(cachePath, {
          schemaVersion: SCHEMA_VERSION,
          key,
          query: request.query,
          results,
          generatedAt,
          lastSuccessAt: generatedAt,
        } satisfies CachedBreakdown);
        atomicWrite(join(dirs.status, `${key}.json`), { schemaVersion: SCHEMA_VERSION, key } satisfies RequestStatus);
        completed++;
      } catch {
        // Persist only a safe category. Provider paths, payloads and arbitrary
        // exception text must never enter this durable projection.
        atomicWrite(join(dirs.status, `${key}.json`), {
          schemaVersion: SCHEMA_VERSION,
          key,
          lastError: { category: "source-error", at: new Date(deps.now?.() ?? Date.now()).toISOString() },
        } satisfies RequestStatus);
      } finally {
        removeRequestIfUnchanged(path, request.requestId);
      }
    }
    return completed;
  })().finally(() => { activeDrain = undefined; });
  return activeDrain;
}
