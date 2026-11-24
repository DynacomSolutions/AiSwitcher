import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { migrate } from "../../src/gateway/pg-store.ts";
import type { SessionTreeRow } from "../../src/gateway/sessions/session-store.ts";
import { compareHost, formatHostReport, HOST_ROWS_SQL, rowOfRaw } from "../../src/server/sessions-db/compare-host.ts";
import { claudeSession, cleanTemps, makeFixture, msAt, tempDir } from "./sessions-db-kit.ts";

/** `scripts/sessions-compare.ts` against a real Postgres: the database mode and the `--rows` mode give the same report. */

const url = process.env.AIS_GATEWAY_TEST_DATABASE_URL;
const optOut = process.env.AIS_GATEWAY_TEST_NO_DATABASE === "1";

if (!url && process.env.CI && !optOut) {
  test("host comparison database tests need AIS_GATEWAY_TEST_DATABASE_URL in CI", () => {
    throw new Error("AIS_GATEWAY_TEST_DATABASE_URL is unset in CI; provide a Postgres service or set AIS_GATEWAY_TEST_NO_DATABASE=1");
  });
} else if (!url) {
  console.warn("SKIP host comparison database tests: AIS_GATEWAY_TEST_DATABASE_URL is not set");
  test.skip("host comparison database tests need AIS_GATEWAY_TEST_DATABASE_URL", () => {});
} else {
  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (!dbName.includes("test")) throw new Error(`refusing to use database "${dbName}": its name must contain "test"`);

  const admin = new SQL(url);
  beforeEach(async () => {
    await migrate(url);
    await admin`TRUNCATE ais_session_file RESTART IDENTITY CASCADE`;
  });
  afterEach(cleanTemps);
  afterAll(async () => {
    await admin.close();
  });

  const SID = "11111111-2222-4333-8444-555555555555";
  const SID2 = "11111111-2222-4333-8444-666666666666";

  async function insert(r: SessionTreeRow, pathNodes: string[]): Promise<void> {
    const [{ id }] = (await admin`INSERT INTO ais_session_file (node, root, rel_path, generation, kind, origin, identity, session_ref, parent_ref, agent_name, title, cwd, project, model,
                                         started_at, updated_at, message_count, committed_bytes, committed_lines, head_sha256, indexed_bytes)
         VALUES (${r.node}, ${r.root}, ${r.relPath}, 0, ${r.kind}, ${r.origin}, ${r.identity}, ${r.sessionRef}, ${r.parentRef}, ${r.agentName}, ${r.title}, ${r.cwd}, ${r.project}, ${r.model},
                 ${r.startedAt === null ? null : new Date(r.startedAt)}, ${r.updatedAt === null ? null : new Date(r.updatedAt)}, ${r.messageCount}, ${r.committedBytes}, ${r.committedLines}, 'head', ${r.indexedBytes})
         RETURNING id`) as { id: number }[];
    for (const node of pathNodes) {
      await admin`INSERT INTO ais_session_path (file_id, node, root, rel_path, origin) VALUES (${id}, ${node}, ${r.root}, ${r.relPath}, ${r.origin})`;
    }
  }

  async function script(args: string[], env: Record<string, string>): Promise<{ code: number; out: string }> {
    const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "../../scripts/sessions-compare.ts"), ...args], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    return { code: await proc.exited, out };
  }

  describe("host comparison on Postgres", () => {
    test("a session whose file row is on another node but whose path row is on this node: both modes give the same report", async () => {
      const f = await makeFixture();
      const dir = await tempDir();
      const own = { kind: "claude" as const, relPath: `projects/-srv-example/${SID}.jsonl`, identity: null, lines: claudeSession("own") };
      const held = { kind: "claude" as const, relPath: `projects/-srv-example/${SID2}.jsonl`, identity: null, lines: claudeSession("held", 6) };
      const other = { kind: "claude" as const, relPath: "projects/-srv-example/00000000-0000-4000-8000-000000000009.jsonl", identity: null, lines: claudeSession("other", 4) };
      await f.writeFile(dir, own, msAt(9));
      await f.writeFile(dir, held, msAt(5));
      const rowOwn = await f.add(own, 3);
      const rowHeld = await f.add(held, 3);
      const rowOther = await f.add(other, 3);
      await insert({ ...rowOwn, node: "node-b" }, ["node-b"]);
      // The file row of this session sits on node-a (it shipped it first); node-b holds the same file through a path row.
      await insert({ ...rowHeld, node: "node-a" }, ["node-a", "node-b"]);
      await insert({ ...rowOther, node: "node-a" }, ["node-a"]);

      const raw = (await admin.unsafe(HOST_ROWS_SQL, ["node-b", ["claude", "codex"]])) as Record<string, unknown>[];
      expect(raw.map((r) => r.session_ref).sort()).toEqual([SID, SID2]);
      const rowsFile = join(dir, "rows.json");
      await writeFile(rowsFile, JSON.stringify(raw));

      // The library on the exported rows: both sessions match their host files.
      const report = await compareHost({ node: "node-b", rows: raw.map(rowOfRaw), configDirs: [dir], days: 400 });
      expect(report).toMatchObject({ filesNodes: 2, dbNodes: 2, matched: 2, equal: 2, unexplained: 0 });
      expect(report.explained).toEqual([]);

      const base = ["--node", "node-b", "--config-dir", dir, "--days", "400"];
      const viaRows = await script([...base, "--rows", rowsFile], { AIS_GATEWAY_STORE_DATABASE_URL: "" });
      const viaDb = await script(base, { AIS_GATEWAY_STORE_DATABASE_URL: url });
      expect(viaDb.code).toBe(0);
      expect(viaRows.out).toBe(viaDb.out);
      expect(viaRows.out).toBe(`${formatHostReport(report)}\n`);
      expect(viaRows.out).not.toContain("not shipped yet");
    }, 60_000);
  });
}
