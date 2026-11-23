import { SQL } from "bun";

/**
 * Index of stored session transcripts in Postgres (tables from migration 0014_sessions).
 *
 * A transcript file is stored as parts: byte ranges cut at line ends. The file row holds the cursor: `committedBytes`
 * is the end of the last part. A writer asks for the cursor, reads from there and sends the next parts. `ingest` is
 * the only code that moves the cursor, and it takes parts in order only: a gap or an overlap is refused. The same
 * part sent twice is a no-op, so a writer can retry after a lost answer.
 */

/** Length of the file head that `headSha256` covers. */
export const HEAD_BYTES = 4096;
/** Sanity cap for one part. The shipper cuts at 4 MiB and goes over only for one very long line. */
export const MAX_PART_BYTES = 64 * 1024 * 1024;

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Names a file. The same file in a new generation (after a rewrite) has the same key. */
export interface SessionFileKey {
  node: string;
  root: string;
  relPath: string;
}

export interface SessionPartInput {
  startOffset: number;
  endOffset: number;
  /** Line count of the part. */
  lines: number;
  plainBytes: number;
  objectBytes: number;
  /** SHA-256 (hex) of the plain bytes. Tells a repeat from a different part at the same offset. */
  plainSha256: string;
  objectKey: string;
}

export interface SessionIngest extends SessionFileKey {
  /** Starts at 0. A larger value than the stored one starts a new generation: the file was rewritten. */
  generation: number;
  kind: string;
  origin: string;
  pool?: string | null;
  sessionRef: string;
  parentRef?: string | null;
  /** SHA-256 (hex) of the first min(4096, end of the last part) bytes of the file after this ingest. */
  headSha256: string;
  /** Host modification time (ms). Moves `updated_at` forward until the indexer reads the real record time. */
  mtimeMs?: number;
  /** In order, contiguous. */
  parts: SessionPartInput[];
}

/** Where a writer continues. A file that is not known yet has no cursor: start at byte 0 of generation 0. */
export interface SessionCursor {
  fileId: number;
  generation: number;
  committedBytes: number;
  committedLines: number;
  headSha256: string;
}

export type IngestConflictReason =
  /** The first part starts after the cursor. */
  | "gap"
  /** A part starts before the cursor and is not an exact repeat of the stored part. */
  | "overlap"
  /** The head of the file differs from the stored head: the file was rewritten. Send generation + 1 from byte 0. */
  | "rewritten"
  /** The generation is older than the stored one. */
  | "stale_generation"
  /** A new generation must start at byte 0. */
  | "generation_start";

export type IngestResult =
  | { status: "committed"; cursor: SessionCursor; created: boolean; partsAdded: number }
  /** Every part was stored already. Nothing changed. */
  | { status: "duplicate"; cursor: SessionCursor }
  /** Refused. Nothing changed. `cursor` is where the file stands now (null: the file is unknown). */
  | { status: "conflict"; reason: IngestConflictReason; cursor: SessionCursor | null };

/** The writer sent data that cannot be valid (a bug in the writer, not a race). */
export class SessionIngestInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionIngestInvalid";
  }
}

export interface SessionTreeRow {
  fileId: number;
  node: string;
  root: string;
  relPath: string;
  generation: number;
  kind: string;
  origin: string;
  pool: string | null;
  identity: string | null;
  sessionRef: string;
  parentRef: string | null;
  agentName: string | null;
  title: string | null;
  cwd: string | null;
  project: string | null;
  model: string | null;
  startedAt: number | null;
  updatedAt: number | null;
  messageCount: number | null;
  committedBytes: number;
  committedLines: number;
  indexedBytes: number;
}

export interface SessionTreeQuery {
  /** Only nodes updated at or after this time (ms). */
  sinceMs?: number;
  kind?: string;
  identity?: string;
  project?: string;
  /** Most nodes to return, newest first (default 5000, at most 50000). */
  limit?: number;
}

export interface SessionPartRow {
  startOffset: number;
  endOffset: number;
  lines: number;
  plainBytes: number;
  objectBytes: number;
  plainSha256: string;
  objectKey: string;
}

export interface SessionStoreHooks {
  /** Test seam. Runs inside the ingest transaction after part `index` was inserted. */
  afterPartInsert?: (index: number) => void | Promise<void>;
}

export interface SessionStoreOptions {
  sql?: SQL;
  /** Pool size when the store opens its own connection (default: the driver default). */
  poolMax?: number;
  hooks?: SessionStoreHooks;
}

type Row = Record<string, unknown>;

/** Carries a refusal out of the transaction so that the transaction rolls back. */
class Refused {
  constructor(readonly result: IngestResult) {}
}

const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const msOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : new Date(v as string | Date).getTime());

function cursorOf(r: Row): SessionCursor {
  return {
    fileId: num(r.id),
    generation: num(r.generation),
    committedBytes: num(r.committed_bytes),
    committedLines: num(r.committed_lines),
    headSha256: String(r.head_sha256),
  };
}

function treeRowOf(r: Row): SessionTreeRow {
  return {
    fileId: num(r.id),
    node: String(r.node),
    root: String(r.root),
    relPath: String(r.rel_path),
    generation: num(r.generation),
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
    startedAt: msOrNull(r.started_at),
    updatedAt: msOrNull(r.updated_at),
    messageCount: numOrNull(r.message_count),
    committedBytes: num(r.committed_bytes),
    committedLines: num(r.committed_lines),
    indexedBytes: num(r.indexed_bytes),
  };
}

function partRowOf(r: Row): SessionPartRow {
  return {
    startOffset: num(r.start_offset),
    endOffset: num(r.end_offset),
    lines: num(r.lines),
    plainBytes: num(r.plain_bytes),
    objectBytes: num(r.object_bytes),
    plainSha256: String(r.plain_sha256),
    objectKey: String(r.object_key),
  };
}

/** Refuses a request that no correct writer sends. A race never reaches here: it ends as a conflict. */
export function validateIngest(req: SessionIngest): void {
  const bad = (m: string): never => {
    throw new SessionIngestInvalid(m);
  };
  for (const f of ["node", "root", "relPath", "kind", "origin", "sessionRef"] as const) {
    if (typeof req[f] !== "string" || req[f].length === 0) bad(`${f} must be a non-empty string`);
  }
  if (!Number.isSafeInteger(req.generation) || req.generation < 0) bad("generation must be a whole number, 0 or more");
  if (!SHA256_HEX.test(req.headSha256)) bad("headSha256 must be 64 lower-case hex characters");
  if (req.mtimeMs !== undefined && !Number.isFinite(req.mtimeMs)) bad("mtimeMs must be a finite number");
  if (req.parts.length === 0) bad("parts must not be empty");
  let at = req.parts[0]!.startOffset;
  for (const p of req.parts) {
    if (!Number.isSafeInteger(p.startOffset) || !Number.isSafeInteger(p.endOffset) || p.startOffset < 0 || p.endOffset <= p.startOffset) bad("a part needs 0 <= startOffset < endOffset");
    if (p.startOffset !== at) bad("parts must be contiguous and in order");
    if (p.plainBytes !== p.endOffset - p.startOffset) bad("plainBytes must equal endOffset - startOffset");
    if (p.plainBytes > MAX_PART_BYTES) bad(`a part is at most ${MAX_PART_BYTES} bytes`);
    if (!Number.isSafeInteger(p.lines) || p.lines < 0) bad("lines must be a whole number, 0 or more");
    if (!Number.isSafeInteger(p.objectBytes) || p.objectBytes < 0) bad("objectBytes must be a whole number, 0 or more");
    if (!SHA256_HEX.test(p.plainSha256)) bad("plainSha256 must be 64 lower-case hex characters");
    if (typeof p.objectKey !== "string" || p.objectKey.length === 0) bad("objectKey must be a non-empty string");
    at = p.endOffset;
  }
}

export class SessionStore {
  private readonly sql: SQL;
  private readonly ownsSql: boolean;
  private readonly hooks: SessionStoreHooks;

  constructor(url: string, opts: SessionStoreOptions = {}) {
    this.ownsSql = !opts.sql;
    this.sql = opts.sql ?? (opts.poolMax ? new SQL(url, { max: opts.poolMax }) : new SQL(url));
    this.hooks = opts.hooks ?? {};
  }

  async close(): Promise<void> {
    if (this.ownsSql) await this.sql.close();
  }

  /** The cursor of the newest generation of each file, in the order of `keys`. null: the file is not known yet. */
  async cursors(keys: SessionFileKey[]): Promise<(SessionCursor | null)[]> {
    if (keys.length === 0) return [];
    const rows = await this.sql.unsafe(
      `SELECT k.ord, f.id, f.generation, f.committed_bytes, f.committed_lines, f.head_sha256
         FROM unnest($1::text[], $2::text[], $3::text[]) WITH ORDINALITY AS k(node, root, rel_path, ord)
         LEFT JOIN LATERAL (
           SELECT id, generation, committed_bytes, committed_lines, head_sha256
             FROM ais_session_file
            WHERE node = k.node AND root = k.root AND rel_path = k.rel_path
            ORDER BY generation DESC LIMIT 1
         ) f ON true
        ORDER BY k.ord`,
      [keys.map((k) => k.node), keys.map((k) => k.root), keys.map((k) => k.relPath)],
    );
    return rows.map((r: Row) => (r.id === null || r.id === undefined ? null : cursorOf(r)));
  }

  /**
   * Stores parts of one file. All or nothing: a refusal leaves the file as it was.
   * One transaction per file, serialised by a lock on the file key, so two writers of one file never interleave.
   */
  async ingest(req: SessionIngest): Promise<IngestResult> {
    validateIngest(req);
    try {
      return await this.sql.begin(async (t) => {
        await t`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["ais_session_file", req.node, req.root, req.relPath])}, 0))`;
        const cur = (
          await t.unsafe(
            `SELECT * FROM ais_session_file WHERE node = $1 AND root = $2 AND rel_path = $3 ORDER BY generation DESC LIMIT 1 FOR UPDATE`,
            [req.node, req.root, req.relPath],
          )
        )[0] as Row | undefined;
        const curCursor = cur ? cursorOf(cur) : null;
        const refuse = (reason: IngestConflictReason): never => {
          throw new Refused({ status: "conflict", reason, cursor: curCursor });
        };
        const first = req.parts[0]!;

        let fileId: number;
        let committed: number;
        let created = false;
        if (!cur || req.generation > num(cur.generation)) {
          // A new file, or a new generation after a rewrite: it starts at byte 0.
          if (first.startOffset !== 0) refuse(cur ? "generation_start" : "gap");
          const row = (
            await t.unsafe(
              `INSERT INTO ais_session_file (node, root, rel_path, generation, kind, origin, pool, session_ref, parent_ref, head_sha256, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE(to_timestamp($11::double precision / 1000), now()))
               RETURNING id`,
              [req.node, req.root, req.relPath, req.generation, req.kind, req.origin, req.pool ?? null, req.sessionRef, req.parentRef ?? null, req.headSha256, req.mtimeMs ?? null],
            )
          )[0] as Row;
          fileId = num(row.id);
          committed = 0;
          created = true;
        } else {
          if (req.generation < num(cur.generation)) refuse("stale_generation");
          // A full 4 KiB head is fixed for the life of the file. A shorter head grows with the file, so it cannot tell a rewrite.
          if (num(cur.committed_bytes) >= HEAD_BYTES && String(cur.head_sha256) !== req.headSha256) refuse("rewritten");
          fileId = num(cur.id);
          committed = num(cur.committed_bytes);
        }

        let added = 0;
        let addedLines = 0;
        for (const [i, p] of req.parts.entries()) {
          if (p.startOffset < committed) {
            // A repeat after a lost answer is fine. Anything else at an old offset is an overlap.
            const stored = (
              await t.unsafe(`SELECT end_offset, plain_sha256 FROM ais_session_part WHERE file_id = $1 AND start_offset = $2`, [fileId, p.startOffset])
            )[0] as Row | undefined;
            if (!stored || num(stored.end_offset) !== p.endOffset || String(stored.plain_sha256) !== p.plainSha256) refuse("overlap");
            continue;
          }
          if (p.startOffset > committed) refuse("gap");
          await t.unsafe(
            `INSERT INTO ais_session_part (file_id, start_offset, end_offset, lines, plain_bytes, object_bytes, plain_sha256, object_key)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [fileId, p.startOffset, p.endOffset, p.lines, p.plainBytes, p.objectBytes, p.plainSha256, p.objectKey],
          );
          committed = p.endOffset;
          added += 1;
          addedLines += p.lines;
          await this.hooks.afterPartInsert?.(i);
        }

        if (added === 0) return { status: "duplicate", cursor: curCursor! } satisfies IngestResult;
        const row = (
          await t.unsafe(
            `UPDATE ais_session_file
                SET committed_bytes = $2, committed_lines = committed_lines + $3, head_sha256 = $4, last_ingest_at = now(),
                    parent_ref = COALESCE(parent_ref, $5),
                    updated_at = GREATEST(COALESCE(updated_at, 'epoch'::timestamptz), COALESCE(to_timestamp($6::double precision / 1000), now()))
              WHERE id = $1
              RETURNING id, generation, committed_bytes, committed_lines, head_sha256`,
            [fileId, committed, addedLines, req.headSha256, req.parentRef ?? null, req.mtimeMs ?? null],
          )
        )[0] as Row;
        return { status: "committed", cursor: cursorOf(row), created, partsAdded: added } satisfies IngestResult;
      });
    } catch (err) {
      if (err instanceof Refused) return err.result;
      throw err;
    }
  }

  /** One node per session, newest first. Reads the view `ais_session_tree`. */
  async tree(q: SessionTreeQuery = {}): Promise<SessionTreeRow[]> {
    const limit = Math.min(Math.max(Math.trunc(q.limit ?? 5000), 1), 50000);
    const rows = await this.sql.unsafe(
      `SELECT * FROM ais_session_tree
        WHERE ($1::double precision IS NULL OR updated_at >= to_timestamp($1::double precision / 1000))
          AND ($2::text IS NULL OR kind = $2)
          AND ($3::text IS NULL OR identity = $3)
          AND ($4::text IS NULL OR project = $4)
        ORDER BY updated_at DESC NULLS LAST, id DESC
        LIMIT $5`,
      [q.sinceMs ?? null, q.kind ?? null, q.identity ?? null, q.project ?? null, limit],
    );
    return rows.map(treeRowOf);
  }

  /** Every stored file row of a session, all generations and folders, newest generation first. */
  async filesOfSession(kind: string, sessionRef: string): Promise<SessionTreeRow[]> {
    const rows = await this.sql.unsafe(
      `SELECT * FROM ais_session_file WHERE kind = $1 AND session_ref = $2 ORDER BY generation DESC, committed_bytes DESC, id DESC`,
      [kind, sessionRef],
    );
    return rows.map(treeRowOf);
  }

  /** The children of a node (subagents), newest first. */
  async children(kind: string, parentRef: string): Promise<SessionTreeRow[]> {
    const rows = await this.sql.unsafe(
      `SELECT * FROM ais_session_tree WHERE kind = $1 AND parent_ref = $2 ORDER BY updated_at DESC NULLS LAST, id DESC`,
      [kind, parentRef],
    );
    return rows.map(treeRowOf);
  }

  /** All parts of a file in byte order. */
  async parts(fileId: number): Promise<SessionPartRow[]> {
    const rows = await this.sql.unsafe(`SELECT * FROM ais_session_part WHERE file_id = $1 ORDER BY start_offset`, [fileId]);
    return rows.map(partRowOf);
  }

  /**
   * The last parts that together cover at least `windowBytes` bytes (all parts when the file is smaller), in byte order.
   * A reader of a live tail takes one to three parts this way.
   */
  async tailParts(fileId: number, windowBytes: number): Promise<SessionPartRow[]> {
    const rows = await this.sql.unsafe(
      `SELECT * FROM (
         SELECT p.*, COALESCE(SUM(plain_bytes) OVER (ORDER BY start_offset DESC ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS newer_bytes
           FROM ais_session_part p WHERE file_id = $1
       ) x
       WHERE newer_bytes < $2
       ORDER BY start_offset`,
      [fileId, Math.max(windowBytes, 1)],
    );
    return rows.map(partRowOf);
  }
}
