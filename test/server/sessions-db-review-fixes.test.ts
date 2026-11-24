import { afterEach, describe, expect, test } from "bun:test";
import type { TranscriptDto } from "../../src/cli/sessions/types.ts";
import { runScan } from "../../src/server/scan-worker.ts";
import { UNASSIGNED_IDENTITY } from "../../src/server/sessions-db/db-source.ts";
import { dbProbeSuspended, markProbeFailedHere, noteDbProbeFailure, resetProbeCacheForTest, takeProbeFailed } from "../../src/server/sessions-db/probe-cache.ts";
import { openSessionsSource } from "../../src/server/sessions-db/source.ts";
import { claudeSession, cleanTemps, makeFixture } from "./sessions-db-kit.ts";

afterEach(async () => {
  resetProbeCacheForTest();
  await cleanTemps();
});

const SID = "11111111-2222-4333-8444-555555555555";
const REL = `projects/-srv-example/${SID}.jsonl`;
const settings = (url: string) => ({
  AIS_SESSIONS_SOURCE: "auto",
  AIS_SESSIONS_DATABASE_URL: url,
  AIS_SESSIONS_S3_ENDPOINT: "https://s3.invalid",
  AIS_SESSIONS_S3_BUCKET: "b",
  AIS_SESSIONS_S3_ACCESS_KEY_ID: "kid",
  AIS_SESSIONS_S3_SECRET_ACCESS_KEY: "ksecret",
  AIS_SESSIONS_AGE_IDENTITY: "AGE-SECRET-KEY-1TEST",
});

describe("auto falls back within the probe timeout", () => {
  test("a close() that waits for a pending connect does not hold the read", async () => {
    const f = await makeFixture();
    const slow = {
      ...f.store,
      ping: () => new Promise<void>(() => {}),
      close: () => new Promise<void>((r) => setTimeout(r, 4000)),
      tree: f.store.tree.bind(f.store),
      filesOfSession: f.store.filesOfSession.bind(f.store),
      tailParts: f.store.tailParts.bind(f.store),
    };
    const t0 = Date.now();
    const h = await openSessionsSource(settings("postgres://u@db.invalid/x"), { store: slow, parts: f.objects, pingTimeoutMs: 150 });
    expect(h.used).toBe("files");
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(takeProbeFailed()).toBe(true);
  }, 20_000);

  test("a port that accepts and never answers (real driver) falls back in about the timeout, not 30 s", async () => {
    const sockets: unknown[] = [];
    const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open: (s) => void sockets.push(s), data() {}, close() {} } });
    try {
      const t0 = Date.now();
      const h = await openSessionsSource(settings(`postgres://u@127.0.0.1:${server.port}/x`), { pingTimeoutMs: 400 });
      expect(h.used).toBe("files");
      expect(Date.now() - t0).toBeLessThan(4000);
    } finally {
      server.stop(true);
    }
  }, 20_000);

  test("after a failed probe the console tells scan children to skip the probe for a while", async () => {
    expect(dbProbeSuspended()).toBe(false);
    noteDbProbeFailure(1_000, 60_000);
    expect(dbProbeSuspended(30_000)).toBe(true);
    expect(dbProbeSuspended(70_000)).toBe(false);
    const f = await makeFixture();
    f.store.failWith = new Error("must not be probed");
    const h = await openSessionsSource(settings("postgres://u@db.invalid/x"), { store: f.store, parts: f.objects, skipProbe: true });
    expect(h.used).toBe("files");
    expect(f.store.calls).toBe(0);
    // db mode ignores the skip: it has no files to fall back to.
    const strict = await openSessionsSource({ ...settings("postgres://u@db.invalid/x"), AIS_SESSIONS_SOURCE: "db" }, { store: f.store, parts: f.objects, skipProbe: true });
    expect(strict.used).toBe("db");
    markProbeFailedHere();
    expect(takeProbeFailed()).toBe(true);
    expect(takeProbeFailed()).toBe(false);
  });
});

describe("an unassigned session opens", () => {
  type T = { transcript: TranscriptDto | null };
  test("in db and auto mode the transcript of the (unassigned) slice is read; files mode keeps the error", async () => {
    const f = await makeFixture();
    await f.add({ kind: "claude", relPath: REL, identity: null, lines: claudeSession("u") }, 3);
    const dbRun = await runScan<T>({ kind: "transcript", tool: "claude", identity: UNASSIGNED_IDENTITY, id: SID, tail: 501, sessionsSource: f.handle() });
    expect(dbRun.ok).toBe(true);
    expect(dbRun.payload!.transcript!.turns[0]!.text).toBe("First prompt u");
    expect(dbRun.payload!.transcript!.session.identity).toBe(UNASSIGNED_IDENTITY);
    const auto = await runScan<T>({ kind: "transcript", tool: "claude", identity: UNASSIGNED_IDENTITY, id: SID, tail: 502, sessionsSource: f.handle({ mode: "auto", fallback: true }) });
    expect(auto.payload!.transcript!.turns.length).toBeGreaterThan(3);
    const missing = await runScan<T>({ kind: "transcript", tool: "claude", identity: UNASSIGNED_IDENTITY, id: "nope", tail: 503, sessionsSource: f.handle({ mode: "auto", fallback: true }) });
    expect(missing.ok).toBe(true);
    expect(missing.payload!.transcript).toBeNull();
    const files = await runScan<T>({
      kind: "transcript",
      tool: "claude",
      identity: UNASSIGNED_IDENTITY,
      id: SID,
      tail: 504,
      configs: [],
      sessionsSource: { mode: "files", used: "files", fallback: false, close: async () => {} },
    });
    expect(files.ok).toBe(false);
    expect(files.status).toBe(400);
  });

  test("a request for identity A does not show a session with no identity, and the unassigned slice does not show A's", async () => {
    const f = await makeFixture();
    await f.add({ kind: "claude", relPath: REL, identity: null, lines: claudeSession("u") }, 3);
    await f.add({ kind: "claude", relPath: `projects/-srv-example/other.jsonl`, identity: "testa", lines: claudeSession("a") }, 3);
    expect(await f.db.readTranscript({ tool: "claude", identity: "testa", id: SID })).toBeUndefined();
    expect(await f.db.readTranscript({ tool: "claude", identity: UNASSIGNED_IDENTITY, id: SID })).toBeDefined();
    expect(await f.db.readTranscript({ tool: "claude", identity: UNASSIGNED_IDENTITY, id: "other" })).toBeUndefined();
    expect(await f.db.readTranscript({ tool: "claude", identity: "testa", id: "other" })).toBeDefined();
  });
});

describe("a missing part row is an integrity error, never short text", () => {
  const stored = async (windowBytes?: number, lines = 12) => {
    const f = await makeFixture(windowBytes ? { windowBytes } : {});
    const row = await f.add({ kind: "claude", relPath: REL, identity: "testa", lines: claudeSession("m", lines) }, 3);
    return { f, row, parts: f.store.parts.get(row.fileId)! };
  };
  const read = (f: Awaited<ReturnType<typeof makeFixture>>) => f.db.readTranscript({ tool: "claude", identity: "testa", id: SID });

  test("whole and intact: still fine", async () => {
    const { f } = await stored();
    expect((await read(f))!.truncated).toBe(false);
  });
  test("last row missing", async () => {
    const { f, row, parts } = await stored();
    f.store.parts.set(row.fileId, parts.slice(0, -1));
    await expect(read(f)).rejects.toMatchObject({ kind: "integrity" });
  });
  test("first row missing, small session", async () => {
    const { f, row, parts } = await stored();
    f.store.parts.set(row.fileId, parts.slice(1));
    await expect(read(f)).rejects.toMatchObject({ kind: "integrity" });
  });
  test("a middle row missing is a gap error", async () => {
    const { f, row, parts } = await stored();
    f.store.parts.set(row.fileId, [parts[0]!, parts[2]!, parts[3]!]);
    await expect(read(f)).rejects.toMatchObject({ kind: "gap" });
  });
  test("every row missing", async () => {
    const { f, row } = await stored();
    f.store.parts.set(row.fileId, []);
    await expect(read(f)).rejects.toMatchObject({ kind: "integrity" });
  });
  test("a real window inside a big session is still a normal truncated read", async () => {
    const { f } = await stored(600, 40);
    const dto = (await read(f))!;
    expect(dto.truncated).toBe(true);
  });
});
