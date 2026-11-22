import { SQL } from "bun";
import type { ChatBody, ChatSelection, ChatState } from "../../browser/chat-protocol.ts";
import { ChatClosedError, ChatExistsError, ChatFenceRequiredError, ChatLeaseLostError, type ChatCreate, type ChatOwner, type ChatEventRow, type ChatPatch, type ChatRecord, type ChatStore, type LeaseFence } from "./types.ts";

const BATCH = 500;

const COLS = `id, binding, window_id, name, color, selection, state, tab_ids, acp_session_id, pod_session, can_load,
  owner_replica, (round(extract(epoch FROM lease_until) * 1000))::bigint AS lease_ms, (lease_until > clock_timestamp()) AS lease_live, epoch, last_seq, generation, created_at, updated_at, closed_at`;

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
    epoch: Number(r.epoch),
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
  if (r.lease_live === true) rec.leaseLive = true;
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

  async create(rec: ChatCreate, cap: number, owner?: ChatOwner): Promise<ChatRecord | "cap"> {
    // The advisory lock serialises creates of one window, so the count and the insert never race.
    let rows: Row[];
    try {
      rows = await this.sql.begin(async (t) => {
        await t`SELECT pg_advisory_xact_lock(hashtextextended(${`${rec.binding}:${rec.windowId}`}, 0))`;
        return t.unsafe(
          `INSERT INTO gateway_chats (id, binding, window_id, name, color, selection, state, tab_ids, acp_session_id, pod_session, can_load, created_at, updated_at, owner_replica, epoch, lease_until)
           SELECT $1, $2, $3, $4, $5, $6::jsonb, 'starting', $7::jsonb, $8, $9, $10, $11::bigint, $11::bigint, $13::text,
             CASE WHEN $13::text IS NULL THEN 0 ELSE 1 END,
             CASE WHEN $13::text IS NULL THEN NULL ELSE clock_timestamp() + make_interval(secs => $14::double precision / 1000.0) END
           WHERE (SELECT count(*) FROM gateway_chats WHERE binding = $2 AND window_id = $3 AND state <> 'closed') < $12
           RETURNING ${COLS}`,
          [rec.id, rec.binding, rec.windowId, rec.name, rec.color, JSON.stringify(rec.selection), JSON.stringify(rec.tabIds),
            rec.acpSessionId ?? null, rec.podSession ?? null, rec.canLoad ?? null, rec.createdAt, cap, owner?.replica ?? null, owner?.ttlMs ?? null],
        );
      });
    } catch (err) {
      const e = err as { errno?: unknown; code?: unknown } | null;
      if (e?.errno === "23505" || e?.code === "23505") throw new ChatExistsError(rec.id);
      throw err;
    }
    if (rows.length > 0) return toRecord(rows[0] as Row);
    // No row: the window is full. A used id must still report ChatExistsError.
    if (await this.get(rec.id)) throw new ChatExistsError(rec.id);
    return "cap";
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

  /** Tells a lost lease from a missing chat after a fenced statement changed no row. */
  private async diagnose(id: string, fence: LeaseFence): Promise<{ exists: boolean; held: boolean; state?: string }> {
    const rows = await this.sql.unsafe(
      `SELECT state, (owner_replica = $2 AND epoch = $3::bigint AND lease_until > clock_timestamp()) AS held FROM gateway_chats WHERE id = $1`,
      [id, fence.replica, fence.epoch],
    );
    const r = rows[0] as Row | undefined;
    return r ? { exists: true, held: r.held === true, state: r.state as string } : { exists: false, held: false };
  }

  async update(id: string, patch: ChatPatch, fence: LeaseFence): Promise<ChatRecord | undefined> {
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
       WHERE id = $1 AND owner_replica = $19 AND epoch = $20::bigint AND lease_until > clock_timestamp()
         AND NOT (state = 'closed' AND $4::boolean AND $5 <> 'closed')
       RETURNING ${COLS}`,
      [id, has("name"), patch.name ?? null, has("state"), patch.state ?? null, has("selection"),
        patch.selection === undefined ? null : JSON.stringify(patch.selection), has("tabIds"),
        patch.tabIds === undefined ? null : JSON.stringify(patch.tabIds), has("acpSessionId"), patch.acpSessionId ?? null,
        has("podSession"), patch.podSession ?? null, has("canLoad"), patch.canLoad ?? null, has("generation"),
        patch.generation ?? null, now, fence.replica, fence.epoch],
    );
    if (rows[0]) return toRecord(rows[0] as Row);
    const d = await this.diagnose(id, fence);
    if (!d.exists) return undefined;
    if (!d.held) throw new ChatLeaseLostError(id);
    throw new ChatClosedError(id);
  }

  async appendEvent(id: string, body: ChatBody, fence?: LeaseFence): Promise<number> {
    if (fence === undefined && body.k !== "user") throw new ChatFenceRequiredError(id);
    // One statement: the counter bump and the event insert commit together.
    const now = Date.now();
    const rows = await this.sql.unsafe(
      `WITH n AS (
         UPDATE gateway_chats SET last_seq = last_seq + 1, updated_at = $2::bigint
         WHERE id = $1 AND (NOT $4::boolean OR (owner_replica = $5::text AND epoch = $6::bigint AND lease_until > clock_timestamp()))
         RETURNING id, last_seq)
       INSERT INTO gateway_chat_events (chat_id, seq, ts, body)
       SELECT id, last_seq, $2::bigint, $3::jsonb FROM n
       RETURNING seq`,
      [id, now, JSON.stringify(body), fence !== undefined, fence?.replica ?? null, fence?.epoch ?? null],
    );
    if (rows[0]) return Number((rows[0] as Row).seq);
    if (fence !== undefined && (await this.diagnose(id, fence)).exists) throw new ChatLeaseLostError(id);
    throw new Error(`unknown chat ${id}`);
  }

  async events(id: string, afterSeq: number, limit: number): Promise<ChatEventRow[]> {
    const rows = await this.sql.unsafe(
      "SELECT seq, ts, body FROM gateway_chat_events WHERE chat_id = $1 AND seq > $2::bigint ORDER BY seq LIMIT $3::int",
      [id, afterSeq, Math.max(0, limit)],
    );
    return rows.map((r: Row) => ({ seq: Number(r.seq), ts: Number(r.ts), body: json<ChatBody>(r.body) }));
  }

  /** nowMs is ignored: the database clock decides expiry. */
  async acquireLease(id: string, replica: string, ttlMs: number, _nowMs: number): Promise<number | undefined> {
    const rows = await this.sql.unsafe(
      `UPDATE gateway_chats SET owner_replica = $2, epoch = epoch + 1,
         lease_until = clock_timestamp() + make_interval(secs => $3::double precision / 1000.0)
       WHERE id = $1 AND (owner_replica IS NULL OR owner_replica = $2 OR lease_until IS NULL OR lease_until <= clock_timestamp())
       RETURNING epoch`,
      [id, replica, ttlMs],
    );
    return rows[0] ? Number((rows[0] as Row).epoch) : undefined;
  }

  async renewLease(id: string, fence: LeaseFence, ttlMs: number, _nowMs: number): Promise<void> {
    const rows = await this.sql.unsafe(
      `UPDATE gateway_chats SET lease_until = clock_timestamp() + make_interval(secs => $4::double precision / 1000.0)
       WHERE id = $1 AND owner_replica = $2 AND epoch = $3::bigint AND lease_until > clock_timestamp() RETURNING id`,
      [id, fence.replica, fence.epoch, ttlMs],
    );
    if (rows.length === 0) throw new ChatLeaseLostError(id);
  }

  async releaseLease(id: string, fence: LeaseFence): Promise<void> {
    await this.sql.unsafe(
      "UPDATE gateway_chats SET owner_replica = NULL, lease_until = NULL WHERE id = $1 AND owner_replica = $2 AND epoch = $3::bigint",
      [id, fence.replica, fence.epoch],
    );
  }

  async ownedBy(replica: string): Promise<ChatRecord[]> {
    const rows = await this.sql.unsafe(`SELECT ${COLS} FROM gateway_chats WHERE owner_replica = $1 AND state <> 'closed' ORDER BY created_at, id`, [replica]);
    return rows.map((r: Row) => toRecord(r));
  }

  private async prune(where: string, cut: number): Promise<number> {
    let total = 0;
    for (;;) {
      const rows = await this.sql.unsafe(
        `DELETE FROM gateway_chats WHERE id IN (SELECT id FROM gateway_chats WHERE ${where} LIMIT ${BATCH}) RETURNING id`,
        [cut],
      );
      total += rows.length;
      if (rows.length < BATCH) return total;
    }
  }

  async pruneClosed(beforeMs: number): Promise<number> {
    return this.prune("state = 'closed' AND closed_at < $1::bigint", beforeMs);
  }

  async pruneIdle(cutMs: number): Promise<number> {
    return this.prune("state <> 'closed' AND updated_at < $1::bigint AND (lease_until IS NULL OR lease_until <= clock_timestamp())", cutMs);
  }
}
