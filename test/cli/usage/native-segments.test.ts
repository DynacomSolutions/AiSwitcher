import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  collectObsoleteNativeBatches,
  nativeExportForTarget,
  nativeIdentityRegistriesPresent,
  promoteNativeBatchFile,
  refreshUsageSnapshot,
  reusableNativeBatchDigest,
  type UsageSnapshot,
  type UsageSnapshotDeps,
  type UsageSnapshotPartition,
} from "../../../src/cli/usage/snapshot.ts";
import { collectObsoleteNativeSegments, nativeSegmentDir } from "../../../src/cli/usage/native-segments.ts";
import { usageSnapshotTargetKey } from "../../../src/cli/usage/snapshot-dirty.ts";
import type { UsageResult, UsageTarget } from "../../../src/cli/usage/run.ts";
import { dailyUsageFromHourlyEntries } from "../../../src/cli/usage/tokscale.ts";
import nativeExport from "../../fixtures/tokscale-native-daily/export.json";
import hourlyReport from "../../fixtures/tokscale-native-daily/hourly.json";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ais-native-segments-"));
  dirs.push(dir);
  return dir;
}

const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const messages = nativeExport.messages as unknown[];
const hourly = hourlyReport.entries;
const identity = { name: "work", label: "Work", configDir: "/not-persisted", env: {} } as UsageTarget["identity"];
const target: UsageTarget = { toolName: "claude", identity };
const key = usageSnapshotTargetKey("claude", identity.name);
const partitionId = createHash("sha256").update(`ais-native-partition-v1\0${key}`).digest("hex");

/** What the patched exporter writes with TOKSCALE_AIS_SEGMENT_DIR: segments
 * of whole messages named by SHA-256 (skipping reusable ones), then the
 * manifest. Returns the bytes it wrote. */
async function writeSegmentedExport(
  exportPath: string,
  segmentDir: string,
  rows: unknown[],
  options: { perSegment?: number; reusable?: Set<string>; generatedAt?: string } = {},
): Promise<number> {
  await mkdir(segmentDir, { recursive: true });
  const perSegment = options.perSegment ?? 10;
  const segments: Array<{ sha256: string; bytes: number; messages: number }> = [];
  let written = 0;
  for (let start = 0; start < rows.length; start += perSegment) {
    const chunk = rows.slice(start, start + perSegment);
    const bytes = JSON.stringify(chunk);
    const sha = sha256(bytes);
    if (!options.reusable?.has(sha)) {
      await writeFile(join(segmentDir, `${sha}.json`), bytes);
      written += bytes.length;
    }
    segments.push({ sha256: sha, bytes: Buffer.byteLength(bytes), messages: chunk.length });
  }
  const manifest = JSON.stringify({
    schemaVersion: 2, format: "ais-segmented-v1", partitionId, generatedAt: options.generatedAt ?? new Date().toISOString(),
    complete: true, messagesSha256: sha256(JSON.stringify(rows)), messageCount: rows.length, segments, hourly,
  });
  await writeFile(exportPath, manifest);
  return written + manifest.length;
}

const result = (messages: number): UsageResult => ({
  provider: "anthropic", identity,
  report: { entries: [], totalInput: messages, totalOutput: 0, totalCacheRead: 0, totalCacheWrite: 0, totalMessages: messages, totalCost: 0 },
});

async function cycle(path: string, nativeBatchRoot: string, now: number, write: (candidatePath: string) => Promise<unknown>) {
  // The zone the fixture's hourly.json was bucketed in, as the exporter's config pins it.
  const tokscaleConfigDir = join(dirname(path), "isolated-config");
  await mkdir(tokscaleConfigDir, { recursive: true });
  await writeFile(join(tokscaleConfigDir, "settings.json"), JSON.stringify({ scanner: { bucketTimezone: "America/New_York" } }));
  const candidate = { path: join(dirname(path), `candidate-${now}.json`), partitionId, tokscaleConfigDir };
  const deps: UsageSnapshotDeps = {
    path, nativeBatchRoot, dirtyDirectory: join(dirname(path), "dirty"), now: () => now, partitionTtlMs: 60_000,
    forcePartitionKeys: [key],
    collectTargets: async () => [target], collectPoolTargets: async () => [],
    collectDefaultProfile: async () => [], collectSwapPools: async () => [],
    captureNative: async () => undefined,
    prepareNativeExportCandidate: async () => candidate,
    collectTargetResults: async (targets, onItemDone, prepareNativeExport) => {
      await prepareNativeExport!(targets[0]!);
      await write(candidate.path);
      onItemDone(0, [result(48)]);
      return [];
    },
  };
  await refreshUsageSnapshot(deps);
  return (JSON.parse(await readFile(path, "utf8")) as { partitions: Record<string, { results: UsageResult[]; nativeBatch?: UsageSnapshotPartition["nativeBatch"]; nativeCoverage?: string }> }).partitions[key]!;
}

describe("segmented native batches", () => {
  test("a segmented export gives the same daily figures as the single-file batch", async () => {
    const root = await tempRoot();
    const path = join(root, "usage", "snapshot.json");
    const nativeBatchRoot = join(root, "native");
    const single = await cycle(path, nativeBatchRoot, Date.UTC(2026, 0, 1), (candidatePath) =>
      writeFile(candidatePath, JSON.stringify({ ...nativeExport, partitionId, generatedAt: new Date().toISOString() })));
    const segmented = await cycle(path, nativeBatchRoot, Date.UTC(2026, 0, 2), (candidatePath) =>
      writeSegmentedExport(candidatePath, nativeSegmentDir(nativeBatchRoot, partitionId), messages));
    expect(segmented.nativeCoverage).toBe("supported");
    expect(segmented.nativeBatch?.format).toBe("segmented-v1");
    expect(segmented.nativeBatch?.segments?.length).toBe(Math.ceil(messages.length / 10));
    expect(segmented.nativeBatch?.messagesSha256).toBe(sha256(JSON.stringify(messages)));
    const [singleRow] = single.results;
    const [segmentedRow] = segmented.results;
    // The fixture's hourly.json is the patched binary's own hourly report of these messages.
    const expected = dailyUsageFromHourlyEntries(hourly)!;
    expect(segmentedRow?.dailyTotals).toEqual(expected.totals);
    expect(segmentedRow?.dailyUsage).toEqual(singleRow?.dailyUsage);
    expect(segmentedRow?.dailyTotals).toEqual(singleRow?.dailyTotals);
    expect(segmentedRow?.dateSpan).toEqual(singleRow?.dateSpan);
  });

  test("a changed cycle reads only the new segments; unchanged ones are only stat'ed", async () => {
    const root = await tempRoot();
    const nativeRoot = join(root, "native");
    const segmentDir = nativeSegmentDir(nativeRoot, partitionId);
    await mkdir(join(nativeRoot, ".staging"), { recursive: true });
    const first = join(nativeRoot, ".staging", "first.json");
    await writeSegmentedExport(first, segmentDir, messages);
    let read = 0;
    const committed = promoteNativeBatchFile(first, partitionId, nativeRoot, { bytesRead: (bytes) => { read += bytes; } });
    const total = committed.segments!.reduce((sum, segment) => sum + segment.bytes, 0);
    expect(read).toBeGreaterThan(total);

    // One message appended inside the second segment's run.
    const grown = [...messages.slice(0, 15), { ...(messages[15] as object), dedup_key: "appended" }, ...messages.slice(15)];
    const second = join(nativeRoot, ".staging", "second.json");
    const reusable = new Set(committed.segments!.map((segment) => segment.sha256));
    const written = await writeSegmentedExport(second, segmentDir, grown, { reusable, perSegment: 10 });
    read = 0;
    const next = promoteNativeBatchFile(second, partitionId, nativeRoot, { bytesRead: (bytes) => { read += bytes; } }, committed);
    const fresh = next.segments!.filter((segment) => !reusable.has(segment.sha256));
    const freshBytes = fresh.reduce((sum, segment) => sum + segment.bytes, 0);
    const manifestBytes = (await stat(join(nativeRoot, next.path.slice("usage/native/".length)))).size;
    expect(read).toBe(freshBytes + manifestBytes);
    expect(written).toBe(freshBytes + manifestBytes);
    expect(freshBytes).toBeLessThan(total);
    // Reused segments keep their verified records.
    for (const segment of next.segments!) {
      if (reusable.has(segment.sha256)) expect(segment).toEqual(committed.segments!.find((old) => old.sha256 === segment.sha256)!);
    }
  });

  test("a damaged or missing segment forces a full rebuild and is never reused", async () => {
    const root = await tempRoot();
    const nativeRoot = join(root, "native");
    const segmentDir = nativeSegmentDir(nativeRoot, partitionId);
    await mkdir(join(nativeRoot, ".staging"), { recursive: true });
    const first = join(nativeRoot, ".staging", "first.json");
    await writeSegmentedExport(first, segmentDir, messages);
    const committed = { ...promoteNativeBatchFile(first, partitionId, nativeRoot), bucketTimezone: "UTC" };
    expect(reusableNativeBatchDigest(committed, partitionId, nativeRoot, "UTC")).toBe(committed.messagesSha256!);

    const victim = join(segmentDir, `${committed.segments![1]!.sha256}.json`);
    const original = await readFile(victim);
    const damaged = Buffer.from(original);
    damaged[Math.floor(damaged.length / 2)] ^= 1;
    await writeFile(victim, damaged);
    // Not intact: no "unchanged" digest and no reusable list (every segment is rewritten).
    expect(reusableNativeBatchDigest(committed, partitionId, nativeRoot, "UTC")).toBeUndefined();
    const previousBin = process.env.AIS_TOKSCALE_SHARED_BIN;
    process.env.AIS_TOKSCALE_SHARED_BIN = "/bin/true";
    try {
      const exported = await nativeExportForTarget(target, key, committed, nativeRoot);
      expect(exported?.invocation.env.TOKSCALE_AIS_SEGMENT_DIR).toBe(segmentDir);
      expect(exported?.invocation.env.TOKSCALE_AIS_REUSABLE_SEGMENTS_FILE).toBeUndefined();
      expect(exported?.invocation.env.TOKSCALE_AIS_PREVIOUS_MESSAGES_SHA256).toBeUndefined();
    } finally {
      if (previousBin === undefined) delete process.env.AIS_TOKSCALE_SHARED_BIN;
      else process.env.AIS_TOKSCALE_SHARED_BIN = previousBin;
    }

    // A manifest naming the damaged segment is refused, even though it names a "known" segment.
    const second = join(nativeRoot, ".staging", "second.json");
    await writeSegmentedExport(second, join(root, "elsewhere"), messages);
    expect(() => promoteNativeBatchFile(second, partitionId, nativeRoot, {}, committed)).toThrow("native-capture-failed");

    // Missing: refused as well.
    await rm(victim);
    expect(() => promoteNativeBatchFile(second, partitionId, nativeRoot, {}, committed)).toThrow("native-capture-failed");

    // The full rebuild writes every segment again and is accepted.
    await writeSegmentedExport(second, segmentDir, messages);
    expect(promoteNativeBatchFile(second, partitionId, nativeRoot, {}, committed).segments!.length).toBe(committed.segments!.length);
  });

  test("damage whose size and mtime were put back is still not trusted", async () => {
    const root = await tempRoot();
    const nativeRoot = join(root, "native");
    const segmentDir = nativeSegmentDir(nativeRoot, partitionId);
    await mkdir(join(nativeRoot, ".staging"), { recursive: true });
    const first = join(nativeRoot, ".staging", "first.json");
    await writeSegmentedExport(first, segmentDir, messages);
    const committed = { ...promoteNativeBatchFile(first, partitionId, nativeRoot), bucketTimezone: "UTC" };
    const victim = join(segmentDir, `${committed.segments![0]!.sha256}.json`);
    // `touch -r` restores the mtime to the nanosecond, as `cp -p` or `rsync -t` would.
    const reference = join(root, "reference");
    expect(Bun.spawnSync(["cp", "-p", victim, reference]).exitCode).toBe(0);
    const damaged = Buffer.from(await readFile(victim));
    damaged[Math.floor(damaged.length / 2)] ^= 1;
    await writeFile(victim, damaged);
    expect(Bun.spawnSync(["touch", "-m", "-r", reference, victim]).exitCode).toBe(0);
    expect((await stat(victim, { bigint: true })).mtimeNs).toBe(BigInt(committed.segments![0]!.mtimeNs));
    expect(reusableNativeBatchDigest(committed, partitionId, nativeRoot, "UTC")).toBeUndefined();
    const second = join(nativeRoot, ".staging", "second.json");
    await writeSegmentedExport(second, join(root, "elsewhere"), messages);
    expect(() => promoteNativeBatchFile(second, partitionId, nativeRoot, {}, committed)).toThrow("native-capture-failed");
  });

  test("collection keeps segments of an export still in flight", async () => {
    const root = await tempRoot();
    const path = join(root, "usage", "snapshot.json");
    const nativeBatchRoot = join(root, "native");
    const segmentDir = nativeSegmentDir(nativeBatchRoot, partitionId);
    await cycle(path, nativeBatchRoot, Date.UTC(2026, 0, 1), (candidatePath) => writeSegmentedExport(candidatePath, segmentDir, messages));
    const snapshot = JSON.parse(await readFile(path, "utf8")) as UsageSnapshot;
    const committedNames = new Set(snapshot.partitions[key]!.nativeBatch!.segments!.map((s) => `${s.sha256}.json`));
    // A slow full rebuild: its first segments are 11 minutes old, its manifest not yet promoted.
    const staged = join(nativeBatchRoot, ".staging", "slow.json");
    await mkdir(dirname(staged), { recursive: true });
    await writeSegmentedExport(staged, segmentDir, [...messages, { ...(messages[0] as object), dedup_key: "slow" }], { perSegment: 7 });
    const inFlight = (await readdir(segmentDir)).filter((name) => !committedNames.has(name));
    expect(inFlight.length).toBeGreaterThan(0);
    const elevenMinutesAgo = new Date(Date.now() - 11 * 60_000);
    for (const name of inFlight) await utimes(join(segmentDir, name), elevenMinutesAgo, elevenMinutesAgo);
    collectObsoleteNativeBatches(snapshot, nativeBatchRoot, Date.now());
    for (const name of [...inFlight, ...committedNames]) expect(existsSync(join(segmentDir, name))).toBe(true);
  });

  test("migration: a single-file batch is never a source of reusable segments; the next segmented batch is", async () => {
    const root = await tempRoot();
    const path = join(root, "usage", "snapshot.json");
    const nativeBatchRoot = join(root, "native");
    const legacy = await cycle(path, nativeBatchRoot, Date.UTC(2026, 0, 1), (candidatePath) =>
      writeFile(candidatePath, JSON.stringify({ ...nativeExport, partitionId, generatedAt: new Date().toISOString(), messagesSha256: sha256(JSON.stringify(messages)) })));
    expect(legacy.nativeBatch?.segments).toBeUndefined();
    const previousBin = process.env.AIS_TOKSCALE_SHARED_BIN;
    process.env.AIS_TOKSCALE_SHARED_BIN = "/bin/true";
    try {
      const fromLegacy = await nativeExportForTarget(target, key, legacy.nativeBatch, nativeBatchRoot);
      expect(fromLegacy?.invocation.env.TOKSCALE_AIS_SEGMENT_DIR).toBe(nativeSegmentDir(nativeBatchRoot, partitionId));
      expect(fromLegacy?.invocation.env.TOKSCALE_AIS_REUSABLE_SEGMENTS_FILE).toBeUndefined();

      const segmented = await cycle(path, nativeBatchRoot, Date.UTC(2026, 0, 2), (candidatePath) =>
        writeSegmentedExport(candidatePath, nativeSegmentDir(nativeBatchRoot, partitionId), messages));
      // Same messages, so the same digest as the single-file batch it replaces.
      expect(segmented.nativeBatch?.messagesSha256).toBe(legacy.nativeBatch?.messagesSha256);
      const fromSegmented = await nativeExportForTarget(target, key, segmented.nativeBatch, nativeBatchRoot);
      const listFile = fromSegmented?.invocation.env.TOKSCALE_AIS_REUSABLE_SEGMENTS_FILE;
      expect(listFile).toBe(`${fromSegmented!.path}.reusable`);
      expect((await readFile(listFile!, "utf8")).split("\n")).toEqual(segmented.nativeBatch!.segments!.map((segment) => segment.sha256));
      await rm(listFile!);
    } finally {
      if (previousBin === undefined) delete process.env.AIS_TOKSCALE_SHARED_BIN;
      else process.env.AIS_TOKSCALE_SHARED_BIN = previousBin;
    }
    // The single-file generation is still kept as one of the two latest.
    const files = await readdir(join(nativeBatchRoot, partitionId));
    expect(files.filter((name) => name.endsWith(".json")).length).toBe(2);
  });

  test("a crash before the manifest commit leaves the committed batch whole and intact", async () => {
    const root = await tempRoot();
    const path = join(root, "usage", "snapshot.json");
    const nativeBatchRoot = join(root, "native");
    const segmentDir = nativeSegmentDir(nativeBatchRoot, partitionId);
    const committed = await cycle(path, nativeBatchRoot, Date.UTC(2026, 0, 1), (candidatePath) =>
      writeSegmentedExport(candidatePath, segmentDir, messages));
    // The exporter wrote new segments and a staged manifest, then the cycle died.
    const grown = [...messages, { ...(messages[0] as object), dedup_key: "late" }];
    const staged = join(nativeBatchRoot, ".staging", "dead.json");
    await mkdir(dirname(staged), { recursive: true });
    await writeSegmentedExport(staged, segmentDir, grown, { reusable: new Set(committed.nativeBatch!.segments!.map((s) => s.sha256)) });
    await writeFile(join(segmentDir, ".ais-segment-1-2-0.tmp"), "partial");
    const snapshot = JSON.parse(await readFile(path, "utf8")) as UsageSnapshot;
    expect(snapshot.partitions[key]!.nativeBatch).toEqual(committed.nativeBatch);
    expect(reusableNativeBatchDigest({ ...committed.nativeBatch!, bucketTimezone: "UTC" }, partitionId, nativeBatchRoot, "UTC")).toBe(committed.nativeBatch!.messagesSha256!);

    // Collection hours later keeps every committed segment and drops the orphans.
    const later = Date.now() + 3 * 60 * 60_000;
    collectObsoleteNativeBatches(snapshot, nativeBatchRoot, later);
    const left = new Set(await readdir(segmentDir));
    for (const segment of committed.nativeBatch!.segments!) expect(left.has(`${segment.sha256}.json`)).toBe(true);
    expect(left.size).toBe(new Set(committed.nativeBatch!.segments!.map((s) => s.sha256)).size);
    expect(reusableNativeBatchDigest({ ...committed.nativeBatch!, bucketTimezone: "UTC" }, partitionId, nativeBatchRoot, "UTC")).toBe(committed.nativeBatch!.messagesSha256!);
  });

  test("segment collection keeps what retained batches or young files need, and stops on doubt", async () => {
    const root = await tempRoot();
    const partitionDir = join(root, partitionId);
    const segmentDir = join(partitionDir, "segments");
    await mkdir(segmentDir, { recursive: true });
    const keptManifest = join(partitionDir, "kept.json");
    await writeSegmentedExport(keptManifest, segmentDir, messages.slice(0, 20));
    const keptNames = new Set(await readdir(segmentDir));
    const oldOrphan = join(segmentDir, `${"1".repeat(64)}.json`);
    const youngOrphan = join(segmentDir, `${"2".repeat(64)}.json`);
    await writeFile(oldOrphan, "[]");
    await writeFile(youngOrphan, "[]");
    const longAgo = new Date(Date.now() - 60 * 60_000);
    await utimes(oldOrphan, longAgo, longAgo);
    for (const name of keptNames) await utimes(join(segmentDir, name), longAgo, longAgo);
    const legacy = join(partitionDir, "legacy.json");
    await writeFile(legacy, JSON.stringify({ schemaVersion: 1, partitionId, messages: [] }));

    // An unreadable kept batch: nothing is removed.
    const broken = join(partitionDir, "broken.json");
    await writeFile(broken, "{\"schemaVersion\":2,\"segm");
    expect(collectObsoleteNativeSegments(partitionDir, [keptManifest, legacy, broken], Date.now(), 10 * 60_000)).toBe(0);
    expect(existsSync(oldOrphan)).toBe(true);

    expect(collectObsoleteNativeSegments(partitionDir, [keptManifest, legacy, join(partitionDir, "vanished.json")], Date.now(), 10 * 60_000)).toBe(1);
    expect(existsSync(oldOrphan)).toBe(false);
    expect(existsSync(youngOrphan)).toBe(true);
    for (const name of keptNames) expect(existsSync(join(segmentDir, name))).toBe(true);
  });
});

describe("scope sweep registry check", () => {
  test("a tool that was never used needs no registry; a used tool without one blocks the sweep", async () => {
    const root = await tempRoot();
    const tool = (name: string) => ({ identitiesJsonPath: join(root, name, "identities.json"), identitiesRootDir: join(root, name, "identities") });
    const claude = tool("claude");
    const neverUsed = tool("kimi");
    const emptyRoot = tool("pi");
    await mkdir(dirname(claude.identitiesJsonPath), { recursive: true });
    await writeFile(claude.identitiesJsonPath, "{}");
    await mkdir(emptyRoot.identitiesRootDir, { recursive: true });
    expect(nativeIdentityRegistriesPresent([claude, neverUsed, emptyRoot])).toBe(true);

    const used = tool("codex");
    await mkdir(join(used.identitiesRootDir, "work"), { recursive: true });
    expect(nativeIdentityRegistriesPresent([claude, used])).toBe(false);
    await writeFile(used.identitiesJsonPath, "{}");
    expect(nativeIdentityRegistriesPresent([claude, used])).toBe(true);
  });
});
