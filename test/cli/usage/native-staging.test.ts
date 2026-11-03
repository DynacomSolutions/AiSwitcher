import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NATIVE_STAGING_MAX_AGE_MS, refreshUsageSnapshot, sweepStaleNativeStaging } from "../../../src/cli/usage/snapshot.ts";
import { DEFAULT_TOKSCALE_EXPORT_TIMEOUT_MS, tokscaleExportTimeoutMs, tokscaleSpawnTimeoutMs } from "../../../src/cli/usage/tokscale.ts";
import type { UsageTarget } from "../../../src/cli/usage/run.ts";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

async function staging(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ais-staging-"));
  dirs.push(dir);
  const root = join(dir, "native", ".staging");
  await mkdir(root, { recursive: true });
  return root;
}
async function age(path: string, ms: number): Promise<void> {
  const when = new Date(Date.now() - ms);
  await utimes(path, when, when);
}

describe("native staging sweep", () => {
  test("removes orphaned exports from dead runs and keeps fresh ones", async () => {
    const root = await staging();
    const orphanTmp = join(root, ".ais-batch-1-2.tmp");
    const orphanJson = join(root, "abc.uuid.json");
    const fresh = join(root, ".ais-batch-3-4.tmp");
    for (const f of [orphanTmp, orphanJson, fresh]) await writeFile(f, "x");
    await age(orphanTmp, NATIVE_STAGING_MAX_AGE_MS + 60_000);
    await age(orphanJson, NATIVE_STAGING_MAX_AGE_MS + 60_000);
    expect(sweepStaleNativeStaging(root)).toBe(2);
    expect(existsSync(orphanTmp)).toBe(false);
    expect(existsSync(orphanJson)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  test("a missing staging directory is not an error", () => {
    expect(sweepStaleNativeStaging(join(tmpdir(), "ais-no-such-staging-dir"))).toBe(0);
  });

  test("a collector cycle clears the stale leftovers beside a pool that fails, and logs why", async () => {
    const root = await staging();
    const base = join(root, "..", "..");
    const leftover = join(root, ".ais-batch-9-9.tmp");
    await writeFile(leftover, "x");
    await age(leftover, NATIVE_STAGING_MAX_AGE_MS + 60_000);
    const pool = { name: "fixturepool", label: "Pool", configDir: "/not-persisted", swapPool: { accounts: ["work"], active: "work" } } as unknown as UsageTarget["identity"];
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const snapshot = await refreshUsageSnapshot({
        path: join(base, "snapshot.json"), dirtyDirectory: join(base, "dirty"), nativeStagingRoot: root,
        collectTargets: async () => [], collectDefaultProfile: async () => [],
        collectPoolTargets: async () => [{ toolName: "claude", identity: pool }],
        collectSwapPools: async () => [],
      });
      expect(snapshot.partitions["target:claude:fixturepool"]?.lastError).toBe("source-error");
      expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain("collector finished without reporting this pool");
      expect(existsSync(leftover)).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  test("a promotion that cannot rename logs the underlying error code", async () => {
    const root = await staging();
    const base = join(root, "..", "..");
    const pool = { name: "fixturepool", label: "Pool", configDir: "/not-persisted", swapPool: { accounts: ["work"], active: "work" } } as unknown as UsageTarget["identity"];
    const partitionId = (await import("node:crypto")).createHash("sha256").update("ais-native-partition-v1\0target:claude:fixturepool").digest("hex");
    const candidate = join(root, `${partitionId}.u.json`);
    await writeFile(candidate, JSON.stringify({ schemaVersion: 1, partitionId, complete: true, generatedAt: new Date().toISOString(), messages: [] }));
    // A file where the partition directory belongs makes the rename fail with ENOTDIR.
    const nativeBatchRoot = join(base, "batches");
    await mkdir(nativeBatchRoot, { recursive: true });
    await writeFile(join(nativeBatchRoot, partitionId), "not a directory");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const snapshot = await refreshUsageSnapshot({
        path: join(base, "snapshot.json"), dirtyDirectory: join(base, "dirty"), nativeBatchRoot, nativeStagingRoot: root,
        collectTargets: async () => [], collectDefaultProfile: async () => [],
        collectPoolTargets: async () => [{ toolName: "claude", identity: pool }],
        collectSwapPools: async (onPoolDone) => { await onPoolDone(pool, [], undefined, { path: candidate, partitionId }); return []; },
      });
      expect(snapshot.partitions["target:claude:fixturepool"]?.lastError).toBe("native-capture-failed");
      const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("native capture");
      expect(logged).toMatch(/ENOTDIR|EEXIST/);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("native export timeout", () => {
  test("defaults above the plain tokscale ceiling and never drops below it", () => {
    const keep = { a: process.env.AIS_TOKSCALE_EXPORT_TIMEOUT_MS, b: process.env.AIS_TOKSCALE_TIMEOUT_MS };
    try {
      delete process.env.AIS_TOKSCALE_EXPORT_TIMEOUT_MS; delete process.env.AIS_TOKSCALE_TIMEOUT_MS;
      expect(tokscaleExportTimeoutMs()).toBe(DEFAULT_TOKSCALE_EXPORT_TIMEOUT_MS);
      expect(tokscaleExportTimeoutMs()).toBeGreaterThan(tokscaleSpawnTimeoutMs());
      process.env.AIS_TOKSCALE_EXPORT_TIMEOUT_MS = "1000";
      expect(tokscaleExportTimeoutMs()).toBe(tokscaleSpawnTimeoutMs());
      process.env.AIS_TOKSCALE_EXPORT_TIMEOUT_MS = String(40 * 60_000);
      expect(tokscaleExportTimeoutMs()).toBe(40 * 60_000);
    } finally {
      for (const [k, v] of [["AIS_TOKSCALE_EXPORT_TIMEOUT_MS", keep.a], ["AIS_TOKSCALE_TIMEOUT_MS", keep.b]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });
});
