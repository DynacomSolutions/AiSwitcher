import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { writeFile } from "node:fs/promises";
import { migrate } from "../../src/gateway/pg-store.ts";
import { SessionStore } from "../../src/gateway/sessions/session-store.ts";
import { SessionsDbSource } from "../../src/server/sessions-db/db-source.ts";
import { SessionsReaderMetrics } from "../../src/server/sessions-db/metrics.ts";
import { PartCache } from "../../src/server/sessions-db/part-cache.ts";
import { PartLoader } from "../../src/server/sessions-db/part-lines.ts";
import type { PartSource } from "../../src/gateway/sessions/part-reader.ts";
import { FakeObjects, makeKeys, sha } from "../gateway/sessions-enrich-kit.ts";
import { encryptPart } from "./sessions-db-kit.ts";

/**
 * Performance proof for the console reader (design 20261123, section 5 targets, task 4.2), on a seeded table of 100,000
 * rows in a real Postgres:
 *
 * - tree, 30 days, 15,000 nodes: p95 under 300 ms;
 * - transcript tail, 4 MiB window: p95 under 400 ms warm (parts cached), under 800 ms cold (every part fetched,
 *   decrypted and unzipped; the object store answers in 10 ms a part, a LAN figure).
 *
 * The measured numbers print as one JSON line and, when AIS_PERF_REPORT names a file, go to that file.
 */

const url = process.env.AIS_GATEWAY_TEST_DATABASE_URL;
const optOut = process.env.AIS_GATEWAY_TEST_NO_DATABASE === "1";

export const TARGETS = { treeP95Ms: 300, warmP95Ms: 400, coldP95Ms: 800 } as const;
const TOTAL_ROWS = 100_000;
const RECENT_ROWS = 15_000; // rows updated within the last 30 days
const MIB = 1024 * 1024;

const p95 = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(xs.length * 0.95) - 1)]!;
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const round = (x: number): number => Math.round(x * 10) / 10;

/** An object store that answers each read after a fixed delay, as a LAN object store does. */
class DelayedObjects implements PartSource {
  constructor(private readonly inner: FakeObjects, public delayMs: number) {}
  async read(key: string): Promise<Uint8Array> {
    if (this.delayMs > 0) await Bun.sleep(this.delayMs);
    return this.inner.read(key);
  }
}

if (!url && process.env.CI && !optOut) {
  test("console sessions performance tests need AIS_GATEWAY_TEST_DATABASE_URL in CI", () => {
    throw new Error("AIS_GATEWAY_TEST_DATABASE_URL is unset in CI; provide a Postgres service or set AIS_GATEWAY_TEST_NO_DATABASE=1");
  });
} else if (!url) {
  console.warn("SKIP console sessions performance tests: AIS_GATEWAY_TEST_DATABASE_URL is not set");
  test.skip("console sessions performance tests need AIS_GATEWAY_TEST_DATABASE_URL", () => {});
} else {
  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (!dbName.includes("test")) throw new Error(`refusing to use database "${dbName}": its name must contain "test"`);

  const admin = new SQL(url);
  let store: SessionStore;
  const report: Record<string, unknown> = {};
  const TAIL_REF = "perf-tail-session";
  const objects = new FakeObjects();
  const delayed = new DelayedObjects(objects, 0);
  let identityKey = "";

  /** One Claude-shaped line of about `size` bytes. */
  const line = (i: number, size: number): string => {
    const base = JSON.stringify({ type: i % 2 === 0 ? "user" : "assistant", message: { role: i % 2 === 0 ? "user" : "assistant", content: i % 2 === 0 ? `Prompt ${i} ` : [{ type: "text", text: `Answer ${i} ` }] }, timestamp: new Date(Date.UTC(2026, 10, 1) + i * 1000).toISOString() });
    return base.length >= size ? base : base.replace(/ (["\]}]+)$/, ` ${"x".repeat(size - base.length)}$1`);
  };

  beforeAll(async () => {
    await migrate(url);
    await admin`TRUNCATE ais_session_file RESTART IDENTITY CASCADE`;
    // 100,000 rows: RECENT_ROWS in the last 30 days, the rest spread over the 700 days before. Six identities plus
    // sessions with no identity yet, one child in ten, Claude and Codex in about 4:1.
    await admin.unsafe(
      `INSERT INTO ais_session_file (node, root, rel_path, generation, kind, origin, identity, session_ref, parent_ref, agent_name, title, cwd, project,
                                      model, started_at, updated_at, message_count, committed_bytes, committed_lines, head_sha256, indexed_bytes)
       SELECT 'node-' || (n % 5), '/data/pool/' || (n % 6), 'projects/p' || (n % 40) || '/s' || n || '.jsonl', 0,
              CASE WHEN n % 5 = 0 THEN 'codex' ELSE 'claude' END, 'host',
              CASE WHEN n % 7 = 0 THEN NULL ELSE 'identity-' || (n % 6) END,
              'sess-' || n, CASE WHEN n % 10 = 0 THEN 'sess-' || (n - 1) END, CASE WHEN n % 10 = 0 THEN 'agent-' || n END,
              'Title of session ' || n, '/srv/repositories/example-org/example-repo-' || (n % 40), 'example-repo-' || (n % 40),
              'model-a-1', now() - ((n % 700) + 1) * interval '1 hour', now() - ((n % 700) + 1) * interval '1 hour', 10 + n % 200, 100000 + n, 100 + n % 500,
              'head-' || n, 100000 + n
         FROM (SELECT n FROM generate_series(1, ${RECENT_ROWS}) AS n) q`,
    );
    // The recent rows above sit within 700 hours (29 days). The older rows follow, 31 to 730 days old.
    await admin.unsafe(
      `INSERT INTO ais_session_file (node, root, rel_path, generation, kind, origin, identity, session_ref, parent_ref, agent_name, title, cwd, project,
                                      model, started_at, updated_at, message_count, committed_bytes, committed_lines, head_sha256, indexed_bytes)
       SELECT 'node-' || (n % 5), '/data/pool/' || (n % 6), 'projects/p' || (n % 40) || '/s' || n || '.jsonl', 0,
              CASE WHEN n % 5 = 0 THEN 'codex' ELSE 'claude' END, 'host',
              CASE WHEN n % 7 = 0 THEN NULL ELSE 'identity-' || (n % 6) END,
              'sess-' || n, CASE WHEN n % 10 = 0 THEN 'sess-' || (n - 1) END, CASE WHEN n % 10 = 0 THEN 'agent-' || n END,
              'Title of session ' || n, '/srv/repositories/example-org/example-repo-' || (n % 40), 'example-repo-' || (n % 40),
              'model-a-1', now() - (31 + n % 700) * interval '1 day', now() - (31 + n % 700) * interval '1 day', 10 + n % 200, 100000 + n, 100 + n % 500,
              'head-' || n, 100000 + n
         FROM (SELECT n FROM generate_series(${RECENT_ROWS + 1}, ${TOTAL_ROWS}) AS n) q`,
    );
    // The session whose tail the transcript test reads: 12 MiB in 1 MiB parts, written now.
    const keys = await makeKeys();
    identityKey = keys.identity;
    const lines: string[] = [];
    let bytes = 0;
    for (let i = 0; bytes < 12 * MIB; i++) {
      const l = line(i, 600 + (i % 7) * 40);
      lines.push(l);
      bytes += new TextEncoder().encode(l).length + 1;
    }
    const [{ id }] = (await admin`INSERT INTO ais_session_file (node, root, rel_path, generation, kind, origin, identity, session_ref, title, cwd, started_at, updated_at, message_count,
                                         committed_bytes, committed_lines, head_sha256, indexed_bytes)
         VALUES ('node-a', '/data/pool', ${`projects/p/${TAIL_REF}.jsonl`}, 0, 'claude', 'host', 'identity-0', ${TAIL_REF}, 'Tail session', '/srv/repositories/example-org/example-repo',
                 now() - interval '1 day', now(), ${lines.length}, ${bytes}, ${lines.length}, 'head', ${bytes}) RETURNING id`) as { id: number }[];
    let off = 0;
    let buf: string[] = [];
    let size = 0;
    const flush = async (): Promise<void> => {
      if (buf.length === 0) return;
      const plain = new TextEncoder().encode(buf.map((l) => `${l}\n`).join(""));
      const stored = await encryptPart(plain, keys.recipient);
      const key = `objects/v1/perf/${TAIL_REF}/${off}-${off + plain.length}.gz.age`;
      objects.objects.set(key, stored);
      await admin`INSERT INTO ais_session_part (file_id, start_offset, end_offset, lines, plain_bytes, object_bytes, plain_sha256, object_key)
                  VALUES (${id}, ${off}, ${off + plain.length}, ${buf.length}, ${plain.length}, ${stored.length}, ${sha(plain)}, ${key})`;
      off += plain.length;
      buf = [];
      size = 0;
    };
    for (const l of lines) {
      buf.push(l);
      size += new TextEncoder().encode(l).length + 1;
      if (size >= MIB) await flush();
    }
    await flush();
    expect(off).toBe(bytes);
    // Autovacuum has not run on a table made a second ago: the planner needs real statistics, as it has in production.
    await admin.unsafe("ANALYZE ais_session_file");
    await admin.unsafe("ANALYZE ais_session_part");
    store = new SessionStore(url, { poolMax: 3 });
  }, 600_000);

  afterEach(() => {
    delayed.delayMs = 0;
  });
  afterAll(async () => {
    await store?.close();
    if (process.env.AIS_PERF_KEEP !== "1") await admin`TRUNCATE ais_session_file RESTART IDENTITY CASCADE`;
    await admin.close();
    const out = { rows: TOTAL_ROWS, targets: TARGETS, ...report };
    console.log(`SESSIONS_PERF ${JSON.stringify(out)}`);
    if (process.env.AIS_PERF_REPORT) await writeFile(process.env.AIS_PERF_REPORT, `${JSON.stringify(out, null, 2)}\n`);
  });

  const source = (cache: PartCache): SessionsDbSource => {
    const metrics = new SessionsReaderMetrics();
    return new SessionsDbSource({ store, loader: new PartLoader({ source: delayed, identity: identityKey, cache, metrics }), metrics, windowBytes: 4 * MIB });
  };

  describe("console reader on a table of 100,000 rows", () => {
    test("the table holds 100,000 rows and about 15,000 of them are in the 30 day window", async () => {
      const [{ n }] = (await admin`SELECT count(*)::int AS n FROM ais_session_file`) as { n: number }[];
      expect(n).toBe(TOTAL_ROWS + 1);
      const [{ r }] = (await admin`SELECT count(*)::int AS r FROM ais_session_tree WHERE updated_at > now() - interval '30 days'`) as { r: number }[];
      expect(r).toBeGreaterThanOrEqual(RECENT_ROWS);
      expect(r).toBeLessThanOrEqual(RECENT_ROWS + 5);
    });

    test("tree() returns the same nodes as the view ais_session_tree on the whole table", async () => {
      const sinceMs = Date.now() - 30 * 86_400_000;
      const viewIds = (await admin.unsafe(`SELECT id FROM ais_session_tree WHERE kind = 'claude' AND updated_at >= to_timestamp($1::double precision / 1000) ORDER BY updated_at DESC NULLS LAST, id DESC LIMIT 50000`, [sinceMs])) as { id: string }[];
      const got = await store.tree({ kind: "claude", sinceMs, limit: 50_000 });
      expect(got.map((r) => r.fileId)).toEqual(viewIds.map((r) => Number(r.id)));
      expect(got.length).toBeGreaterThan(10_000);
    }, 120_000);

    test(`tree, 30 days, ${RECENT_ROWS} nodes: p95 under ${TARGETS.treeP95Ms} ms`, async () => {
      const db = source(new PartCache(MIB));
      const targets = ["claude", "codex"].flatMap((tool) => Array.from({ length: 6 }, (_, i) => ({ tool: tool as "claude" | "codex", identity: `identity-${i}` })));
      const run = async (): Promise<{ ms: number; nodes: number }> => {
        const t0 = performance.now();
        const slices = await db.readTrees({ kinds: ["claude", "codex"], targets, opts: { days: 30 }, includeUnassigned: true });
        return { ms: performance.now() - t0, nodes: slices.reduce((a, s) => a + s.nodes.length, 0) };
      };
      await run(); // plan and connection warm-up, as the console has after its first poll
      const samples: number[] = [];
      let nodes = 0;
      for (let i = 0; i < 40; i++) {
        const r = await run();
        samples.push(r.ms);
        nodes = r.nodes;
      }
      expect(nodes).toBeGreaterThanOrEqual(RECENT_ROWS);
      expect(nodes).toBeLessThanOrEqual(RECENT_ROWS + 5);
      // The query alone, to see where the time goes.
      const q: number[] = [];
      for (let i = 0; i < 20; i++) {
        const t0 = performance.now();
        await store.tree({ kind: "claude", sinceMs: Date.now() - 30 * 86_400_000, limit: 50_000 });
        q.push(performance.now() - t0);
      }
      report.tree = { nodes, runs: samples.length, p50Ms: round(median(samples)), p95Ms: round(p95(samples)), queryClaudeP50Ms: round(median(q)), queryClaudeP95Ms: round(p95(q)) };
      expect(p95(samples)).toBeLessThan(TARGETS.treeP95Ms);
    }, 120_000);

    test(`transcript tail, 4 MiB window, warm: p95 under ${TARGETS.warmP95Ms} ms`, async () => {
      const cache = new PartCache(64 * MIB);
      const db = source(cache);
      const read = async (): Promise<number> => {
        const t0 = performance.now();
        const dto = await db.readTranscript({ tool: "claude", id: TAIL_REF });
        const ms = performance.now() - t0;
        expect(dto?.truncated).toBe(true);
        expect(dto!.turns.length).toBeGreaterThan(0);
        return ms;
      };
      await read(); // fills the cache
      const samples: number[] = [];
      for (let i = 0; i < 40; i++) samples.push(await read());
      report.transcriptWarm = { runs: samples.length, p50Ms: round(median(samples)), p95Ms: round(p95(samples)) };
      expect(p95(samples)).toBeLessThan(TARGETS.warmP95Ms);
    }, 120_000);

    test(`transcript tail, 4 MiB window, cold: p95 under ${TARGETS.coldP95Ms} ms`, async () => {
      delayed.delayMs = 10;
      const samples: number[] = [];
      let parts = 0;
      for (let i = 0; i < 20; i++) {
        const cache = new PartCache(64 * MIB); // empty: every part is fetched, decrypted and unzipped
        const metrics = new SessionsReaderMetrics();
        const db = new SessionsDbSource({ store, loader: new PartLoader({ source: delayed, identity: identityKey, cache, metrics }), metrics, windowBytes: 4 * MIB });
        const t0 = performance.now();
        const dto = await db.readTranscript({ tool: "claude", id: TAIL_REF });
        samples.push(performance.now() - t0);
        expect(dto?.truncated).toBe(true);
        parts = (await store.tailParts((await store.filesOfSession("claude", TAIL_REF))[0]!.fileId, 4 * MIB)).length;
      }
      report.transcriptCold = { runs: samples.length, partsPerRead: parts, objectStoreDelayMsPerPart: 10, p50Ms: round(median(samples)), p95Ms: round(p95(samples)) };
      expect(p95(samples)).toBeLessThan(TARGETS.coldP95Ms);
    }, 120_000);
  });
}
