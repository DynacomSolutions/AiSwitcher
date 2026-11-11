import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  collectObsoleteNativeBatches,
  importRetainedNativeBatch,
  refreshUsageSnapshot,
  type UsageSnapshot,
  type UsageSnapshotDeps,
  type UsageSnapshotPartition,
} from "../../../src/cli/usage/snapshot.ts";
import { nativeSegmentDir } from "../../../src/cli/usage/native-segments.ts";
import { reportEntriesFromMessages, sessionsOnDisk } from "../../../src/cli/usage/retained-sessions.ts";
import { updateUsageProjects } from "../../../src/cli/usage/projects.ts";
import { usageSnapshotTargetKey } from "../../../src/cli/usage/snapshot-dirty.ts";
import type { UsageResult, UsageTarget } from "../../../src/cli/usage/run.ts";
import { hourlyEntriesFromNativeMessages } from "../../../src/cli/usage/tokscale.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ais-retained-"));
  dirs.push(dir);
  return dir;
}

const sha256 = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const ZONE = "UTC";
const SESSION_GONE = "0b7c1d2e-0000-4000-8000-00000000a001";
const SESSION_LIVE = "0b7c1d2e-0000-4000-8000-00000000b002";

/** A message as the exporter writes it, one session in one workspace. */
function message(session: string, index: number, day: string, cost: number, workspace: string): Record<string, unknown> {
  return {
    client: "claude", model_id: "claude-model", provider_id: "anthropic", session_id: session,
    workspace_key: workspace, workspace_label: workspace,
    timestamp: Date.parse(`${day}T10:00:00Z`) + index * 60_000, date: day,
    tokens: { input: 10, output: 20, cache_read: 100, cache_write: 5, cache_write_1h: 0, reasoning: 0 },
    cost, message_count: 1, dedup_key: `${session}:${index}`,
  };
}
const gone = Array.from({ length: 12 }, (_, i) => message(SESSION_GONE, i, "2026-06-12", 2, "/work/acme/old-app"));
const live = Array.from({ length: 25 }, (_, i) => message(SESSION_LIVE, i, "2026-11-10", 1, "/work/acme/widget"));
const grownLive = [...live, ...Array.from({ length: 5 }, (_, i) => message(SESSION_LIVE, 25 + i, "2026-11-11", 1, "/work/acme/widget"))];

const configDir = (root: string) => join(root, "identity");
const identityOf = (root: string) => ({ name: "work", label: "Work", configDir: configDir(root), env: {} }) as UsageTarget["identity"];
const key = usageSnapshotTargetKey("claude", "work");
const partitionId = createHash("sha256").update(`ais-native-partition-v1\0${key}`).digest("hex");

/** The patched exporter with TOKSCALE_AIS_SEGMENT_DIR: segments of whole
 * messages, then the manifest with Tokscale's hourly rollup. */
async function writeSegmentedExport(exportPath: string, segmentDir: string, rows: unknown[], perSegment = 10): Promise<void> {
  await mkdir(segmentDir, { recursive: true });
  const segments: Array<{ sha256: string; bytes: number; messages: number }> = [];
  for (let start = 0; start < rows.length; start += perSegment) {
    const chunk = rows.slice(start, start + perSegment);
    const bytes = JSON.stringify(chunk);
    await writeFile(join(segmentDir, `${sha256(bytes)}.json`), bytes);
    segments.push({ sha256: sha256(bytes), bytes: Buffer.byteLength(bytes), messages: chunk.length });
  }
  await writeFile(exportPath, JSON.stringify({
    schemaVersion: 2, format: "ais-segmented-v1", partitionId, generatedAt: new Date().toISOString(),
    complete: true, messagesSha256: sha256(JSON.stringify(rows)), messageCount: rows.length, segments,
    hourly: hourlyEntriesFromNativeMessages(rows, ZONE),
  }));
}

/** Tokscale's `--json` report of the same export. */
function reportRow(root: string, rows: Record<string, unknown>[]): UsageResult {
  const entries = reportEntriesFromMessages(rows, "claude");
  const sum = (field: "input" | "output" | "cacheRead" | "cacheWrite" | "messageCount" | "cost") => entries.reduce((total, entry) => total + entry[field], 0);
  return {
    provider: "anthropic", identity: identityOf(root), sourceTool: "claude",
    report: { entries, totalInput: sum("input"), totalOutput: sum("output"), totalCacheRead: sum("cacheRead"), totalCacheWrite: sum("cacheWrite"), totalMessages: sum("messageCount"), totalCost: sum("cost") },
  };
}

type Partition = UsageSnapshotPartition;

/** One collector cycle whose export holds `rows` (or answers "unchanged"). */
async function cycle(root: string, now: number, rows: Record<string, unknown>[], options: { unchanged?: boolean } = {}): Promise<Partition> {
  const path = join(root, "usage", "snapshot.json");
  const nativeBatchRoot = join(root, "usage", "native");
  const tokscaleConfigDir = join(root, "isolated-config");
  await mkdir(tokscaleConfigDir, { recursive: true });
  await writeFile(join(tokscaleConfigDir, "settings.json"), JSON.stringify({ scanner: { bucketTimezone: ZONE } }));
  const candidate = { path: join(root, `candidate-${now}.json`), partitionId, tokscaleConfigDir };
  const target: UsageTarget = { toolName: "claude", identity: identityOf(root) };
  const deps: UsageSnapshotDeps = {
    path, nativeBatchRoot, dirtyDirectory: join(root, "dirty"), now: () => now, partitionTtlMs: 60_000,
    forcePartitionKeys: [key], identityRegistriesPresent: () => false,
    collectTargets: async () => [target], collectPoolTargets: async () => [],
    collectDefaultProfile: async () => [], collectSwapPools: async () => [],
    captureNative: async () => undefined, updateProjects: async () => undefined,
    prepareNativeExportCandidate: async () => candidate,
    collectTargetResults: async (targets, onItemDone, prepareNativeExport) => {
      await prepareNativeExport!(targets[0]!);
      if (options.unchanged) {
        await writeFile(candidate.path, JSON.stringify({ schemaVersion: 1, partitionId, unchanged: true, messagesSha256: sha256(JSON.stringify(rows)) }));
      } else {
        await writeSegmentedExport(candidate.path, nativeSegmentDir(nativeBatchRoot, partitionId), rows);
      }
      onItemDone(0, [reportRow(root, rows)]);
      return [];
    },
  };
  await refreshUsageSnapshot(deps);
  return readPartition(root);
}

async function readSnapshotFile(root: string): Promise<UsageSnapshot> {
  return JSON.parse(await readFile(join(root, "usage", "snapshot.json"), "utf8")) as UsageSnapshot;
}
async function readPartition(root: string): Promise<Partition> {
  return (await readSnapshotFile(root)).partitions[key]!;
}
async function manifestOf(root: string, partition: Partition): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(root, "usage", "native", partition.nativeBatch!.path.slice("usage/native/".length)), "utf8")) as Record<string, unknown>;
}

const costOf = (rows: Record<string, unknown>[]) => rows.reduce((sum, row) => sum + (row.cost as number), 0);
const totalCost = (partition: Partition) => partition.results.reduce((sum, row) => sum + (row.report?.totalCost ?? 0), 0);
const totalMessages = (partition: Partition) => partition.results.reduce((sum, row) => sum + (row.report?.totalMessages ?? 0), 0);

async function projectCost(root: string, workspace: string): Promise<number> {
  const snapshot = await readSnapshotFile(root);
  const file = await updateUsageProjects(snapshot, {
    usageDir: join(root, "usage"), poolAttribution: async () => undefined,
    workspace: { resolveProject: (cwd) => ({ path: cwd, source: "plain" }) },
  });
  return file.rows.filter((row) => row.workspace === workspace).reduce((sum, row) => sum + row.cost, 0);
}

describe("retained sessions", () => {
  test("a session whose transcript is gone and that the next export lacks stays in totals, daily usage and projects", async () => {
    const root = await tempRoot();
    const first = await cycle(root, Date.UTC(2026, 10, 11, 0), [...gone, ...live]);
    expect(totalCost(first)).toBe(costOf([...gone, ...live]));
    expect(first.results[0]?.dailyTotals?.["2026-06-12"]).toBeDefined();

    // The cache lost the deleted transcript: the next batch holds only the ongoing one.
    const second = await cycle(root, Date.UTC(2026, 10, 11, 1), grownLive);
    expect(totalCost(second)).toBe(costOf([...gone, ...grownLive]));
    expect(totalMessages(second)).toBe(gone.length + grownLive.length);
    expect(second.results[0]?.dailyTotals?.["2026-06-12"]?.[5]).toBe(costOf(gone));
    expect(second.results[0]?.dailyTotals?.["2026-11-11"]?.[4]).toBe(5);
    const manifest = await manifestOf(root, second);
    const retained = manifest.retainedSessions as Array<{ sessionId: string; messages: number }>;
    expect(retained.map((session) => session.sessionId)).toEqual([SESSION_GONE]);
    expect(manifest.messageCount).toBe(gone.length + grownLive.length);
    // Tokscale's digest stays the one its "unchanged" answer compares.
    expect(second.nativeBatch?.messagesSha256).toBe(sha256(JSON.stringify(grownLive)));
    expect(second.nativeBatch?.segments?.at(-1)?.sha256).toBe((manifest.segments as Array<{ sha256: string }>).at(-1)!.sha256);
    expect(await projectCost(root, "/work/acme/old-app")).toBe(costOf(gone));
    expect(await projectCost(root, "/work/acme/widget")).toBe(costOf(grownLive));

    // Tokscale answers "unchanged": the committed batch and its retained sessions stand.
    const unchanged = await cycle(root, Date.UTC(2026, 10, 11, 2), grownLive, { unchanged: true });
    expect(unchanged.nativeBatch?.path).toBe(second.nativeBatch?.path);
    expect(totalCost(unchanged)).toBe(costOf([...gone, ...grownLive]));
    expect(unchanged.results[0]?.dailyTotals?.["2026-06-12"]?.[5]).toBe(costOf(gone));

    // Later changed cycles carry it.
    const third = await cycle(root, Date.UTC(2026, 10, 11, 3), [...grownLive, message(SESSION_LIVE, 99, "2026-11-11", 1, "/work/acme/widget")]);
    expect(totalCost(third)).toBe(costOf(gone) + costOf(grownLive) + 1);
    expect(((await manifestOf(root, third)).retainedSessions as unknown[]).length).toBe(1);
  });

  test("a session that is exported again replaces its retained copy (no double count)", async () => {
    const root = await tempRoot();
    await cycle(root, Date.UTC(2026, 10, 11, 0), [...gone, ...live]);
    await cycle(root, Date.UTC(2026, 10, 11, 1), live);
    const back = await cycle(root, Date.UTC(2026, 10, 11, 2), [...gone, ...grownLive]);
    expect(totalCost(back)).toBe(costOf([...gone, ...grownLive]));
    expect(totalMessages(back)).toBe(gone.length + grownLive.length);
    expect((await manifestOf(root, back)).retainedSessions).toBeUndefined();
    expect(await projectCost(root, "/work/acme/old-app")).toBe(costOf(gone));
  });

  test("a session whose transcript is still on disk is not retained", async () => {
    const root = await tempRoot();
    await mkdir(join(configDir(root), "projects", "-work-acme-old-app"), { recursive: true });
    await writeFile(join(configDir(root), "projects", "-work-acme-old-app", `${SESSION_GONE}.jsonl`), "{}\n");
    await cycle(root, Date.UTC(2026, 10, 11, 0), [...gone, ...live]);
    const second = await cycle(root, Date.UTC(2026, 10, 11, 1), live);
    expect(totalCost(second)).toBe(costOf(live));
    expect((await manifestOf(root, second)).retainedSessions).toBeUndefined();
  });

  test("synthetic recovery rows keep their semantics: never retained", async () => {
    const root = await tempRoot();
    // Tokscale's recovery row: its session id is its dedup key.
    const recovery: Record<string, unknown> = { ...message("local-recovery:daily:2026-06-01", 0, "2026-06-01", 3, ""), dedup_key: "local-recovery:daily:2026-06-01" };
    await cycle(root, Date.UTC(2026, 10, 11, 0), [recovery, ...live]);
    const second = await cycle(root, Date.UTC(2026, 10, 11, 1), live);
    expect(totalCost(second)).toBe(costOf(live));
    expect((await manifestOf(root, second)).retainedSessions).toBeUndefined();
  });

  test("collection never removes a retained session's segment", async () => {
    const root = await tempRoot();
    const nativeRoot = join(root, "usage", "native");
    const first = await cycle(root, Date.UTC(2026, 10, 11, 0), [...gone, ...live]);
    const second = await cycle(root, Date.UTC(2026, 10, 11, 1), live);
    const retainedSha = second.nativeBatch!.segments!.at(-1)!.sha256;
    let rows = live;
    for (let hour = 2; hour < 6; hour++) {
      rows = [...rows, message(SESSION_LIVE, 100 + hour, "2026-11-11", 1, "/work/acme/widget")];
      await cycle(root, Date.UTC(2026, 10, 11, hour), rows);
    }
    // Far past every grace period: only what the current batch names is kept.
    collectObsoleteNativeBatches(await readSnapshotFile(root), nativeRoot, Date.now() + 30 * 24 * 60 * 60_000);
    const latest = await readPartition(root);
    expect(latest.nativeBatch!.segments!.map((segment) => segment.sha256)).toContain(retainedSha);
    expect(existsSync(join(nativeSegmentDir(nativeRoot, partitionId), `${retainedSha}.json`))).toBe(true);
    // The first export's segments that held the deleted session were collected.
    const names = new Set(await readdir(nativeSegmentDir(nativeRoot, partitionId)));
    expect(names.has(`${first.nativeBatch!.segments![0]!.sha256}.json`)).toBe(false);
    expect(totalCost(latest)).toBe(costOf([...gone, ...rows]));
    expect(await projectCost(root, "/work/acme/old-app")).toBe(costOf(gone));
  });

  test("import-batch takes the sessions an older batch copy has and the current batch lost, once", async () => {
    const root = await tempRoot();
    const path = join(root, "usage", "snapshot.json");
    const nativeBatchRoot = join(root, "usage", "native");
    const first = await cycle(root, Date.UTC(2026, 10, 11, 0), [...gone, ...live]);
    // The backup: the old manifest and its segments.
    const backupDir = join(root, "backup");
    await mkdir(backupDir, { recursive: true });
    const manifestName = first.nativeBatch!.path.split("/").at(-1)!;
    await cp(join(nativeBatchRoot, partitionId, manifestName), join(backupDir, manifestName));
    await cp(nativeSegmentDir(nativeBatchRoot, partitionId), join(backupDir, "segments"), { recursive: true });

    // The loss happened while the transcript still existed, so nothing was retained.
    const transcript = join(configDir(root), "projects", "-work-acme-old-app", `${SESSION_GONE}.jsonl`);
    await mkdir(dirname(transcript), { recursive: true });
    await writeFile(transcript, "{}\n");
    await cycle(root, Date.UTC(2026, 10, 11, 1), live);
    await rm(transcript);
    const lost = await cycle(root, Date.UTC(2026, 10, 11, 2), grownLive);
    expect(totalCost(lost)).toBe(costOf(grownLive));

    const options = {
      path, nativeBatchRoot, now: () => Date.UTC(2026, 10, 11, 3),
      findTarget: async () => ({ toolName: "claude" as const, identity: identityOf(root) }),
      updateProjects: async () => undefined,
    };
    const dry = await importRetainedNativeBatch(join(backupDir, manifestName), { ...options, dryRun: true });
    expect(dry).toMatchObject({ partitionKey: key, sessions: 1, messages: gone.length, cost: costOf(gone), present: 1, onDisk: 0, firstDate: "2026-06-12" });
    expect(totalCost(await readPartition(root))).toBe(costOf(grownLive));

    const imported = await importRetainedNativeBatch(join(backupDir, manifestName), options);
    expect(imported.sessions).toBe(1);
    const after = await readPartition(root);
    expect(totalCost(after)).toBe(costOf([...gone, ...grownLive]));
    expect(totalMessages(after)).toBe(gone.length + grownLive.length);
    expect(after.results[0]?.dailyTotals?.["2026-06-12"]?.[5]).toBe(costOf(gone));
    expect((await readSnapshotFile(root)).aggregateResults).toBeDefined();
    expect(await projectCost(root, "/work/acme/old-app")).toBe(costOf(gone));

    // Again: nothing to add.
    expect((await importRetainedNativeBatch(join(backupDir, manifestName), options)).sessions).toBe(0);
    expect(totalCost(await readPartition(root))).toBe(costOf([...gone, ...grownLive]));

    // The next cycles carry it, and an "unchanged" answer keeps it.
    const unchanged = await cycle(root, Date.UTC(2026, 10, 11, 4), grownLive, { unchanged: true });
    expect(totalCost(unchanged)).toBe(costOf([...gone, ...grownLive]));
    const next = await cycle(root, Date.UTC(2026, 10, 11, 5), [...grownLive, message(SESSION_LIVE, 200, "2026-11-11", 1, "/work/acme/widget")]);
    expect(totalCost(next)).toBe(costOf([...gone, ...grownLive]) + 1);
  });

  test("sessionsOnDisk finds Claude and Codex transcript names and treats a missing root as empty", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "projects", "-work-acme", SESSION_LIVE, "subagents"), { recursive: true });
    await mkdir(join(root, "sessions", "2026", "11"), { recursive: true });
    await writeFile(join(root, "sessions", "2026", "11", `rollout-2026-11-10T10-00-00-${SESSION_GONE}.jsonl`), "");
    const found = sessionsOnDisk([join(root, "projects"), join(root, "sessions"), join(root, "missing")], new Set([SESSION_LIVE, SESSION_GONE, "other"]));
    expect([...found].sort()).toEqual([SESSION_GONE, SESSION_LIVE].sort());
  });
});
