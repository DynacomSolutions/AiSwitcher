import type { TreeNodeDto } from "../../cli/sessions/types.ts";

/**
 * The fields the console shows for a tree node and that must not change when the tree moves from the host files to the
 * database (design 20261123, section 6, proof 5). `identity` is left out on purpose: a stored session has no identity
 * until the gateway resolves one, and the database tree shows it in the unassigned slice.
 */
export const COMPARED_FIELDS = ["id", "parentId", "title", "cwd", "startedAt", "updatedAt", "messageCount"] as const;
export type ComparedField = (typeof COMPARED_FIELDS)[number];

/** One difference between the two trees. */
export type TreeDiff =
  /** The files tree has the node and the database tree has not. */
  | { kind: "only-files"; id: string; files: TreeNodeDto }
  /** The database tree has the node and the files tree has not. */
  | { kind: "only-db"; id: string; db: TreeNodeDto }
  /** Both trees have the node and one field differs. `undefined` means the field is absent. */
  | { kind: "field"; id: string; field: Exclude<ComparedField, "id">; files: unknown; db: unknown; tolerated?: true };

export interface TreeComparison {
  filesNodes: number;
  dbNodes: number;
  /** Nodes in both trees (matched on id). */
  matched: number;
  /** Matched nodes with no field difference, or only `updatedAt` differences inside the tolerance. */
  equal: number;
  diffs: TreeDiff[];
}

export interface CompareOptions {
  /**
   * Largest `updatedAt` gap (ms) that still counts as equal (default 0, exact). The Codex file reader uses the file mtime,
   * the database the time of the last record, and the two differ by the write delay (1 to 2 ms on real data). A gap inside
   * the tolerance is still listed, with `tolerated: true`.
   */
  updatedToleranceMs?: number;
}

/** Compares two node lists (one tool, any identity split) on `COMPARED_FIELDS`. The id is the join key. */
export function compareTreeNodes(files: readonly TreeNodeDto[], db: readonly TreeNodeDto[], opts: CompareOptions = {}): TreeComparison {
  const tolerance = opts.updatedToleranceMs ?? 0;
  const dbById = new Map(db.map((n) => [n.id, n]));
  const filesById = new Map(files.map((n) => [n.id, n]));
  const diffs: TreeDiff[] = [];
  let matched = 0;
  let equal = 0;
  for (const f of files) {
    const d = dbById.get(f.id);
    if (!d) {
      diffs.push({ kind: "only-files", id: f.id, files: f });
      continue;
    }
    matched += 1;
    let clean = true;
    for (const field of COMPARED_FIELDS) {
      if (field === "id") continue;
      const a = f[field];
      const b = d[field];
      if (a === b) continue;
      const skew = field === "updatedAt" && typeof a === "string" && typeof b === "string" ? Math.abs(Date.parse(a) - Date.parse(b)) : Number.NaN;
      if (skew <= tolerance) {
        diffs.push({ kind: "field", id: f.id, field, files: a, db: b, tolerated: true });
      } else {
        clean = false;
        diffs.push({ kind: "field", id: f.id, field, files: a, db: b });
      }
    }
    if (clean) equal += 1;
  }
  for (const d of db) if (!filesById.has(d.id)) diffs.push({ kind: "only-db", id: d.id, db: d });
  return { filesNodes: files.length, dbNodes: db.length, matched, equal, diffs };
}

/** Share of equal nodes among all nodes either tree holds (the union). 1 when both are empty. */
export function equalShare(c: TreeComparison): number {
  const union = c.filesNodes + c.dbNodes - c.matched;
  return union === 0 ? 1 : c.equal / union;
}
