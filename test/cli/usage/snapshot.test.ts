import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  acquireSnapshotLock,
  externalUsageCollectorOwnsRefreshes,
  recordUsageSnapshotRefreshFailure,
  readUsageSnapshotEnvelope,
  refreshUsageSnapshot,
  USAGE_SNAPSHOT_DIRTY_MIN_INTERVAL_MS,
  validateNativeBatchEnvelope,
  type UsageSnapshotDeps,
} from "../../../src/cli/usage/snapshot.ts";
import { acknowledgeUsageSnapshotDirty, markUsageSnapshotDirty, readUsageSnapshotDirtyMarkers, usageSnapshotTargetKey } from "../../../src/cli/usage/snapshot-dirty.ts";
import { readUsageSnapshotMetricsStatus } from "../../../src/cli/usage/snapshot-status.ts";
import type { UsageResult, UsageTarget } from "../../../src/cli/usage/run.ts";

const dirs: string[] = [];
async function snapshotFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ais-usage-snapshot-"));
  dirs.push(dir);
  return join(dir, "usage", "snapshot.json");
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const identity = { name: "work", label: "Work", configDir: "/not-persisted", env: { TOKEN: "not-persisted" } } as UsageTarget["identity"];
const target: UsageTarget = { toolName: "claude", identity };
const result = (messages: number, id = identity): UsageResult => ({
  provider: "anthropic",
  identity: id,
  report: {
    entries: [], totalInput: messages, totalOutput: 0, totalCacheRead: 0,
    totalCacheWrite: 0, totalMessages: messages, totalCost: 0,
  },
});

function deps(path: string, options: { now: number; results: UsageResult[]; fail?: boolean }): UsageSnapshotDeps {
  return {
    path,
    dirtyDirectory: join(dirname(path), "dirty"),
    now: () => options.now,
    partitionTtlMs: 60_000,
    collectTargets: async () => [target],
    collectPoolTargets: async () => [],
    collectTargetResults: async (_targets: UsageTarget[], done: (index: number, results: UsageResult[]) => void) => {
      if (options.fail) {
        done(0, [{ ...result(0), sourceOnlyError: true, error: "secret-like-provider-error" }]);
      } else {
        done(0, options.results);
      }
      return [];
    },
    collectDefaultProfile: async () => [],
    collectSwapPools: async () => [],
    captureNative: async (spec: { partitionKey: string; partitionId: string }) => ({
      path: `usage/native/${spec.partitionId}/fixture.json`, sha256: "a".repeat(64),
      generatedAt: new Date(options.now).toISOString(), partitionId: spec.partitionId,
    }),
  };
}

describe("shared usage snapshot", () => {
  test("native batch envelope fixtures require the exact partition and a complete message list", () => {
    const partitionId = "a".repeat(64);
    const valid = {
      schemaVersion: 1, partitionId, generatedAt: "2026-01-01T00:00:00.000Z",
      complete: true, messages: [{ client: "claude", model: "model-x" }],
    };
    expect(validateNativeBatchEnvelope(valid, partitionId)).toBe(valid.generatedAt);
    expect(() => validateNativeBatchEnvelope({ ...valid, partitionId: "b".repeat(64) }, partitionId)).toThrow("invalid-native-batch");
    expect(() => validateNativeBatchEnvelope({ ...valid, complete: false }, partitionId)).toThrow("invalid-native-batch");
    expect(() => validateNativeBatchEnvelope({ ...valid, messages: [null] }, partitionId)).toThrow("invalid-native-batch");
  });

  test("native capture failures persist safe stage and error details for missing and invalid candidates", async () => {
    const now = Date.UTC(2026, 0, 1);
    const path = await snapshotFile();
    const key = usageSnapshotTargetKey("claude", identity.name);
    const partitionId = createHash("sha256").update(`ais-native-partition-v1\0${key}`).digest("hex");
    const candidatePath = join(dirname(path), "private-profile-secret.json");
    const nativeBatchCandidate = { path: candidatePath, partitionId };
    const candidateResults = [{ ...result(5), nativeBatchCandidate }];
    const runCandidate = async () => refreshUsageSnapshot({
      ...deps(path, { now, results: candidateResults }),
      forcePartitionKeys: [key],
    });

    await runCandidate();
    let snapshot = JSON.parse(await readFile(path, "utf8")) as {
      partitions: Record<string, { nativeFailure?: { stage: string; errorClass: string; errorCode?: string } }>;
    };
    expect(snapshot.partitions[key]?.nativeFailure).toEqual({
      stage: "candidate-read", errorClass: "Error", errorCode: "ENOENT",
    });
    expect(await readFile(path, "utf8")).not.toContain("private-profile-secret");

    await writeFile(candidatePath, "{ malformed json");
    await runCandidate();
    snapshot = JSON.parse(await readFile(path, "utf8")) as typeof snapshot;
    expect(snapshot.partitions[key]?.nativeFailure).toEqual({ stage: "candidate-json-parse", errorClass: "SyntaxError" });

    const malformedEnvelope = {
      schemaVersion: 1, partitionId, generatedAt: new Date(now).toISOString(), complete: false, messages: [],
    };
    await writeFile(candidatePath, JSON.stringify(malformedEnvelope));
    await runCandidate();
    snapshot = JSON.parse(await readFile(path, "utf8")) as typeof snapshot;
    expect(snapshot.partitions[key]?.nativeFailure).toEqual({ stage: "candidate-envelope-validation", errorClass: "Error" });

    await writeFile(candidatePath, JSON.stringify({ ...malformedEnvelope, complete: true }));
    const mismatchedResults = [{ ...result(5), nativeBatchCandidate: { path: candidatePath, partitionId: "b".repeat(64) } }];
    await refreshUsageSnapshot({
      ...deps(path, { now, results: mismatchedResults }),
      forcePartitionKeys: [key],
    });
    snapshot = JSON.parse(await readFile(path, "utf8")) as typeof snapshot;
    expect(snapshot.partitions[key]?.nativeFailure).toEqual({ stage: "partition-id-mismatch", errorClass: "Error" });
  });

  test("empty report rows retain their separately supplied native export candidate", async () => {
    const now = Date.UTC(2026, 0, 1);
    const path = await snapshotFile();
    const key = usageSnapshotTargetKey("claude", identity.name);
    const partitionId = createHash("sha256").update(`ais-native-partition-v1\0${key}`).digest("hex");
    const candidate = { path: join(dirname(path), "empty-report-native.json"), partitionId };
    const nativeBatchRoot = join(dirname(path), "native-batches");
    await refreshUsageSnapshot({
      ...deps(path, { now, results: [] }),
      nativeBatchRoot,
      forcePartitionKeys: [key],
      prepareNativeExportCandidate: async () => candidate,
      collectTargetResults: async (targets, onItemDone, prepareNativeExport) => {
        expect(prepareNativeExport).toBeDefined();
        const prepared = await prepareNativeExport!(targets[0]!);
        expect(prepared).toEqual(candidate);
        await writeFile(candidate.path, JSON.stringify({
          schemaVersion: 1, partitionId, generatedAt: new Date(now).toISOString(), complete: true, messages: [],
        }));
        onItemDone(0, []);
        return [];
      },
    });

    const snapshot = JSON.parse(await readFile(path, "utf8")) as {
      partitions: Record<string, { nativeCoverage?: string; nativeBatch?: { path: string; partitionId: string }; nativeFailure?: unknown; lastSuccessAt?: string }>;
    };
    expect(snapshot.partitions[key]?.nativeCoverage).toBe("supported");
    expect(snapshot.partitions[key]?.nativeBatch?.partitionId).toBe(partitionId);
    expect(snapshot.partitions[key]?.nativeBatch?.path).toMatch(/^usage\/native\//);
    expect(snapshot.partitions[key]?.nativeFailure).toBeUndefined();
    expect(snapshot.partitions[key]?.lastSuccessAt).toBe(new Date(now).toISOString());
    expect(await Bun.file(join(nativeBatchRoot, partitionId, basename(snapshot.partitions[key]!.nativeBatch!.path))).exists()).toBe(true);
  });

  test("empty swap-pool report rows retain their native export candidate", async () => {
    const now = Date.UTC(2026, 0, 1);
    const path = await snapshotFile();
    const pool = { ...identity, name: "pool", swapPool: { accounts: [identity.name], active: identity.name } };
    const poolTarget: UsageTarget = { toolName: "claude", identity: pool };
    const key = usageSnapshotTargetKey("claude", pool.name);
    const partitionId = createHash("sha256").update(`ais-native-partition-v1\0${key}`).digest("hex");
    const candidate = { path: join(dirname(path), "empty-pool-native.json"), partitionId };
    const nativeBatchRoot = join(dirname(path), "native-batches");
    await refreshUsageSnapshot({
      ...deps(path, { now, results: [] }),
      nativeBatchRoot,
      collectTargets: async () => [],
      collectPoolTargets: async () => [poolTarget],
      collectSwapPools: async (onPoolDone, prepareNativeExport) => {
        await prepareNativeExport!(poolTarget);
        await writeFile(candidate.path, JSON.stringify({
          schemaVersion: 1, partitionId, generatedAt: new Date(now).toISOString(), complete: true, messages: [],
        }));
        await onPoolDone(pool, []);
        return [];
      },
      prepareNativeExportCandidate: async () => candidate,
    });

    const snapshot = JSON.parse(await readFile(path, "utf8")) as {
      partitions: Record<string, { nativeCoverage?: string; nativeBatch?: { path: string; partitionId: string }; nativeFailure?: unknown; lastSuccessAt?: string }>;
    };
    expect(snapshot.partitions[key]?.nativeCoverage).toBe("supported");
    expect(snapshot.partitions[key]?.nativeBatch?.partitionId).toBe(partitionId);
    expect(snapshot.partitions[key]?.nativeFailure).toBeUndefined();
    expect(snapshot.partitions[key]?.lastSuccessAt).toBe(new Date(now).toISOString());
  });

  test("Codex Bedrock report partitions are explicitly report-only for native coverage", async () => {
    const now = Date.UTC(2026, 0, 1);
    const path = await snapshotFile();
    const bedrockIdentity = { ...identity, name: "bedrock", env: { CLAUDE_CODE_USE_BEDROCK: "1" } };
    const bedrockTarget: UsageTarget = { toolName: "codex", identity: bedrockIdentity };
    const key = usageSnapshotTargetKey("codex", bedrockIdentity.name);
    await refreshUsageSnapshot({
      ...deps(path, { now, results: [result(1, bedrockIdentity)] }),
      collectTargets: async () => [bedrockTarget],
      collectTargetResults: async (_targets, onItemDone) => {
        onItemDone(0, [result(1, bedrockIdentity)]);
        return [];
      },
    });
    const snapshot = JSON.parse(await readFile(path, "utf8")) as {
      partitions: Record<string, { nativeCoverage?: string; results: UsageResult[] }>;
    };
    expect(snapshot.partitions[key]?.nativeCoverage).toBe("unsupported");
    expect(snapshot.partitions[key]?.results).toHaveLength(1);
  });

  test("restart reads persisted last-good data without another collection", async () => {
    const path = await snapshotFile();
    await refreshUsageSnapshot(deps(path, { now: Date.UTC(2026, 0, 1), results: [result(4)] }));

    const restarted = readUsageSnapshotEnvelope(undefined, undefined, path, Date.UTC(2026, 0, 1) + 1);
    expect(restarted?.results).toHaveLength(1);
    expect(restarted?.pending).toBe(false);
    expect(restarted?.stale).toBe(false);
    expect(await stat(path).then((item) => item.mode & 0o777)).toBe(0o600);
    const text = await readFile(path, "utf8");
    expect(text).not.toContain("/not-persisted");
    expect(text).not.toContain("not-persisted");
  });

  test("snapshot status records producer cycles and source scans for scrape consumers", async () => {
    const path = await snapshotFile();
    await refreshUsageSnapshot(deps(path, { now: Date.UTC(2026, 0, 1), results: [result(4)] }));
    const status = readUsageSnapshotMetricsStatus(path);
    expect(status.refreshCyclesTotal).toBe(1);
    expect(status.sourceScansTotal).toBe(2);
    expect(status.sourceScanFailuresTotal).toBe(0);
    expect(status.producerStartedAt).toBe(new Date(Date.UTC(2026, 0, 1)).toISOString());
  });

  test("persistent external collector sentinel is honoured without its environment flag", async () => {
    const path = await snapshotFile();
    const marker = join(dirname(path), "collector.external");
    const previous = process.env.AIS_USAGE_COLLECTOR_MODE;
    try {
      delete process.env.AIS_USAGE_COLLECTOR_MODE;
      await mkdir(dirname(marker), { recursive: true });
      await writeFile(marker, "old-daemon-pid\n");
      expect(externalUsageCollectorOwnsRefreshes(marker)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.AIS_USAGE_COLLECTOR_MODE;
      else process.env.AIS_USAGE_COLLECTOR_MODE = previous;
    }
  });

  const oldIdentity = { name: "old", label: "Old", configDir: "/not-persisted", env: {} } as UsageTarget["identity"];
  const oldTarget: UsageTarget = { toolName: "claude", identity: oldIdentity };
  const multi = (path: string, now: number, targets: UsageTarget[]): UsageSnapshotDeps => ({
    ...deps(path, { now, results: [] }),
    collectTargets: async () => targets,
    collectTargetResults: async (list, done) => {
      list.forEach((item, index) => done(index, [result(item === oldTarget ? 5 : 1, item.identity)]));
      return [];
    },
  });

  test("retired identity partitions keep their results but never make the envelope stale", async () => {
    const path = await snapshotFile();
    const t0 = Date.UTC(2026, 0, 1);
    await refreshUsageSnapshot(multi(path, t0, [target, oldTarget]));
    const later = t0 + 10 * 24 * 3_600_000;
    const snapshot = await refreshUsageSnapshot(multi(path, later, [target]));
    const retired = snapshot.partitions[usageSnapshotTargetKey("claude", "old")]!;
    expect(retired.retired).toBe(true);
    expect(retired.results.length).toBe(1);
    expect(snapshot.partitions[usageSnapshotTargetKey("claude", "work")]!.retired).toBeUndefined();
    const envelope = readUsageSnapshotEnvelope(undefined, undefined, path, later + 1000)!;
    expect(envelope.stale).toBe(false);
    expect(envelope.pending).toBe(false);
    expect(envelope.lastSuccessAt).not.toBe(retired.lastSuccessAt);
    expect((envelope.results as UsageResult[]).reduce((sum, row) => sum + row.report!.totalMessages, 0)).toBe(6);
  });

  test("a retired partition whose target returns is un-retired and refreshed", async () => {
    const path = await snapshotFile();
    const t0 = Date.UTC(2026, 0, 1);
    await refreshUsageSnapshot(multi(path, t0, [target, oldTarget]));
    await refreshUsageSnapshot(multi(path, t0 + 120_000, [target]));
    const back = t0 + 240_000;
    const snapshot = await refreshUsageSnapshot(multi(path, back, [target, oldTarget]));
    const revived = snapshot.partitions[usageSnapshotTargetKey("claude", "old")]!;
    expect(revived.retired).toBeUndefined();
    expect(Date.parse(revived.lastSuccessAt!)).toBe(back);
  });

  test("newly discovered identities are visible as pending while their first scan runs", async () => {
    const path = await snapshotFile();
    let releaseScan!: () => void;
    let started!: () => void;
    const scanning = new Promise<void>((resolve) => { started = resolve; });
    const scanGate = new Promise<void>((resolve) => { releaseScan = resolve; });
    const refresh = refreshUsageSnapshot({
      ...deps(path, { now: Date.UTC(2026, 0, 1), results: [result(1)] }),
      collectTargetResults: async (_targets, done) => {
        started();
        await scanGate;
        done(0, [result(1)]);
        return [];
      },
    });
    await scanning;
    const pending = readUsageSnapshotEnvelope("claude", "work", path);
    expect(pending?.pending).toBe(true);
    expect(pending?.stale).toBe(true);
    releaseScan();
    await refresh;
  });

  test("successful partition freshness starts at commit completion while attempts retain cycle start", async () => {
    const path = await snapshotFile();
    const startedAt = Date.UTC(2026, 0, 1);
    let currentMs = startedAt;
    const key = usageSnapshotTargetKey("claude", identity.name);
    await refreshUsageSnapshot({
      ...deps(path, { now: startedAt, results: [result(4)] }),
      now: () => currentMs,
      collectTargetResults: async (_targets, done) => {
        // Simulate a source that takes longer than the cache TTL to finish.
        currentMs += 75_000;
        done(0, [result(4)]);
        return [];
      },
    });

    const persisted = JSON.parse(await readFile(path, "utf8")) as {
      aggregateGeneratedAt: string;
      partitions: Record<string, { lastAttemptAt: string; lastSuccessAt?: string }>;
    };
    expect(persisted.partitions[key]?.lastAttemptAt).toBe(new Date(startedAt).toISOString());
    expect(persisted.partitions[key]?.lastSuccessAt).toBe(new Date(currentMs).toISOString());
    expect(persisted.aggregateGeneratedAt).toBe(new Date(currentMs).toISOString());
    expect(readUsageSnapshotEnvelope("claude", "work", path, currentMs + 1)?.stale).toBe(false);
  });

  test("swap-pool scans mark missing callbacks failed whether the collector resolves or rejects", async () => {
    for (const rejects of [false, true]) {
      const path = await snapshotFile();
      const startedAt = Date.UTC(2026, 0, 1) + (rejects ? 1 : 0);
      const pool = { ...identity, name: rejects ? "pool-reject" : "pool-resolve", swapPool: { accounts: [identity.name], active: identity.name } };
      const poolTarget: UsageTarget = { toolName: "claude", identity: pool };
      const key = usageSnapshotTargetKey("claude", pool.name);
      await refreshUsageSnapshot({
        ...deps(path, { now: startedAt, results: [] }),
        collectTargets: async () => [],
        collectPoolTargets: async () => [poolTarget],
        collectSwapPools: async () => {
          if (rejects) throw new Error("collector failed without callback");
          return [];
        },
      });

      const persisted = JSON.parse(await readFile(path, "utf8")) as {
        producer?: { refreshCyclesFailedTotal?: number };
        partitions: Record<string, { lastAttemptAt: string; lastSuccessAt?: string; lastError?: string; nativeCoverage?: string }>;
      };
      expect(persisted.partitions[key]?.lastAttemptAt).toBe(new Date(startedAt).toISOString());
      expect(persisted.partitions[key]?.lastSuccessAt).toBeUndefined();
      expect(persisted.partitions[key]?.lastError).toBe("source-error");
      expect(persisted.partitions[key]?.nativeCoverage).toBe("error");
      expect(persisted.producer?.refreshCyclesFailedTotal).toBe(1);
    }
  });

  test("isolated worker failure preserves last-good data and completes an unfinished cycle once", async () => {
    const path = await snapshotFile();
    const startedAt = Date.UTC(2026, 0, 1);
    await refreshUsageSnapshot(deps(path, { now: startedAt, results: [result(9)] }));
    const key = usageSnapshotTargetKey("claude", "work");
    const freshKey = usageSnapshotTargetKey("claude", "new-identity");
    const persisted = JSON.parse(await readFile(path, "utf8")) as {
      generatedAt: string;
      aggregateGeneratedAt?: string;
      producer: Record<string, unknown>;
      partitions: Record<string, { results?: UsageResult[]; [key: string]: unknown }>;
    };
    const previousAggregateGeneration = persisted.aggregateGeneratedAt;
    const previousRows = persisted.partitions[key]?.results;
    const nativeBatch = {
      path: "usage/native/fixture/last-good.json", partitionId: "a".repeat(64),
      generatedAt: new Date(startedAt).toISOString(), sha256: "b".repeat(64),
    };
    persisted.partitions[key]!.nativeBatch = nativeBatch;
    const cycleStartedAt = new Date(startedAt + 10_000).toISOString();
    persisted.producer.lastStartedAt = cycleStartedAt;
    persisted.producer.lastCompletedAt = new Date(startedAt + 5_000).toISOString();
    persisted.partitions[freshKey] = {
      tool: "claude", identity: "new-identity", nativeCoverage: "pending", results: [], lastAttemptAt: cycleStartedAt,
    };
    await writeFile(path, JSON.stringify(persisted));

    const failed = await recordUsageSnapshotRefreshFailure("collector-timeout", {
      path, now: () => startedAt + 20_000,
    });
    expect(failed?.partitions[key]?.results).toEqual(previousRows);
    expect(failed?.partitions[key]?.nativeBatch).toEqual(nativeBatch);
    expect(failed?.aggregateGeneratedAt).toBe(previousAggregateGeneration);
    expect(failed?.partitions[freshKey]?.lastError).toBe("source-interrupted");
    expect(failed?.partitions[freshKey]?.nativeCoverage).toBe("error");
    expect(failed?.producer?.lastCycleError).toBe("collector-timeout");
    expect(failed?.producer?.lastCompletedAt).toBe(new Date(startedAt + 20_000).toISOString());
    expect(failed?.producer?.refreshCyclesFailedTotal).toBe(1);

    const completedBytes = await readFile(path, "utf8");
    expect(await recordUsageSnapshotRefreshFailure("collector-failed", { path, now: () => startedAt + 30_000 })).toBeUndefined();
    expect(await readFile(path, "utf8")).toBe(completedBytes);
  });

  test("isolated worker failure does not overwrite a snapshot while its writer lock is held", async () => {
    const path = await snapshotFile();
    const startedAt = Date.UTC(2026, 0, 1);
    await refreshUsageSnapshot(deps(path, { now: startedAt, results: [result(2)] }));
    const snapshot = JSON.parse(await readFile(path, "utf8")) as { producer: Record<string, unknown> };
    snapshot.producer.lastStartedAt = new Date(startedAt + 10_000).toISOString();
    snapshot.producer.lastCompletedAt = new Date(startedAt + 5_000).toISOString();
    await writeFile(path, JSON.stringify(snapshot));
    const before = await readFile(path, "utf8");
    const release = await acquireSnapshotLock(path);
    expect(release).toBeDefined();
    try {
      expect(await recordUsageSnapshotRefreshFailure("collector-rejected", { path, now: () => startedAt + 20_000 })).toBeUndefined();
      expect(await readFile(path, "utf8")).toBe(before);
    } finally {
      await release?.();
    }
  });

  test("a dirty source publishes appended usage without a read-triggered scan", async () => {
    const path = await snapshotFile();
    const now = Date.UTC(2026, 0, 1);
    await refreshUsageSnapshot(deps(path, { now, results: [result(1)] }));
    let calls = 0;
    const appended = deps(path, { now: now + 1, results: [result(2)] });
    appended.collectTargetResults = async (_targets, done) => {
      calls++;
      done(0, [result(2)]);
      return [];
    };

    const filtered = readUsageSnapshotEnvelope("claude", "work", path, now + 1);
    expect(filtered?.results).toHaveLength(1);
    expect(calls).toBe(0);
    markUsageSnapshotDirty(usageSnapshotTargetKey("claude", "work"), join(dirname(path), "dirty"));
    await refreshUsageSnapshot(appended);
    // Inside the dirty window the full re-export is deferred; the marker survives for later.
    expect(calls).toBe(0);
    const later = now + USAGE_SNAPSHOT_DIRTY_MIN_INTERVAL_MS;
    await refreshUsageSnapshot({ ...appended, now: () => later });
    expect(calls).toBe(1);
    expect(readUsageSnapshotEnvelope("claude", "work", path, later + 1)?.results).toHaveLength(1);
  });

  test("failed scans preserve last-good results and persist only a safe error category", async () => {
    const path = await snapshotFile();
    const now = Date.UTC(2026, 0, 1);
    await refreshUsageSnapshot(deps(path, { now, results: [result(7)] }));
    markUsageSnapshotDirty(usageSnapshotTargetKey("claude", "work"), join(dirname(path), "dirty"));
    const failedAt = now + 1;
    await refreshUsageSnapshot({ ...deps(path, { now: failedAt, results: [], fail: true }), dirtyMinIntervalMs: 0 });

    const envelope = readUsageSnapshotEnvelope(undefined, undefined, path, failedAt + 1);
    const persisted = JSON.parse(await readFile(path, "utf8")) as { aggregateGeneratedAt: string; generatedAt: string };
    expect(envelope?.results).toHaveLength(1);
    expect(envelope?.lastError).toBe("source-error");
    expect(envelope?.stale).toBe(true);
    expect(envelope?.generatedAt).toBe(new Date(now).toISOString());
    expect(persisted.aggregateGeneratedAt).toBe(new Date(now).toISOString());
    expect(persisted.generatedAt).toBe(new Date(failedAt).toISOString());
    expect(await readFile(path, "utf8")).not.toContain("secret-like-provider-error");
  });

  test("a successful scan with lower totals than the prior snapshot is committed", async () => {
    const path = await snapshotFile();
    const now = Date.UTC(2026, 0, 1);
    const key = usageSnapshotTargetKey("claude", "work");
    await refreshUsageSnapshot(deps(path, { now, results: [result(12)] }));
    await refreshUsageSnapshot({ ...deps(path, { now: now + 1, results: [result(8)] }), forcePartitionKeys: [key] });
    const next = JSON.parse(await readFile(path, "utf8")) as {
      partitions: Record<string, { results: UsageResult[]; lastError?: string }>;
    };
    expect(next.partitions[key]?.results[0]?.report?.totalInput).toBe(8);
    expect(next.partitions[key]?.lastError).toBeUndefined();
    expect(readUsageSnapshotEnvelope("claude", "work", path, now + 2)?.lastError).toBeUndefined();
  });

  test("cost-only repricing decreases are accepted when counts are unchanged", async () => {
    const path = await snapshotFile();
    const now = Date.UTC(2026, 0, 1);
    const key = usageSnapshotTargetKey("claude", "work");
    await refreshUsageSnapshot(deps(path, { now, results: [result(7)] }));
    const lowerCost = result(7);
    lowerCost.report!.totalCost = 0.01;
    await refreshUsageSnapshot({
      ...deps(path, { now: now + 1, results: [lowerCost] }),
      forcePartitionKeys: [key],
    });

    const persisted = JSON.parse(await readFile(path, "utf8")) as { partitions: Record<string, { results: UsageResult[] }> };
    const envelope = readUsageSnapshotEnvelope("claude", "work", path, now + 2);
    expect(persisted.partitions[key]?.results[0]?.report?.totalCost).toBe(0.01);
    expect(envelope?.lastSuccessAt).toBe(new Date(now + 1).toISOString());
    expect(envelope?.lastError).toBeUndefined();
  });

  test("an empty first scan establishes a valid initial baseline", async () => {
    const path = await snapshotFile();
    const now = Date.UTC(2026, 0, 1);
    const key = usageSnapshotTargetKey("claude", "work");
    await refreshUsageSnapshot({
      ...deps(path, { now, results: [] }),
      forcePartitionKeys: [key],
    });

    const envelope = readUsageSnapshotEnvelope("claude", "work", path, now + 1);
    expect(envelope?.results).toHaveLength(0);
    expect(envelope?.lastSuccessAt).toBe(new Date(now).toISOString());
    expect(envelope?.lastError).toBeUndefined();
  });

  test("successful report-only refresh removes an obsolete native batch pointer", async () => {
    const path = await snapshotFile();
    const now = Date.UTC(2026, 0, 1);
    await refreshUsageSnapshot(deps(path, { now, results: [result(7)] }));
    const persisted = JSON.parse(await readFile(path, "utf8")) as {
      partitions: Record<string, { nativeBatch?: unknown; nativeCoverage?: string; lastSuccessAt?: string }>;
    };
    const partition = Object.values(persisted.partitions).find((item) => item.lastSuccessAt !== undefined) as
      { nativeBatch?: unknown; nativeCoverage?: string; lastSuccessAt?: string };
    partition.nativeBatch = {
      path: "usage/native/fixture/old.json",
      partitionId: "a".repeat(64),
      generatedAt: new Date(now).toISOString(),
      sha256: "b".repeat(64),
    };
    partition.nativeCoverage = "supported";
    await writeFile(path, JSON.stringify(persisted));

    const updated = deps(path, { now: now + 1, results: [result(8)] });
    updated.forcePartitionKeys = Object.keys(persisted.partitions);
    await refreshUsageSnapshot(updated);

    const next = JSON.parse(await readFile(path, "utf8")) as {
      partitions: Record<string, { nativeBatch?: unknown; nativeCoverage?: string; lastSuccessAt?: string }>;
    };
    const refreshed = Object.values(next.partitions).find((item) => item.lastSuccessAt !== undefined);
    expect(refreshed?.nativeCoverage).toBe("unsupported");
    expect(refreshed?.nativeBatch).toBeUndefined();
  });

  test("identity-filtered reads return only matching members from a shared partition", async () => {
    const path = await snapshotFile();
    const other = { ...identity, name: "other", label: "Other" };
    await refreshUsageSnapshot({
      ...deps(path, { now: Date.UTC(2026, 0, 1), results: [] }),
      collectTargetResults: async (_targets, done) => {
        done(0, [result(2), result(3, other)]);
        return [];
      },
    });

    const filtered = readUsageSnapshotEnvelope(undefined, "work", path);
    expect(filtered?.results).toHaveLength(1);
    expect((filtered?.results[0] as { identity: { name: string } }).identity.name).toBe("work");
  });

  test("manifest aggregate retains source clients per entry through cross-source merges and native suppression", async () => {
    const path = await snapshotFile();
    const sourceEntry = (client?: string) => ({
      model: "model-x", provider: "anthropic", input: 1, output: 2, cacheRead: 0,
      cacheWrite: 0, reasoning: 0, messageCount: 1, cost: 0.1,
      ...(client ? { client } : {}),
    });
    const reportFor = (entry: ReturnType<typeof sourceEntry>) => ({
      entries: [entry], totalInput: 1, totalOutput: 2, totalCacheRead: 0,
      totalCacheWrite: 0, totalMessages: 1, totalCost: 0.1,
    }) as NonNullable<UsageResult["report"]>;
    const rows: UsageResult[] = [
      { provider: "anthropic", identity, sourceTool: "ali", report: reportFor(sourceEntry()) },
      { provider: "anthropic", identity, sourceTool: "zai", report: reportFor(sourceEntry()) },
      { provider: "anthropic", identity, sourceTool: "claude", report: reportFor(sourceEntry()) },
      { provider: "anthropic", identity, sourceTool: "pi", nativeCoverageTool: "claude", report: reportFor(sourceEntry("pi")) },
    ];
    await refreshUsageSnapshot({
      ...deps(path, { now: Date.UTC(2026, 0, 1), results: rows }),
      collectTargets: async () => [{ toolName: "ali", identity }],
      collectTargetResults: async (_targets, done) => { done(0, rows); return []; },
    });

    const persisted = JSON.parse(await readFile(path, "utf8")) as { aggregateResults: Array<{ report: { entries: Array<{ client?: string }> } }> };
    const clients = persisted.aggregateResults.flatMap((row) => row.report.entries.map((entry) => entry.client));
    expect(clients).toEqual(["ali", "zai", "claude"]);
  });

  test("a newer dirty marker survives acknowledgement of an older scan", async () => {
    const path = await snapshotFile();
    const dirty = join(dirname(path), "dirty");
    const key = usageSnapshotTargetKey("claude", "work");
    markUsageSnapshotDirty(key, dirty);
    const scanned = readUsageSnapshotDirtyMarkers(dirty);
    markUsageSnapshotDirty(key, dirty);
    acknowledgeUsageSnapshotDirty(scanned, dirty);
    expect(readUsageSnapshotDirtyMarkers(dirty)).toHaveLength(1);
    expect(readUsageSnapshotDirtyMarkers(dirty)[0]?.token).not.toBe(scanned[0]?.token);
  });

  test("the kernel lock excludes a second process until the owner releases it", async () => {
    if (!Bun.which("flock")) return;
    const path = await snapshotFile();
    const release = await acquireSnapshotLock(path);
    expect(release).toBeDefined();
    expect(await acquireSnapshotLock(path)).toBeUndefined();
    await release?.();
    const reacquired = await acquireSnapshotLock(path);
    expect(reacquired).toBeDefined();
    await reacquired?.();
  });
});
