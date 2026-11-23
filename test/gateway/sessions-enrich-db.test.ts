import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { migrate } from "../../src/gateway/pg-store.ts";
import { SessionEnricher } from "../../src/gateway/sessions/enrich.ts";
import { SessionStore, partObjectPrefix, type SessionIngest } from "../../src/gateway/sessions/session-store.ts";
import { FakeObjects, claudeLines, makeKeys, sha, storeParts, wholePass, type Keys } from "./sessions-enrich-kit.ts";

/** The enrichment against the real SessionStore on Postgres, with a fake object store. */

const url = process.env.AIS_GATEWAY_TEST_DATABASE_URL;
const optOut = process.env.AIS_GATEWAY_TEST_NO_DATABASE === "1";

const REL = "projects/-srv-example/11111111-2222-4333-8444-555555555555.jsonl";

if (!url && process.env.CI && !optOut) {
  test("session enrichment tests need AIS_GATEWAY_TEST_DATABASE_URL in CI", () => {
    throw new Error("AIS_GATEWAY_TEST_DATABASE_URL is unset in CI; provide a Postgres service or set AIS_GATEWAY_TEST_NO_DATABASE=1");
  });
} else if (!url) {
  console.warn("SKIP session enrichment database tests: AIS_GATEWAY_TEST_DATABASE_URL is not set");
  test.skip("session enrichment database tests need AIS_GATEWAY_TEST_DATABASE_URL", () => {});
} else {
  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (!dbName.includes("test")) throw new Error(`refusing to use database "${dbName}": its name must contain "test"`);

  const stores: SessionStore[] = [];
  const admin = new SQL(url);
  const make = (): SessionStore => {
    const s = new SessionStore(url, { poolMax: 3 });
    stores.push(s);
    return s;
  };
  let keys: Keys;
  beforeAll(async () => {
    keys = await makeKeys();
  });
  beforeEach(async () => {
    await migrate(url);
    await admin`TRUNCATE ais_session_file RESTART IDENTITY CASCADE`;
  });
  afterEach(async () => {
    for (const s of stores.splice(0)) await s.close();
  });
  afterAll(async () => {
    await admin.close();
  });

  /** Ingests the parts of `lines` in groups, as the shipper does, and returns the file id. */
  async function ingestLines(store: SessionStore, objects: FakeObjects, rel: string, tag: string, lines: string[], perPart: number, startAt = 0, startOffset = 0, over: Partial<SessionIngest> = {}) {
    const kind = over.kind ?? "claude";
    const sessionRef = over.sessionRef ?? "11111111-2222-4333-8444-555555555555";
    const parts = await storeParts(objects, keys.recipient, tag, lines, perPart, startAt, startOffset, partObjectPrefix(kind, sessionRef, 0));
    const res = await store.ingest({
      node: "node-a",
      root: "/data/pool",
      relPath: rel,
      generation: 0,
      kind,
      origin: "pool-folder",
      sessionRef,
      headSha256: sha("head"),
      mtimeMs: 1_700_000_000_000,
      parts,
      ...over,
    });
    expect(res.status).toBe("committed");
    return parts;
  }

  const row = async (rel: string) => (await admin`SELECT * FROM ais_session_file WHERE rel_path = ${rel}`)[0]!;

  describe("SessionStore enrichment methods", () => {
    test("queue, backlog, parts window, compare-and-set write", async () => {
      const store = make();
      const objects = new FakeObjects();
      const lines = claudeLines(8);
      await ingestLines(store, objects, REL, "f1", lines, 2);
      await ingestLines(store, objects, "x/other.jsonl", "f2", claudeLines(2), 2, 0, 0, { kind: "grok", sessionRef: "g1" });

      const queue = await store.enrichQueue(10);
      expect(queue.map((c) => [c.relPath, c.kind, c.indexedBytes])).toEqual([[REL, "claude", 0]]);
      expect(queue[0]!.scanState).toEqual({});
      expect(await store.enrichQueue(10, [queue[0]!.fileId])).toEqual([]);
      const backlog = await store.enrichBacklog();
      expect(backlog).toMatchObject({ files: 1, bytes: queue[0]!.committedBytes });
      expect(backlog.oldestIngestAt).toBeGreaterThan(0);

      const all = await store.partsFrom(queue[0]!.fileId, 0, 1e9);
      expect(all.length).toBe(4);
      const two = await store.partsFrom(queue[0]!.fileId, all[1]!.startOffset, all[1]!.plainBytes + 1);
      expect(two.map((p) => p.startOffset)).toEqual([all[1]!.startOffset, all[2]!.startOffset]);
      expect((await store.partsFrom(queue[0]!.fileId, 0, 1)).length).toBe(1);

      const whole = wholePass("claude", REL, lines);
      const w = { fileId: queue[0]!.fileId, expectedIndexedBytes: 0, fields: whole.fields, state: whole.state };
      expect(await store.applyEnrichment({ ...w, expectedIndexedBytes: 5 })).toBe(false);
      expect(await store.applyEnrichment({ ...w, fields: { ...whole.fields, indexedBytes: queue[0]!.committedBytes + 1 } })).toBe(false);
      expect(await store.applyEnrichment(w)).toBe(true);
      // The same write again is stale now.
      expect(await store.applyEnrichment(w)).toBe(false);
      const r = await row(REL);
      expect(r).toMatchObject({ title: "First prompt a", cwd: "/srv/repositories/example-org/example-repo", project: "example-org/example-repo", model: "model-a-1", message_count: 8 });
      expect(Number(r.indexed_bytes)).toBe(whole.fields.indexedBytes);
      expect(typeof r.scan_state === "string" ? JSON.parse(r.scan_state) : r.scan_state).toEqual(whole.state);
      expect(new Date(r.updated_at).getTime()).toBe(whole.fields.updatedAt!);
      expect((await store.enrichQueue(10)).length).toBe(0);
      expect(await store.enrichBacklog()).toEqual({ files: 0, bytes: 0, oldestIngestAt: null });
    });

    test("a null record time keeps the ingest time, and a null title stays null", async () => {
      const store = make();
      const objects = new FakeObjects();
      await ingestLines(store, objects, REL, "f1", [JSON.stringify({ type: "permission-mode", permissionMode: "default" })], 1);
      const before = await row(REL);
      const c = (await store.enrichQueue(1))[0]!;
      const whole = wholePass("claude", REL, [JSON.stringify({ type: "permission-mode", permissionMode: "default" })]);
      expect(await store.applyEnrichment({ fileId: c.fileId, expectedIndexedBytes: 0, fields: whole.fields, state: whole.state })).toBe(true);
      const after = await row(REL);
      expect(after.title).toBeNull();
      expect(new Date(after.updated_at).getTime()).toBe(new Date(before.updated_at).getTime());
    });

    test("markIndexed moves the indexed bytes of a file that needs no indexing", async () => {
      const store = make();
      const objects = new FakeObjects();
      await ingestLines(store, objects, "session_index.jsonl", "si", ['{"id":"t"}'], 1, 0, 0, { kind: "codex", sessionRef: "session_index" });
      const c = (await store.enrichQueue(1))[0]!;
      expect(await store.markIndexed(c.fileId, 7)).toBe(false);
      expect(await store.markIndexed(c.fileId, 0)).toBe(true);
      expect(await store.enrichQueue(1)).toEqual([]);
    });
  });

  describe("enrichment against Postgres", () => {
    test("a growing file is enriched part by part and equals one pass over the file", async () => {
      const store = make();
      const objects = new FakeObjects();
      const lines = claudeLines(10);
      const enricher = new SessionEnricher({ store, source: objects, identity: keys.identity, isLeader: () => true });
      const first = await ingestLines(store, objects, REL, "f1", lines.slice(0, 6), 2);
      expect((await enricher.runOnce()).enriched).toBe(1);
      expect(Number((await row(REL)).indexed_bytes)).toBe(first.at(-1)!.endOffset);
      // The shipper adds more parts. The enrichment reads only those.
      await ingestLines(store, objects, REL, "f1", lines, 2, 6, first.at(-1)!.endOffset);
      objects.reads.length = 0;
      expect((await enricher.runOnce()).enriched).toBe(1);
      expect(objects.reads.length).toBe(2);
      const whole = wholePass("claude", REL, lines);
      const r = await row(REL);
      expect(Number(r.indexed_bytes)).toBe(whole.fields.indexedBytes);
      expect(Number(r.committed_bytes)).toBe(whole.fields.indexedBytes);
      expect(r).toMatchObject({ title: whole.fields.title, message_count: whole.fields.messageCount, project: "example-org/example-repo" });
      const tree = await store.tree();
      expect(tree.map((n) => [n.sessionRef, n.title, n.indexedBytes === n.committedBytes])).toEqual([["11111111-2222-4333-8444-555555555555", "First prompt a", true]]);
    });

    test("only one of two runners writes, and a crash after the read leaves the row as it was", async () => {
      const store = make();
      const objects = new FakeObjects();
      const lines = claudeLines(6);
      await ingestLines(store, objects, REL, "f1", lines, 2);
      const a = new SessionEnricher({ store, source: objects, identity: keys.identity, isLeader: () => true });
      const b = new SessionEnricher({ store: make(), source: objects, identity: keys.identity, isLeader: () => true });
      const [ra, rb] = await Promise.all([a.runOnce(), b.runOnce()]);
      expect(ra.enriched + rb.enriched).toBe(1);
      const whole = wholePass("claude", REL, lines);
      expect(Number((await row(REL)).indexed_bytes)).toBe(whole.fields.indexedBytes);

      // A new file whose read dies half way: nothing is written.
      await ingestLines(store, objects, "projects/-srv-example/22222222-2222-4333-8444-555555555555.jsonl", "f2", lines, 2, 0, 0, { sessionRef: "22222222-2222-4333-8444-555555555555" });
      objects.reads.length = 0;
      objects.failAfter = { reads: 1, error: new Error("process killed") };
      await a.runOnce();
      const crashed = await row("projects/-srv-example/22222222-2222-4333-8444-555555555555.jsonl");
      expect(Number(crashed.indexed_bytes)).toBe(0);
      expect(crashed.title).toBeNull();
    });
  });
}
