import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Identity, ToolConfig } from "../../src/identities/types.ts";
import { readSessionTrees } from "../../src/cli/sessions/tree.ts";
import { readTranscript } from "../../src/cli/sessions/transcript.ts";
import type { ToolTreeDto, TranscriptDto, TreeNodeDto } from "../../src/cli/sessions/types.ts";
import { PartReadError } from "../../src/gateway/sessions/part-reader.ts";
import { runScan } from "../../src/server/scan-worker.ts";
import { UNASSIGNED_IDENTITY } from "../../src/server/sessions-db/db-source.ts";
import { sessionsReaderConfigFromEnv, sessionsSourceMode } from "../../src/server/sessions-db/config.ts";
import { SessionsReaderMetrics } from "../../src/server/sessions-db/metrics.ts";
import { PartCache } from "../../src/server/sessions-db/part-cache.ts";
import { PartLoader, SessionsReadError } from "../../src/server/sessions-db/part-lines.ts";
import { announceSessionsSource, openSessionsSource, resetAnnouncedForTest } from "../../src/server/sessions-db/source.ts";
import { cleanTemps, claudeAgent, claudeSession, codexRollout, encryptPart, makeFixture, msAt, sha, tempDir, T0 } from "./sessions-db-kit.ts";

afterEach(cleanTemps);

const SID = "11111111-2222-4333-8444-555555555555";
const AID = "a1b2c3d4e5f6a7b8c";
const CODEX_ID = "019a0000-0000-7000-8000-000000000001";
const CLAUDE_REL = `projects/-srv-example/${SID}.jsonl`;
const AGENT_REL = `projects/-srv-example/${SID}/subagents/agent-${AID}.jsonl`;
const CODEX_REL = `sessions/2026/03/01/rollout-2026-03-01T09-00-30-${CODEX_ID}.jsonl`;
const DAYS = 400; // the fixtures are dated March 2026
const sortById = (nodes: TreeNodeDto[]): TreeNodeDto[] => [...nodes].sort((a, b) => a.id.localeCompare(b.id));

/** The same sessions as host files (what the file reader sees) and as database rows (what the db reader sees). */
async function seed(perPart = 3) {
  const f = await makeFixture();
  const configDir = await tempDir();
  const claude = { kind: "claude" as const, relPath: CLAUDE_REL, identity: "testa", lines: claudeSession("a") };
  const agent = { kind: "claude" as const, relPath: AGENT_REL, identity: "testa", lines: claudeAgent(AID, SID) };
  const codex = { kind: "codex" as const, relPath: CODEX_REL, identity: "testa", lines: codexRollout(CODEX_ID) };
  await f.writeFile(configDir, claude, msAt(9));
  await f.writeFile(configDir, agent, msAt(22));
  await f.writeFile(configDir, codex, msAt(35));
  await f.add(claude, perPart);
  await f.add(agent, perPart);
  await f.add(codex, perPart);
  const identity = { name: "testa", configDir } as Identity;
  return { f, configDir, identity };
}

describe("database tree equals the file tree", () => {
  test("claude and codex nodes are equal field by field", async () => {
    const { f, identity } = await seed();
    const opts = { days: DAYS };
    const files = {
      claude: await readSessionTrees("claude", identity, opts),
      codex: await readSessionTrees("codex", identity, opts),
    };
    const slices = await f.db.readTrees({ kinds: ["claude", "codex"], targets: [{ tool: "claude", identity: "testa" }, { tool: "codex", identity: "testa" }], opts });
    expect(slices).toHaveLength(2);
    for (const tool of ["claude", "codex"] as const) {
      const db = slices.find((s) => s.tool === tool)!;
      expect(db.nodes.length).toBeGreaterThan(0);
      expect(sortById(db.nodes)).toEqual(sortById(files[tool].nodes));
    }
    // The subagent is a child of its session at depth 1, with the agent name.
    const agentNode = slices[0]!.nodes.find((n) => n.id === `${SID}/${AID}`)!;
    expect(agentNode).toMatchObject({ parentId: SID, depth: 1, agentName: AID });
  });

  test("the window and the active filter drop old nodes as the files do", async () => {
    const { f, identity } = await seed();
    const files = await readSessionTrees("claude", identity, { days: 1, now: msAt(9) + 3_600_000 });
    const db = await f.db.readTrees({ kinds: ["claude"], targets: [{ tool: "claude", identity: "testa" }], opts: { days: 1, now: msAt(9) + 3_600_000 } });
    expect(sortById(db[0]!.nodes)).toEqual(sortById(files.nodes));
    expect(db[0]!.nodes.length).toBe(2);
    const old = await f.db.readTrees({ kinds: ["claude"], targets: [{ tool: "claude", identity: "testa" }], opts: { days: 1, now: msAt(9) + 3 * 86_400_000 } });
    expect(old[0]!.nodes).toEqual([]);
  });

  test("a session with no identity yet shows in an unassigned slice, unless an identity is asked for", async () => {
    const f = await makeFixture();
    await f.add({ kind: "claude", relPath: CLAUDE_REL, identity: null, lines: claudeSession("u") }, 4);
    const args = { kinds: ["claude" as const], targets: [{ tool: "claude" as const, identity: "testa" }], opts: { days: DAYS } };
    const all = await f.db.readTrees({ ...args, includeUnassigned: true });
    expect(all.map((s) => [s.identity, s.nodes.length])).toEqual([["testa", 0], [UNASSIGNED_IDENTITY, 1]]);
    expect((await f.db.readTrees({ ...args, includeUnassigned: false })).map((s) => s.identity)).toEqual(["testa"]);
  });
});

describe("database transcript equals the file transcript", () => {
  const compare = async (tool: "claude" | "codex", id: string, perPart: number, tail = 500) => {
    const { f, identity } = await seed(perPart);
    const files = (await readTranscript(tool, identity, id, { tail }))!;
    const db = (await f.db.readTranscript({ tool, identity: "testa", id, tail }))!;
    expect(db.turns.length).toBeGreaterThan(1);
    expect(db).toEqual(files);
    return { f, db };
  };

  test("claude, whole session in one part", async () => {
    await compare("claude", SID, 100);
  });
  test("claude, many parts, tool call and result in different parts", async () => {
    const { f, db } = await compare("claude", SID, 2);
    expect(db.turns.find((t) => t.role === "tool")!.text).toBe("listing a");
    expect(f.objects.reads.length).toBeGreaterThan(3);
  });
  test("claude subagent", async () => {
    await compare("claude", `${SID}/${AID}`, 1);
  });
  test("codex, many parts", async () => {
    await compare("codex", CODEX_ID, 2);
  });
  test("a small tail keeps the newest turns and says truncated", async () => {
    const { db } = await compare("claude", SID, 3, 3);
    expect(db.truncated).toBe(true);
    expect(db.turns).toHaveLength(3);
  });
  test("a session that is not stored is not found; another identity does not match", async () => {
    const { f } = await seed();
    expect(await f.db.readTranscript({ tool: "claude", id: "nope" })).toBeUndefined();
    expect(await f.db.readTranscript({ tool: "claude", identity: "other", id: SID })).toBeUndefined();
    expect(await f.db.readTranscript({ tool: "claude", id: SID })).toBeDefined();
  });

  test("a session larger than the window decodes the tail only, is truncated, and takes its meta from the index", async () => {
    const f = await makeFixture({ windowBytes: 600 });
    const lines = claudeSession("big", 40);
    const row = await f.add({ kind: "claude", relPath: CLAUDE_REL, identity: "testa", lines }, 2);
    const dto = (await f.db.readTranscript({ tool: "claude", identity: "testa", id: SID }))!;
    expect(dto.truncated).toBe(true);
    expect(f.objects.reads.length).toBeLessThan(f.store.parts.get(row.fileId)!.length);
    expect(dto.turns.at(-1)!.text).toContain("Answer 39");
    expect(dto.session).toMatchObject({ title: "First prompt big", cwd: "/srv/repositories/example-org/example-repo", startedAt: new Date(msAt(0)).toISOString() });
  });
});

describe("a part that fails its check gives an error, never wrong text", () => {
  test("same length, other content: hash differs", async () => {
    const { f } = await seed(2);
    const row = (await f.store.filesOfSession("claude", SID))[0]!;
    const part = f.store.parts.get(row.fileId)![1]!;
    const forged = new TextEncoder().encode("x".repeat(part.plainBytes));
    f.objects.objects.set(part.objectKey, await encryptPart(forged, f.keys.recipient));
    await expect(f.db.readTranscript({ tool: "claude", identity: "testa", id: SID })).rejects.toMatchObject({ kind: "integrity" });
    expect(f.metrics.render().join("\n")).toContain('ais_console_sessions_read_errors_total{kind="integrity"} 1');
  });
  test("wrong length, a missing object, bytes that are not age, and a gap in the parts", async () => {
    const { f } = await seed(2);
    const row = (await f.store.filesOfSession("claude", SID))[0]!;
    const parts = f.store.parts.get(row.fileId)!;
    f.objects.objects.set(parts[0]!.objectKey, await encryptPart(new TextEncoder().encode("short"), f.keys.recipient));
    await expect(f.db.readTranscript({ tool: "claude", id: SID })).rejects.toMatchObject({ kind: "integrity" });
    f.objects.objects.delete(parts[0]!.objectKey);
    await expect(f.db.readTranscript({ tool: "claude", id: SID })).rejects.toMatchObject({ kind: "missing" });
    f.objects.objects.set(parts[0]!.objectKey, new Uint8Array([1, 2, 3]));
    await expect(f.db.readTranscript({ tool: "claude", id: SID })).rejects.toMatchObject({ kind: "decrypt" });
    f.store.parts.set(row.fileId, [parts[0]!, parts[2]!]);
    await expect(f.db.readTranscript({ tool: "claude", id: SID })).rejects.toBeInstanceOf(Error);
  });
  test("a wrong identity key cannot decrypt", async () => {
    const { f } = await seed(2);
    const other = await makeOtherLoader(f);
    const row = (await f.store.filesOfSession("claude", SID))[0]!;
    await expect(other.text(f.store.parts.get(row.fileId)![0]!)).rejects.toBeInstanceOf(PartReadError);
  });
});

async function makeOtherLoader(f: Awaited<ReturnType<typeof makeFixture>>): Promise<PartLoader> {
  const { makeKeys } = await import("../gateway/sessions-enrich-kit.ts");
  const other = await makeKeys();
  return new PartLoader({ source: f.objects, identity: other.identity, cache: new PartCache(0), metrics: new SessionsReaderMetrics() });
}

describe("part loader", () => {
  test("a torn last line joins the next part", async () => {
    const f = await makeFixture();
    const text = ["{\"a\":1}", "{\"b\":2}", "{\"c\":3}"].join("\n");
    const cut = text.indexOf("\"b\"") + 2; // inside the second line
    const bytes = new TextEncoder().encode(text);
    const mk = async (start: number, end: number, name: string) => {
      const plain = bytes.slice(start, end);
      f.objects.objects.set(name, await encryptPart(plain, f.keys.recipient));
      return { startOffset: start, endOffset: end, lines: 1, plainBytes: plain.length, objectBytes: 1, plainSha256: sha(plain), objectKey: name };
    };
    const parts = [await mk(0, cut, "k1"), await mk(cut, bytes.length, "k2")];
    const loader = new PartLoader({ source: f.objects, identity: f.keys.identity, cache: new PartCache(1 << 20), metrics: f.metrics });
    const out: string[] = [];
    for await (const l of loader.lines(parts)) out.push(l);
    expect(out).toEqual(["{\"a\":1}", "{\"b\":2}", "{\"c\":3}"]);
  });
  test("parts out of order or with a gap are refused", async () => {
    const { f } = await seed(2);
    const row = (await f.store.filesOfSession("claude", SID))[0]!;
    const parts = f.store.parts.get(row.fileId)!;
    const loader = new PartLoader({ source: f.objects, identity: f.keys.identity, cache: new PartCache(0), metrics: f.metrics });
    await expect((async () => { for await (const _ of loader.lines([parts[0]!, parts[2]!])) void _; })()).rejects.toBeInstanceOf(SessionsReadError);
  });
});

describe("part cache is bounded", () => {
  test("evicts the least recently used part and never holds more than the cap", () => {
    const c = new PartCache(100);
    c.set("a", "A", 40);
    c.set("b", "B", 40);
    expect(c.get("a")).toBe("A"); // a is now the newest
    c.set("c", "C", 40);
    expect(c.get("b")).toBeUndefined();
    expect(c.get("a")).toBe("A");
    expect(c.size).toBeLessThanOrEqual(100);
    c.set("huge", "H", 500);
    expect(c.get("huge")).toBeUndefined();
    expect(new PartCache(0).get("x")).toBeUndefined();
  });
  test("a second read of a session is served from the cache", async () => {
    const { f } = await seed(2);
    await f.db.readTranscript({ tool: "claude", identity: "testa", id: SID });
    const reads = f.objects.reads.length;
    await f.db.readTranscript({ tool: "claude", identity: "testa", id: SID });
    expect(f.objects.reads.length).toBe(reads);
    expect(f.metrics.render().join("\n")).toMatch(/ais_console_sessions_parts_total\{source="cache"\} [1-9]/);
  });
});

describe("metrics", () => {
  test("requests, errors and part latency are counted, and a child delta merges", async () => {
    const { f } = await seed(3);
    await f.db.readTranscript({ tool: "claude", id: SID });
    await f.db.readTrees({ kinds: ["claude"], targets: [], opts: { days: DAYS } });
    const text = f.metrics.render().join("\n");
    expect(text).toContain('ais_console_sessions_read_requests_total{kind="transcript",source="db",outcome="ok"} 1');
    expect(text).toContain('ais_console_sessions_read_requests_total{kind="tree",source="db",outcome="ok"} 1');
    expect(text).toMatch(/ais_console_sessions_part_fetch_seconds_count [1-9]/);
    expect(text).toContain('le="+Inf"');
    const parent = new SessionsReaderMetrics();
    parent.merge(f.metrics.drain());
    parent.merge("not a delta");
    parent.merge({ requests: { "tree|db|ok": -5, bad: "x" } });
    expect(parent.render().join("\n")).toContain('ais_console_sessions_read_requests_total{kind="transcript",source="db",outcome="ok"} 1');
    expect(f.metrics.render().join("\n")).toContain('ais_console_sessions_read_requests_total{kind="transcript",source="db",outcome="ok"} 0');
  });
  test("a store failure counts as a store error", async () => {
    const { f } = await seed(3);
    f.store.failWith = new Error("connection refused to a private host");
    await expect(f.db.readTranscript({ tool: "claude", id: SID })).rejects.toMatchObject({ kind: "store" });
    await expect(f.db.readTrees({ kinds: ["claude"], targets: [], opts: {} })).rejects.toMatchObject({ kind: "store" });
    // The error text of the driver (it may name a host) never reaches the caller.
    await f.db.readTranscript({ tool: "claude", id: SID }).catch((e: Error) => expect(e.message).not.toContain("private host"));
    expect(f.metrics.render().join("\n")).toContain('ais_console_sessions_read_errors_total{kind="store"} 3');
  });
});

describe("source selection", () => {
  const settings = {
    AIS_SESSIONS_DATABASE_URL: "postgres://user:secret-pw@db.invalid/x",
    AIS_SESSIONS_S3_ENDPOINT: "https://s3.invalid",
    AIS_SESSIONS_S3_BUCKET: "b",
    AIS_SESSIONS_S3_ACCESS_KEY_ID: "kid",
    AIS_SESSIONS_S3_SECRET_ACCESS_KEY: "ksecret",
    AIS_SESSIONS_AGE_IDENTITY: "AGE-SECRET-KEY-1TEST",
  };
  test("the default and unknown values are files", () => {
    expect(sessionsSourceMode({})).toBe("files");
    expect(sessionsSourceMode({ AIS_SESSIONS_SOURCE: "" })).toBe("files");
    expect(sessionsSourceMode({ AIS_SESSIONS_SOURCE: "dbb" })).toBe("files");
    expect(sessionsSourceMode({ AIS_SESSIONS_SOURCE: " AUTO " })).toBe("auto");
    expect(sessionsSourceMode({ AIS_SESSIONS_SOURCE: "db" })).toBe("db");
  });
  test("files touches no database even when every setting is present", async () => {
    const f = await makeFixture();
    f.store.failWith = new Error("must not be called");
    const h = await openSessionsSource({ ...settings }, { store: f.store });
    expect(h).toMatchObject({ mode: "files", used: "files", fallback: false });
    expect(f.store.calls).toBe(0);
  });
  test("db without settings throws and names settings, never values", async () => {
    const err = await openSessionsSource({ AIS_SESSIONS_SOURCE: "db", AIS_SESSIONS_S3_BUCKET: "b" }).catch((e: Error) => e);
    expect((err as Error).message).toContain("AIS_SESSIONS_S3_ENDPOINT");
    expect((err as Error).message).not.toContain("=b");
  });
  test("auto without settings uses the files and says why", async () => {
    const h = await openSessionsSource({ AIS_SESSIONS_SOURCE: "auto" });
    expect(h.used).toBe("files");
    expect(h.reason).toContain("AIS_SESSIONS_AGE_IDENTITY");
  });
  test("auto with settings and an answering database uses the database; a silent one falls back to files", async () => {
    const f = await makeFixture();
    const up = await openSessionsSource({ ...settings, AIS_SESSIONS_SOURCE: "auto" }, { store: f.store, parts: f.objects });
    expect(up).toMatchObject({ mode: "auto", used: "db", fallback: true });
    f.store.failWith = new Error("down");
    const down = await openSessionsSource({ ...settings, AIS_SESSIONS_SOURCE: "auto" }, { store: f.store, parts: f.objects });
    expect(down.used).toBe("files");
    expect(down.reason).not.toContain("secret");
  });
  test("the console logs the source once, with no values", async () => {
    resetAnnouncedForTest();
    const lines: string[] = [];
    const m = new SessionsReaderMetrics();
    const f = await makeFixture();
    const env = { ...settings, AIS_SESSIONS_SOURCE: "auto" };
    expect(await announceSessionsSource(env, (l) => lines.push(l), { store: f.store, parts: f.objects, metrics: m })).toBe("db");
    await announceSessionsSource(env, (l) => lines.push(l), { store: f.store, parts: f.objects, metrics: m });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("reading db");
    expect(lines.join("")).not.toContain("secret");
    expect(m.render().join("\n")).toContain('ais_console_sessions_source{source="db"} 1');
    resetAnnouncedForTest();
  });
  test("reader settings parse with caps", () => {
    expect(sessionsReaderConfigFromEnv({})).toBeUndefined();
    const cfg = sessionsReaderConfigFromEnv({ ...settings, AIS_SESSIONS_READ_WINDOW_BYTES: "999999999999", AIS_SESSIONS_PART_CACHE_BYTES: "0" })!;
    expect(cfg.windowBytes).toBe(16 * 1024 * 1024);
    expect(cfg.cacheBytes).toBe(0);
    expect(cfg.region).toBe("auto");
  });
});

/* ---------------------- the page output (scan worker payload) ---------------------- */

function fakeConfig(registryPath: string): ToolConfig {
  return {
    toolName: "claude",
    realBinaryName: "claude",
    envVarName: "CLAUDE_CONFIG_DIR",
    identitiesJsonPath: registryPath,
    identitiesRootDir: join(registryPath, "..", "identities"),
    globalMemoryProjection: "claude-append-file",
  };
}

async function pageFixture(perPart = 3) {
  const f = await makeFixture();
  const home = await tempDir();
  const configDir = join(home, "cfg");
  const registryPath = join(home, "identities.json");
  await mkdir(configDir, { recursive: true });
  await writeFile(registryPath, JSON.stringify({ version: 1, identities: [{ name: "testa", label: "Test A", configDir } as Identity] }));
  const claude = { kind: "claude" as const, relPath: CLAUDE_REL, identity: "testa", lines: claudeSession("p") };
  const agent = { kind: "claude" as const, relPath: AGENT_REL, identity: "testa", lines: claudeAgent(AID, SID) };
  await f.writeFile(configDir, claude, msAt(9));
  await f.writeFile(configDir, agent, msAt(22));
  await f.add(claude, perPart);
  await f.add(agent, perPart);
  return { f, configs: [fakeConfig(registryPath)] };
}

describe("page output: db and files give the same payload", () => {
  type Tree = { tools: ToolTreeDto[]; days: number };
  test("tree", async () => {
    const { f, configs } = await pageFixture();
    const filesRun = await runScan<Tree>({ kind: "tree", tool: "claude", configs, days: DAYS });
    const dbRun = await runScan<Tree>({ kind: "tree", tool: "claude", configs, days: DAYS + 1, sessionsSource: f.handle() });
    expect(filesRun.ok).toBe(true);
    expect(dbRun.ok).toBe(true);
    const norm = (t: Tree) => t.tools.map((s) => ({ ...s, nodes: sortById(s.nodes) }));
    expect(norm(dbRun.payload!)).toEqual(norm(filesRun.payload!));
    expect(dbRun.payload!.tools[0]!.nodes).toHaveLength(2);
  });
  test("transcript", async () => {
    const { f, configs } = await pageFixture(2);
    type T = { transcript: TranscriptDto | null };
    const filesRun = await runScan<T>({ kind: "transcript", tool: "claude", identity: "testa", configs, id: SID, tail: 500 });
    const dbRun = await runScan<T>({ kind: "transcript", tool: "claude", identity: "testa", configs, id: SID, tail: 499, sessionsSource: f.handle() });
    expect(filesRun.payload!.transcript!.turns.length).toBeGreaterThan(3);
    expect(dbRun.payload!.transcript).toEqual(filesRun.payload!.transcript!);
  });
  test("a corrupt part is an error in db mode, and the files answer in auto mode", async () => {
    const { f, configs } = await pageFixture(2);
    const row = (await f.store.filesOfSession("claude", SID))[0]!;
    const part = f.store.parts.get(row.fileId)![0]!;
    f.objects.objects.set(part.objectKey, await encryptPart(new TextEncoder().encode("y".repeat(part.plainBytes)), f.keys.recipient));
    type T = { transcript: TranscriptDto | null };
    const strict = await runScan<T>({ kind: "transcript", tool: "claude", identity: "testa", configs, id: SID, tail: 498, sessionsSource: f.handle() });
    expect(strict.ok).toBe(false);
    expect(strict.status).toBe(502);
    expect(strict.error).not.toContain("yyyy");
    const auto = await runScan<T>({ kind: "transcript", tool: "claude", identity: "testa", configs, id: SID, tail: 497, sessionsSource: f.handle({ mode: "auto", fallback: true }) });
    expect(auto.ok).toBe(true);
    expect(auto.payload!.transcript!.turns[0]!.text).toBe("First prompt p");
    expect(f.metrics.render().join("\n")).toContain('kind="integrity"} 2');
  });
  test("auto falls back to the files for a session the database does not hold yet", async () => {
    const { f, configs } = await pageFixture();
    const home = configs[0]!.identitiesJsonPath;
    expect(home).toBeTruthy();
    f.store.rows.length = 0;
    type T = { transcript: TranscriptDto | null };
    const auto = await runScan<T>({ kind: "transcript", tool: "claude", identity: "testa", configs, id: SID, tail: 496, sessionsSource: f.handle({ mode: "auto", fallback: true }) });
    expect(auto.payload!.transcript!.turns.length).toBeGreaterThan(3);
    const strict = await runScan<T>({ kind: "transcript", tool: "claude", identity: "testa", configs, id: SID, tail: 495, sessionsSource: f.handle() });
    expect(strict.payload!.transcript).toBeNull();
  });
  test("a database that fails mid-read falls back to the files in auto, and shows the error in db", async () => {
    const { f, configs } = await pageFixture();
    f.store.failWith = new Error("down");
    type Tree = { tools: ToolTreeDto[] };
    const auto = await runScan<Tree>({ kind: "tree", tool: "claude", configs, days: DAYS + 2, sessionsSource: f.handle({ mode: "auto", fallback: true }) });
    expect(auto.payload!.tools[0]!.nodes).toHaveLength(2);
    expect(auto.payload!.tools[0]!.error).toBeUndefined();
    const strict = await runScan<Tree>({ kind: "tree", tool: "claude", configs, days: DAYS + 3, sessionsSource: f.handle() });
    expect(strict.payload!.tools[0]!.nodes).toEqual([]);
    expect(strict.payload!.tools[0]!.error).toBeTruthy();
    expect(strict.payload!.tools[0]!.error).not.toContain("down");
  });
  test("the default source is the files: no database settings, same payload as before", async () => {
    const { configs } = await pageFixture();
    const run = await runScan<{ tools: ToolTreeDto[] }>({ kind: "tree", tool: "claude", configs, days: DAYS + 4 });
    expect(run.ok).toBe(true);
    expect(run.payload!.tools[0]!.nodes).toHaveLength(2);
  });
});

test("fixture clock is March 2026", () => {
  expect(new Date(T0).toISOString()).toBe("2026-03-01T09:00:00.000Z");
});
