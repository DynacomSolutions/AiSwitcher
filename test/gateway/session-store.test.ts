import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { SQL } from "bun";
import { migrate } from "../../src/gateway/pg-store.ts";
import {
  HEAD_BYTES,
  SessionIngestInvalid,
  SessionStore,
  validateIngest,
  type SessionIngest,
  type SessionPartInput,
} from "../../src/gateway/sessions/session-store.ts";

const url = process.env.AIS_GATEWAY_TEST_DATABASE_URL;
const optOut = process.env.AIS_GATEWAY_TEST_NO_DATABASE === "1";

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

/** A part of `len` bytes at `start`. `tag` changes the content hash. */
function part(start: number, len: number, tag = "a"): SessionPartInput {
  return {
    startOffset: start,
    endOffset: start + len,
    lines: Math.max(1, Math.round(len / 100)),
    plainBytes: len,
    objectBytes: Math.round(len / 6),
    plainSha256: sha(`${start}:${len}:${tag}`),
    objectKey: `objects/v1/node-a/r/f/g0/${start}-${start + len}.gz.age`,
  };
}

function req(parts: SessionPartInput[], over: Partial<SessionIngest> = {}): SessionIngest {
  return {
    node: "node-a",
    root: "/data/pool",
    relPath: "projects/p/s1.jsonl",
    generation: 0,
    kind: "claude",
    origin: "pool-folder",
    pool: "main",
    sessionRef: "s1",
    headSha256: sha("head"),
    parts,
    ...over,
  };
}

const keyOf = (r: SessionIngest) => ({ kind: r.kind, sessionRef: r.sessionRef, node: r.node, root: r.root, relPath: r.relPath });

describe("validateIngest", () => {
  test("refuses requests that no correct writer sends", () => {
    const bad = (r: SessionIngest) => expect(() => validateIngest(r)).toThrow(SessionIngestInvalid);
    bad(req([]));
    bad(req([part(0, 100), part(200, 100)]));
    bad(req([{ ...part(0, 100), plainBytes: 99 }]));
    bad(req([{ ...part(0, 100), endOffset: 0 }]));
    bad(req([{ ...part(0, 100), startOffset: -1 }]));
    bad(req([{ ...part(0, 100), plainSha256: "xyz" }]));
    bad(req([{ ...part(0, 100), objectKey: "" }]));
    bad(req([part(0, 100)], { headSha256: "ABC" }));
    bad(req([part(0, 100)], { generation: -1 }));
    bad(req([part(0, 100)], { sessionRef: "" }));
    expect(() => validateIngest(req([part(0, 100), part(100, 50)]))).not.toThrow();
  });
});

if (!url && process.env.CI && !optOut) {
  test("session store tests need AIS_GATEWAY_TEST_DATABASE_URL in CI", () => {
    throw new Error("AIS_GATEWAY_TEST_DATABASE_URL is unset in CI; provide a Postgres service or set AIS_GATEWAY_TEST_NO_DATABASE=1");
  });
} else if (!url) {
  console.warn("SKIP session store tests: AIS_GATEWAY_TEST_DATABASE_URL is not set");
  test.skip("session store tests need AIS_GATEWAY_TEST_DATABASE_URL", () => {});
} else {
  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (!dbName.includes("test")) throw new Error(`refusing to use database "${dbName}": its name must contain "test"`);

  const stores: SessionStore[] = [];
  const admin = new SQL(url);
  const make = (hooks?: ConstructorParameters<typeof SessionStore>[1]): SessionStore => {
    const s = new SessionStore(url, { poolMax: 3, ...hooks });
    stores.push(s);
    return s;
  };
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

  const state = async (r: SessionIngest) => {
    const [c] = await make().cursors([keyOf(r)]);
    return c;
  };
  const partCount = async (): Promise<number> => Number((await admin`SELECT count(*)::int AS n FROM ais_session_part`)[0]!.n);

  describe("migration 0014", () => {
    test("creates the tables and the view, and runs twice without error", async () => {
      await migrate(url);
      await migrate(url);
      const t = await admin`SELECT to_regclass('ais_session_file') AS f, to_regclass('ais_session_part') AS p, to_regclass('ais_session_tree') AS v, to_regclass('ais_session_path') AS h`;
      expect(t[0]).toMatchObject({ f: "ais_session_file", p: "ais_session_part", v: "ais_session_tree", h: "ais_session_path" });
      const v = await admin`SELECT version FROM schema_migrations WHERE version IN ('0014_sessions', '0015_sessions_one_copy')`;
      expect(v.length).toBe(2);
    });
  });

  describe("cursors", () => {
    test("an unknown file has no cursor", async () => {
      expect(await make().cursors([keyOf(req([part(0, 100)]))])).toEqual([null]);
      expect(await make().cursors([])).toEqual([]);
    });

    test("the cursor follows the ingest, one answer per key in the order asked", async () => {
      const s = make();
      const a = req([part(0, 1000), part(1000, 500)]);
      const b = req([part(0, 300)], { relPath: "projects/p/s2.jsonl", sessionRef: "s2" });
      await s.ingest(a);
      await s.ingest(b);
      const [ca, unknown, cb] = await s.cursors([keyOf(a), { ...keyOf(a), sessionRef: "nobody", node: "node-b", root: "/x", relPath: "y" }, keyOf(b)]);
      expect(ca).toMatchObject({ generation: 0, committedBytes: 1500, headSha256: a.headSha256, held: true });
      expect(unknown).toBeNull();
      expect(cb).toMatchObject({ committedBytes: 300 });
      expect(ca!.committedLines).toBe(part(0, 1000).lines + part(1000, 500).lines);
    });

    test("the key is the tool and the session id: another path gets the same cursor, but is not a holder", async () => {
      const s = make();
      await s.ingest(req([part(0, 100)]));
      const [otherNode, otherRoot, otherTool] = await s.cursors([
        keyOf(req([], { node: "node-b" })),
        keyOf(req([], { root: "/other" })),
        keyOf(req([], { kind: "codex" })),
      ]);
      expect(otherNode).toMatchObject({ committedBytes: 100, held: false });
      expect(otherRoot).toMatchObject({ committedBytes: 100, held: false });
      expect(otherTool).toBeNull();
    });
  });

  describe("ingest by offset", () => {
    test("a new file takes its first parts and the cursor moves to the last end", async () => {
      const s = make();
      const r = await s.ingest(req([part(0, 4000), part(4000, 2500)]));
      expect(r).toMatchObject({ status: "committed", created: true, partsAdded: 2, cursor: { committedBytes: 6500 } });
      const next = await s.ingest(req([part(6500, 700)]));
      expect(next).toMatchObject({ status: "committed", created: false, partsAdded: 1, cursor: { committedBytes: 7200 } });
      const fileId = (next as { cursor: { fileId: number } }).cursor.fileId;
      expect((await s.parts(fileId)).map((p) => [p.startOffset, p.endOffset])).toEqual([[0, 4000], [4000, 6500], [6500, 7200]]);
    });

    test("a gap is refused and changes nothing", async () => {
      const s = make();
      await s.ingest(req([part(0, 1000)]));
      const r = await s.ingest(req([part(1100, 100)]));
      expect(r).toMatchObject({ status: "conflict", reason: "gap", cursor: { committedBytes: 1000 } });
      expect((await state(req([])))?.committedBytes).toBe(1000);
      expect(await partCount()).toBe(1);
    });

    test("a new file that does not start at byte 0 is refused and leaves no row", async () => {
      const s = make();
      const r = await s.ingest(req([part(500, 100)]));
      expect(r).toEqual({ status: "conflict", reason: "gap", cursor: null });
      expect(Number((await admin`SELECT count(*)::int AS n FROM ais_session_file`)[0]!.n)).toBe(0);
    });

    test("an overlap is refused: a different hash, a different end, or a start inside a part", async () => {
      const s = make();
      await s.ingest(req([part(0, 1000), part(1000, 1000)]));
      expect(await s.ingest(req([part(1000, 1000, "other")]))).toMatchObject({ status: "conflict", reason: "overlap" });
      expect(await s.ingest(req([part(0, 1500)]))).toMatchObject({ status: "conflict", reason: "overlap" });
      expect(await s.ingest(req([part(500, 1500)]))).toMatchObject({ status: "conflict", reason: "overlap" });
      expect((await state(req([])))?.committedBytes).toBe(2000);
      expect(await partCount()).toBe(2);
    });

    test("the first part may be a repeat and the next one new", async () => {
      const s = make();
      await s.ingest(req([part(0, 1000)]));
      const r = await s.ingest(req([part(0, 1000), part(1000, 200)]));
      expect(r).toMatchObject({ status: "committed", partsAdded: 1, cursor: { committedBytes: 1200 } });
      expect(await partCount()).toBe(2);
    });
  });

  describe("idempotent ingest", () => {
    test("the same part twice is a no-op and the second answer says so", async () => {
      const s = make();
      const first = await s.ingest(req([part(0, 1000)]));
      const before = await admin`SELECT last_ingest_at, committed_lines FROM ais_session_file`;
      const again = await s.ingest(req([part(0, 1000)]));
      expect(first.status).toBe("committed");
      expect(again).toMatchObject({ status: "duplicate", cursor: { committedBytes: 1000 } });
      const after = await admin`SELECT last_ingest_at, committed_lines FROM ais_session_file`;
      expect(after).toEqual(before);
      expect(await partCount()).toBe(1);
    });

    test("the same multi-part request twice stores each part once and keeps the line count", async () => {
      const s = make();
      const r = req([part(0, 1000), part(1000, 1000), part(2000, 1000)]);
      await s.ingest(r);
      const again = await s.ingest(r);
      expect(again.status).toBe("duplicate");
      expect((await state(r))?.committedLines).toBe(part(0, 1000).lines * 3);
      expect(await partCount()).toBe(3);
    });
  });

  describe("rewrites and generations", () => {
    test("a different full head is refused as rewritten", async () => {
      const s = make();
      await s.ingest(req([part(0, HEAD_BYTES + 100)]));
      const r = await s.ingest(req([part(HEAD_BYTES + 100, 100)], { headSha256: sha("other head") }));
      expect(r).toMatchObject({ status: "conflict", reason: "rewritten", cursor: { generation: 0, committedBytes: HEAD_BYTES + 100 } });
    });

    test("a head shorter than 4 KiB grows with the file and is not a rewrite", async () => {
      const s = make();
      await s.ingest(req([part(0, 100)], { headSha256: sha("h1") }));
      const r = await s.ingest(req([part(100, 100)], { headSha256: sha("h2") }));
      expect(r).toMatchObject({ status: "committed", cursor: { committedBytes: 200, headSha256: sha("h2") } });
    });

    test("a new generation starts at byte 0 and becomes the cursor, the old one stays", async () => {
      const s = make();
      await s.ingest(req([part(0, 6000)]));
      const r = await s.ingest(req([part(0, 800, "v2")], { generation: 1, headSha256: sha("new head") }));
      expect(r).toMatchObject({ status: "committed", created: true, cursor: { generation: 1, committedBytes: 800 } });
      expect((await state(req([])))?.generation).toBe(1);
      const rows = await admin`SELECT generation, committed_bytes FROM ais_session_file ORDER BY generation`;
      expect(rows.map((x: { generation: number; committed_bytes: string }) => [Number(x.generation), Number(x.committed_bytes)])).toEqual([[0, 6000], [1, 800]]);
    });

    test("a new generation that does not start at byte 0 is refused", async () => {
      const s = make();
      await s.ingest(req([part(0, 1000)]));
      expect(await s.ingest(req([part(1000, 100)], { generation: 1 }))).toMatchObject({ status: "conflict", reason: "generation_start", cursor: { generation: 0 } });
      expect(await partCount()).toBe(1);
    });

    test("an old generation is refused once a newer one exists", async () => {
      const s = make();
      await s.ingest(req([part(0, 1000)]));
      await s.ingest(req([part(0, 500, "v2")], { generation: 1 }));
      expect(await s.ingest(req([part(1000, 100)]))).toMatchObject({ status: "conflict", reason: "stale_generation", cursor: { generation: 1 } });
    });

    test("the answer to a lost generation bump is a repeat of the same request", async () => {
      const s = make();
      await s.ingest(req([part(0, 1000)]));
      const bump = req([part(0, 500, "v2")], { generation: 1 });
      expect((await s.ingest(bump)).status).toBe("committed");
      expect((await s.ingest(bump)).status).toBe("duplicate");
    });
  });

  describe("concurrent writers", () => {
    test("eight writers of the same part: one commits, the others see a duplicate", async () => {
      const writers = Array.from({ length: 8 }, () => make());
      const results = await Promise.all(writers.map((w) => w.ingest(req([part(0, 1000)]))));
      expect(results.filter((r) => r.status === "committed")).toHaveLength(1);
      expect(results.filter((r) => r.status === "duplicate")).toHaveLength(7);
      expect(await partCount()).toBe(1);
      expect((await state(req([])))?.committedLines).toBe(part(0, 1000).lines);
    });

    test("two writers with different bytes at one offset: one wins, the other is refused as an overlap", async () => {
      const [a, b] = [make(), make()];
      const [ra, rb] = await Promise.all([a.ingest(req([part(0, 1000, "A")])), b.ingest(req([part(0, 1000, "B")]))]);
      expect([ra.status, rb.status].sort()).toEqual(["committed", "conflict"]);
      const loser = ra.status === "conflict" ? ra : rb;
      expect(loser).toMatchObject({ reason: "overlap", cursor: { committedBytes: 1000 } });
      const stored = (await admin`SELECT plain_sha256 FROM ais_session_part`)[0]!.plain_sha256;
      expect([sha("0:1000:A"), sha("0:1000:B")]).toContain(stored);
    });

    test("writers racing on consecutive parts end with a contiguous file whatever the order", async () => {
      const writers = Array.from({ length: 6 }, () => make());
      const parts = Array.from({ length: 6 }, (_, i) => part(i * 500, 500));
      // Each writer sends its own part. Late ones may meet a gap, so they retry from the cursor like a real shipper.
      await Promise.all(
        writers.map(async (w, i) => {
          for (let attempt = 0; attempt < 50; attempt += 1) {
            const r = await w.ingest(req([parts[i]!]));
            if (r.status !== "conflict") return;
            if (r.reason !== "gap") throw new Error(`unexpected ${r.reason}`);
            await new Promise((res) => setTimeout(res, 5));
          }
          throw new Error("writer never got in");
        }),
      );
      const cur = await state(req([]));
      expect(cur?.committedBytes).toBe(3000);
      const ps = await make().parts(cur!.fileId);
      expect(ps.map((p) => p.startOffset)).toEqual([0, 500, 1000, 1500, 2000, 2500]);
      for (let i = 1; i < ps.length; i += 1) expect(ps[i]!.startOffset).toBe(ps[i - 1]!.endOffset);
    });

    test("writers of different files do not block each other", async () => {
      const writers = Array.from({ length: 5 }, () => make());
      const rs = await Promise.all(writers.map((w, i) => w.ingest(req([part(0, 100)], { relPath: `projects/p/f${i}.jsonl`, sessionRef: `f${i}` }))));
      expect(rs.every((r) => r.status === "committed")).toBe(true);
    });
  });

  describe("crash in the middle of an ingest", () => {
    test("a failure after the first part leaves nothing behind, and a retry commits all parts", async () => {
      const boom = make({ hooks: { afterPartInsert: (i) => { if (i === 0) throw new Error("boom"); } } });
      const r = req([part(0, 1000), part(1000, 1000)]);
      await expect(boom.ingest(r)).rejects.toThrow("boom");
      expect(await state(r)).toBeNull();
      expect(await partCount()).toBe(0);
      expect(Number((await admin`SELECT count(*)::int AS n FROM ais_session_file`)[0]!.n)).toBe(0);
      expect(await make().ingest(r)).toMatchObject({ status: "committed", partsAdded: 2, cursor: { committedBytes: 2000 } });
    });

    test("a failure on an append keeps the earlier cursor", async () => {
      await make().ingest(req([part(0, 1000)]));
      const boom = make({ hooks: { afterPartInsert: () => { throw new Error("boom"); } } });
      await expect(boom.ingest(req([part(1000, 500)]))).rejects.toThrow("boom");
      expect((await state(req([])))?.committedBytes).toBe(1000);
      expect(await partCount()).toBe(1);
    });

    test("a killed database connection mid-transaction commits nothing, and the next writer takes the lock", async () => {
      const victim = make({
        hooks: {
          afterPartInsert: async () => {
            // The connection waits in the hook with the transaction open. End its backend, as a crash or failover would.
            await admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
                         WHERE datname = current_database() AND state = 'idle in transaction' AND pid <> pg_backend_pid()`;
            await new Promise((res) => setTimeout(res, 100));
          },
        },
      });
      const r = req([part(0, 1000), part(1000, 1000)]);
      await expect(victim.ingest(r)).rejects.toBeDefined();
      expect(await state(r)).toBeNull();
      expect(await partCount()).toBe(0);
      expect(await make().ingest(r)).toMatchObject({ status: "committed", cursor: { committedBytes: 2000 } });
    });

    test("the answer is lost after the commit: the retry is a duplicate and the cursor stays", async () => {
      const s = make();
      const r = req([part(0, 1000), part(1000, 1000)]);
      await s.ingest(r);
      const retry = await make().ingest(r);
      expect(retry).toMatchObject({ status: "duplicate", cursor: { committedBytes: 2000 } });
    });
  });

  describe("one copy per session", () => {
    /** The same session as seen from a second path (another folder, another node). */
    const copy = (parts: SessionPartInput[], over: Partial<SessionIngest> = {}): SessionIngest =>
      req(parts, { node: "node-b", root: "/other/root", relPath: "pool2/s1.jsonl", origin: "t3-pool", pool: "second", ...over });
    const fileCount = async (): Promise<number> => Number((await admin`SELECT count(*)::int AS n FROM ais_session_file`)[0]!.n);

    test("a second path continues the stored session from the cursor and no byte is stored twice", async () => {
      const s = make();
      await s.ingest(req([part(0, 5000)], { mtimeMs: Date.parse("2026-11-01T10:00:00Z") }));
      const [c] = await s.cursors([keyOf(copy([]))]);
      expect(c).toMatchObject({ committedBytes: 5000, held: false });
      const r = await s.ingest(copy([part(5000, 4000)], { mtimeMs: Date.parse("2026-11-01T11:00:00Z") }));
      expect(r).toMatchObject({ status: "committed", created: false, partsAdded: 1, cursor: { committedBytes: 9000 } });
      expect(await fileCount()).toBe(1);
      expect(await partCount()).toBe(2);
      expect((await s.parts((r as { cursor: { fileId: number } }).cursor.fileId)).map((p) => [p.startOffset, p.endOffset])).toEqual([[0, 5000], [5000, 9000]]);
      const tree = await s.tree();
      expect(tree).toHaveLength(1);
      expect(tree[0]).toMatchObject({ sessionRef: "s1", committedBytes: 9000 });
    });

    test("the index records every path that held the session", async () => {
      const s = make();
      await s.ingest(req([part(0, 5000)]));
      await s.ingest(copy([part(5000, 100)]));
      const paths = await s.paths("claude", "s1");
      expect(paths.map((p) => [p.node, p.root, p.relPath, p.origin, p.pool])).toEqual([
        ["node-a", "/data/pool", "projects/p/s1.jsonl", "pool-folder", "main"],
        ["node-b", "/other/root", "pool2/s1.jsonl", "t3-pool", "second"],
      ]);
      expect(await s.filesOfSession("claude", "s1")).toHaveLength(1);
      const [c] = await s.cursors([keyOf(copy([]))]);
      expect(c?.held).toBe(true);
    });

    test("a copy that is stored already is recorded with no new bytes, and the repeat changes nothing", async () => {
      const s = make();
      await s.ingest(req([part(0, 5000)]));
      const before = await admin`SELECT last_ingest_at, committed_bytes FROM ais_session_file`;
      expect(await s.hold(copy([]))).toMatchObject({ status: "duplicate", cursor: { committedBytes: 5000 } });
      expect(await s.hold(copy([]))).toMatchObject({ status: "duplicate" });
      expect(await admin`SELECT last_ingest_at, committed_bytes FROM ais_session_file`).toEqual(before);
      expect((await s.paths("claude", "s1")).map((p) => p.node)).toEqual(["node-a", "node-b"]);
      expect(await partCount()).toBe(1);
    });

    test("the same bytes sent from a second path are a repeat, not a second copy", async () => {
      const s = make();
      await s.ingest(req([part(0, 5000)]));
      expect(await s.ingest(copy([part(0, 5000)]))).toMatchObject({ status: "duplicate" });
      expect(await partCount()).toBe(1);
      expect((await s.paths("claude", "s1")).map((p) => p.node)).toEqual(["node-a", "node-b"]);
    });

    test("a path with another head holds another file under the same id: refused and not recorded", async () => {
      const s = make();
      await s.ingest(req([part(0, HEAD_BYTES + 100)]));
      const diverged = copy([part(HEAD_BYTES + 100, 100)], { headSha256: sha("other head") });
      expect(await s.ingest(diverged)).toMatchObject({ status: "conflict", reason: "other_copy", cursor: { committedBytes: HEAD_BYTES + 100 } });
      expect(await s.hold(copy([], { headSha256: sha("other head") }))).toMatchObject({ status: "conflict", reason: "other_copy" });
      expect(await partCount()).toBe(1);
      expect((await s.paths("claude", "s1")).map((p) => p.node)).toEqual(["node-a"]);
    });

    test("only a holder may start a new generation: a stranger is refused, so two diverged copies never take turns", async () => {
      const s = make();
      await s.ingest(req([part(0, HEAD_BYTES + 100)]));
      const stranger = copy([part(0, 800, "v2")], { generation: 1, headSha256: sha("stranger head") });
      expect(await s.ingest(stranger)).toMatchObject({ status: "conflict", reason: "other_copy", cursor: { generation: 0 } });
      expect(await fileCount()).toBe(1);
      // The holder rewrites its file: a head that differs is a rewrite, and generation 1 starts at byte 0.
      const rewrite = req([part(HEAD_BYTES + 100, 100)], { headSha256: sha("new head") });
      expect(await s.ingest(rewrite)).toMatchObject({ status: "conflict", reason: "rewritten" });
      const v2 = HEAD_BYTES + 200;
      expect(await s.ingest(req([part(0, v2, "v2")], { generation: 1, headSha256: sha("new head") }))).toMatchObject({ status: "committed", created: true, cursor: { generation: 1 } });
      // The stranger still holds the old file: its head differs from generation 1, and it is still a stranger.
      expect(await s.ingest(copy([part(v2, 100)], { generation: 1 }))).toMatchObject({ status: "conflict", reason: "other_copy" });
      expect(await s.ingest(copy([part(0, 900, "v3")], { generation: 2, headSha256: sha("stranger head") }))).toMatchObject({ status: "conflict", reason: "other_copy" });
      expect(await fileCount()).toBe(2);
    });

    test("a hold for an unknown session or a new generation is refused", async () => {
      const s = make();
      expect(await s.hold(copy([]))).toEqual({ status: "conflict", reason: "gap", cursor: null });
      await s.ingest(req([part(0, 1000)]));
      expect(await s.hold(req([], { generation: 1 }))).toMatchObject({ status: "conflict", reason: "generation_start" });
      expect(await s.hold(req([], { generation: 0, headSha256: sha("head") }))).toMatchObject({ status: "duplicate" });
      expect(await fileCount()).toBe(1);
    });

    test("writers on two nodes race on one session: one copy of the bytes, contiguous parts", async () => {
      const writers = Array.from({ length: 6 }, () => make());
      const parts = Array.from({ length: 6 }, (_, i) => part(i * 500, 500));
      await Promise.all(
        writers.map(async (w, i) => {
          const send = i % 2 === 0 ? req : copy;
          for (let attempt = 0; attempt < 80; attempt += 1) {
            const r = await w.ingest(send([parts[i]!]));
            if (r.status !== "conflict") return;
            if (r.reason !== "gap") throw new Error(`unexpected ${r.reason}`);
            await new Promise((res) => setTimeout(res, 5));
          }
          throw new Error("writer never got in");
        }),
      );
      expect(await fileCount()).toBe(1);
      const cur = await state(req([]));
      expect(cur?.committedBytes).toBe(3000);
      expect(await partCount()).toBe(6);
      expect((await make().paths("claude", "s1")).map((p) => p.node).sort()).toEqual(["node-a", "node-b"]);
    });

    test("the same session id of two tools is two sessions even on one path", async () => {
      const s = make();
      await s.ingest(req([part(0, 100)]));
      await s.ingest(req([part(0, 100)], { kind: "codex" }));
      expect(await fileCount()).toBe(2);
    });

    test("migration 0015 merges rows of one session that exist before it and keeps every path", async () => {
      const s = make();
      await s.ingest(req([part(0, 5000)]));
      await s.ingest(req([part(0, 9000, "big")], { sessionRef: "s2" }));
      // Rebuild the state before 0015: keyed by host path, two rows for one session, no path table content.
      await admin`DELETE FROM schema_migrations WHERE version = '0015_sessions_one_copy'`;
      await admin`DROP VIEW ais_session_tree`;
      await admin`DROP INDEX ais_session_file_session_generation`;
      await admin`TRUNCATE ais_session_path`;
      await admin`UPDATE ais_session_file SET node = 'node-b', root = '/other', rel_path = 'x.jsonl' WHERE committed_bytes = 9000`;
      await admin`ALTER TABLE ais_session_file ADD CONSTRAINT ais_session_file_node_root_rel_path_generation_key UNIQUE (node, root, rel_path, generation)`;
      await admin`UPDATE ais_session_file SET session_ref = 's1'`;
      await migrate(url);
      const rows = await admin`SELECT id, node, committed_bytes FROM ais_session_file`;
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]!.committed_bytes)).toBe(9000);
      const paths = await admin`SELECT node FROM ais_session_path ORDER BY node`;
      expect(paths.map((p: { node: string }) => p.node)).toEqual(["node-a", "node-b"]);
      expect(await partCount()).toBe(1);
      expect(await s.tree()).toHaveLength(1);
    });
  });

  describe("tree view and queries", () => {
    const at = (iso: string) => Date.parse(iso);

    test("a rewritten file shows its newest generation only", async () => {
      const s = make();
      await s.ingest(req([part(0, 9000)]));
      await s.ingest(req([part(0, 400, "v2")], { generation: 1 }));
      const tree = await s.tree();
      expect(tree).toHaveLength(1);
      expect(tree[0]).toMatchObject({ generation: 1, committedBytes: 400 });
    });

    test("the same session id of two tools stays two nodes", async () => {
      const s = make();
      await s.ingest(req([part(0, 100)], { kind: "claude", sessionRef: "x" }));
      await s.ingest(req([part(0, 100)], { kind: "codex", sessionRef: "x", relPath: "sessions/x.jsonl" }));
      expect((await s.tree()).map((n) => n.kind).sort()).toEqual(["claude", "codex"]);
    });

    test("tree is newest first and filters by time, kind, identity, project and limit", async () => {
      const s = make();
      const mk = (n: number, over: Partial<SessionIngest>) =>
        s.ingest(req([part(0, 100)], { relPath: `p/f${n}.jsonl`, sessionRef: `f${n}`, mtimeMs: at(`2026-11-0${n}T00:00:00Z`), ...over }));
      await mk(1, {});
      await mk(2, { kind: "codex" });
      await mk(3, {});
      await mk(4, {});
      await admin`UPDATE ais_session_file SET identity = 'work', project = 'org/repo' WHERE session_ref IN ('f3', 'f4')`;
      expect((await s.tree()).map((n) => n.sessionRef)).toEqual(["f4", "f3", "f2", "f1"]);
      expect((await s.tree({ sinceMs: at("2026-11-02T00:00:00Z") })).map((n) => n.sessionRef)).toEqual(["f4", "f3", "f2"]);
      expect((await s.tree({ kind: "codex" })).map((n) => n.sessionRef)).toEqual(["f2"]);
      expect((await s.tree({ identity: "work" })).map((n) => n.sessionRef)).toEqual(["f4", "f3"]);
      expect((await s.tree({ project: "org/repo", limit: 1 })).map((n) => n.sessionRef)).toEqual(["f4"]);
    });

    test("updated_at only moves forward with the host time, and parent_ref is kept once set", async () => {
      const s = make();
      await s.ingest(req([part(0, 100)], { mtimeMs: at("2026-11-05T00:00:00Z"), parentRef: "root1" }));
      await s.ingest(req([part(100, 100)], { mtimeMs: at("2026-11-03T00:00:00Z"), parentRef: "other" }));
      const n = (await s.tree())[0]!;
      expect(n.updatedAt).toBe(at("2026-11-05T00:00:00Z"));
      expect(n.parentRef).toBe("root1");
    });

    test("children lists the subagents of a node", async () => {
      const s = make();
      await s.ingest(req([part(0, 100)], { sessionRef: "parent1", relPath: "p/parent1.jsonl", mtimeMs: at("2026-11-01T00:00:00Z") }));
      await s.ingest(req([part(0, 100)], { sessionRef: "parent1/a1", parentRef: "parent1", relPath: "p/parent1/subagents/a1.jsonl", mtimeMs: at("2026-11-02T00:00:00Z") }));
      await s.ingest(req([part(0, 100)], { sessionRef: "parent1/a2", parentRef: "parent1", relPath: "p/parent1/subagents/a2.jsonl", mtimeMs: at("2026-11-03T00:00:00Z") }));
      expect((await s.children("claude", "parent1")).map((n) => n.sessionRef)).toEqual(["parent1/a2", "parent1/a1"]);
      expect(await s.children("claude", "nobody")).toEqual([]);
    });

    test("a file with unread bytes shows in the enrichment queue index condition", async () => {
      const s = make();
      await s.ingest(req([part(0, 100)]));
      const rows = await admin`SELECT indexed_bytes, committed_bytes FROM ais_session_file WHERE indexed_bytes < committed_bytes`;
      expect(rows).toHaveLength(1);
    });

    test("tailParts returns the last parts that cover the window, in byte order", async () => {
      const s = make();
      const r = await s.ingest(req([part(0, 1000), part(1000, 1000), part(2000, 1000), part(3000, 1000)]));
      const id = (r as { cursor: { fileId: number } }).cursor.fileId;
      const starts = async (w: number) => (await s.tailParts(id, w)).map((p) => p.startOffset);
      expect(await starts(1)).toEqual([3000]);
      expect(await starts(1000)).toEqual([3000]);
      expect(await starts(1001)).toEqual([2000, 3000]);
      expect(await starts(2500)).toEqual([1000, 2000, 3000]);
      expect(await starts(10_000)).toEqual([0, 1000, 2000, 3000]);
    });
  });
}
