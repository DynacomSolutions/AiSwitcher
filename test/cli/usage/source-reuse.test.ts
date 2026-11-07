import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { refreshUsageSnapshot, type UsageSnapshotDeps, type UsageSnapshotPartition } from "../../../src/cli/usage/snapshot.ts";
import { DigestMemo, nativeSourceFingerprint, sharedNativeExportInputs, type NativeSourceFingerprintEnv } from "../../../src/cli/usage/source-fingerprint.ts";
import { usageSnapshotTargetKey } from "../../../src/cli/usage/snapshot-dirty.ts";
import type { UsageResult, UsageTarget } from "../../../src/cli/usage/run.ts";
import nativeExport from "../../fixtures/tokscale-native-daily/export.json";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ais-source-reuse-"));
  dirs.push(dir);
  return dir;
}

/** A home with one Claude and one Codex identity, an exporter binary and its
 * isolated config (settings and a pricing cache). */
async function fixture() {
  const root = await tempRoot();
  const home = join(root, "home");
  const claudeDir = join(home, ".claude", "identities", "work");
  const codexDir = join(home, ".codex", "identities", "work");
  await mkdir(join(claudeDir, "projects", "-repo", "session-a", "subagents"), { recursive: true });
  await writeFile(join(claudeDir, "projects", "-repo", "session-a.jsonl"), "{\"type\":\"assistant\"}\n");
  await writeFile(join(claudeDir, "projects", "-repo", "session-a", "subagents", "agent-1.jsonl"), "{}\n");
  await writeFile(join(claudeDir, "projects", "-repo", "session-a", "subagents", "agent-1.meta.json"), "{\"agentType\":\"x\"}");
  await mkdir(join(codexDir, "sessions", "2026", "11", "07"), { recursive: true });
  await writeFile(join(codexDir, "sessions", "2026", "11", "07", "rollout-1.jsonl"), "{}\n");
  const configDir = join(root, "isolated-config");
  await mkdir(join(configDir, "cache"), { recursive: true });
  await writeFile(join(configDir, "settings.json"), JSON.stringify({ scanner: { extraScanPaths: {}, bucketTimezone: "Asia/Bangkok" } }));
  await writeFile(join(configDir, "cache", "pricing-litellm.json"), "{\"timestamp\":1000,\"data\":{\"model-a\":{\"input\":1}}}");
  const binaryPath = join(root, "tokscale");
  await writeFile(binaryPath, "binary-v1", { mode: 0o755 });
  const env: NativeSourceFingerprintEnv = { home, binaryPath, configDir, digestMemoPath: join(root, "digests.json") };
  const claude: UsageTarget = { toolName: "claude", identity: { name: "work", label: "Work", configDir: claudeDir, env: {} } as UsageTarget["identity"] };
  const codex: UsageTarget = { toolName: "codex", identity: { name: "work", label: "Work", configDir: codexDir, env: {} } as UsageTarget["identity"] };
  const fingerprint = (target: UsageTarget) => nativeSourceFingerprint(target, sharedNativeExportInputs(env), env);
  return { root, home, claudeDir, codexDir, configDir, binaryPath, env, claude, codex, fingerprint };
}

describe("native source fingerprint", () => {
  test("is stable while nothing changes and follows every change Tokscale would see", async () => {
    const f = await fixture();
    const base = f.fingerprint(f.claude)!;
    expect(base).toMatch(/^[a-f0-9]{64}$/);
    expect(f.fingerprint(f.claude)).toBe(base);

    // An appended transcript.
    await appendFile(join(f.claudeDir, "projects", "-repo", "session-a.jsonl"), "{}\n");
    const appended = f.fingerprint(f.claude)!;
    expect(appended).not.toBe(base);

    // An mtime moved back by hand still changes the ctime.
    const transcript = join(f.claudeDir, "projects", "-repo", "session-a.jsonl");
    await utimes(transcript, new Date(0), new Date(0));
    const touched = f.fingerprint(f.claude)!;
    expect(touched).not.toBe(appended);

    // A subagent sidecar, a new session and a sibling transcripts root.
    await writeFile(join(f.claudeDir, "projects", "-repo", "session-a", "subagents", "agent-1.meta.json"), "{\"agentType\":\"y\"}");
    const sidecar = f.fingerprint(f.claude)!;
    expect(sidecar).not.toBe(touched);
    await writeFile(join(f.claudeDir, "projects", "-repo", "session-b.jsonl"), "{}\n");
    const added = f.fingerprint(f.claude)!;
    expect(added).not.toBe(sidecar);
    await mkdir(join(f.claudeDir, "transcripts"));
    expect(f.fingerprint(f.claude)).not.toBe(added);
  });

  test("covers the Codex archive and headless roots", async () => {
    const f = await fixture();
    const base = f.fingerprint(f.codex)!;
    await mkdir(join(f.codexDir, "archived_sessions"));
    await writeFile(join(f.codexDir, "archived_sessions", "rollout-0.jsonl.zst"), "x");
    const archived = f.fingerprint(f.codex)!;
    expect(archived).not.toBe(base);
    await mkdir(join(f.home, ".config", "tokscale", "headless", "codex"), { recursive: true });
    expect(f.fingerprint(f.codex)).not.toBe(archived);
    // Claude's fingerprint does not depend on Codex's sources.
    const claude = f.fingerprint(f.claude);
    await writeFile(join(f.codexDir, "sessions", "2026", "11", "07", "rollout-2.jsonl"), "{}\n");
    expect(f.fingerprint(f.claude)).toBe(claude);
  });

  test("pricing counts by its data, not by the hourly refresh stamp; binary and settings count", async () => {
    const f = await fixture();
    const base = f.fingerprint(f.claude)!;
    await writeFile(join(f.configDir, "cache", "pricing-litellm.json"), "{\"timestamp\":2000,\"data\":{\"model-a\":{\"input\":1}}}");
    expect(f.fingerprint(f.claude)).toBe(base);
    await writeFile(join(f.configDir, "cache", "pricing-litellm.json"), "{\"timestamp\":3000,\"data\":{\"model-a\":{\"input\":2}}}");
    const repriced = f.fingerprint(f.claude)!;
    expect(repriced).not.toBe(base);

    // A rebuilt binary with the same bytes (a new inode) keeps the fingerprint; other bytes change it.
    await rm(f.binaryPath);
    await writeFile(f.binaryPath, "binary-v1", { mode: 0o755 });
    expect(f.fingerprint(f.claude)).toBe(repriced);
    await rm(f.binaryPath);
    await writeFile(f.binaryPath, "binary-v2", { mode: 0o755 });
    const rebuilt = f.fingerprint(f.claude)!;
    expect(rebuilt).not.toBe(repriced);

    await writeFile(join(f.configDir, "settings.json"), JSON.stringify({ scanner: { extraScanPaths: {}, bucketTimezone: "UTC" } }));
    expect(f.fingerprint(f.claude)).not.toBe(rebuilt);
  });

  test("a remembered digest is used only while the file's stat is unchanged", async () => {
    const f = await fixture();
    const memoPath = join(f.root, "memo.json");
    const whole = (bytes: Buffer) => bytes;
    const first = new DigestMemo(memoPath);
    expect(first.digest(f.binaryPath, whole)).toBe(createHash("sha256").update("binary-v1").digest("hex"));
    first.save();
    const remembered = JSON.parse(await readFile(memoPath, "utf8")) as { schema: 1; entries: Record<string, { key: string; sha256: string }> };
    // The remembered digest is what a re-read is skipped for (shown by forging it)...
    for (const entry of Object.values(remembered.entries)) entry.sha256 = "0".repeat(64);
    await writeFile(memoPath, JSON.stringify(remembered));
    expect(new DigestMemo(memoPath).digest(f.binaryPath, whole)).toBe("0".repeat(64));
    // ...and a rewritten file (new size, mtime, ctime) is hashed again.
    await writeFile(f.binaryPath, "binary-v3");
    expect(new DigestMemo(memoPath).digest(f.binaryPath, whole)).toBe(createHash("sha256").update("binary-v3").digest("hex"));
  });

  test("covers the Claude desktop IndexedDB store and its blobs in every app location", async () => {
    const f = await fixture();
    let previous = f.fingerprint(f.claude)!;
    for (const app of ["Library/Application Support/Claude", "AppData/Roaming/Claude", ".config/Claude"]) {
      for (const kind of ["leveldb", "blob"]) {
        const dir = join(f.home, app, "IndexedDB", `https_claude.ai_0.indexeddb.${kind}`);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "000003.log"), "record");
        const added = f.fingerprint(f.claude)!;
        expect(added).not.toBe(previous);
        await appendFile(join(dir, "000003.log"), "more");
        const grown = f.fingerprint(f.claude)!;
        expect(grown).not.toBe(added);
        previous = grown;
      }
    }
    // Codex does not read the desktop store.
    const codex = f.fingerprint(f.codex);
    await appendFile(join(f.home, ".config/Claude/IndexedDB/https_claude.ai_0.indexeddb.leveldb/000003.log"), "x");
    expect(f.fingerprint(f.codex)).toBe(codex);
  });

  test("custom prices and recovered usage count, a missing file being its own value", async () => {
    const f = await fixture();
    for (const name of ["custom-pricing.json", "recovered-usage-v1.json"]) {
      const base = f.fingerprint(f.claude)!;
      await writeFile(join(f.configDir, name), "{}");
      const present = f.fingerprint(f.claude)!;
      expect(present).not.toBe(base);
      await writeFile(join(f.configDir, name), "{\"changed\":true}");
      expect(f.fingerprint(f.claude)).not.toBe(present);
      await rm(join(f.configDir, name));
      expect(f.fingerprint(f.claude)).toBe(base);
    }
  });

  test("a new AIS release changes every fingerprint", async () => {
    const f = await fixture();
    const at = (aisVersion: string) => {
      const env = { ...f.env, aisVersion };
      return nativeSourceFingerprint(f.claude, sharedNativeExportInputs(env), env);
    };
    expect(at("0.5.30")).toBe(at("0.5.30")!);
    expect(at("0.5.31")).not.toBe(at("0.5.30")!);
  });

  test("undecidable sources are always exported", async () => {
    const f = await fixture();
    // Other tools are not covered.
    expect(f.fingerprint({ ...f.claude, toolName: "grok" })).toBeUndefined();
    // A symlink in a source tree.
    await symlink(join(f.root, "elsewhere"), join(f.claudeDir, "projects", "-linked"));
    expect(f.fingerprint(f.claude)).toBeUndefined();
    await rm(join(f.claudeDir, "projects", "-linked"));
    expect(f.fingerprint(f.claude)).toMatch(/^[a-f0-9]{64}$/);
    // A cc-mirror variant may name any config directory.
    await mkdir(join(f.home, ".cc-mirror"));
    expect(f.fingerprint(f.claude)).toBeUndefined();
    await rm(join(f.home, ".cc-mirror"), { recursive: true });
    // Extra scan paths configured for the tool.
    await writeFile(join(f.configDir, "settings.json"), JSON.stringify({ scanner: { extraScanPaths: { codex: ["/anywhere"] } } }));
    expect(f.fingerprint(f.codex)).toBeUndefined();
    expect(f.fingerprint(f.claude)).toMatch(/^[a-f0-9]{64}$/);
    // No exporter binary.
    await rm(f.binaryPath);
    expect(f.fingerprint(f.claude)).toBeUndefined();
  });
});

const identity = { name: "work", label: "Work", configDir: "/not-persisted", env: {} } as UsageTarget["identity"];
const target: UsageTarget = { toolName: "claude", identity };
const key = usageSnapshotTargetKey("claude", identity.name);
const partitionId = createHash("sha256").update(`ais-native-partition-v1\0${key}`).digest("hex");
const row = (messages: number): UsageResult => ({
  provider: "anthropic", identity,
  report: { entries: [], totalInput: messages, totalOutput: 0, totalCacheRead: 0, totalCacheWrite: 0, totalMessages: messages, totalCost: 0 },
});
const HOUR = 60 * 60_000;

/** One collector cycle for one Claude source. `fingerprint` is its source
 * fingerprint this cycle; the fake exporter writes a full batch with
 * `messages` rows. Returns the committed partition and whether Tokscale ran. */
async function cycle(root: string, now: number, fingerprint: string | undefined, options: { messages?: number; force?: boolean; extraCost?: number; identity?: UsageTarget["identity"] } = {}) {
  const target: UsageTarget = { toolName: "claude", identity: options.identity ?? identity };
  const path = join(root, "usage", "snapshot.json");
  const nativeBatchRoot = join(root, "native");
  const tokscaleConfigDir = join(root, "isolated-config");
  await mkdir(tokscaleConfigDir, { recursive: true });
  await writeFile(join(tokscaleConfigDir, "settings.json"), JSON.stringify({ scanner: { bucketTimezone: "America/New_York" } }));
  const candidate = { path: join(root, `candidate-${now}.json`), partitionId, tokscaleConfigDir };
  let exported = false;
  let probes = 0;
  const deps: UsageSnapshotDeps = {
    path, nativeBatchRoot, dirtyDirectory: join(root, "dirty"), now: () => now, partitionTtlMs: 15 * 60_000,
    ...(options.force ? { forcePartitionKeys: [key] } : {}),
    collectTargets: async () => [target], collectPoolTargets: async () => [],
    collectDefaultProfile: async () => [], collectSwapPools: async () => [],
    captureNative: async () => undefined,
    nativeSourceFingerprint: () => fingerprint,
    usageRunDeps: { fetchExtraCost: async () => { probes++; return options.extraCost === undefined ? undefined : { active: true, spentUsd: options.extraCost } as never; } },
    prepareNativeExportCandidate: async () => candidate,
    collectTargetResults: async (targets, onItemDone, prepareNativeExport) => {
      exported = true;
      await prepareNativeExport!(targets[0]!);
      const messages = (nativeExport.messages as unknown[]).slice(0, options.messages ?? 20);
      await writeFile(candidate.path, JSON.stringify({ ...nativeExport, messages, partitionId, generatedAt: new Date(now).toISOString() }));
      onItemDone(0, [row(messages.length)]);
      return [];
    },
  };
  await refreshUsageSnapshot(deps);
  const partition = (JSON.parse(await readFile(path, "utf8")) as { partitions: Record<string, UsageSnapshotPartition> }).partitions[key]!;
  return { partition, exported, probes };
}

describe("collector reuse of unchanged sources", () => {
  test("an unchanged source keeps its batch and rows without running Tokscale; a change exports again", async () => {
    const root = await tempRoot();
    const t0 = Date.UTC(2026, 10, 7, 12);
    const first = await cycle(root, t0, "a".repeat(64));
    expect(first.exported).toBe(true);
    expect(first.partition.sourceFingerprint).toBe("a".repeat(64));
    expect(first.partition.nativeExportedAt).toBe(new Date(t0).toISOString());

    // Due again by TTL (as after a restart or an update), sources unchanged.
    const second = await cycle(root, t0 + HOUR, "a".repeat(64), { extraCost: 12 });
    expect(second.exported).toBe(false);
    expect(second.probes).toBe(1);
    expect(second.partition.nativeBatch).toEqual(first.partition.nativeBatch);
    expect(second.partition.results.map(({ extraCost: _e, ...rest }) => rest)).toEqual(first.partition.results);
    expect(second.partition.results[0]?.extraCost).toEqual({ active: true, spentUsd: 12 } as never);
    expect(second.partition.lastSuccessAt).toBe(new Date(t0 + HOUR).toISOString());
    expect(second.partition.nativeExportedAt).toBe(first.partition.nativeExportedAt);
    expect(second.partition.results[0]?.dailyTotals).toBeDefined();
    expect(second.partition.results[0]?.dailyTotals).toEqual(first.partition.results[0]?.dailyTotals);

    // A changed source exports, and its new figures replace the old ones.
    const third = await cycle(root, t0 + 2 * HOUR, "b".repeat(64), { messages: 30 });
    expect(third.exported).toBe(true);
    expect(third.partition.results[0]?.report?.totalMessages).toBe(30);
    expect(third.partition.sourceFingerprint).toBe("b".repeat(64));
    expect(third.partition.nativeBatch?.path).not.toBe(first.partition.nativeBatch?.path);
  });

  test("a forced refresh, an expired reuse, a damaged batch or an undecidable source exports", async () => {
    const root = await tempRoot();
    const t0 = Date.UTC(2026, 10, 7, 12);
    await cycle(root, t0, "a".repeat(64));
    expect((await cycle(root, t0 + HOUR, "a".repeat(64), { force: true })).exported).toBe(true);
    // Exported at t0 + 1h; reuse lasts under 6 hours from there.
    expect((await cycle(root, t0 + 6 * HOUR, "a".repeat(64))).exported).toBe(false);
    expect((await cycle(root, t0 + 7 * HOUR, "a".repeat(64))).exported).toBe(true);
    expect((await cycle(root, t0 + 8 * HOUR, undefined)).exported).toBe(true);
    // An export without a fingerprint records none, so the next cycle exports too.
    const unknown = await cycle(root, t0 + 9 * HOUR, "a".repeat(64));
    expect(unknown.exported).toBe(true);

    // The committed batch file no longer matches what was promoted.
    const batch = join(root, "native", unknown.partition.nativeBatch!.path.slice("usage/native/".length));
    await appendFile(batch, " ");
    expect((await cycle(root, t0 + 10 * HOUR, "a".repeat(64))).exported).toBe(true);
  });

  test("reused rows show the identity as it is now", async () => {
    const root = await tempRoot();
    const t0 = Date.UTC(2026, 10, 7, 12);
    await cycle(root, t0, "a".repeat(64));
    const renamed = { ...identity, label: "Work (renamed)", aliases: ["w"] } as UsageTarget["identity"];
    const reused = await cycle(root, t0 + HOUR, "a".repeat(64), { identity: renamed });
    expect(reused.exported).toBe(false);
    expect(reused.partition.results[0]?.identity).toEqual({ name: "work", label: "Work (renamed)", aliases: ["w"] } as never);
  });

  test("extra-cost probes of reused sources run together and never hold up an export", async () => {
    const root = await tempRoot();
    const path = join(root, "usage", "snapshot.json");
    const nativeBatchRoot = join(root, "native");
    const tokscaleConfigDir = join(root, "isolated-config");
    await mkdir(tokscaleConfigDir, { recursive: true });
    await writeFile(join(tokscaleConfigDir, "settings.json"), JSON.stringify({ scanner: { bucketTimezone: "America/New_York" } }));
    const targets: UsageTarget[] = ["a", "b", "c"].map((name) => ({ toolName: "claude", identity: { ...identity, name, label: name } as UsageTarget["identity"] }));
    const idOf = (t: UsageTarget) => createHash("sha256").update(`ais-native-partition-v1\0${usageSnapshotTargetKey("claude", t.identity.name)}`).digest("hex");
    const run = async (now: number, fingerprints: Record<string, string>, probeMs: number) => {
      const events: string[] = [];
      let active = 0;
      let maxActive = 0;
      const deps: UsageSnapshotDeps = {
        path, nativeBatchRoot, dirtyDirectory: join(root, "dirty"), now: () => now, partitionTtlMs: 15 * 60_000,
        collectTargets: async () => targets, collectPoolTargets: async () => [],
        collectDefaultProfile: async () => [], collectSwapPools: async () => [],
        captureNative: async () => undefined,
        nativeSourceFingerprint: (t) => fingerprints[t.identity.name],
        usageRunDeps: {
          fetchExtraCost: async (_tool, who) => {
            active++; maxActive = Math.max(maxActive, active);
            await Bun.sleep(probeMs);
            active--; events.push(`probe-done:${who.name}`);
            return undefined;
          },
        },
        prepareNativeExportCandidate: async (t) => ({ path: join(root, `candidate-${t.identity.name}-${now}.json`), partitionId: idOf(t), tokscaleConfigDir }),
        collectTargetResults: async (selected, onItemDone, prepareNativeExport) => {
          for (const [index, t] of selected.entries()) {
            events.push(`export:${t.identity.name}`);
            const candidate = await prepareNativeExport!(t);
            await writeFile(candidate!.path, JSON.stringify({ ...nativeExport, messages: (nativeExport.messages as unknown[]).slice(0, 5), partitionId: idOf(t), generatedAt: new Date(now).toISOString() }));
            await onItemDone(index, [{ ...row(5), identity: t.identity }]);
          }
          return [];
        },
      };
      await refreshUsageSnapshot(deps);
      return { events, maxActive };
    };
    const t0 = Date.UTC(2026, 10, 7, 12);
    await run(t0, { a: "a".repeat(64), b: "b".repeat(64), c: "c".repeat(64) }, 0);
    // a and b unchanged, c changed: c's export must not wait for a's and b's probes.
    const { events, maxActive } = await run(t0 + HOUR, { a: "a".repeat(64), b: "b".repeat(64), c: "d".repeat(64) }, 300);
    expect(events.indexOf("export:c")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("export:c")).toBeLessThan(events.indexOf("probe-done:a"));
    expect(events.indexOf("export:c")).toBeLessThan(events.indexOf("probe-done:b"));
    expect(maxActive).toBeGreaterThanOrEqual(2);
  });

  test("a source that failed last time exports, never reuses", async () => {
    const root = await tempRoot();
    const t0 = Date.UTC(2026, 10, 7, 12);
    await cycle(root, t0, "a".repeat(64));
    const path = join(root, "usage", "snapshot.json");
    const snapshot = JSON.parse(await readFile(path, "utf8")) as { partitions: Record<string, UsageSnapshotPartition> };
    snapshot.partitions[key] = { ...snapshot.partitions[key]!, lastError: "source-error", lastErrorAt: new Date(t0).toISOString() };
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(snapshot));
    expect((await cycle(root, t0 + HOUR, "a".repeat(64))).exported).toBe(true);
  });
});
