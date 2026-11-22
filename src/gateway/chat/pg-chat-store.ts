import { SQL } from "bun";
import type { ChatBody, ChatSelection, ChatState } from "../../browser/chat-protocol.ts";
import type { ChatCreate, ChatEventRow, ChatPatch, ChatRecord, ChatStore } from "./types.ts";

const COLS = `id, binding, window_id, name, color, selection, state, tab_ids, acp_session_id, pod_session, can_load,
  owner_replica, (round(extract(epoch FROM lease_until) * 1000))::bigint AS lease_ms, last_seq, generation, created_at, updated_at, closed_at`;

const json = <T>(v: unknown): T => (typeof v === "string" ? (JSON.parse(v) as T) : (v as T));

type Row = Record<string, unknown>;

function toRecord(r: Row): ChatRecord {
  const rec: ChatRecord = {
    id: r.id as string,
    binding: r.binding as string,
    windowId: Number(r.window_id),
    name: r.name as string,
    color: r.color as string,
    selection: json<ChatSelection>(r.selection),
    state: r.state as ChatState,
    tabIds: json<number[]>(r.tab_ids),
    lastSeq: Number(r.last_seq),
    generation: Number(r.generation),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
  if (r.acp_session_id != null) rec.acpSessionId = r.acp_session_id as string;
  if (r.pod_session != null) rec.podSession = r.pod_session as string;
  if (r.can_load != null) rec.canLoad = r.can_load as boolean;
  if (r.owner_replica != null) rec.ownerReplica = r.owner_replica as string;
  if (r.lease_ms != null) rec.leaseUntil = Number(r.lease_ms);
  if (r.closed_at != null) rec.closedAt = Number(r.closed_at);
  return rec;
}

export interface PgChatStoreOptions { sql?: SQL }

/** Postgres chat store. The tables come from migration 0012_chat. */
export class PgChatStore implements ChatStore {
  private readonly sql: SQL;
  private readonly ownsSql: boolean;

  constructor(url: string, opts: PgChatStoreOptions = {}) {
    this.ownsSql = !opts.sql;
    this.sql = opts.sql ?? new SQL(url);
  }

  async close(): Promise<void> {
    if (this.ownsSql) await this.sql.close();
  }

  async create(rec: ChatCreate, cap: number): Promise<ChatRecord | "cap"> {
    // The advisory lock serialises creates of one window, so the count and the insert never race.
    const rows = await this.sql.begin(async (t) => {
      await t`SELECT pg_advisory_xact_lock(hashtextextended(${`${rec.binding}:${rec.windowId}`}, 0))`;
      return t.unsafe(
        `INSERT INTO gateway_chats (id, binding, window_id, name, color, selection, state, tab_ids, acp_session_id, pod_session, can_load, owner_replica, lease_until, created_at, updated_at)
         SELECT $1, $2, $3, $4, $5, $6::jsonb, 'starting', $7::jsonb, $8, $9, $10, $11, to_timestamp($12::double precision / 1000.0), $13::bigint, $13::bigint
         WHERE (SELECT count(*) FROM gateway_chats WHERE binding = $2 AND window_id = $3 AND state <> 'closed') < $14
         RETURNING ${COLS}`,
        [rec.id, rec.binding, rec.windowId, rec.name, rec.color, JSON.stringify(rec.selection), JSON.stringify(rec.tabIds),
          rec.acpSessionId ?? null, rec.podSession ?? null, rec.canLoad ?? null, rec.ownerReplica ?? null,
          rec.leaseUntil ?? null, rec.createdAt, cap],
      );
    });
    return rows.length === 0 ? "cap" : toRecord(rows[0] as Row);
  }

  async get(id: string): Promise<ChatRecord | undefined> {
    const rows = await this.sql.unsafe(`SELECT ${COLS} FROM gateway_chats WHERE id = $1`, [id]);
    return rows[0] ? toRecord(rows[0] as Row) : undefined;
  }

  async listByBinding(binding: string, opts: { windowId?: number; includeClosed?: boolean } = {}): Promise<ChatRecord[]> {
    const rows = await this.sql.unsafe(
      `SELECT ${COLS} FROM gateway_chats
       WHERE binding = $1 AND ($2::int IS NULL OR window_id = $2::int) AND ($3::boolean OR state <> 'closed')
       ORDER BY created_at, id`,
      [binding, opts.windowId ?? null, opts.includeClosed === true],
    );
    return rows.map((r: Row) => toRecord(r));
  }

  async update(id: string, patch: ChatPatch): Promise<ChatRecord | undefined> {
    const now = Date.now();
    const has = (k: keyof ChatPatch): boolean => patch[k] !== undefined;
    const rows = await this.sql.unsafe(
      `UPDATE gateway_chats SET
         name = CASE WHEN $2::boolean THEN $3 ELSE name END,
         state = CASE WHEN $4::boolean THEN $5 ELSE state END,
         selection = CASE WHEN $6::boolean THEN $7::jsonb ELSE selection END,
         tab_ids = CASE WHEN $8::boolean THEN $9::jsonb ELSE tab_ids END,
         acp_session_id = CASE WHEN $10::boolean THEN $11 ELSE acp_session_id END,
         pod_session = CASE WHEN $12::boolean THEN $13 ELSE pod_session END,
         can_load = CASE WHEN $14::boolean THEN $15::boolean ELSE can_load END,
         generation = CASE WHEN $16::boolean THEN $17::int ELSE generation END,
         closed_at = CASE WHEN NOT $4::boolean THEN closed_at WHEN $5 = 'closed' THEN coalesce(closed_at, $18::bigint) ELSE NULL END,
         updated_at = $18::bigint
       WHERE id = $1
       RETURNING ${COLS}`,
      [id, has("name"), patch.name ?? null, has("state"), patch.state ?? null, has("selection"),
        patch.selection === undefined ? null : JSON.stringify(patch.selection), has("tabIds"),
        patch.tabIds === undefined ? null : JSON.stringify(patch.tabIds), has("acpSessionId"), patch.acpSessionId ?? null,
        has("podSession"), patch.podSession ?? null, has("canLoad"), patch.canLoad ?? null, has("generation"),
        patch.generation ?? null, now],
    );
    return rows[0] ? toRecord(rows[0] as Row) : undefined;
  }

  async appendEvent(id: string, body: ChatBody): Promise<number> {
    // One statement: the counter bump and the event insert commit together.
    const rows = await this.sql.unsafe(
      `WITH n AS (UPDATE gateway_chats SET last_seq = last_seq + 1 WHERE id = $1 RETURNING id, last_seq)
       INSERT INTO gateway_chat_events (chat_id, seq, ts, body)
       SELECT id, last_seq, $2::bigint, $3::jsonb FROM n
       RETURNING seq`,
      [id, Date.now(), JSON.stringify(body)],
    );
    if (!rows[0]) throw new Error(`unknown chat ${id}`);
    return Number((rows[0] as Row).seq);
  }

  async events(id: string, afterSeq: number, limit: number): Promise<ChatEventRow[]> {
    const rows = await this.sql.unsafe(
      "SELECT seq, ts, body FROM gateway_chat_events WHERE chat_id = $1 AND seq > $2::bigint ORDER BY seq LIMIT $3::int",
      [id, afterSeq, Math.max(0, limit)],
    );
    return rows.map((r: Row) => ({ seq: Number(r.seq), ts: Number(r.ts), body: json<ChatBody>(r.body) }));
  }

  async acquireLease(id: string, replica: string, ttlMs: number, nowMs: number): Promise<boolean> {
    const rows = await this.sql.unsafe(
      `UPDATE gateway_chats SET owner_replica = $2, lease_until = to_timestamp(($3::double precision + $4::double precision) / 1000.0)
       WHERE id = $1 AND (owner_replica IS NULL OR owner_replica = $2 OR lease_until IS NULL OR lease_until <= to_timestamp($3::double precision / 1000.0))
       RETURNING id`,
      [id, replica, nowMs, ttlMs],
    );
    return rows.length > 0;
  }

  async renewLease(id: string, replica: string, ttlMs: number, nowMs: number): Promise<boolean> {
    const rows = await this.sql.unsafe(
      `UPDATE gateway_chats SET lease_until = to_timestamp(($3::double precision + $4::double precision) / 1000.0)
       WHERE id = $1 AND owner_replica = $2 RETURNING id`,
      [id, replica, nowMs, ttlMs],
    );
    return rows.length > 0;
  }

  async releaseLease(id: string, replica: string): Promise<void> {
    await this.sql.unsafe("UPDATE gateway_chats SET owner_replica = NULL, lease_until = NULL WHERE id = $1 AND owner_replica = $2", [id, replica]);
  }

  async ownedBy(replica: string): Promise<ChatRecord[]> {
    const rows = await this.sql.unsafe(`SELECT ${COLS} FROM gateway_chats WHERE owner_replica = $1 AND state <> 'closed' ORDER BY created_at, id`, [replica]);
    return rows.map((r: Row) => toRecord(r));
  }

  async pruneClosed(beforeMs: number): Promise<number> {
    const rows = await this.sql.unsafe("DELETE FROM gateway_chats WHERE state = 'closed' AND closed_at < $1::bigint RETURNING id", [beforeMs]);
    return rows.length;
  }
}
