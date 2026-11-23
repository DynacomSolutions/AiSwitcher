import { createHash } from "node:crypto";
import { SQL } from "bun";

/**
 * Index of stored session transcripts in Postgres (tables from migration 0014_sessions).
 *
 * A transcript file is stored as parts: byte ranges cut at line ends. The file row holds the cursor: `committedBytes`
 * is the end of the last part. A writer asks for the cursor, reads from there and sends the next parts. `ingest` is
 * the only code that moves the cursor, and it takes parts in order only: a gap or an overlap is refused. The same
 * part sent twice is a no-op, so a writer can retry after a lost answer.
 *
 * One copy per session (migration 0015_sessions_one_copy). A session is named by its tool (`kind`) and its session id
 * (`sessionRef`), not by the host path. The same session in two folders or on two nodes is stored once. The table
 * `ais_session_path` records every path that held it. A path that holds a different file under the same session id
 * (a head that differs) is refused as `other_copy` and starts no new generation, so two diverged copies never take turns.
 *
 * Who may write. A path that holds the CURRENT generation (its path row points at the newest file row) appends, and it alone
 * may start a new generation (a rewrite). A path that held only an older generation is a stranger now: it gets `other_copy`.
 * A stranger that wants to join the session must prove that its file holds the stored bytes: it sends an `anchor`, the hash of
 * its own bytes for the last stored part (range and hash come from the cursor answer). Without the proof nothing is stored
 * and the path is not recorded. A holder may send the anchor too: a mismatch is then a rewrite.
 */

/** Length of the file head that `headSha256` covers. */
export const HEAD_BYTES = 4096;
/** Sanity cap for one part. The shipper cuts at 4 MiB and goes over only for one very long line. */
export const MAX_PART_BYTES = 64 * 1024 * 1024;

const SHA256_HEX = /^[0-9a-f]{64}$/;
/** Largest value of a Postgres `integer` column (generation, lines). */
export const INT4_MAX = 2_147_483_647;
/** Host modification times outside 1970 to 2099 are a bug of the writer, not a time. */
export const MTIME_MIN_MS = 0;
export const MTIME_MAX_MS = 4_102_444_800_000;
/** Control characters (NUL included) and lone surrogates: Postgres refuses some, and none is a valid path or name. */
const BAD_TEXT = /[\u0000-\u001f\u007f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
export const hasBadText = (s: string): boolean => BAD_TEXT.test(s);

/**
 * Every part object of a session lives under this prefix: tool, the first 16 hex characters of SHA-256 of the session id,
 * and the generation. The key holds no title, prompt or path. The shipper builds the same prefix.
 */
export function partObjectPrefix(kind: string, sessionRef: string, generation: number): string {
  return `objects/v1/${kind}/${createHash("sha256").update(sessionRef).digest("hex").slice(0, 16)}/g${generation}/`;
}
const KEY_REST = /^[A-Za-z0-9._-]{1,128}$/;

/** A host path that holds a session file. */
export interface SessionPath {
  node: string;
  root: string;
  relPath: string;
}

/** Names a stored session. The same session in a new generation (after a rewrite) has the same key. */
export interface SessionFileKey extends SessionPath {
  kind: string;
  sessionRef: string;
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

/**
 * Proof that a path holds the stored bytes: the SHA-256 of the path's own file bytes in `[startOffset, endOffset)`, which is
 * a part that the session has stored (the last part, as the cursor answer names it). The store compares it with the stored
 * part that starts at `startOffset`. The hash covers bytes the writer reads from its own file, so a copy that differs inside
 * that range (or whose line cuts differ) does not pass.
 */
export interface SessionAnchor {
  startOffset: number;
  endOffset: number;
  plainSha256: string;
}

export interface SessionIngest extends SessionFileKey {
  /** Starts at 0. A larger value than the stored one starts a new generation: the file was rewritten. */
  generation: number;
  origin: string;
  pool?: string | null;
  parentRef?: string | null;
  /** SHA-256 (hex) of the first min(4096, end of the last part) bytes of the file after this ingest. */
  headSha256: string;
  /**
   * Required from a path that does not hold the current generation yet (it joins the session as another copy). Optional
   * from a holder. Absent from the first writer of a new session.
   */
  anchor?: SessionAnchor | null;
  /** Host modification time (ms). Moves `updated_at` forward until the indexer reads the real record time. */
  mtimeMs?: number;
  /** In order, contiguous. */
  parts: SessionPartInput[];
}

/** A path that holds a session, with no new bytes: the writer reports that its copy is stored already. */
export type SessionHold = Omit<SessionIngest, "parts">;

/** Where a writer continues. A file that is not known yet has no cursor: start at byte 0 of generation 0. */
export interface SessionCursor {
  fileId: number;
  generation: number;
  committedBytes: number;
  committedLines: number;
  headSha256: string;
}

/** The answer to a cursor request: the cursor of the session, and whether the asked path is recorded as a holder of it. */
export interface SessionCursorInfo extends SessionCursor {
  /** True when the asked path holds the CURRENT generation. */
  held: boolean;
  /** The last stored part: the range and hash that a new holder proves with. null: nothing stored. */
  anchor: SessionAnchor | null;
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
  /** A new generation must start at byte 0 and carry parts. */
  | "generation_start"
  /**
   * The session is stored already from another path, and this path holds a different file under the same id (a head that
   * differs, or a rewrite). Nothing is stored. The writer skips this copy.
   */
  | "other_copy"
  /**
   * The path does not hold the current generation and sent no anchor. Nothing is stored and the path is not recorded.
   * Read the cursor again and send its `anchor` hash of your own bytes.
   */
  | "proof_required";

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

/** One host path that held a session. */
export interface SessionHolderRow extends SessionPath {
  origin: string;
  pool: string | null;
  generation: number;
  firstSeenAt: number;
  lastSeenAt: number;
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

const bad = (m: string): never => {
  throw new SessionIngestInvalid(m);
};

/** The fields every request carries. Throws SessionIngestInvalid. */
function validateBase(req: SessionHold): void {
  for (const f of ["node", "root", "relPath", "kind", "origin", "sessionRef"] as const) {
    if (typeof req[f] !== "string" || req[f].length === 0) bad(`${f} must be a non-empty string`);
    if (hasBadText(req[f])) bad(`${f} must not hold control characters`);
  }
  for (const f of ["pool", "parentRef"] as const) {
    const v = req[f];
    if (v !== undefined && v !== null && (typeof v !== "string" || v.length === 0 || hasBadText(v))) bad(`${f} must be a text with no control characters, or null`);
  }
  if (!Number.isSafeInteger(req.generation) || req.generation < 0 || req.generation > INT4_MAX) bad(`generation must be a whole number from 0 to ${INT4_MAX}`);
  if (!SHA256_HEX.test(req.headSha256)) bad("headSha256 must be 64 lower-case hex characters");
  if (req.mtimeMs !== undefined && (!Number.isFinite(req.mtimeMs) || req.mtimeMs < MTIME_MIN_MS || req.mtimeMs > MTIME_MAX_MS)) bad(`mtimeMs must be a time from ${MTIME_MIN_MS} to ${MTIME_MAX_MS} (ms since 1970)`);
  const a = req.anchor;
  if (a !== undefined && a !== null) {
    if (!Number.isSafeInteger(a.startOffset) || !Number.isSafeInteger(a.endOffset) || a.startOffset < 0 || a.endOffset <= a.startOffset) bad("anchor needs 0 <= startOffset < endOffset");
    if (!SHA256_HEX.test(a.plainSha256)) bad("anchor.plainSha256 must be 64 lower-case hex characters");
  }
}

/** Refuses a hold request (no parts) that no correct writer sends. */
export function validateHold(req: SessionHold): void {
  validateBase(req);
}

/** Refuses a request that no correct writer sends. A race never reaches here: it ends as a conflict. */
export function validateIngest(req: SessionIngest): void {
  validateBase(req);
  if (req.parts.length === 0) bad("parts must not be empty");
  let at = req.parts[0]!.startOffset;
  for (const p of req.parts) {
    if (!Number.isSafeInteger(p.startOffset) || !Number.isSafeInteger(p.endOffset) || p.startOffset < 0 || p.endOffset <= p.startOffset) bad("a part needs 0 <= startOffset < endOffset");
    if (p.startOffset !== at) bad("parts must be contiguous and in order");
    if (p.plainBytes !== p.endOffset - p.startOffset) bad("plainBytes must equal endOffset - startOffset");
    if (p.plainBytes > MAX_PART_BYTES) bad(`a part is at most ${MAX_PART_BYTES} bytes`);
    if (!Number.isSafeInteger(p.lines) || p.lines < 0 || p.lines > INT4_MAX) bad(`lines must be a whole number from 0 to ${INT4_MAX}`);
    if (!Number.isSafeInteger(p.objectBytes) || p.objectBytes < 0) bad("objectBytes must be a whole number, 0 or more");
    if (!SHA256_HEX.test(p.plainSha256)) bad("plainSha256 must be 64 lower-case hex characters");
    const prefix = partObjectPrefix(req.kind, req.sessionRef, req.generation);
    if (typeof p.objectKey !== "string" || !p.objectKey.startsWith(prefix) || !KEY_REST.test(p.objectKey.slice(prefix.length)) || p.objectKey.slice(prefix.length).includes("..")) {
      bad(`objectKey must be ${prefix}<name> for this session and generation`);
    }
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

  /** Reads the database. Throws when it is unreachable. */
  async ping(): Promise<void> {
    await this.sql`SELECT 1`;
  }

  /**
   * The cursor of the newest generation of each session, in the order of `keys`. null: the session is not known yet.
   * The session is found by tool and session id, so a path that holds a copy of a stored session gets the same cursor.
   * `held` tells whether the asked path holds the current generation. `anchor` is the last stored part (what a path proves with).
   */
  async cursors(keys: SessionFileKey[]): Promise<(SessionCursorInfo | null)[]> {
    if (keys.length === 0) return [];
    const rows = await this.sql.unsafe(
      `SELECT k.ord, f.id, f.generation, f.committed_bytes, f.committed_lines, f.head_sha256,
              a.start_offset AS anchor_start, a.end_offset AS anchor_end, a.plain_sha256 AS anchor_sha256,
              f.id IS NOT NULL AND EXISTS (
                SELECT 1 FROM ais_session_path p WHERE p.file_id = f.id AND p.node = k.node AND p.root = k.root AND p.rel_path = k.rel_path
              ) AS held
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[]) WITH ORDINALITY AS k(kind, session_ref, node, root, rel_path, ord)
         LEFT JOIN LATERAL (
           SELECT id, generation, committed_bytes, committed_lines, head_sha256
             FROM ais_session_file
            WHERE kind = k.kind AND session_ref = k.session_ref
            ORDER BY generation DESC LIMIT 1
         ) f ON true
         LEFT JOIN LATERAL (
           SELECT start_offset, end_offset, plain_sha256 FROM ais_session_part WHERE file_id = f.id ORDER BY start_offset DESC LIMIT 1
         ) a ON true
        ORDER BY k.ord`,
      [keys.map((k) => k.kind), keys.map((k) => k.sessionRef), keys.map((k) => k.node), keys.map((k) => k.root), keys.map((k) => k.relPath)],
    );
    return rows.map((r: Row) =>
      r.id === null || r.id === undefined
        ? null
        : {
            ...cursorOf(r),
            held: r.held === true,
            anchor: r.anchor_sha256 === null || r.anchor_sha256 === undefined ? null : { startOffset: num(r.anchor_start), endOffset: num(r.anchor_end), plainSha256: String(r.anchor_sha256) },
          },
    );
  }

  /**
   * Stores parts of one session. All or nothing: a refusal leaves the session as it was.
   * One transaction per session, serialised by a lock on the tool and the session id, so two writers (also two paths
   * that hold the same session) never interleave. The path is recorded as a holder of the session.
   */
  async ingest(req: SessionIngest): Promise<IngestResult> {
    validateIngest(req);
    return this.writeSession(req);
  }

  /**
   * Records that a path holds a session that is stored already (a copy in another folder or on another node), with no
   * new bytes. An unknown session or a generation that is not the stored one is a conflict, as in `ingest`.
   */
  async hold(req: SessionHold): Promise<IngestResult> {
    validateHold(req);
    return this.writeSession({ ...req, parts: [] });
  }

  private async writeSession(req: SessionIngest): Promise<IngestResult> {
    try {
      return await this.sql.begin(async (t) => {
        await t`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["ais_session", req.kind, req.sessionRef])}, 0))`;
        const cur = (
          await t.unsafe(
            `SELECT * FROM ais_session_file WHERE kind = $1 AND session_ref = $2 ORDER BY generation DESC LIMIT 1 FOR UPDATE`,
            [req.kind, req.sessionRef],
          )
        )[0] as Row | undefined;
        const curCursor = cur ? cursorOf(cur) : null;
        const refuse = (reason: IngestConflictReason): never => {
          throw new Refused({ status: "conflict", reason, cursor: curCursor });
        };
        // Only a holder of the CURRENT generation appends or rewrites. A path that held an older generation is a stranger now.
        const held = cur
          ? (
              await t.unsafe(`SELECT 1 FROM ais_session_path WHERE file_id = $1 AND node = $2 AND root = $3 AND rel_path = $4 LIMIT 1`, [num(cur.id), req.node, req.root, req.relPath])
            ).length > 0
          : false;
        const first = req.parts[0];

        let fileId: number;
        let committed: number;
        let created = false;
        if (!cur || req.generation > num(cur.generation)) {
          // A new session, or a new generation after a rewrite: it starts at byte 0.
          // Only a holder of the current generation rewrites it. Any other path with other content is another copy: skip it.
          if (cur && !held) refuse("other_copy");
          if (!first || first.startOffset !== 0) refuse(cur ? "generation_start" : "gap");
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
          // A holder whose file changed rewrote it. A path that is not a holder has another file under the same id.
          const differs: IngestConflictReason = held ? "rewritten" : "other_copy";
          // A full 4 KiB head is fixed for the life of the file. A shorter head grows with the file, so it cannot tell a rewrite.
          if (num(cur.committed_bytes) >= HEAD_BYTES && String(cur.head_sha256) !== req.headSha256) refuse(differs);
          // The head covers 4 KiB only. The anchor covers the last stored part, so a copy that differs later cannot join.
          if (req.anchor) {
            const stored = (
              await t.unsafe(`SELECT end_offset, plain_sha256 FROM ais_session_part WHERE file_id = $1 AND start_offset = $2`, [num(cur.id), req.anchor.startOffset])
            )[0] as Row | undefined;
            if (!stored || num(stored.end_offset) !== req.anchor.endOffset || String(stored.plain_sha256) !== req.anchor.plainSha256) refuse(differs);
          } else if (!held) {
            refuse("proof_required");
          }
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

        // Record the path as a holder. A repeat touches the row at most once a minute.
        await t.unsafe(
          `INSERT INTO ais_session_path (file_id, node, root, rel_path, origin, pool)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (file_id, node, root, rel_path) DO UPDATE
             SET last_seen_at = now(), origin = EXCLUDED.origin, pool = EXCLUDED.pool
             WHERE ais_session_path.last_seen_at < now() - interval '1 minute'`,
          [fileId, req.node, req.root, req.relPath, req.origin, req.pool ?? null],
        );

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

  /** Every stored file row of a session (one per generation), newest generation first. */
  async filesOfSession(kind: string, sessionRef: string): Promise<SessionTreeRow[]> {
    const rows = await this.sql.unsafe(
      `SELECT * FROM ais_session_file WHERE kind = $1 AND session_ref = $2 ORDER BY generation DESC, committed_bytes DESC, id DESC`,
      [kind, sessionRef],
    );
    return rows.map(treeRowOf);
  }

  /** Every path that held a session (all generations), first seen first. */
  async paths(kind: string, sessionRef: string): Promise<SessionHolderRow[]> {
    const rows = await this.sql.unsafe(
      `SELECT p.node, p.root, p.rel_path, p.origin, p.pool, p.first_seen_at, p.last_seen_at, f.generation
         FROM ais_session_path p JOIN ais_session_file f ON f.id = p.file_id
        WHERE f.kind = $1 AND f.session_ref = $2
        ORDER BY p.first_seen_at, p.node, p.root, p.rel_path`,
      [kind, sessionRef],
    );
    return rows.map((r: Row) => ({
      node: String(r.node),
      root: String(r.root),
      relPath: String(r.rel_path),
      origin: String(r.origin),
      pool: strOrNull(r.pool),
      generation: num(r.generation),
      firstSeenAt: msOrNull(r.first_seen_at) ?? 0,
      lastSeenAt: msOrNull(r.last_seen_at) ?? 0,
    }));
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
