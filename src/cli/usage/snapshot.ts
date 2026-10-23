import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { aisCacheDir } from "../../shared/ais-home.ts";
import { withUsableCwd } from "../../shared/exec.ts";
import { toolConfigFromFlag } from "../identities/resolve-tool.ts";
import { isSwapPool } from "../../identities/swap-pool.ts";
import { acknowledgeUsageSnapshotDirty, ensureUsageSnapshotDirty, readUsageSnapshotDirtyMarkers, usageSnapshotDirtyId, usageSnapshotTargetKey, usageSnapshotDirtyDirectory } from "./snapshot-dirty.ts";
import { aggregateUsageResults, collectTargets, defaultOpencodeProfileUsageResults, runTokscaleForUsageTarget, runUsageQueryForTargets, swapPoolUsageResults, type UsageResult, type UsageTarget } from "./run.ts";
import { usageResultsForJson } from "./run.ts";
import { buildAisTokscaleExportInvocation, runAisTokscaleExportInvocation } from "./tokscale.ts";
import type { UsageSnapshotMetricsStatus } from "./snapshot-status.ts";
export { readUsageSnapshotMetricsStatus } from "./snapshot-status.ts";

export const USAGE_SNAPSHOT_REFRESH_INTERVAL_MS = 2 * 60_000;
export const USAGE_SNAPSHOT_PARTITION_TTL_MS = 15 * 60_000;
export const USAGE_SNAPSHOT_FILE = join(aisCacheDir(), "usage", "snapshot.json");
// Two latest generations protect a reader racing a manifest replacement.
// A 10-minute grace covers ordinary reads; long-lived readers must retry once
// against the current manifest if their pinned batch has already been swept.
const NATIVE_BATCH_READER_AGE_FLOOR_MS = 10 * 60_000;
const EXTERNAL_COLLECTOR_MARKER = join(aisCacheDir(), "usage", "collector.external");

export function externalUsageCollectorOwnsRefreshes(markerPath = EXTERNAL_COLLECTOR_MARKER): boolean {
  return process.env.AIS_USAGE_COLLECTOR_MODE === "external" || existsSync(markerPath);
}

const DEFAULT_OPENCODE_PARTITION = "special:opencode-default";
function swapPoolPartitionKey(name: string): string {
  return usageSnapshotTargetKey("claude-swap-pool", name);
}

export interface UsageSnapshotPartition {
  tool?: string;
  identity?: string;
  nativeCoverage?: "supported" | "unsupported" | "error" | "pending";
  results: UsageResult[];
  nativeBatch?: {
    path: string;
    sha256: string;
    generatedAt: string;
    /** Opaque Tokscale export key. The manifest partition key is an AIS
     * report/source identifier and is deliberately not the export identity. */
    partitionId: string;
  };
  lastAttemptAt: string;
  lastSuccessAt?: string;
  lastError?: string;
  lastErrorAt?: string;
}

export interface UsageSnapshot {
  schemaVersion: 1;
  generatedAt: string;
  aggregateResults?: unknown[];
  aggregateGeneratedAt?: string;
  nativeCoverage?: {
    supported: number;
    unsupported: number;
    error: number;
    pending: number;
  };
  producer?: {
    lastStartedAt?: string;
    lastHeartbeatAt?: string;
    lastCompletedAt?: string;
    lastCycleError?: string;
    refreshCyclesTotal?: number;
    refreshCyclesFailedTotal?: number;
    sourceScansTotal?: number;
    sourceScanFailuresTotal?: number;
  };
  partitions: Record<string, UsageSnapshotPartition>;
}

export interface UsageSnapshotEnvelope {
  results: unknown[];
  generatedAt: string;
  stale: boolean;
  pending: boolean;
  nativeCoverage: { supported: number; unsupported: number; error: number; pending: number };
  lastSuccessAt?: string;
  lastError?: string;
  lastErrorAt?: string;
}

export interface UsageSnapshotDeps {
  path?: string;
  now?: () => number;
  partitionTtlMs?: number;
  forcePartitionKeys?: string[];
  dirtyDirectory?: string;
  collectTargets?: () => Promise<UsageTarget[]>;
  collectPoolTargets?: () => Promise<UsageTarget[]>;
  collectTargetResults?: (targets: UsageTarget[], onItemDone: (index: number, results: UsageResult[]) => void) => Promise<UsageResult[]>;
  collectDefaultProfile?: () => Promise<UsageResult[]>;
  collectSwapPools?: (onPoolDone: (pool: UsageTarget["identity"], results: UsageResult[], failed?: boolean, nativeBatchCandidate?: UsageResult["nativeBatchCandidate"]) => void | Promise<void>) => Promise<UsageResult[]>;
  captureNative?: (spec: NativeSnapshotCaptureSpec) => Promise<UsageSnapshotPartition["nativeBatch"]>;
}

export interface NativeSnapshotCaptureSpec {
  partitionKey: string;
  partitionId: string;
  toolName: UsageTarget["toolName"];
  identity?: UsageTarget["identity"];
}


/** Build isolated Tokscale native message captures for custom report readers.
 * Args intentionally stop before `--json`; the lifecycle helper appends its
 * export capability flags and validates the emitted batch. */
export async function buildNativeSnapshotCaptureSpecs(targets: UsageTarget[]): Promise<NativeSnapshotCaptureSpec[]> {
  const specs: NativeSnapshotCaptureSpec[] = [];
  for (const target of targets) {
    if (target.toolName !== "opencode" && target.toolName !== "pi") continue;
    const partitionKey = targetKey(target);
    specs.push({ partitionKey, partitionId: createHash("sha256").update(`ais-native-partition-v1\0${partitionKey}`).digest("hex"), toolName: target.toolName, identity: target.identity });
  }
  // The default profile has no identity target, so provide its exact XDG data
  // root explicitly instead of inheriting a service/launcher override.
  const partitionKey = DEFAULT_OPENCODE_PARTITION;
  specs.push({
    partitionKey,
    partitionId: createHash("sha256").update(`ais-native-partition-v1\0${partitionKey}`).digest("hex"),
    toolName: "opencode",
  });
  return specs;
}

async function captureNativeBatch(spec: NativeSnapshotCaptureSpec, deps: UsageSnapshotDeps): Promise<UsageSnapshotPartition["nativeBatch"]> {
  if (deps.captureNative) return deps.captureNative(spec);
  const cache = aisCacheDir();
  const staging = join(cache, "usage", "native", ".staging");
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  const temporary = join(staging, `${spec.partitionId}.${crypto.randomUUID()}.json`);
  try {
    const invocation = await buildAisTokscaleExportInvocation({
      toolName: spec.toolName,
      ...(spec.identity ? { identity: spec.identity } : {}),
      partitionId: spec.partitionId,
      exportPath: temporary,
    });
    if (!invocation) return undefined;
    await runAisTokscaleExportInvocation(invocation);
    return promoteNativeBatchFile(temporary, spec.partitionId);
  } finally {
    try { unlinkSync(temporary); } catch { /* no export was produced */ }
  }
}

function nativePartitionId(partitionKey: string): string {
  return createHash("sha256").update(`ais-native-partition-v1\0${partitionKey}`).digest("hex");
}

function nativeExportSupportedInSameRun(toolName: UsageTarget["toolName"]): boolean {
  return toolName !== "ali" && toolName !== "zai" && toolName !== "opencode" && toolName !== "pi";
}

async function nativeExportForTarget(target: UsageTarget, key = targetKey(target)) {
  if (!nativeExportSupportedInSameRun(target.toolName)) return undefined;
  const partitionId = nativePartitionId(key);
  const staging = join(aisCacheDir(), "usage", "native", ".staging");
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  const path = join(staging, `${partitionId}.${crypto.randomUUID()}.json`);
  const invocation = await buildAisTokscaleExportInvocation({
    toolName: target.toolName, identity: target.identity, partitionId, exportPath: path,
  });
  return invocation ? { invocation, path, partitionId } : undefined;
}

function candidateFromResults(results: UsageResult[]): UsageResult["nativeBatchCandidate"] | undefined {
  return results.find((result) => result.nativeBatchCandidate)?.nativeBatchCandidate;
}

function validateNativeBatchFile(path: string, partitionId: string): NonNullable<UsageSnapshotPartition["nativeBatch"]> {
  const generatedAt = validateNativeBatchEnvelope(JSON.parse(readFileSync(path, "utf8")), partitionId);
  const bytes = readFileSync(path);
  return {
    path: "",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    generatedAt,
    partitionId,
  };
}

export function validateNativeBatchEnvelope(value: unknown, partitionId: string): string {
  const envelope = value as Record<string, unknown> | null;
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) ||
      envelope.schemaVersion !== 1 || envelope.partitionId !== partitionId || envelope.complete !== true ||
      typeof envelope.generatedAt !== "string" || !Number.isFinite(Date.parse(envelope.generatedAt)) || !Array.isArray(envelope.messages) ||
      !envelope.messages.every((message) => message !== null && typeof message === "object" && !Array.isArray(message))) {
    throw new Error("invalid-native-batch");
  }
  return envelope.generatedAt;
}

function promoteNativeBatchFile(candidatePath: string, partitionId: string): NonNullable<UsageSnapshotPartition["nativeBatch"]> {
  const ref = validateNativeBatchFile(candidatePath, partitionId);
  const bytes = readFileSync(candidatePath);
  const attempt = crypto.randomUUID();
  const batchDir = join(aisCacheDir(), "usage", "native", partitionId);
  mkdirSync(batchDir, { recursive: true, mode: 0o700 });
  const batchName = `${attempt}.json`;
  const promoted = join(batchDir, batchName);
  writeFileSync(promoted, bytes, { flag: "wx", mode: 0o600 });
  chmodSync(promoted, 0o600);
  return { ...ref, path: `usage/native/${partitionId}/${batchName}` };
}

let activeRefresh: Promise<UsageSnapshot> | undefined;

export async function acquireSnapshotLock(path: string): Promise<(() => Promise<void>) | undefined> {
  const lockPath = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(lockPath, "a", 0o600);
  try { chmodSync(lockPath, 0o600); } finally { closeSync(fd); }
  // flock's child holds a kernel advisory lock on the shared hostPath inode
  // for the whole refresh. The kernel releases it on process exit, including
  // crashes and pod restarts, without PID/hostname/clock based reclamation.
  const flock = Bun.which("flock");
  if (!flock) throw new Error("snapshot-lock-unavailable");
  const child = Bun.spawn([flock, "-n", lockPath, "/bin/sh", "-c", "printf locked; cat >/dev/null"], {
    stdin: "pipe", stdout: "pipe", stderr: "ignore",
  });
  try {
    const reader = child.stdout.getReader();
    const result = await Promise.race([reader.read(), child.exited.then(() => ({ done: true as const, value: undefined }))]);
    if (!result || result.done || new TextDecoder().decode(result.value) !== "locked") {
      child.stdin.end();
      await child.exited;
      return undefined;
    }
    return async () => {
      child.stdin.end();
      await child.exited;
    };
  } catch {
    child.stdin.end();
    await child.exited;
    return undefined;
  }
}

function snapshotPath(path = USAGE_SNAPSHOT_FILE): string {
  return path;
}

function readSnapshot(path = USAGE_SNAPSHOT_FILE): UsageSnapshot | undefined {
  try {
    const value = JSON.parse(readFileSync(snapshotPath(path), "utf8")) as Partial<UsageSnapshot>;
    if (value.schemaVersion !== 1 || typeof value.generatedAt !== "string" || !value.partitions || typeof value.partitions !== "object") return undefined;
    const partitions: Record<string, UsageSnapshotPartition> = {};
    for (const [key, partition] of Object.entries(value.partitions)) {
      if (!partition || typeof partition !== "object" || !Array.isArray(partition.results) || !partition.results.every(isValidUsageResult) || typeof partition.lastAttemptAt !== "string") continue;
      if (partition.nativeBatch !== undefined) {
        const ref = partition.nativeBatch;
        if (!ref || typeof ref !== "object" || typeof ref.path !== "string" || !ref.path.startsWith("usage/native/") || ref.path.includes("..") ||
            typeof ref.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(ref.sha256) || typeof ref.generatedAt !== "string" ||
            typeof ref.partitionId !== "string" || !/^[a-f0-9]{64}$/.test(ref.partitionId)) continue;
      }
      partitions[key] = partition as UsageSnapshotPartition;
    }
    return {
      schemaVersion: 1,
      generatedAt: value.generatedAt,
      ...(Array.isArray(value.aggregateResults) ? { aggregateResults: value.aggregateResults } : {}),
      ...(typeof value.aggregateGeneratedAt === "string" ? { aggregateGeneratedAt: value.aggregateGeneratedAt } : {}),
      ...(value.nativeCoverage && typeof value.nativeCoverage === "object" ? { nativeCoverage: value.nativeCoverage } : {}),
      ...(value.producer ? { producer: value.producer } : {}),
      partitions,
    };
  } catch {
    return undefined;
  }
}

function writeSnapshot(snapshot: UsageSnapshot, path = USAGE_SNAPSHOT_FILE): void {
  const aggregateSourceRows = Object.values(snapshot.partitions).flatMap((partition) => partition.results.map((result) => {
    if (!result.report) return result;
    const client = result.nativeCoverageTool ?? result.sourceTool ?? "unknown";
    return {
      ...result,
      report: {
        ...result.report,
        entries: result.report.entries.map((entry) => ({ ...entry, client: entry.client || client })),
      },
    };
  }));
  const file = snapshotPath(path);
  const committed: UsageSnapshot = {
    ...snapshot,
    aggregateResults: snapshotResultsForJson(aggregateUsageResults(aggregateSourceRows)),
    aggregateGeneratedAt: snapshot.aggregateGeneratedAt ?? snapshot.generatedAt,
    nativeCoverage: Object.values(snapshot.partitions).reduce((coverage, partition) => {
      const state = partition.nativeCoverage ?? "pending";
      coverage[state]++;
      return coverage;
    }, { supported: 0, unsupported: 0, error: 0, pending: 0 }),
  };
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(temporary, JSON.stringify(committed), { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
    if (path === USAGE_SNAPSHOT_FILE) collectObsoleteNativeBatches(committed);
    const successfulAt = Object.values(committed.partitions)
      .map((partition) => partition.lastSuccessAt ? Date.parse(partition.lastSuccessAt) : undefined)
      .filter((value): value is number => value !== undefined && Number.isFinite(value));
    const status: UsageSnapshotMetricsStatus = {
      ...(committed.producer?.lastStartedAt ? { producerStartedAt: committed.producer.lastStartedAt } : {}),
      ...(committed.producer?.lastHeartbeatAt ? { producerHeartbeatAt: committed.producer.lastHeartbeatAt } : {}),
      ...(committed.producer?.lastCompletedAt ? { producerCompletedAt: committed.producer.lastCompletedAt } : {}),
      ...(Number.isFinite(committed.producer?.refreshCyclesTotal) ? { refreshCyclesTotal: committed.producer!.refreshCyclesTotal } : {}),
      ...(Number.isFinite(committed.producer?.refreshCyclesFailedTotal) ? { refreshCyclesFailedTotal: committed.producer!.refreshCyclesFailedTotal } : {}),
      ...(Number.isFinite(committed.producer?.sourceScansTotal) ? { sourceScansTotal: committed.producer!.sourceScansTotal } : {}),
      ...(Number.isFinite(committed.producer?.sourceScanFailuresTotal) ? { sourceScanFailuresTotal: committed.producer!.sourceScanFailuresTotal } : {}),
      ...(committed.producer?.lastCycleError ? { lastCycleError: committed.producer.lastCycleError } : {}),
      ...(successfulAt.length ? {
        latestSuccessAt: new Date(Math.max(...successfulAt)).toISOString(),
        oldestSuccessAt: new Date(Math.min(...successfulAt)).toISOString(),
      } : {}),
      partitions: Object.keys(committed.partitions).length,
      partitionsWithErrors: Object.values(committed.partitions).filter((partition) => partition.lastError).length,
    };
    const statusFile = join(dirname(file), "status.json");
    const statusTemporary = `${statusFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      writeFileSync(statusTemporary, JSON.stringify(status), { mode: 0o600 });
      chmodSync(statusTemporary, 0o600);
      renameSync(statusTemporary, statusFile);
    } catch {
      try { unlinkSync(statusTemporary); } catch { /* no temporary file remains */ }
    }
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* no temporary file remains */ }
    throw error;
  }
}

/** The shared manifest carries stable Tokscale client provenance for its
 * all-time overlay. Normal CLI/API JSON intentionally continues to omit it. */
function snapshotResultsForJson(results: UsageResult[]): unknown[] {
  return usageResultsForJson(results).map((serialized, index) => {
    const source = results[index];
    if (!source?.report || !serialized || typeof serialized !== "object") return serialized;
    const row = serialized as Record<string, unknown>;
    const report = row.report as Record<string, unknown> | undefined;
    if (!report || !Array.isArray(report.entries)) return serialized;
    return {
      ...row,
      report: {
        ...report,
        entries: source.report.entries.map(({ client, ...entry }) => ({ ...entry, ...(client ? { client } : {}) })),
      },
    };
  });
}

/** Retain manifest-listed batches, two recent generations per partition, and
 * a short reader grace period. Readers of older manifests retry against the
 * current manifest if their batch has been swept. Only generations created
 * by this writer (UUID JSON names) are eligible for deletion. */
function collectObsoleteNativeBatches(snapshot: UsageSnapshot): void {
  const nativeRoot = join(aisCacheDir(), "usage", "native");
  const listed = new Set(Object.values(snapshot.partitions)
    .map((partition) => partition.nativeBatch?.path)
    .filter((path): path is string => path !== undefined));
  let partitionDirectories;
  try {
    partitionDirectories = readdirSync(nativeRoot, { withFileTypes: true });
  } catch {
    return;
  }
  const now = Date.now();
  for (const entry of partitionDirectories) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
    const relativeDirectory = `usage/native/${entry.name}`;
    const directory = join(nativeRoot, entry.name);
    let generations;
    try {
      generations = readdirSync(directory, { withFileTypes: true })
        .filter((item) => item.isFile() && /^[0-9a-f-]{36}\.json$/.test(item.name))
        .map((item) => {
          const path = join(directory, item.name);
          try { return { item: item.name, path, mtimeMs: statSync(path).mtimeMs }; }
          catch { return undefined; }
        })
        .filter((item): item is { item: string; path: string; mtimeMs: number } => item !== undefined)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
    } catch {
      continue;
    }
    for (const [index, generation] of generations.entries()) {
      const relativePath = `${relativeDirectory}/${generation.item}`;
      if (listed.has(relativePath) || index < 2 || now - generation.mtimeMs < NATIVE_BATCH_READER_AGE_FLOOR_MS) continue;
      try { unlinkSync(generation.path); } catch { /* another safe cleanup may have won */ }
    }
  }
}

function targetKey(target: UsageTarget): string {
  return usageSnapshotTargetKey(target.toolName, target.identity.name);
}

function safeIdentity(identity: UsageResult["identity"]): UsageResult["identity"] {
  return {
    name: identity.name,
    label: identity.label,
    ...(identity.aliases ? { aliases: identity.aliases } : {}),
  } as UsageResult["identity"];
}

function safeResults(results: UsageResult[]): UsageResult[] {
  return results.map((result) => ({
    ...result,
    nativeBatchCandidate: undefined,
    identity: safeIdentity(result.identity),
    ...(result.error ? { error: "source-error" } : {}),
  }));
}

function errorCategory(results: UsageResult[]): string {
  if (results.some((row) => !isValidUsageResult(row))) return "invalid-result";
  if (results.some((row) => row.sourceOnlyError)) return "source-error";
  return "partial-result";
}

function hasCollectorError(results: UsageResult[]): boolean {
  return results.some((result) => result.error !== undefined || result.sourceOnlyError === true || !isValidUsageResult(result));
}

function reportCountTotals(results: UsageResult[]): { tokens?: number; messages?: number } {
  const reports = results.map((result) => result.report);
  if (reports.some((report) => report === undefined)) return {};
  const concrete = reports as NonNullable<UsageResult["report"]>[];
  const tokenParts = concrete.flatMap((report) => [report.totalInput, report.totalOutput, report.totalCacheRead, report.totalCacheWrite]);
  const tokens = tokenParts.every((value) => Number.isFinite(value) && value >= 0)
    ? tokenParts.reduce((total, value) => total + value, 0)
    : undefined;
  const messages = concrete.every((report) => Number.isFinite(report.totalMessages) && report.totalMessages >= 0)
    ? concrete.reduce((total, report) => total + report.totalMessages, 0)
    : undefined;
  return { ...(tokens === undefined ? {} : { tokens }), ...(messages === undefined ? {} : { messages }) };
}

function isSuspectedHistoryRegression(previous: UsageResult[], incoming: UsageResult[]): boolean {
  // An empty successful scan is a real zero, not missing count metadata. Keep
  // a valid non-empty source partition until an operator reconciles a reset.
  if (previous.length > 0 && incoming.length === 0) return true;
  const before = reportCountTotals(previous);
  const after = reportCountTotals(incoming);
  return (before.tokens !== undefined && after.tokens !== undefined && after.tokens < before.tokens) ||
    (before.messages !== undefined && after.messages !== undefined && after.messages < before.messages);
}

function isValidUsageResult(value: UsageResult): boolean {
  if (!value || typeof value !== "object" || typeof value.provider !== "string" || !value.identity || typeof value.identity.name !== "string") return false;
  if (value.report === undefined) return true;
  const report = value.report;
  const totals = [report.totalInput, report.totalOutput, report.totalCacheRead, report.totalCacheWrite, report.totalMessages, report.totalCost];
  return Array.isArray(report.entries) && totals.every(Number.isFinite) && report.entries.every((entry) =>
    entry && typeof entry.model === "string" && typeof entry.provider === "string" &&
    [entry.input, entry.output, entry.cacheRead, entry.cacheWrite, entry.reasoning, entry.messageCount, entry.cost].every(Number.isFinite));
}

async function defaultCollectTargets(): Promise<UsageTarget[]> {
  return collectTargets({});
}

async function refreshUsageSnapshotOnce(deps: UsageSnapshotDeps): Promise<UsageSnapshot> {
  const path = deps.path ?? USAGE_SNAPSHOT_FILE;
  const releaseLock = await acquireSnapshotLock(path);
  if (!releaseLock) return readSnapshot(path) ?? { schemaVersion: 1, generatedAt: new Date((deps.now ?? Date.now)()).toISOString(), partitions: {} };
  try {
    return await refreshUsageSnapshotLocked(deps, path);
  } finally {
    await releaseLock();
  }
}

async function refreshUsageSnapshotLocked(deps: UsageSnapshotDeps, path: string): Promise<UsageSnapshot> {
  const now = deps.now ?? Date.now;
  const ttl = deps.partitionTtlMs ?? USAGE_SNAPSHOT_PARTITION_TTL_MS;
  const previous = readSnapshot(path) ?? { schemaVersion: 1 as const, generatedAt: new Date(now()).toISOString(), partitions: {} };
  const currentMs = now();
  const attemptedAt = new Date(currentMs).toISOString();
  // Aggregate generation advances only when a successful partition commit
  // changes the canonical projection. Heartbeats and failed attempts keep the
  // previous generation so native and API readers can identify the same data.
  let aggregateGeneratedAt = previous.aggregateGeneratedAt ?? previous.generatedAt;
  const producer = {
    ...previous.producer,
    lastStartedAt: attemptedAt,
    lastHeartbeatAt: attemptedAt,
    lastCycleError: undefined,
    refreshCyclesTotal: (previous.producer?.refreshCyclesTotal ?? 0) + 1,
    refreshCyclesFailedTotal: previous.producer?.refreshCyclesFailedTotal ?? 0,
    sourceScansTotal: previous.producer?.sourceScansTotal ?? 0,
    sourceScanFailuresTotal: previous.producer?.sourceScanFailuresTotal ?? 0,
  };
  const partitions = { ...previous.partitions };
  writeSnapshot({ schemaVersion: 1, generatedAt: attemptedAt, aggregateGeneratedAt, producer, partitions }, path);
  let targets: UsageTarget[];
  try {
    targets = await (deps.collectTargets ?? defaultCollectTargets)();
  } catch {
    partitions["special:discovery"] = {
      results: [], lastAttemptAt: attemptedAt, lastError: "target-discovery-failed", lastErrorAt: attemptedAt,
    };
    const snapshot: UsageSnapshot = { schemaVersion: 1, generatedAt: attemptedAt, aggregateGeneratedAt, producer: { ...producer, lastCompletedAt: attemptedAt, lastCycleError: "target-discovery-failed", refreshCyclesFailedTotal: producer.refreshCyclesFailedTotal + 1 }, partitions };
    writeSnapshot(snapshot, path);
    return snapshot;
  }
  delete partitions["special:discovery"];
  let poolTargets: UsageTarget[] = [];
  try {
    poolTargets = (await (deps.collectPoolTargets ?? (() => collectTargets({}, undefined, { includePools: true })))())
      .filter((target) => target.toolName === "claude" && isSwapPool(target.identity));
    delete partitions["special:pool-discovery"];
  } catch {
    // Keep last-good pool partitions and make discovery failure visible.
    partitions["special:pool-discovery"] = {
      tool: "claude", results: [], lastAttemptAt: attemptedAt,
      lastError: "pool-discovery-failed", lastErrorAt: attemptedAt,
    };
  }
  targets = targets.filter((target) => !isSwapPool(target.identity));
  for (const target of targets) {
    const key = targetKey(target);
    partitions[key] ??= { tool: target.toolName, identity: target.identity.name, nativeCoverage: "pending", results: [], lastAttemptAt: attemptedAt };
  }
  for (const target of poolTargets) {
    const key = targetKey(target);
    partitions[key] ??= { tool: target.toolName, identity: target.identity.name, nativeCoverage: "pending", results: [], lastAttemptAt: attemptedAt };
  }
  partitions[DEFAULT_OPENCODE_PARTITION] ??= { tool: "opencode", nativeCoverage: "pending", results: [], lastAttemptAt: attemptedAt };
  writeSnapshot({ schemaVersion: 1, generatedAt: attemptedAt, aggregateGeneratedAt, producer, partitions }, path);
  const dirtyDirectory = deps.dirtyDirectory ?? usageSnapshotDirtyDirectory;
  const dirtyMarkers = readUsageSnapshotDirtyMarkers(dirtyDirectory);
  const candidateKeys = [
    ...targets.map(targetKey),
    ...poolTargets.map((target) => usageSnapshotTargetKey(target.toolName, target.identity.name)),
    DEFAULT_OPENCODE_PARTITION,
  ];
  const dirtyKeyById = new Map(candidateKeys.map((key) => [usageSnapshotDirtyId(key), key]));
  dirtyKeyById.set(usageSnapshotDirtyId("special:all"), "special:all");
  const forcedKeys = new Set(deps.forcePartitionKeys ?? []);
  for (const marker of dirtyMarkers) {
    const key = dirtyKeyById.get(marker.id);
    if (key === "special:all") for (const candidate of candidateKeys) forcedKeys.add(candidate);
    else if (key) forcedKeys.add(key);
  }
  const dueTargets = targets.filter((target) => {
    const previousPartition = partitions[targetKey(target)];
    const lastSuccess = previousPartition?.lastSuccessAt ? Date.parse(previousPartition.lastSuccessAt) : 0;
    return !previousPartition || currentMs - lastSuccess >= ttl || forcedKeys.has(targetKey(target));
  });
  const nativeSpecs = new Map((await buildNativeSnapshotCaptureSpecs(targets)).map((spec) => [spec.partitionKey, spec]));
  const dueDefaultProfile = (() => {
    const partition = partitions[DEFAULT_OPENCODE_PARTITION];
    return !partition?.lastSuccessAt || currentMs - Date.parse(partition.lastSuccessAt) >= ttl || deps.forcePartitionKeys?.includes(DEFAULT_OPENCODE_PARTITION) === true || forcedKeys.has(DEFAULT_OPENCODE_PARTITION);
  })();
  const dueSwapPools = poolTargets.filter((target) => {
    const key = targetKey(target);
    const partition = partitions[key];
    return !partition?.lastSuccessAt || currentMs - Date.parse(partition.lastSuccessAt) >= ttl || deps.forcePartitionKeys?.includes(key) === true || forcedKeys.has(key);
  });

  const savePartition = async (key: string, tool: string | undefined, identity: string | undefined, results: UsageResult[], nativeCandidate = candidateFromResults(results)) => {
    producer.sourceScansTotal++;
    const prior = partitions[key];
    if (hasCollectorError(results)) {
      producer.sourceScanFailuresTotal++;
      if (nativeCandidate) try { unlinkSync(nativeCandidate.path); } catch { /* no staged export remains */ }
      partitions[key] = {
        ...(tool ? { tool } : {}), ...(identity ? { identity } : {}),
        nativeCoverage: "error",
        results: prior?.results ?? [],
        ...(prior?.nativeBatch ? { nativeBatch: prior.nativeBatch } : {}),
        lastAttemptAt: attemptedAt,
        ...(prior?.lastSuccessAt ? { lastSuccessAt: prior.lastSuccessAt } : {}),
        lastError: errorCategory(results),
        lastErrorAt: attemptedAt,
      };
      writeSnapshot({ schemaVersion: 1, generatedAt: attemptedAt, aggregateGeneratedAt, producer: { ...producer, lastHeartbeatAt: new Date(now()).toISOString() }, partitions }, path);
      return;
    }
    if (prior?.lastSuccessAt && isSuspectedHistoryRegression(prior.results, results)) {
      producer.sourceScanFailuresTotal++;
      if (nativeCandidate) try { unlinkSync(nativeCandidate.path); } catch { /* no staged export remains */ }
      // There is deliberately no force-refresh bypass. To reconcile an
      // intentional source-history reset, back up the manifest, explicitly
      // remove the affected partition, then enqueue a fresh scan to establish
      // its new baseline. Ordinary TTL and dirty refreshes stay protective.
      partitions[key] = {
        ...(tool ? { tool } : {}), ...(identity ? { identity } : {}),
        nativeCoverage: "error",
        results: prior.results,
        ...(prior.nativeBatch ? { nativeBatch: prior.nativeBatch } : {}),
        lastAttemptAt: attemptedAt,
        ...(prior.lastSuccessAt ? { lastSuccessAt: prior.lastSuccessAt } : {}),
        lastError: "suspected-history-regression",
        lastErrorAt: attemptedAt,
      };
      writeSnapshot({ schemaVersion: 1, generatedAt: attemptedAt, aggregateGeneratedAt, producer: { ...producer, lastHeartbeatAt: new Date(now()).toISOString() }, partitions }, path);
      return;
    }
    // A completed report refresh without a native export must not retain a
    // pointer to an older batch beside the new aggregate. Failures above keep
    // the prior report and pointer together; this success path commits the
    // coverage state and batch pointer as one generation.
    let nativeBatch: UsageSnapshotPartition["nativeBatch"];
    let nativeCoverage: UsageSnapshotPartition["nativeCoverage"] = tool === "ali" || tool === "zai" ? "unsupported" : "pending";
    const nativeSpec = nativeSpecs.get(key);
    try {
      if (nativeCandidate) {
        const expectedPartitionId = nativePartitionId(key);
        if (nativeCandidate.partitionId !== expectedPartitionId) throw new Error("native-export-partition-mismatch");
        nativeBatch = promoteNativeBatchFile(nativeCandidate.path, expectedPartitionId);
        nativeCoverage = "supported";
      } else if (nativeSpec) {
        nativeBatch = await captureNativeBatch(nativeSpec, deps);
        nativeCoverage = nativeBatch ? "supported" : "unsupported";
      } else if (tool && nativeExportSupportedInSameRun(tool as UsageTarget["toolName"])) {
        if (!deps.collectTargetResults && !deps.collectSwapPools) throw new Error("native-export-missing");
        nativeCoverage = "unsupported";
      }
    } catch {
      producer.sourceScanFailuresTotal++;
      if (nativeCandidate) try { unlinkSync(nativeCandidate.path); } catch { /* no staged export remains */ }
      partitions[key] = {
        ...(tool ? { tool } : {}), ...(identity ? { identity } : {}), nativeCoverage: "error",
        results: prior?.results ?? [], ...(prior?.nativeBatch ? { nativeBatch: prior.nativeBatch } : {}),
        lastAttemptAt: attemptedAt, ...(prior?.lastSuccessAt ? { lastSuccessAt: prior.lastSuccessAt } : {}),
        lastError: "native-capture-failed", lastErrorAt: attemptedAt,
      };
      writeSnapshot({ schemaVersion: 1, generatedAt: attemptedAt, aggregateGeneratedAt, producer: { ...producer, lastHeartbeatAt: new Date(now()).toISOString() }, partitions }, path);
      return;
    } finally {
      if (nativeCandidate) try { unlinkSync(nativeCandidate.path); } catch { /* promotion removes staged data below */ }
    }
    partitions[key] = {
      ...(tool ? { tool } : {}), ...(identity ? { identity } : {}),
      nativeCoverage,
      results: safeResults(results),
      ...(nativeBatch ? { nativeBatch } : {}),
      lastAttemptAt: attemptedAt,
      lastSuccessAt: attemptedAt,
    };
    aggregateGeneratedAt = attemptedAt;
    writeSnapshot({ schemaVersion: 1, generatedAt: attemptedAt, aggregateGeneratedAt, producer: { ...producer, lastHeartbeatAt: new Date(now()).toISOString() }, partitions }, path);
  };

  if (dueTargets.length > 0) {
    const collect = deps.collectTargetResults ?? ((selected: UsageTarget[], onItemDone: (index: number, results: UsageResult[]) => void) =>
      runUsageQueryForTargets(selected, { onItemDone, deps: { nativeExportForTarget: (target) => nativeExportForTarget(target) } }));
    const recorded = new Set<number>();
    try {
      await collect(dueTargets, async (index, results) => {
        const target = dueTargets[index];
        if (!target) return;
        recorded.add(index);
        await savePartition(targetKey(target), target.toolName, target.identity.name, results);
      });
    } catch {
      // Completed callbacks have already been durably saved. Remaining
      // identities keep their prior rows and receive a safe error category.
    }
    // A collector that omits a completion callback is a partial scan. Keep
    // any existing last-good rows and record the missing result as an error.
    for (let index = 0; index < dueTargets.length; index++) {
      if (recorded.has(index)) continue;
      const target = dueTargets[index]!;
      await savePartition(targetKey(target), target.toolName, target.identity.name, [{
        provider: "unattributed", identity: safeIdentity(target.identity), sourceOnlyError: true, error: "source-error",
      }]);
    }
  }

  const specialJobs: Array<{ due: boolean; key: string; tool: string; collect: () => Promise<UsageResult[]> }> = [
    { due: dueDefaultProfile, key: DEFAULT_OPENCODE_PARTITION, tool: "opencode", collect: deps.collectDefaultProfile ?? defaultOpencodeProfileUsageResults },
  ];
  for (const job of specialJobs) {
    if (!job.due) continue;
    try {
      const results = await job.collect();
      await savePartition(job.key, job.tool, undefined, results);
    } catch (error) {
      producer.sourceScansTotal++;
      producer.sourceScanFailuresTotal++;
      const prior = partitions[job.key];
      partitions[job.key] = {
        tool: job.tool, nativeCoverage: "error", results: prior?.results ?? [], lastAttemptAt: attemptedAt,
        ...(prior?.nativeBatch ? { nativeBatch: prior.nativeBatch } : {}),
        ...(prior?.lastSuccessAt ? { lastSuccessAt: prior.lastSuccessAt } : {}),
        lastError: "source-error",
        lastErrorAt: attemptedAt,
      };
    }
    writeSnapshot({ schemaVersion: 1, generatedAt: attemptedAt, aggregateGeneratedAt, producer: { ...producer, lastHeartbeatAt: new Date(now()).toISOString() }, partitions }, path);
  }

  if (dueSwapPools.length > 0) {
    const dueNames = new Set(dueSwapPools.map((target) => target.identity.name));
    const onPoolDone = async (pool: UsageTarget["identity"], results: UsageResult[], failed = false, nativeCandidate?: UsageResult["nativeBatchCandidate"]) => {
      if (!dueNames.has(pool.name)) return;
      const key = targetKey({ toolName: "claude", identity: pool });
      if (failed) {
        producer.sourceScansTotal++;
        producer.sourceScanFailuresTotal++;
        const prior = partitions[key];
        partitions[key] = {
          tool: "claude", identity: pool.name, nativeCoverage: "error", results: prior?.results ?? [], lastAttemptAt: attemptedAt,
          ...(prior?.nativeBatch ? { nativeBatch: prior.nativeBatch } : {}),
          ...(prior?.lastSuccessAt ? { lastSuccessAt: prior.lastSuccessAt } : {}),
          lastError: "source-error", lastErrorAt: attemptedAt,
        };
        writeSnapshot({ schemaVersion: 1, generatedAt: attemptedAt, aggregateGeneratedAt, producer: { ...producer, lastHeartbeatAt: new Date(now()).toISOString() }, partitions }, path);
        return;
      }
      await savePartition(key, "claude", pool.name, results, nativeCandidate ?? candidateFromResults(results));
    };
    try {
      if (deps.collectSwapPools) {
        await deps.collectSwapPools(onPoolDone);
      } else {
        await swapPoolUsageResults({}, undefined,
          async (target, suppression) => {
            const nativeExport = await nativeExportForTarget(target);
            const results = await runTokscaleForUsageTarget(target, suppression, { nativeExportForTarget: async () => nativeExport });
            if (nativeExport && !candidateFromResults(results)) {
              return results.length
                ? results.map((result) => ({ ...result, sourceOnlyError: true as const, error: "native-capture-failed" }))
                : [{ provider: "anthropic", identity: target.identity, sourceOnlyError: true, error: "native-capture-failed" }];
            }
            return results;
          },
          onPoolDone, dueNames);
      }
      for (const pool of dueSwapPools) {
        const key = targetKey(pool);
        if (partitions[key]?.lastAttemptAt === attemptedAt) continue;
        onPoolDone(pool.identity, [], true);
      }
    } catch {
      for (const pool of dueSwapPools) {
        const key = targetKey(pool);
        if (partitions[key]?.lastAttemptAt !== attemptedAt) onPoolDone(pool.identity, [], true);
      }
    }
  }

  const cycleFailed = Object.values(partitions).some((partition) => partition.lastAttemptAt === attemptedAt && partition.lastError !== undefined);
  const snapshot: UsageSnapshot = {
    schemaVersion: 1,
    generatedAt: attemptedAt,
    aggregateGeneratedAt,
    producer: {
      ...producer,
      lastHeartbeatAt: new Date(now()).toISOString(),
      lastCompletedAt: new Date(now()).toISOString(),
      ...(cycleFailed ? { lastCycleError: "partition-refresh-failed", refreshCyclesFailedTotal: producer.refreshCyclesFailedTotal + 1 } : { lastCycleError: undefined }),
    },
    partitions,
  };
  writeSnapshot(snapshot, path);
  acknowledgeUsageSnapshotDirty(dirtyMarkers.filter((marker) => {
    const key = dirtyKeyById.get(marker.id);
    if (key === "special:all") return candidateKeys.every((candidate) => partitions[candidate]?.lastAttemptAt === attemptedAt && partitions[candidate]?.lastError === undefined);
    return key !== undefined && partitions[key]?.lastAttemptAt === attemptedAt && partitions[key]?.lastError === undefined;
  }), dirtyDirectory);
  return snapshot;
}

export function readUsageSnapshotEnvelope(
  tool?: string,
  identity?: string,
  path = USAGE_SNAPSHOT_FILE,
  now = Date.now(),
): UsageSnapshotEnvelope | undefined {
  const snapshot = readSnapshot(path);
  if (!snapshot) return undefined;
  const toolConfig = tool === undefined ? undefined : toolConfigFromFlag({ tool });
  const matching = Object.entries(snapshot.partitions).filter(([key, partition]) => {
    if (toolConfig && partition.tool !== toolConfig.toolName) return false;
    if (identity !== undefined) {
      const matchesIdentity = partition.identity === identity || partition.results.some((result) => result.identity.name === identity || result.identity.aliases?.includes(identity));
      if (!matchesIdentity) return false;
    }
    // The unscoped OpenCode profile is included in unfiltered and opencode
    // views, while Claude swap attribution follows its member identities.
    if (key === DEFAULT_OPENCODE_PARTITION && toolConfig && toolConfig.toolName !== "opencode") return false;
    if (key.startsWith("target:claude-swap-pool:") && toolConfig && toolConfig.toolName !== "claude") return false;
    return true;
  });
  const scopedRows = identity === undefined ? matching.flatMap(([, partition]) => partition.results) : matching.flatMap(([, partition]) =>
    partition.results.filter((result) => result.identity.name === identity || result.identity.aliases?.includes(identity)));
  const results = aggregateUsageResults(scopedRows);
  const successfulTimes = matching.map(([, partition]) => partition.lastSuccessAt ? Date.parse(partition.lastSuccessAt) : undefined).filter((value): value is number => value !== undefined);
  const errors = matching.map(([, partition]) => partition.lastError ? { error: partition.lastError, at: partition.lastErrorAt ?? partition.lastAttemptAt } : undefined).filter((value): value is { error: string; at: string } => value !== undefined);
  const lastSuccess = successfulTimes.length ? Math.min(...successfulTimes) : undefined;
  const pending = matching.length === 0 || matching.some(([, partition]) => partition.lastSuccessAt === undefined);
  const nativeCoverage = matching.reduce((coverage, [, partition]) => {
    coverage[partition.nativeCoverage ?? "pending"]++;
    return coverage;
  }, { supported: 0, unsupported: 0, error: 0, pending: 0 });
  return {
    results: usageResultsForJson(results),
    generatedAt: snapshot.aggregateGeneratedAt ?? snapshot.generatedAt,
    stale: lastSuccess === undefined || now - lastSuccess >= USAGE_SNAPSHOT_PARTITION_TTL_MS || errors.length > 0 || pending,
    ...(lastSuccess !== undefined ? { lastSuccessAt: new Date(lastSuccess).toISOString() } : {}),
    pending,
    nativeCoverage,
    ...(errors.length ? { lastError: errors.map((entry) => entry.error).join("; "), lastErrorAt: new Date(Math.max(...errors.map((entry) => Date.parse(entry.at)))).toISOString() } : {}),
  };
}

/** One refresh at a time in this process. A timer tick or cold CLI request
 * arriving during a scan shares its result instead of starting a second
 * history read. */
export function refreshUsageSnapshot(deps: UsageSnapshotDeps = {}): Promise<UsageSnapshot> {
  if (activeRefresh) return activeRefresh;
  activeRefresh = refreshUsageSnapshotOnce(deps).finally(() => { activeRefresh = undefined; });
  return activeRefresh;
}

/** Ask an isolated worker to refresh the canonical store without keeping a
 * CLI caller alive. The worker has the same bounded Tokscale subprocess
 * limits as the daemon-owned scan path. */
export function startUsageSnapshotRefreshInBackground(): boolean {
  if (externalUsageCollectorOwnsRefreshes()) {
    try {
      ensureUsageSnapshotDirty("special:all");
      return true;
    } catch {
      return false;
    }
  }
  const main = Bun.main;
  const isScript = /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(main) && (() => { try { return statSync(main).isFile(); } catch { return false; } })();
  const inner = isScript ? [process.execPath, main] : [process.execPath];
  const setsid = Bun.which("setsid");
  const args = setsid ? [setsid, ...inner] : inner;
  try {
    const proc = withUsableCwd(() => Bun.spawn(args.concat("__scan_worker"), {
      stdin: "pipe", stdout: "ignore", stderr: "ignore", detached: true,
    }));
    proc.stdin.write(JSON.stringify({ kind: "usageSnapshotRefresh" }));
    proc.stdin.end();
    (proc as unknown as { unref?: () => void }).unref?.();
    return true;
  } catch {
    return false;
  }
}

/** Request freshness without doing work in an API handler. In external mode,
 * a host service owns collection, so this only writes a coalesced marker. */
export function requestUsageSnapshotRefresh(): boolean {
  if (externalUsageCollectorOwnsRefreshes()) {
    try {
      ensureUsageSnapshotDirty("special:all");
      return true;
    } catch {
      return false;
    }
  }
  return true;
}

export const usageSnapshotPath = USAGE_SNAPSHOT_FILE;
