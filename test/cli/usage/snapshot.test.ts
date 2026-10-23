import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  acquireSnapshotLock,
  externalUsageCollectorOwnsRefreshes,
  readUsageSnapshotEnvelope,
  refreshUsageSnapshot,
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
    expect(calls).toBe(1);
    expect(readUsageSnapshotEnvelope("claude", "work", path, now + 2)?.results).toHaveLength(1);
  });

  test("failed scans preserve last-good results and persist only a safe error category", async () => {
    const path = await snapshotFile();
    const now = Date.UTC(2026, 0, 1);
    await refreshUsageSnapshot(deps(path, { now, results: [result(7)] }));
    markUsageSnapshotDirty(usageSnapshotTargetKey("claude", "work"), join(dirname(path), "dirty"));
    await refreshUsageSnapshot(deps(path, { now: now + 1, results: [], fail: true }));

    const envelope = readUsageSnapshotEnvelope(undefined, undefined, path, now + 2);
    const persisted = JSON.parse(await readFile(path, "utf8")) as { aggregateGeneratedAt: string; generatedAt: string };
    expect(envelope?.results).toHaveLength(1);
    expect(envelope?.lastError).toBe("source-error");
    expect(envelope?.stale).toBe(true);
    expect(envelope?.generatedAt).toBe(new Date(now).toISOString());
    expect(persisted.aggregateGeneratedAt).toBe(new Date(now).toISOString());
    expect(persisted.generatedAt).toBe(new Date(now + 1).toISOString());
    expect(await readFile(path, "utf8")).not.toContain("secret-like-provider-error");
  });

  test("a successful smaller report preserves the last-good report and native batch", async () => {
    const path = await snapshotFile();
    const now = Date.UTC(2026, 0, 1);
    const key = usageSnapshotTargetKey("claude", "work");
    await refreshUsageSnapshot(deps(path, { now, results: [result(12)] }));
    const persisted = JSON.parse(await readFile(path, "utf8")) as {
      partitions: Record<string, { results: UsageResult[]; nativeBatch?: unknown; lastSuccessAt?: string }>;
    };
    const prior = persisted.partitions[key];
    const nativeBatch = {
      path: "usage/native/fixture/last-good.json", partitionId: "a".repeat(64),
      generatedAt: new Date(now).toISOString(), sha256: "b".repeat(64),
    };
    prior.nativeBatch = nativeBatch;
    await writeFile(path, JSON.stringify(persisted));

    await refreshUsageSnapshot({
      ...deps(path, { now: now + 1, results: [result(8)] }),
      forcePartitionKeys: [key],
    });
    const next = JSON.parse(await readFile(path, "utf8")) as {
      partitions: Record<string, { results: UsageResult[]; nativeBatch?: unknown; lastSuccessAt?: string; lastError?: string }>;
    };
    const retained = next.partitions[key];
    expect(retained.results[0]?.report?.totalInput).toBe(12);
    expect(retained.nativeBatch).toEqual(nativeBatch);
    expect(retained.lastSuccessAt).toBe(new Date(now).toISOString());
    expect(retained.lastError).toBe("suspected-history-regression");
    const envelope = readUsageSnapshotEnvelope("claude", "work", path, now + 2);
    expect(envelope?.stale).toBe(true);
    expect(envelope?.lastError).toBe("suspected-history-regression");
  });

  test("a successful empty scan cannot erase a non-empty last-good partition", async () => {
    const path = await snapshotFile();
    const now = Date.UTC(2026, 0, 1);
    const key = usageSnapshotTargetKey("claude", "work");
    await refreshUsageSnapshot(deps(path, { now, results: [result(3)] }));
    await refreshUsageSnapshot({
      ...deps(path, { now: now + 1, results: [] }),
      forcePartitionKeys: [key],
    });

    const envelope = readUsageSnapshotEnvelope("claude", "work", path, now + 2);
    expect(envelope?.results).toHaveLength(1);
    expect(envelope?.lastError).toBe("suspected-history-regression");
    expect(envelope?.stale).toBe(true);
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
