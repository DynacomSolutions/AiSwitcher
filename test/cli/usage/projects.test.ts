import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUsageProjects, updateUsageProjects } from "../../../src/cli/usage/projects.ts";
import { decodeClaudeProjectKey, encodeClaudeProjectKey, resolveWorkspaces } from "../../../src/cli/usage/projects-workspace.ts";

const dirs: string[] = [];
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "ais-projects-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const PARTITION_ID = "a".repeat(64);
const message = (over: Record<string, unknown>) => ({
  client: "claude", model_id: "m", provider_id: "anthropic", session_id: "s", workspace_key: "/work/acme/widget", workspace_label: "widget",
  timestamp: Date.parse("2026-11-10T12:00:00Z"), date: "2026-11-10",
  tokens: { input: 10, output: 5, cache_read: 100, cache_write: 7, cache_write_1h: 3, reasoning: 0 }, cost: 1.5, ...over,
});

function singleBatch(usageDir: string, partitionId: string, messages: unknown[]): string {
  const name = "batch.json";
  mkdirSync(join(usageDir, "native", partitionId), { recursive: true });
  writeFileSync(join(usageDir, "native", partitionId, name), JSON.stringify({ schemaVersion: 1, partitionId, complete: true, generatedAt: "2026-11-10T00:00:00Z", messages }));
  return `usage/native/${partitionId}/${name}`;
}

function segmentedBatch(usageDir: string, partitionId: string, segments: unknown[][]): string {
  const dir = join(usageDir, "native", partitionId);
  mkdirSync(join(dir, "segments"), { recursive: true });
  const listed = segments.map((messages) => {
    const body = JSON.stringify(messages);
    const sha256 = createHash("sha256").update(body).digest("hex");
    writeFileSync(join(dir, "segments", `${sha256}.json`), body);
    return { sha256, bytes: body.length, messages: messages.length };
  });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    schemaVersion: 2, format: "ais-segmented-v1", partitionId, complete: true, generatedAt: "2026-11-10T00:00:00Z",
    messagesSha256: "b".repeat(64), messageCount: segments.flat().length, segments: listed, hourly: [],
  }));
  return `usage/native/${partitionId}/manifest.json`;
}

const partition = (tool: string, identity: string, path: string, sha: string) => ({
  tool, identity, results: [], lastAttemptAt: "2026-11-10T00:00:00Z",
  nativeBatch: { path, sha256: sha, generatedAt: "2026-11-10T00:00:00Z", partitionId: PARTITION_ID },
});

describe("updateUsageProjects", () => {
  test("aggregates single-file and segmented batches per workspace, day, provider and identity", async () => {
    const usageDir = temp();
    const single = singleBatch(usageDir, PARTITION_ID, [
      message({}),
      message({ cost: 0.5, timestamp: Date.parse("2026-11-10T13:00:00Z") }),
      message({ date: "2026-11-11", timestamp: Date.parse("2026-11-11T09:00:00Z") }),
    ]);
    const otherId = "c".repeat(64);
    const segmented = segmentedBatch(usageDir, otherId, [
      [message({ client: "codex", provider_id: "openai", workspace_key: "/work/acme/other", workspace_label: "other", cost: 2 })],
      [message({ client: "codex", provider_id: "openai", workspace_key: "/work/acme/other", workspace_label: "other", cost: 3 })],
    ]);
    const snapshot = { partitions: {
      "target:claude:alice": partition("claude", "alice", single, "1".repeat(64)),
      "target:codex:bob": { ...partition("codex", "bob", segmented, "2".repeat(64)), nativeBatch: { ...partition("codex", "bob", segmented, "2".repeat(64)).nativeBatch, partitionId: otherId } },
    } };
    const file = await updateUsageProjects(snapshot, { usageDir, workspace: { resolveProject: (cwd) => ({ path: cwd, source: "plain" }) } });
    const widget = file.rows.filter((r) => r.workspace === "/work/acme/widget").sort((a, b) => a.date.localeCompare(b.date));
    expect(widget).toHaveLength(2);
    expect(widget[0]).toMatchObject({ date: "2026-11-10", provider: "anthropic", identity: "alice", tool: "claude", cost: 2, input: 20, output: 10, cacheRead: 200, cacheWrite: 20, messages: 2 });
    expect(widget[0]!.lastMs).toBe(Date.parse("2026-11-10T13:00:00Z"));
    const other = file.rows.filter((r) => r.workspace === "/work/acme/other");
    expect(other).toHaveLength(1);
    expect(other[0]).toMatchObject({ provider: "openai", identity: "bob", tool: "codex", cost: 5, messages: 2 });
    const read = readUsageProjects(join(usageDir, "projects.json"))!;
    expect(read.rows.find((r) => r.workspace === "/work/acme/widget")).toMatchObject({ path: "/work/acme/widget", source: "plain" });
  });

  test("an unchanged batch is not read again; a changed sha is", async () => {
    const usageDir = temp();
    const path = singleBatch(usageDir, PARTITION_ID, [message({})]);
    const reads: string[] = [];
    const run = (sha: string) => updateUsageProjects({ partitions: { "target:claude:alice": partition("claude", "alice", path, sha) } }, {
      usageDir, onFileRead: (p) => reads.push(p), workspace: { resolveProject: (cwd) => ({ path: cwd, source: "plain" }) },
    });
    await run("1".repeat(64));
    expect(reads).toHaveLength(1);
    const again = await run("1".repeat(64));
    expect(reads).toHaveLength(1);
    expect(again.rows).toHaveLength(1);
    await run("2".repeat(64));
    expect(reads).toHaveLength(2);
  });

  test("attributes a swap pool's messages to the member active at each message", async () => {
    const usageDir = temp();
    const path = singleBatch(usageDir, PARTITION_ID, [
      message({ timestamp: 1000, date: "2026-11-10" }),
      message({ timestamp: 5000, date: "2026-11-10" }),
    ]);
    const file = await updateUsageProjects({ partitions: { "target:claude:team": partition("claude", "team", path, "1".repeat(64)) } }, {
      usageDir,
      poolFingerprint: () => "f1",
      poolAttribution: async () => ({
        pool: "team", fallback: "alice", known: new Set(["alice", "bob"]),
        events: [{ ts: new Date(3000).toISOString(), pool: "team", to: "bob" } as never],
      }),
      workspace: { resolveProject: (cwd) => ({ path: cwd, source: "plain" }) },
    });
    expect(file.rows.map((r) => r.identity).sort()).toEqual(["alice", "bob"]);
  });

  test("a claude partition that is not a pool keeps its own identity", async () => {
    const usageDir = temp();
    const path = singleBatch(usageDir, PARTITION_ID, [message({})]);
    const file = await updateUsageProjects({ partitions: { "target:claude:alice": partition("claude", "alice", path, "1".repeat(64)) } }, {
      usageDir, poolAttribution: async () => undefined, workspace: { resolveProject: (cwd) => ({ path: cwd, source: "plain" }) },
    });
    expect(file.rows.map((r) => r.identity)).toEqual(["alice"]);
  });
});

describe("Claude workspace keys", () => {
  test("decodes a dot directory, a dash-containing name and a deleted folder against a temp tree", () => {
    const root = temp();
    mkdirSync(join(root, "work", "acme", ".cluster"), { recursive: true });
    mkdirSync(join(root, "work", "acme", "my-app"), { recursive: true });
    const key = (path: string) => encodeClaudeProjectKey(path);
    expect(decodeClaudeProjectKey(key(join(root, "work", "acme", ".cluster")))).toMatchObject({ path: join(root, "work", "acme", ".cluster"), rest: "" });
    expect(decodeClaudeProjectKey(key(join(root, "work", "acme", "my-app")))).toMatchObject({ path: join(root, "work", "acme", "my-app"), rest: "" });
    const gone = decodeClaudeProjectKey(`${key(join(root, "work", "acme"))}-gone-task`);
    expect(gone).toMatchObject({ path: join(root, "work", "acme"), rest: "gone-task" });
  });

  test("resolves keys, persists the decode and falls back to the label when nothing resolves", () => {
    const root = temp();
    mkdirSync(join(root, "work", "acme", "my-app"), { recursive: true });
    const cachePath = join(root, "cache.json");
    const key = encodeClaudeProjectKey(join(root, "work", "acme", "my-app"));
    let decodes = 0;
    const decode = (k: string) => { decodes++; return decodeClaudeProjectKey(k); };
    const keys = new Map([[key, "my-app"], ["-elsewhere-host-thing", "thing"], ["/work/acme/not-here", "not-here"], ["", ""]]);
    const first = resolveWorkspaces(keys, { cachePath, decode });
    expect(first[key]).toMatchObject({ path: join(root, "work", "acme", "my-app"), source: "plain" });
    expect(first["-elsewhere-host-thing"]).toMatchObject({ path: "-elsewhere-host-thing", name: "thing", source: "missing" });
    expect(first["/work/acme/not-here"]).toMatchObject({ source: "missing" });
    expect(first[""]).toMatchObject({ source: "unknown" });
    const decodesAfterFirst = decodes;
    resolveWorkspaces(new Map([[key, "my-app"]]), { cachePath, decode });
    expect(decodes).toBe(decodesAfterFirst);
  });
});

describe("missing folders", () => {
  test("infers a repo from the key's tail, longest match wins, ambiguity stays unattributed", () => {
    const root = temp();
    const cachePath = join(root, "cache.json");
    const remotes: Record<string, { path: string; source: "git"; repo: string; org: string; host: string }> = {
      "/work/acme/widget": { path: "/work/acme/widget", source: "git", repo: "acme/widget", org: "acme", host: "example.com" },
      "/work/acme/acme-co-uk": { path: "/work/acme/acme-co-uk", source: "git", repo: "acme/acme-co-uk", org: "acme", host: "example.com" },
      "/work/acme/co-uk": { path: "/work/acme/co-uk", source: "git", repo: "acme/co-uk", org: "acme", host: "example.com" },
      "/work/one/dup": { path: "/work/one/dup", source: "git", repo: "one/dup", org: "one", host: "example.com" },
      "/work/two/dup": { path: "/work/two/dup", source: "git", repo: "two/dup", org: "two", host: "example.com" },
    };
    const keys = new Map([
      ...Object.keys(remotes).map((k) => [k, ""] as [string, string]),
      ["-Users-alice-Projects-Widget", "Widget"],
      ["-home-Projects-acme-co-uk", "acme-co-uk"],
      ["-Users-bob-dup", "dup"],
      ["/work/other-host/widget", "widget"],
      ["-Users-alice-nothing", "nothing"],
    ]);
    const out = resolveWorkspaces(keys, { cachePath, resolveProject: (cwd) => remotes[cwd] ?? { path: cwd, source: "missing" } });
    expect(out["-Users-alice-Projects-Widget"]).toMatchObject({ repo: "acme/widget", inferred: true, name: "widget", path: "-Users-alice-Projects-Widget", source: "missing" });
    expect(out["-home-Projects-acme-co-uk"]).toMatchObject({ repo: "acme/acme-co-uk", inferred: true });
    expect(out["-Users-bob-dup"]!.repo).toBeUndefined();
    expect(out["-Users-bob-dup"]).toMatchObject({ name: "dup" });
    expect(out["/work/other-host/widget"]).toMatchObject({ repo: "acme/widget", inferred: true });
    expect(out["-Users-alice-nothing"]).toMatchObject({ name: "nothing" });
    expect(out["-Users-alice-nothing"]!.repo).toBeUndefined();
  });

  test("a gone org folder takes the owner it is named after; a repo match still wins", () => {
    const root = temp();
    const remotes: Record<string, { path: string; source: "git"; repo: string; org: string; host: string }> = {
      "/work/Acme-Group/widget": { path: "/work/Acme-Group/widget", source: "git", repo: "Acme-Group/widget", org: "Acme-Group", host: "example.com" },
    };
    const keys = new Map([
      ["/work/Acme-Group/widget", ""],
      ["-Users-alice-Projects-acme-group", "acme-group"],
      ["/old/layout/acme-group", "acme-group"],
      ["-Users-alice-Projects-acme-group-widget", "widget"],
      ["-Users-alice-Projects-group", "group"],
      ["-Users-alice-Projects-AcmeGroup", "AcmeGroup"],
    ]);
    const out = resolveWorkspaces(keys, { cachePath: join(root, "cache.json"), resolveProject: (cwd) => remotes[cwd] ?? { path: cwd, source: "missing" } });
    expect(out["-Users-alice-Projects-acme-group"]).toMatchObject({ org: "Acme-Group", host: "example.com", inferred: true, name: "acme-group" });
    expect(out["-Users-alice-Projects-acme-group"]!.repo).toBeUndefined();
    expect(out["/old/layout/acme-group"]).toMatchObject({ org: "Acme-Group", inferred: true });
    expect(out["-Users-alice-Projects-acme-group-widget"]).toMatchObject({ repo: "Acme-Group/widget", inferred: true });
    expect(out["-Users-alice-Projects-group"]!.org).toBeUndefined();
    expect(out["-Users-alice-Projects-AcmeGroup"]).toMatchObject({ org: "Acme-Group", inferred: true });
  });
});
