import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { readSessionTrees, computeDepths } from "../../cli/sessions/tree.ts";
import type { TreeNodeDto } from "../../cli/sessions/types.ts";
import type { Identity } from "../../identities/types.ts";
import type { SessionTreeRow } from "../../gateway/sessions/session-store.ts";
import { COMPARED_FIELDS, compareTreeNodes, equalShare, type TreeComparison, type TreeDiff } from "./compare.ts";
import { DB_SESSION_TOOLS, nodeOf, UNASSIGNED_IDENTITY, type DbSessionTool } from "./db-source.ts";

/**
 * Host comparison: the old file scan against the database tree for one host. Read-only. It lists every difference and
 * says why for each one it can explain. The pure parts live here so that a test covers them. The script is
 * `scripts/sessions-compare.ts`.
 */

/** The stored files of one host, one row per session (the same choice as the view `ais_session_tree`). Only SELECT. */
export const HOST_ROWS_SQL = `
SELECT DISTINCT ON (f.kind, f.session_ref)
       f.id, f.node, f.root, f.rel_path, f.generation, f.kind, f.origin, f.pool, f.identity, f.session_ref, f.parent_ref,
       f.agent_name, f.title, f.cwd, f.project, f.model,
       extract(epoch from f.started_at) * 1000 AS started_ms, extract(epoch from f.updated_at) * 1000 AS updated_ms,
       f.message_count, f.committed_bytes, f.committed_lines, f.indexed_bytes
  FROM ais_session_file f
 WHERE f.kind = ANY($2::text[])
   AND (f.node = $1 OR EXISTS (SELECT 1 FROM ais_session_path p WHERE p.file_id = f.id AND p.node = $1))
 ORDER BY f.kind, f.session_ref, f.generation DESC, f.committed_bytes DESC, f.updated_at DESC NULLS LAST, f.id DESC`;

type Raw = Record<string, unknown>;
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** A stored row, from a result row of `HOST_ROWS_SQL` (or its JSON export). */
export function rowOfRaw(r: Raw): SessionTreeRow {
  return {
    fileId: Number(r.id),
    node: String(r.node),
    root: String(r.root),
    relPath: String(r.rel_path),
    generation: Number(r.generation),
    kind: String(r.kind),
    origin: String(r.origin),
    pool: strOrNull(r.pool),
    identity: strOrNull(r.identity),
    sessionRef: String(r.session_ref),
    parentRef: strOrNull(r.parent_ref),
    agentName: strOrNull(r.agent_name),
    title: strOrNull(r.title),
    cwd: strOrNull(r.cwd),
    project: strOrNull(r.project),
    model: strOrNull(r.model),
    startedAt: numOrNull(r.started_ms),
    updatedAt: numOrNull(r.updated_ms),
    messageCount: numOrNull(r.message_count),
    committedBytes: Number(r.committed_bytes),
    committedLines: Number(r.committed_lines),
    indexedBytes: Number(r.indexed_bytes),
  };
}

/** Why a difference is expected. `undefined` means nobody can explain it from the data at hand. */
export interface Explained {
  diff: TreeDiff;
  tool: DbSessionTool;
  /** Short reason, or undefined when unexplained. */
  reason?: string;
}

export interface HostReport {
  node: string;
  /** True when `updatedAt` was compared exactly for every tool. */
  strict: boolean;
  days: number;
  perTool: { tool: DbSessionTool; comparison: TreeComparison; share: number }[];
  explained: Explained[];
  /** Database nodes that have no identity yet (shown in the unassigned slice). Not compared. */
  dbWithoutIdentity: number;
  dbNodes: number;
  filesNodes: number;
  matched: number;
  equal: number;
  /** Equal nodes over the union of both trees. */
  share: number;
  /** Equal nodes over the nodes both trees hold (1 when none). The 99.9% gate reads this one. */
  matchedShare: number;
  unexplained: number;
}

/** File size, or undefined when the file is absent. */
const sizeOf = async (path: string): Promise<number | undefined> => {
  try {
    return (await stat(path)).size;
  } catch {
    return undefined;
  }
};

export interface HostCompareArgs {
  node: string;
  /** Stored rows of the host. */
  rows: readonly SessionTreeRow[];
  /** Host folders that hold `projects/` and `sessions/` (one per identity). */
  configDirs: readonly string[];
  days: number;
  now?: number;
  /** Exact `updatedAt` for Codex too (no tolerance). Claude is always exact. */
  strict?: boolean;
}

/** Codex only: file mtime against the last record time. A write delay of a few ms, never a second. Claude has none. */
export const UPDATED_TOLERANCE_MS = 1000;

export async function compareHost(args: HostCompareArgs): Promise<HostReport> {
  const opts = { days: args.days, ...(args.now !== undefined ? { now: args.now } : {}) };
  const rowsByRef = new Map(args.rows.map((r) => [`${r.kind}|${r.sessionRef}`, r]));
  const perTool: HostReport["perTool"] = [];
  const explained: Explained[] = [];
  let dbWithoutIdentity = 0;
  for (const tool of DB_SESSION_TOOLS) {
    const files: TreeNodeDto[] = [];
    for (const dir of args.configDirs) {
      const identity = { name: basename(dir), configDir: dir } as Identity;
      files.push(...(await readSessionTrees(tool, identity, opts)).nodes);
    }
    const rows = args.rows.filter((r) => r.kind === tool && r.updatedAt !== null && r.updatedAt >= (opts.now ?? Date.now()) - args.days * 86_400_000);
    dbWithoutIdentity += rows.filter((r) => r.identity === null).length;
    const db = computeDepths(rows.map((r) => nodeOf(r, tool, r.identity ?? UNASSIGNED_IDENTITY, opts)));
    const comparison = compareTreeNodes(files, db, { updatedToleranceMs: tool === "codex" && !args.strict ? UPDATED_TOLERANCE_MS : 0 });
    perTool.push({ tool, comparison, share: equalShare(comparison) });
    for (const diff of comparison.diffs) explained.push({ diff, tool, ...(await explain(tool, diff, rowsByRef, args.configDirs)) });
  }
  const sum = (f: (c: TreeComparison) => number): number => perTool.reduce((a, t) => a + f(t.comparison), 0);
  const filesNodes = sum((c) => c.filesNodes);
  const dbNodes = sum((c) => c.dbNodes);
  const matched = sum((c) => c.matched);
  const equal = sum((c) => c.equal);
  const union = filesNodes + dbNodes - matched;
  return {
    node: args.node,
    strict: args.strict === true,
    days: args.days,
    perTool,
    explained,
    dbWithoutIdentity,
    dbNodes,
    filesNodes,
    matched,
    equal,
    share: union === 0 ? 1 : equal / union,
    matchedShare: matched === 0 ? 1 : equal / matched,
    unexplained: explained.filter((e) => e.reason === undefined).length,
  };
}

async function explain(tool: DbSessionTool, diff: TreeDiff, rowsByRef: Map<string, SessionTreeRow>, configDirs: readonly string[]): Promise<{ reason?: string }> {
  const row = rowsByRef.get(`${tool}|${diff.id}`);
  const hostSize = async (): Promise<number | undefined> => {
    if (!row) return undefined;
    for (const dir of configDirs) {
      const size = await sizeOf(join(dir, row.relPath));
      if (size !== undefined) return size;
    }
    return undefined;
  };
  if (diff.kind === "field" && diff.tolerated) {
    const gap = Math.abs(Date.parse(String(diff.files)) - Date.parse(String(diff.db)));
    return { reason: `${gap} ms apart: the files scan reads the file mtime, the database the time of the last record (a write delay)` };
  }
  if (diff.kind === "only-db") {
    return (await hostSize()) === undefined ? { reason: "the host file is gone (the tool removed it after the ship); the store keeps it" } : {};
  }
  if (diff.kind === "only-files") {
    return row ? {} : { reason: "no stored row: the file is not shipped yet" };
  }
  const size = await hostSize();
  if (row && size !== undefined && size > row.committedBytes) return { reason: `the host file grew after the ship (${size} bytes on the host, ${row.committedBytes} stored)` };
  return {};
}

/** The report as text, for a terminal or a file. Every difference is one line. */
export function formatHostReport(r: HostReport): string {
  const out: string[] = [];
  const pct = (x: number): string => `${(x * 100).toFixed(2)}%`;
  out.push(`Host ${r.node}, window ${r.days} days`);
  out.push(`Compared fields: ${COMPARED_FIELDS.join(", ")} (joined on tool and id; identity is not compared; ${r.strict ? "updatedAt exact" : `updatedAt of Codex equal within ${UPDATED_TOLERANCE_MS} ms, Claude exact`})`);
  for (const t of r.perTool) {
    const c = t.comparison;
    out.push(`  ${t.tool}: files ${c.filesNodes}, database ${c.dbNodes}, matched ${c.matched}, equal ${c.equal}, share ${pct(t.share)}`);
  }
  out.push(`Total: files ${r.filesNodes}, database ${r.dbNodes}, matched ${r.matched}, equal ${r.equal}, equal share ${pct(r.share)} of the union, ${pct(r.matchedShare)} of the ${r.matched} matched nodes`);
  out.push(`Identity: ${r.dbWithoutIdentity} of ${r.dbNodes} database nodes have no identity yet (unassigned slice). This is expected until the gateway resolves identities.`);
  out.push(`Differences: ${r.explained.length}, explained ${r.explained.length - r.unexplained}, unexplained ${r.unexplained}`);
  for (const e of r.explained) {
    const d = e.diff;
    const what = d.kind === "field" ? `${d.field}: files=${JSON.stringify(d.files)} database=${JSON.stringify(d.db)}` : d.kind === "only-files" ? `only in files (${d.files.title})` : `only in database (${d.db.title})`;
    out.push(`  [${e.reason === undefined ? "UNEXPLAINED" : "explained"}] ${e.tool} ${d.id} ${what}${e.reason ? ` -- ${e.reason}` : ""}`);
  }
  return out.join("\n");
}
