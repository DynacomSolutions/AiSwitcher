import { beforeAll, describe, expect, test } from "bun:test";
import { Encrypter } from "age-encryption";
import { SessionEnricher, type EnricherOptions } from "../../src/gateway/sessions/enrich.ts";
import { sessionsEnrichConfigFromEnv } from "../../src/gateway/sessions/enrich-config.ts";
import { SessionsEnrichMetrics } from "../../src/gateway/sessions/enrich-metrics.ts";
import { PartReadError, S3PartSource, decodePart } from "../../src/gateway/sessions/part-reader.ts";
import { FakeObjects, FakeStore, RecordingMetrics, claudeLines, makeKeys, sha, storeParts, wholePass, type Keys } from "./sessions-enrich-kit.ts";

const REL = "projects/-srv-example/11111111-2222-4333-8444-555555555555.jsonl";

let keys: Keys;
let other: Keys;
beforeAll(async () => {
  keys = await makeKeys();
  other = await makeKeys();
});

function setup(over: Partial<EnricherOptions> = {}) {
  const store = new FakeStore();
  const objects = new FakeObjects();
  const metrics = new RecordingMetrics();
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms: number) => void (t += ms) };
  const make = (extra: Partial<EnricherOptions> = {}) =>
    new SessionEnricher({ store, source: objects, identity: keys.identity, isLeader: () => true, metrics, now: clock.now, ...over, ...extra });
  return { store, objects, metrics, clock, enricher: make(), make };
}

/** The indexed fields of a file must equal one pass over its whole text. */
function expectWhole(file: { fields: Record<string, unknown> | null; scanState: unknown; indexedBytes: number }, lines: string[], relPath = REL) {
  const whole = wholePass("claude", relPath, lines);
  expect(file.fields).toEqual(whole.fields as unknown as Record<string, unknown>);
  expect(file.scanState).toEqual(whole.state);
  expect(file.indexedBytes).toBe(whole.fields.indexedBytes);
}

describe("enrichment loop", () => {
  test("only the leader works", async () => {
    const { store, objects, metrics, make } = setup();
    const lines = claudeLines(6);
    store.add("claude", REL, await storeParts(objects, keys.recipient, "f1", lines, 2));
    const follower = make({ isLeader: () => false });
    const r = await follower.runOnce();
    expect(r.ran).toBe(false);
    expect(store.calls).toBe(0);
    expect(objects.reads).toEqual([]);
    expect(metrics.leaders).toEqual([false]);
    const leader = make();
    expect((await leader.runOnce()).enriched).toBe(1);
    expectWhole(store.files.get(1)!, lines);
  });

  test("a file in several parts equals one pass over the whole file", async () => {
    const { store, objects, enricher, metrics } = setup();
    const lines = claudeLines(11);
    store.add("claude", REL, await storeParts(objects, keys.recipient, "f1", lines, 3));
    const r = await enricher.runOnce();
    expect(r).toMatchObject({ ran: true, enriched: 1, errors: 0, more: false });
    expectWhole(store.files.get(1)!, lines);
    expect(metrics.files).toBe(1);
    expect(metrics.parts).toBe(4);
    expect(metrics.backlogs.at(-1)).toEqual({ files: 0, bytes: 0, oldestIngestAt: null });
    expect(metrics.successes.length).toBe(1);
    // Nothing is left: the next pass reads nothing.
    objects.reads.length = 0;
    expect((await enricher.runOnce()).enriched).toBe(0);
    expect(objects.reads).toEqual([]);
  });

  test("resumes from the stored state and reads only the new parts", async () => {
    const { store, objects, enricher } = setup();
    const lines = claudeLines(9);
    const first = await storeParts(objects, keys.recipient, "f1", lines.slice(0, 4), 2);
    const file = store.add("claude", REL, first);
    await enricher.runOnce();
    expect(file.indexedBytes).toBe(first.at(-1)!.endOffset);
    // The file grows: two more parts. Their offsets continue the first parts.
    const rest = await storeParts(objects, keys.recipient, "f1", lines.slice(4), 3, 0, first.at(-1)!.endOffset);
    file.parts.push(...rest);
    objects.reads.length = 0;
    await enricher.runOnce();
    expect(objects.reads).toEqual(rest.map((p) => p.objectKey));
    expectWhole(file, lines);
  });

  test("a part gap indexes what is contiguous, reports the gap and backs the file off", async () => {
    const { store, objects, enricher, metrics, clock } = setup();
    const lines = claudeLines(8);
    const parts = await storeParts(objects, keys.recipient, "f1", lines, 2);
    // Part 2 of 4 never arrived in the index.
    const file = store.add("claude", REL, [parts[0]!, parts[2]!, parts[3]!]);
    const r = await enricher.runOnce();
    expect(r.enriched).toBe(1);
    expect(r.errors).toBe(1);
    expect(metrics.errors).toEqual(["gap"]);
    expect(file.indexedBytes).toBe(parts[0]!.endOffset);
    // Backed off: the next pass skips the file.
    objects.reads.length = 0;
    expect((await enricher.runOnce()).enriched).toBe(0);
    expect(objects.reads).toEqual([]);
    // The index repairs itself (the missing part arrives), the back-off passes, the file completes.
    file.parts.splice(1, 0, parts[1]!);
    clock.advance(60_000);
    expect((await enricher.runOnce()).enriched).toBe(1);
    expectWhole(file, lines);
  });

  test("a gap at the very start of the read is an error and nothing is written", async () => {
    const { store, objects, enricher, metrics } = setup();
    const parts = await storeParts(objects, keys.recipient, "f1", claudeLines(6), 2);
    const file = store.add("claude", REL, parts.slice(1));
    expect((await enricher.runOnce()).errors).toBe(1);
    expect(metrics.errors).toEqual(["gap"]);
    expect(file.writes).toBe(0);
    expect(file.indexedBytes).toBe(0);
  });

  test("a decrypt failure writes nothing, counts, backs off, and recovers", async () => {
    const { store, objects, enricher, metrics, clock } = setup();
    const lines = claudeLines(6);
    const parts = await storeParts(objects, other.recipient, "f1", lines, 2);
    const file = store.add("claude", REL, parts);
    const r = await enricher.runOnce();
    expect(r).toMatchObject({ enriched: 0, errors: 1 });
    expect(metrics.errors).toEqual(["decrypt"]);
    expect(file.writes).toBe(0);
    expect(store.files.get(1)!.indexedBytes).toBe(0);
    expect(enricher.backedOff()).toEqual([1]);
    // The right objects are stored again after the back-off.
    const good = await storeParts(objects, keys.recipient, "f1", lines, 2);
    expect(good.map((p) => p.objectKey)).toEqual(parts.map((p) => p.objectKey));
    clock.advance(31_000);
    expect((await enricher.runOnce()).enriched).toBe(1);
    expectWhole(file, lines);
  });

  test("the back-off doubles up to its ceiling", async () => {
    const { store, objects, enricher, clock } = setup({ fileBackoffMs: 1000, fileBackoffMaxMs: 3500 });
    store.add("claude", REL, await storeParts(objects, other.recipient, "f1", claudeLines(4), 2));
    const waits: number[] = [];
    for (let i = 0; i < 4; i++) {
      await enricher.runOnce();
      let waited = 0;
      while (enricher.backedOff().length > 0) {
        clock.advance(100);
        waited += 100;
      }
      waits.push(waited);
    }
    expect(waits).toEqual([1000, 2000, 3500, 3500]);
  });

  test("a part with the wrong content fails the integrity check", async () => {
    const { store, objects, enricher, metrics } = setup();
    const lines = claudeLines(4);
    const parts = await storeParts(objects, keys.recipient, "f1", lines, 2);
    parts[0]!.plainSha256 = sha("something else");
    store.add("claude", REL, parts);
    await enricher.runOnce();
    expect(metrics.errors).toEqual(["integrity"]);
    expect(store.files.get(1)!.writes).toBe(0);
  });

  test("a part object that is missing is counted as missing", async () => {
    const { store, objects, enricher, metrics } = setup();
    const parts = await storeParts(objects, keys.recipient, "f1", claudeLines(4), 2);
    objects.objects.delete(parts[1]!.objectKey);
    const file = store.add("claude", REL, parts);
    await enricher.runOnce();
    expect(metrics.errors).toEqual(["missing"]);
    // The first part is lost with it: a file moves only after all parts of the step read.
    expect(file.writes).toBe(0);
  });

  test("a crash in the middle of a batch keeps finished files and redoes the rest", async () => {
    const { store, objects, enricher, metrics, clock } = setup({ concurrency: 1 });
    const a = claudeLines(6, "a");
    const b = claudeLines(6, "b");
    const fa = store.add("claude", "projects/x/a.jsonl", await storeParts(objects, keys.recipient, "fa", a, 2), 1);
    const fb = store.add("claude", "projects/x/b.jsonl", await storeParts(objects, keys.recipient, "fb", b, 2), 2);
    // The second file dies after its first part was read (a crash between reading and writing).
    objects.failAfter = { reads: 4, error: new PartReadError("fetch", "connection reset") };
    const r1 = await enricher.runOnce();
    expect(r1.enriched).toBe(1);
    expect(fa.indexedBytes).toBeGreaterThan(0);
    expect(fb.indexedBytes).toBe(0);
    expect(fb.writes).toBe(0);
    expect(metrics.errors).toEqual(["fetch"]);
    expect(enricher.loopFailureCount).toBe(0);
    // A new process (empty memory) continues from the stored state.
    objects.failAfter = undefined;
    const fresh = setup().make({ store, source: objects, metrics, now: clock.now });
    expect((await fresh.runOnce()).enriched).toBe(1);
    expectWhole(fa, a, "projects/x/a.jsonl");
    expectWhole(fb, b, "projects/x/b.jsonl");
    expect(fa.writes).toBe(1);
  });

  test("a failed write leaves the state as it was and the next pass finishes the file", async () => {
    const { store, objects, enricher, clock } = setup();
    const lines = claudeLines(6);
    const file = store.add("claude", REL, await storeParts(objects, keys.recipient, "f1", lines, 2));
    store.failNext.applyEnrichment = new Error("connection terminated");
    const r = await enricher.runOnce();
    expect(r.errors).toBe(1);
    expect(file.indexedBytes).toBe(0);
    expect(file.scanState).toEqual({});
    // The whole pass failed and nothing moved: the loop backs off too.
    expect(enricher.loopFailureCount).toBe(1);
    clock.advance(31_000);
    expect((await enricher.runOnce()).enriched).toBe(1);
    expect(enricher.loopFailureCount).toBe(0);
    expectWhole(file, lines);
  });

  test("a second runner cannot write over the first: the write needs the same indexed_bytes", async () => {
    const { store, objects, make } = setup();
    const lines = claudeLines(6);
    const file = store.add("claude", REL, await storeParts(objects, keys.recipient, "f1", lines, 2));
    const slow = make();
    // While the slow runner holds its read, a faster one finishes the file.
    let once = true;
    store.beforeApply = () => {
      if (!once) return;
      once = false;
      store.beforeApply = undefined;
      const w = whole(lines);
      file.indexedBytes = w.fields.indexedBytes;
      file.scanState = w.state;
      file.fields = { ...w.fields };
      file.writes += 1;
    };
    const r = await slow.runOnce();
    expect(r.enriched).toBe(0);
    expect(file.writes).toBe(1);
    expectWhole(file, lines);
  });

  test("a store that cannot list the queue backs the loop off and recovers", async () => {
    const { store, objects, enricher, metrics } = setup();
    store.add("claude", REL, await storeParts(objects, keys.recipient, "f1", claudeLines(2), 2));
    store.failNext.enrichQueue = new Error("database down");
    expect((await enricher.runOnce()).errors).toBe(1);
    expect(enricher.loopFailureCount).toBe(1);
    expect(metrics.errors).toEqual(["store"]);
    expect((await enricher.runOnce()).enriched).toBe(1);
    expect(enricher.loopFailureCount).toBe(0);
  });

  test("a file is read in bounded steps and the pass reports that more is left", async () => {
    const { store, objects, enricher } = setup({ maxBytesPerFile: 1 });
    const lines = claudeLines(8);
    const file = store.add("claude", REL, await storeParts(objects, keys.recipient, "f1", lines, 2));
    let passes = 0;
    for (;;) {
      passes += 1;
      const r = await enricher.runOnce();
      expect(r.errors).toBe(0);
      if (!r.more) break;
      expect(passes).toBeLessThan(10);
    }
    // One part per pass: four parts, the last pass ends the file.
    expect(passes).toBe(4);
    expectWhole(file, lines);
  });

  test("a state from another version or file is not continued: the file is read again from byte 0", async () => {
    const { store, objects, enricher } = setup();
    const lines = claudeLines(6);
    const file = store.add("claude", REL, await storeParts(objects, keys.recipient, "f1", lines, 2));
    file.indexedBytes = file.parts[1]!.endOffset;
    file.scanState = { v: 99, kind: "claude", relPath: REL, bytes: file.indexedBytes, lines: 4 };
    objects.reads.length = 0;
    await enricher.runOnce();
    expect(objects.reads.length).toBe(3);
    expectWhole(file, lines);
  });

  test("files without an indexer, and the thread name file, leave the queue unread", async () => {
    const { store, objects, enricher } = setup();
    const p = await storeParts(objects, keys.recipient, "f1", ['{"id":"t","thread_name":"x"}'], 1);
    const index = store.add("codex", "session_index.jsonl", p);
    const grok = store.add("grok", "x/y.jsonl", p);
    await enricher.runOnce();
    expect(objects.reads).toEqual([]);
    expect(index.indexedBytes).toBe(index.parts[0]!.endOffset);
    // The fake queue (like the SQL) does not list kinds without an indexer.
    expect(grok.indexedBytes).toBe(0);
  });

  test("Codex rollouts are indexed too", async () => {
    const { store, objects, enricher } = setup();
    const rel = "sessions/2026/03/02/rollout-2026-03-02T08-00-00-11111111-2222-4333-8444-555555555555.jsonl";
    const lines = [
      JSON.stringify({ timestamp: "2026-03-02T08:00:00.000Z", type: "session_meta", payload: { id: "11111111-2222-4333-8444-555555555555", cwd: "/srv/repositories/example-org/example-repo" } }),
      JSON.stringify({ timestamp: "2026-03-02T08:00:01.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Rename the helper" }] } }),
      JSON.stringify({ timestamp: "2026-03-02T08:00:02.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] } }),
    ];
    const file = store.add("codex", rel, await storeParts(objects, keys.recipient, "c1", lines, 2));
    await enricher.runOnce();
    const whole = wholePass("codex", rel, lines);
    expect(file.fields).toEqual(whole.fields as unknown as Record<string, unknown>);
    expect(file.fields).toMatchObject({ title: "Rename the helper", project: "example-org/example-repo", messageCount: 2 });
  });

  test("start runs the loop until stop, and stop waits for the pass", async () => {
    const { store, objects, make } = setup();
    const lines = claudeLines(4);
    const file = store.add("claude", REL, await storeParts(objects, keys.recipient, "f1", lines, 2));
    const e = make({ intervalMs: 20 });
    e.start();
    e.start();
    for (let i = 0; i < 100 && file.indexedBytes === 0; i++) await Bun.sleep(10);
    await e.stop();
    expectWhole(file, lines);
    const calls = store.calls;
    await Bun.sleep(60);
    expect(store.calls).toBe(calls);
  });
});

function whole(lines: string[]) {
  return wholePass("claude", REL, lines);
}

describe("decodePart", () => {
  test("round trip, and every failure has its own kind", async () => {
    const objects = new FakeObjects();
    const [row] = await storeParts(objects, keys.recipient, "f", ["a", "b"], 2);
    const stored = objects.objects.get(row!.objectKey)!;
    expect(await decodePart(stored, row!, keys.identity)).toBe("a\nb\n");
    const kind = async (p: Promise<unknown>) => ((await p.catch((e) => e)) as PartReadError).kind;
    expect(await kind(decodePart(stored, row!, other.identity))).toBe("decrypt");
    expect(await kind(decodePart(new Uint8Array([1, 2, 3]), row!, keys.identity))).toBe("decrypt");
    expect(await kind(decodePart(stored, { ...row!, plainBytes: row!.plainBytes + 1 }, keys.identity))).toBe("integrity");
    expect(await kind(decodePart(stored, { ...row!, plainSha256: sha("x") }, keys.identity))).toBe("integrity");
    const e = new Encrypter();
    e.addRecipient(keys.recipient);
    const notGzip = await e.encrypt(new TextEncoder().encode("plain text, not gzip"));
    expect(await kind(decodePart(notGzip, row!, keys.identity))).toBe("integrity");
  });

  test("the S3 source refuses keys outside its prefix before any request", async () => {
    const src = new S3PartSource({ endpoint: "http://127.0.0.1:1", bucket: "b", prefix: "objects/v1/", region: "auto", accessKeyId: "AKIDEXAMPLE0000000", secretAccessKey: "SYNTHETIC_FIXTURE_secret" });
    for (const key of ["", "other/x", "/objects/v1/x", "objects/v1/../x"]) {
      expect(((await src.read(key).catch((e) => e)) as PartReadError).kind).toBe("bad_key");
    }
  });
});

describe("settings from the environment", () => {
  const base = {
    AIS_SESSIONS_ENRICH: "1",
    AIS_SESSIONS_S3_ENDPOINT: "http://objects.example.test:8080",
    AIS_SESSIONS_S3_BUCKET: "sessions-bucket",
    AIS_SESSIONS_S3_PREFIX: "objects/v1/",
    AIS_SESSIONS_S3_ACCESS_KEY_ID: "AKIDEXAMPLE0000000",
    AIS_SESSIONS_S3_SECRET_ACCESS_KEY: "SYNTHETIC_FIXTURE_secret",
    AIS_SESSIONS_AGE_IDENTITY: "SYNTHETIC_FIXTURE_identity",
  };

  test("off by default and for any value but 1 or true", () => {
    expect(sessionsEnrichConfigFromEnv({})).toBeUndefined();
    expect(sessionsEnrichConfigFromEnv({ ...base, AIS_SESSIONS_ENRICH: "0" })).toBeUndefined();
    expect(sessionsEnrichConfigFromEnv({ ...base, AIS_SESSIONS_ENRICH: "yes" })).toBeUndefined();
  });

  test("reads every setting, with defaults", () => {
    expect(sessionsEnrichConfigFromEnv(base)).toMatchObject({ bucket: "sessions-bucket", prefix: "objects/v1/", region: "auto", intervalMs: 5000, batchFiles: 50 });
    expect(sessionsEnrichConfigFromEnv({ ...base, AIS_SESSIONS_ENRICH: "true", AIS_SESSIONS_S3_REGION: "r1", AIS_SESSIONS_ENRICH_BATCH: "7", AIS_SESSIONS_ENRICH_INTERVAL_MS: "x" })).toMatchObject({ region: "r1", batchFiles: 7, intervalMs: 5000 });
  });

  test("a missing setting names its variable and never a value", () => {
    for (const name of ["AIS_SESSIONS_S3_ENDPOINT", "AIS_SESSIONS_S3_BUCKET", "AIS_SESSIONS_S3_ACCESS_KEY_ID", "AIS_SESSIONS_S3_SECRET_ACCESS_KEY", "AIS_SESSIONS_AGE_IDENTITY"]) {
      const env: Record<string, string | undefined> = { ...base, [name]: "  " };
      expect(() => sessionsEnrichConfigFromEnv(env)).toThrow(`${name} is not set`);
    }
  });
});

describe("metrics text", () => {
  test("counters, errors by kind, and backlog gauges that only the leader sets", () => {
    const m = new SessionsEnrichMetrics();
    m.leader(true);
    m.fileEnriched(100, 40, 2);
    m.error("decrypt");
    m.error("nonsense" as never);
    m.success(5_000_000);
    m.backlog({ files: 3, bytes: 900, oldestIngestAt: 4_990_000 }, 5_000_000);
    const text = m.render().join("\n");
    expect(text).toContain("ais_sessions_files_enriched_total 1");
    expect(text).toContain('ais_sessions_enrich_bytes_total{kind="plain"} 100');
    expect(text).toContain('ais_sessions_enrich_bytes_total{kind="object"} 40');
    expect(text).toContain('ais_sessions_indexer_errors_total{kind="decrypt"} 1');
    expect(text).toContain('ais_sessions_indexer_errors_total{kind="other"} 1');
    expect(text).toContain("ais_sessions_indexer_last_success_timestamp_seconds 5000");
    expect(text).toContain("ais_sessions_unindexed_bytes 900");
    expect(text).toContain("ais_sessions_enrich_lag_seconds 10");
    m.leader(false);
    const after = m.render().join("\n");
    expect(after).not.toContain("ais_sessions_unindexed_bytes");
    expect(after).toContain("ais_sessions_enrich_leader 0");
  });
});

describe("gateway metrics page", () => {
  test("a section added to PrometheusMetrics shows in the render", async () => {
    const { PrometheusMetrics } = await import("../../src/gateway/metrics.ts");
    const page = new PrometheusMetrics({ ledgerDepth: () => 0, ledgerDropped: () => 0 });
    expect(page.render()).not.toContain("ais_sessions_files_enriched_total");
    const m = new SessionsEnrichMetrics();
    page.sections.push(() => m.render());
    expect(page.render()).toContain("ais_sessions_files_enriched_total 0");
  });
});
