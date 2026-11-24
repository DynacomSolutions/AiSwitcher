import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { compareHost, formatHostReport, HOST_ROWS_SQL, rowOfRaw, UPDATED_TOLERANCE_MS } from "../../src/server/sessions-db/compare-host.ts";
import { compareTreeNodes } from "../../src/server/sessions-db/compare.ts";
import type { SessionTreeRow } from "../../src/gateway/sessions/session-store.ts";
import { claudeAgent, claudeSession, cleanTemps, codexRollout, makeFixture, msAt, tempDir } from "./sessions-db-kit.ts";

/** The host comparison behind `scripts/sessions-compare.ts`: it must find and explain each kind of difference. */

afterEach(cleanTemps);

const SID = "11111111-2222-4333-8444-555555555555";
const SID2 = "11111111-2222-4333-8444-666666666666";
const AID = "a1b2c3d4e5f6a7b8c";
const CODEX_ID = "019a0000-0000-7000-8000-000000000001";
const CLAUDE_REL = `projects/-srv-example/${SID}.jsonl`;
const CLAUDE2_REL = `projects/-srv-example/${SID2}.jsonl`;
const AGENT_REL = `projects/-srv-example/${SID}/subagents/agent-${AID}.jsonl`;
const CODEX_REL = `sessions/2026/03/01/rollout-2026-03-01T09-00-30-${CODEX_ID}.jsonl`;
const NOW = msAt(100);

async function seed(codexMtimeSkewMs = 0) {
  const f = await makeFixture();
  const dir = await tempDir();
  const files = [
    { kind: "claude" as const, relPath: CLAUDE_REL, identity: null, lines: claudeSession("a"), mtime: msAt(9) },
    { kind: "claude" as const, relPath: CLAUDE2_REL, identity: null, lines: claudeSession("b", 6), mtime: msAt(5) },
    { kind: "claude" as const, relPath: AGENT_REL, identity: null, lines: claudeAgent(AID, SID), mtime: msAt(22) },
    { kind: "codex" as const, relPath: CODEX_REL, identity: null, lines: codexRollout(CODEX_ID), mtime: msAt(35) + codexMtimeSkewMs },
  ];
  const rows: SessionTreeRow[] = [];
  for (const file of files) {
    await f.writeFile(dir, file, file.mtime);
    rows.push(await f.add(file, 3));
  }
  return { dir, rows };
}

const run = (dir: string, rows: SessionTreeRow[], strict = false) => compareHost({ node: "node-a", rows, configDirs: [dir], days: 400, now: NOW, strict });

describe("host comparison", () => {
  test("equal trees: every node matches, the missing identity is reported and not compared", async () => {
    const { dir, rows } = await seed();
    const r = await run(dir, rows);
    expect(r).toMatchObject({ filesNodes: 4, dbNodes: 4, matched: 4, equal: 4, share: 1, unexplained: 0, dbWithoutIdentity: 4 });
    expect(r.explained).toEqual([]);
    const text = formatHostReport(r);
    expect(text).toContain("4 of 4 database nodes have no identity yet");
    expect(text).toContain("Differences: 0");
  });

  test("a Codex file mtime a few ms after its last record is listed, explained and counted equal", async () => {
    const { dir, rows } = await seed(3);
    const r = await run(dir, rows);
    expect(r.equal).toBe(4);
    expect(r.unexplained).toBe(0);
    expect(r.explained).toHaveLength(1);
    expect(r.explained[0]).toMatchObject({ tool: "codex", diff: { kind: "field", field: "updatedAt", tolerated: true } });
    expect(r.explained[0]!.reason).toContain("3 ms apart");
    // The strict comparison does see it.
    const strict = compareTreeNodes([{ id: "x", tool: "codex", identity: "i", title: "t", cwd: null, startedAt: "a", updatedAt: "2026-03-01T09:00:35.003Z", inProgress: false, depth: 0 }], [{ id: "x", tool: "codex", identity: "i", title: "t", cwd: null, startedAt: "a", updatedAt: "2026-03-01T09:00:35.000Z", inProgress: false, depth: 0 }]);
    expect(strict.equal).toBe(0);
    // A gap of more than the tolerance is a real difference.
    const { dir: dir2, rows: rows2 } = await seed(UPDATED_TOLERANCE_MS + 500);
    const r2 = await run(dir2, rows2);
    expect(r2.equal).toBe(3);
    expect(r2.unexplained).toBe(1);
  });

  test("the tolerance is for Codex only: a Claude gap of 500 ms is a difference, and --strict makes Codex exact", async () => {
    const { dir, rows } = await seed();
    const skewed = rows.map((r) => (r.sessionRef === SID2 && r.updatedAt !== null ? { ...r, updatedAt: r.updatedAt + 500 } : r));
    const r = await run(dir, skewed);
    expect(r).toMatchObject({ matched: 4, equal: 3, unexplained: 1 });
    expect(r.explained[0]).toMatchObject({ tool: "claude", diff: { kind: "field", field: "updatedAt" } });
    expect(r.explained[0]!.diff).not.toHaveProperty("tolerated");
    expect(r.explained[0]!.reason).toBeUndefined();
    const { dir: dir2, rows: rows2 } = await seed(3);
    expect((await run(dir2, rows2)).unexplained).toBe(0);
    const strict = await run(dir2, rows2, true);
    expect(strict).toMatchObject({ equal: 3, unexplained: 1, strict: true });
    expect(formatHostReport(strict)).toContain("updatedAt exact");
  });

  test("a host file that the tool removed after the ship is explained", async () => {
    const { dir, rows } = await seed();
    await rm(join(dir, CLAUDE2_REL));
    const r = await run(dir, rows);
    expect(r).toMatchObject({ filesNodes: 3, dbNodes: 4, matched: 3, equal: 3, unexplained: 0, matchedShare: 1 });
    expect(r.explained).toHaveLength(1);
    expect(r.explained[0]).toMatchObject({ diff: { kind: "only-db", id: SID2 } });
    expect(r.explained[0]!.reason).toContain("host file is gone");
    expect(r.share).toBe(0.75);
  });

  test("a host file that grew after the ship is explained; a file with no stored row is not", async () => {
    const { dir, rows } = await seed();
    const grown = JSON.stringify({ type: "user", message: { role: "user", content: "later" }, timestamp: new Date(msAt(50)).toISOString() });
    await appendFile(join(dir, CLAUDE_REL), `${grown}\n`);
    await utimes(join(dir, CLAUDE_REL), new Date(msAt(50)), new Date(msAt(50)));
    const grew = await run(dir, rows);
    expect(grew.explained.map((e) => [e.diff.kind === "field" ? e.diff.field : e.diff.kind, e.reason?.startsWith("the host file grew")])).toEqual([
      ["updatedAt", true],
      ["messageCount", true],
    ]);
    expect(grew.unexplained).toBe(0);
    // The same session, with no row: the file is not shipped yet. It is listed as an only-files difference.
    const missing = await run(dir, rows.filter((r) => r.sessionRef !== SID2));
    const d = missing.explained.find((e) => e.diff.kind === "only-files")!;
    expect(d.diff.id).toBe(SID2);
    expect(d.reason).toContain("not shipped yet");
  });

  test("a stored title that differs, with the same size on the host, is unexplained", async () => {
    const { dir, rows } = await seed();
    const bad = rows.map((r) => (r.sessionRef === SID ? { ...r, title: "Another title" } : r));
    const r = await run(dir, bad);
    expect(r.unexplained).toBe(1);
    expect(r.explained[0]).toMatchObject({ diff: { kind: "field", field: "title", db: "Another title" } });
    expect(r.explained[0]!.reason).toBeUndefined();
    expect(formatHostReport(r)).toContain("[UNEXPLAINED]");
  });

  test("a row of the export maps to a store row; the SELECT only reads", () => {
    const row = rowOfRaw({ id: "5", node: "n", root: "/r", rel_path: "p.jsonl", generation: 0, kind: "codex", origin: "host", pool: null, identity: null, session_ref: "s", parent_ref: null, agent_name: null, title: "t", cwd: null, project: null, model: null, started_ms: "1795023198000.5", updated_ms: 1795023200000, message_count: null, committed_bytes: "10", committed_lines: 2, indexed_bytes: "10" });
    expect(row).toMatchObject({ fileId: 5, kind: "codex", identity: null, startedAt: 1795023198000.5, updatedAt: 1795023200000, messageCount: null, committedBytes: 10 });
    expect(HOST_ROWS_SQL.trim().toUpperCase().startsWith("SELECT")).toBe(true);
    expect(HOST_ROWS_SQL).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/i);
  });
});
