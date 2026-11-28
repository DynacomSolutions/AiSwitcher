import type { SQL } from "bun";
import type { PoolUsage } from "../identities/pool/adapter.ts";
import { bounded } from "./refresh-guard.ts";
import { redactText } from "./upstream-error.ts";
import type { GatewayMetrics } from "./metrics.ts";

/**
 * The reset log: one append-only row for every reset attempt, for Claude and Codex, manual and automatic.
 * Nothing deletes or prunes a row. Each row is updated once, to fill `after` with the first usage reading that follows it.
 * A row holds no token, cookie or secret. `grantId` is a credit or grant ID only.
 */

export const RESET_LOG_PROVIDERS = ["claude", "codex"] as const;
export const RESET_LOG_TRIGGERS = ["manual", "auto"] as const;
export const RESET_LOG_OUTCOMES = ["reset", "no_credit", "already_redeemed", "rejected", "error"] as const;

export type ResetLogProvider = (typeof RESET_LOG_PROVIDERS)[number];
export type ResetLogTrigger = (typeof RESET_LOG_TRIGGERS)[number];
export type ResetLogOutcome = (typeof RESET_LOG_OUTCOMES)[number];

/** One usage window. `key` is stable across providers: `five_hour`, `weekly`, `weekly_<model>` and so on. */
export interface ResetLogWindow {
  key: string;
  label: string | null;
  percent: number;
  resetsAt: string | null;
}

export interface ResetLogEntry {
  /** When the attempt ended and the row was made. */
  at: string;
  /** When the attempt started (the call to `begin`). Null for a row from before this column existed. */
  startedAt: string | null;
  provider: ResetLogProvider;
  trigger: ResetLogTrigger;
  actor: string;
  identity: string;
  account: string | null;
  pool: string | null;
  grantId: string | null;
  before: ResetLogWindow[];
  outcome: ResetLogOutcome;
  message: string | null;
  resetsLeftAfter: number | null;
}

/** A row as the read API answers it. `id` is a decimal string. */
export interface ResetLogRow extends ResetLogEntry {
  id: string;
  after: ResetLogWindow[] | null;
  afterAt: string | null;
}

export interface ResetLogFilters {
  identity?: string;
  provider?: ResetLogProvider;
  trigger?: ResetLogTrigger;
  outcome?: ResetLogOutcome;
  /** Inclusive lower bound (ISO instant). */
  from?: string;
  /** Exclusive upper bound (ISO instant). `parseResetLogQuery` turns an inclusive `to` into this. */
  toExclusive?: string;
  limit?: number;
  /** Cursor: only rows older than this position in the order (`at` then `id`, both descending). */
  before?: ResetLogCursor;
}

/** The position of one row in the list order. The API shows it as one opaque string (`encodeResetLogCursor`). */
export interface ResetLogCursor {
  /** ISO instant, up to microsecond precision. */
  at: string;
  /** Row ID, decimal digits. */
  id: string;
}

export interface ResetLogPage {
  rows: ResetLogRow[];
  /** Opaque cursor for the next page (pass it as `before`), or null at the end. */
  nextBefore: string | null;
  identities: string[];
}

const CURSOR_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const CURSOR_ID = /^\d{1,18}$/;

/** Packs a list position into the opaque string that the API gives as `nextBefore` and takes as `before`. */
export function encodeResetLogCursor(cursor: ResetLogCursor): string {
  return Buffer.from(`${cursor.at}|${cursor.id}`, "utf8").toString("base64url");
}

/** The reverse of `encodeResetLogCursor`. Undefined for any text that is not a cursor. */
export function decodeResetLogCursor(text: string): ResetLogCursor | undefined {
  if (text.length > 120 || !/^[A-Za-z0-9_-]+$/.test(text)) return undefined;
  const [at, id, ...rest] = Buffer.from(text, "base64url").toString("utf8").split("|");
  if (rest.length || at === undefined || id === undefined || !CURSOR_AT.test(at) || !CURSOR_ID.test(id)) return undefined;
  if (!Number.isFinite(Date.parse(at))) return undefined;
  return { at, id };
}

export const RESET_LOG_DEFAULT_LIMIT = 100;
export const RESET_LOG_MAX_LIMIT = 500;

export interface ResetLogStore {
  insert(entry: ResetLogEntry): Promise<void>;
  list(filters: ResetLogFilters): Promise<ResetLogPage>;
  /** Sets `after` and `after_at` on the `reset` rows of this member that have none and are older than `readingAt`. One fill per row. */
  fillAfter(provider: ResetLogProvider, identity: string, after: ResetLogWindow[], readingAt: string): Promise<{ filled: number; pending: boolean }>;
  /** The members that have a `reset` row with no `after`. */
  pendingMembers(): Promise<Array<{ provider: ResetLogProvider; identity: string }>>;
}

/* --------------------------------- windows -------------------------------- */

const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

function baseKey(label: string): string {
  const lower = label.trim().toLowerCase();
  if (lower === "five-hour" || lower === "session" || lower === "5h") return "five_hour";
  if (lower === "seven-day" || lower === "week" || lower === "weekly" || lower === "7d") return "weekly";
  if (lower === "month" || lower === "monthly") return "monthly";
  // Claude names a model window "seven-day (Opus)". The model part follows below.
  if (/^seven-day\s*\(.+\)$/.test(lower)) return "weekly";
  return slug(lower) || "window";
}

/** Maps the windows of one usage reading to log windows. Every window of the reading is kept. */
export function resetLogWindows(reading: Pick<PoolUsage, "windows"> | undefined): ResetLogWindow[] {
  const used = new Map<string, number>();
  const out: ResetLogWindow[] = [];
  for (const window of reading?.windows ?? []) {
    if (!Number.isFinite(window.utilization)) continue;
    const model = window.model?.trim();
    const base = baseKey(window.label);
    // A model name may repeat in a label. The model is added once.
    let key = model ? `${base}_${slug(model)}` : base;
    const seen = used.get(key) ?? 0;
    used.set(key, seen + 1);
    if (seen > 0) key = `${key}_${seen + 1}`;
    const reset = window.resetsAt?.trim();
    out.push({
      key,
      label: window.label.trim() || null,
      percent: window.utilization,
      resetsAt: reset ? reset : null,
    });
  }
  return out;
}

/* ---------------------------------- query --------------------------------- */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

function instant(value: string, endOfDay: boolean): string | undefined {
  const text = value.trim();
  if (DATE_ONLY.test(text)) {
    const start = Date.parse(`${text}T00:00:00.000Z`);
    if (!Number.isFinite(start) || new Date(start).toISOString().slice(0, 10) !== text) return undefined;
    return new Date(endOfDay ? start + DAY_MS : start).toISOString();
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(text)) return undefined;
  const at = Date.parse(text);
  // An inclusive datetime end becomes an exclusive bound one millisecond later.
  return Number.isFinite(at) ? new Date(endOfDay ? at + 1 : at).toISOString() : undefined;
}

const oneOf = <T extends string>(list: readonly T[], value: string | undefined): T | undefined =>
  list.find((item) => item === value);

/**
 * Validates the query of GET /reset-log (gateway) and GET /api/logs/resets (console).
 * Returns the filters, or a short message that names the first problem.
 */
export function parseResetLogQuery(query: (name: string) => string | undefined): ResetLogFilters | string {
  const filters: ResetLogFilters = {};
  const text = (name: string): string | undefined => {
    const value = query(name);
    return value === undefined || value.trim() === "" ? undefined : value.trim();
  };
  const identity = text("identity");
  if (identity !== undefined) {
    if (identity.length > 256) return "identity is too long";
    filters.identity = identity;
  }
  const provider = text("provider");
  if (provider !== undefined) {
    const found = oneOf(RESET_LOG_PROVIDERS, provider);
    if (!found) return `provider must be one of ${RESET_LOG_PROVIDERS.join(", ")}`;
    filters.provider = found;
  }
  const trigger = text("trigger");
  if (trigger !== undefined) {
    const found = oneOf(RESET_LOG_TRIGGERS, trigger);
    if (!found) return `trigger must be one of ${RESET_LOG_TRIGGERS.join(", ")}`;
    filters.trigger = found;
  }
  const outcome = text("outcome");
  if (outcome !== undefined) {
    const found = oneOf(RESET_LOG_OUTCOMES, outcome);
    if (!found) return `outcome must be one of ${RESET_LOG_OUTCOMES.join(", ")}`;
    filters.outcome = found;
  }
  const from = text("from");
  if (from !== undefined) {
    const at = instant(from, false);
    if (!at) return "from must be an ISO date or date-time";
    filters.from = at;
  }
  const to = text("to");
  if (to !== undefined) {
    const at = instant(to, true);
    if (!at) return "to must be an ISO date or date-time";
    filters.toExclusive = at;
  }
  const limit = text("limit");
  if (limit !== undefined) {
    if (!/^\d+$/.test(limit) || Number(limit) < 1) return "limit must be a whole number of 1 or more";
    filters.limit = Math.min(Number(limit), RESET_LOG_MAX_LIMIT);
  }
  const before = text("before");
  if (before !== undefined) {
    const cursor = decodeResetLogCursor(before);
    if (!cursor) return "before must be a cursor from nextBefore";
    filters.before = cursor;
  }
  return filters;
}

/** Placement of the page: one extra row tells whether another page follows. */
function page(rows: ResetLogRow[], limit: number, identities: string[], cursorOf: (row: ResetLogRow) => ResetLogCursor): ResetLogPage {
  const more = rows.length > limit;
  const shown = more ? rows.slice(0, limit) : rows;
  const last = shown[shown.length - 1];
  return { rows: shown, nextBefore: more && last ? encodeResetLogCursor(cursorOf(last)) : null, identities };
}

/** Newest first: `at` descending, then `id` descending. */
function newerFirst(a: { at: string; id: string }, b: { at: string; id: string }): number {
  const byTime = Date.parse(b.at) - Date.parse(a.at);
  if (byTime !== 0) return byTime;
  const x = BigInt(a.id);
  const y = BigInt(b.id);
  return x === y ? 0 : y > x ? 1 : -1;
}

/* ---------------------------------- stores -------------------------------- */

/** In memory: for tests and for a gateway with no database of its own. */
export class MemoryResetLog implements ResetLogStore {
  private readonly rows: ResetLogRow[] = [];
  private nextId = 1;
  /** Test hook: the next `insert` calls fail while this holds. */
  failInserts = false;

  async insert(entry: ResetLogEntry): Promise<void> {
    if (this.failInserts) throw new Error("reset log store unavailable");
    this.rows.push({ ...structuredClone(entry), id: String(this.nextId++), after: null, afterAt: null });
  }

  async list(filters: ResetLogFilters): Promise<ResetLogPage> {
    const limit = filters.limit ?? RESET_LOG_DEFAULT_LIMIT;
    const from = filters.from === undefined ? undefined : Date.parse(filters.from);
    const to = filters.toExclusive === undefined ? undefined : Date.parse(filters.toExclusive);
    const cursor = filters.before;
    const matches = this.rows
      .filter((row) =>
        (filters.identity === undefined || row.identity === filters.identity) &&
        (filters.provider === undefined || row.provider === filters.provider) &&
        (filters.trigger === undefined || row.trigger === filters.trigger) &&
        (filters.outcome === undefined || row.outcome === filters.outcome) &&
        (from === undefined || Date.parse(row.at) >= from) &&
        (to === undefined || Date.parse(row.at) < to) &&
        (cursor === undefined || newerFirst(row, { at: cursor.at, id: cursor.id }) > 0))
      .sort(newerFirst)
      .slice(0, limit + 1)
      .map((row) => structuredClone(row));
    return page(matches, limit, [...new Set(this.rows.map((row) => row.identity))].sort(), (row) => ({ at: new Date(row.at).toISOString(), id: row.id }));
  }

  async fillAfter(provider: ResetLogProvider, identity: string, after: ResetLogWindow[], readingAt: string): Promise<{ filled: number; pending: boolean }> {
    let filled = 0;
    for (const row of this.rows) {
      if (row.provider !== provider || row.identity !== identity || row.outcome !== "reset" || row.after !== null) continue;
      if (!(Date.parse(row.at) < Date.parse(readingAt))) continue;
      row.after = structuredClone(after);
      row.afterAt = new Date(readingAt).toISOString();
      filled += 1;
    }
    return { filled, pending: this.rows.some((row) => row.provider === provider && row.identity === identity && row.outcome === "reset" && row.after === null) };
  }

  async pendingMembers(): Promise<Array<{ provider: ResetLogProvider; identity: string }>> {
    const seen = new Map<string, { provider: ResetLogProvider; identity: string }>();
    for (const row of this.rows) if (row.outcome === "reset" && row.after === null) seen.set(`${row.provider}\u0000${row.identity}`, { provider: row.provider, identity: row.identity });
    return [...seen.values()];
  }

  /** Test hook: every row, oldest first. */
  all(): ResetLogRow[] {
    return structuredClone(this.rows);
  }
}

interface DbRow {
  id: string | number | bigint;
  at: Date | string;
  /** `at` as text with microseconds, for the cursor. */
  at_cursor: string;
  started_at: Date | string | null;
  provider: ResetLogProvider;
  trigger: ResetLogTrigger;
  actor: string;
  identity: string;
  account: string | null;
  pool: string | null;
  grant_id: string | null;
  before: unknown;
  outcome: ResetLogOutcome;
  message: string | null;
  resets_left_after: number | null;
  after: unknown;
  after_at: Date | string | null;
}

const json = (value: unknown): unknown => (typeof value === "string" ? JSON.parse(value) : value);
const iso = (value: Date | string): string => new Date(value).toISOString();

function mapRow(row: DbRow): ResetLogRow {
  return {
    id: String(row.id),
    at: iso(row.at),
    startedAt: row.started_at === null || row.started_at === undefined ? null : iso(row.started_at),
    provider: row.provider,
    trigger: row.trigger,
    actor: row.actor,
    identity: row.identity,
    account: row.account,
    pool: row.pool,
    grantId: row.grant_id,
    before: (json(row.before) as ResetLogWindow[] | null) ?? [],
    outcome: row.outcome,
    message: row.message,
    resetsLeftAfter: row.resets_left_after === null ? null : Number(row.resets_left_after),
    after: row.after === null || row.after === undefined ? null : (json(row.after) as ResetLogWindow[]),
    afterAt: row.after_at === null ? null : iso(row.after_at),
  };
}

/** How long the list of known identities stays cached (the filter menu does not need more). */
const IDENTITIES_TTL_MS = 60_000;

/** PostgreSQL table `reset_log` (migration 0024). Only inserts, reads and one `after` fill per row. */
export class PgResetLog implements ResetLogStore {
  private names: { at: number; list: string[] } | undefined;
  private readonly now: () => number;

  constructor(private readonly sql: SQL, options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  async insert(entry: ResetLogEntry): Promise<void> {
    await this.sql`INSERT INTO reset_log
      (at, started_at, provider, "trigger", actor, identity, account, pool, grant_id, "before", outcome, message, resets_left_after)
      VALUES (${entry.at}::text::timestamptz, ${entry.startedAt}::text::timestamptz, ${entry.provider}, ${entry.trigger}, ${entry.actor}, ${entry.identity},
        ${entry.account}, ${entry.pool}, ${entry.grantId}, ${JSON.stringify(entry.before)}::text::jsonb,
        ${entry.outcome}, ${entry.message}, ${entry.resetsLeftAfter})`;
    // A new identity shows in the filter menu at once, without a second read of the table.
    if (this.names && !this.names.list.includes(entry.identity)) this.names.list = [...this.names.list, entry.identity].sort();
  }

  /** The distinct identities, read at most once a minute. A failed read keeps the last list. */
  private async identities(): Promise<string[]> {
    const cached = this.names;
    if (cached && this.now() - cached.at < IDENTITIES_TTL_MS) return cached.list;
    try {
      const rows: Array<{ identity: string }> = await this.sql`SELECT DISTINCT identity FROM reset_log ORDER BY identity`;
      this.names = { at: this.now(), list: rows.map((row) => row.identity) };
      return this.names.list;
    } catch (error) {
      if (cached) return cached.list;
      throw error;
    }
  }

  async list(filters: ResetLogFilters): Promise<ResetLogPage> {
    const limit = filters.limit ?? RESET_LOG_DEFAULT_LIMIT;
    const cursor = filters.before;
    const rows: DbRow[] = await this.sql`SELECT id::text AS id, at, to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"."US"Z"') AS at_cursor,
        started_at, provider, "trigger", actor, identity, account, pool, grant_id,
        "before", outcome, message, resets_left_after, "after", after_at
      FROM reset_log
      WHERE (${filters.identity ?? null}::text IS NULL OR identity = ${filters.identity ?? null})
        AND (${filters.provider ?? null}::text IS NULL OR provider = ${filters.provider ?? null})
        AND (${filters.trigger ?? null}::text IS NULL OR "trigger" = ${filters.trigger ?? null})
        AND (${filters.outcome ?? null}::text IS NULL OR outcome = ${filters.outcome ?? null})
        AND (${filters.from ?? null}::text IS NULL OR at >= ${filters.from ?? null}::text::timestamptz)
        AND (${filters.toExclusive ?? null}::text IS NULL OR at < ${filters.toExclusive ?? null}::text::timestamptz)
        AND (${cursor?.at ?? null}::text IS NULL OR (at, id) < (${cursor?.at ?? null}::text::timestamptz, ${cursor?.id ?? null}::text::bigint))
      ORDER BY at DESC, id DESC
      LIMIT ${limit + 1}`;
    const cursors = new Map(rows.map((row) => [String(row.id), row.at_cursor]));
    return page(rows.map(mapRow), limit, await this.identities(), (row) => ({ at: cursors.get(row.id) ?? row.at, id: row.id }));
  }

  async fillAfter(provider: ResetLogProvider, identity: string, after: ResetLogWindow[], readingAt: string): Promise<{ filled: number; pending: boolean }> {
    const filled: unknown[] = await this.sql`UPDATE reset_log
      SET "after" = ${JSON.stringify(after)}::text::jsonb, after_at = ${readingAt}::text::timestamptz
      WHERE provider = ${provider} AND identity = ${identity} AND outcome = 'reset' AND "after" IS NULL AND at < ${readingAt}::text::timestamptz
      RETURNING id`;
    const [left] = await this.sql`SELECT EXISTS (
      SELECT 1 FROM reset_log WHERE provider = ${provider} AND identity = ${identity} AND outcome = 'reset' AND "after" IS NULL
    ) AS pending`;
    return { filled: filled.length, pending: left?.pending === true };
  }

  async pendingMembers(): Promise<Array<{ provider: ResetLogProvider; identity: string }>> {
    const rows: Array<{ provider: ResetLogProvider; identity: string }> =
      await this.sql`SELECT DISTINCT provider, identity FROM reset_log WHERE outcome = 'reset' AND "after" IS NULL`;
    return rows.map(({ provider, identity }) => ({ provider, identity }));
  }
}

/* --------------------------------- logger --------------------------------- */

export interface ResetAttemptStart {
  provider: ResetLogProvider;
  trigger: ResetLogTrigger;
  /** Who started it: `user`, `auto-reset-worker`, `pool-route`, with the console user or app after a colon when known. */
  actor: string;
  identity: string;
  account?: string | null;
  pool?: string | null;
  /** A credit or grant ID. Never a token. */
  grantId?: string | null;
  /** The reading from before the reset. Left out: the logger reads the cached usage of the member at once. */
  before?: Pick<PoolUsage, "windows"> | undefined;
}

export interface ResetAttemptResult {
  outcome: ResetLogOutcome;
  message?: string | null;
  resetsLeftAfter?: number | null;
  /** Known only after the reset (for example, the credit the provider reported). */
  grantId?: string | null;
  account?: string | null;
  /** The reading that the decision used. It replaces the windows that `begin` took from the cache. */
  before?: Pick<PoolUsage, "windows">;
}

export interface ResetAttempt {
  /**
   * Writes the row once. It never rejects: a failed write is retried, then counted and logged.
   * A caller on a response path does not await it: the logger tracks the write, and `drain` waits for it.
   */
  finish(result: ResetAttemptResult): Promise<void>;
}

export interface ResetLogger {
  /** Captures the windows now and returns the handle that writes the row. It never rejects. */
  begin(start: ResetAttemptStart): Promise<ResetAttempt>;
  /** Called for every stored usage reading. It fills `after` of rows that wait for it, once per row. It never throws. */
  onReading(provider: string, identity: string, reading: PoolUsage): void;
  /** Loads the members that have rows with no `after`. Call once at start. */
  warm(): Promise<void>;
  /** Waits until every started write has ended (written, or given up). Never rejects. Call at stop. */
  drain(): Promise<void>;
}

export interface ResetLoggerOptions {
  store: ResetLogStore;
  /** The cached usage of one member. Used when `begin` has no `before`. */
  usageFor?: (provider: ResetLogProvider, identity: string) => Promise<PoolUsage | undefined>;
  metrics?: Pick<GatewayMetrics, "resetAttempt" | "resetLogWriteFailure">;
  now?: () => number;
  log?: (line: string) => void;
  /** Longest one store call may take (default 2000 ms). */
  storeTimeoutMs?: number;
  /** How long a replica trusts its list of members with rows to fill (default 5 minutes). */
  resyncMs?: number;
  /** The waits between the tries of one write (default 250 ms, then 1 s: three tries in all). */
  retryBackoffMs?: readonly number[];
  /** Most writes that may be waiting at once (default 1000). A write over the limit is dropped and counted. */
  queueLimit?: number;
  /** Replaces the wait between two tries (tests). */
  sleep?: (ms: number) => Promise<void>;
}

const RETRY_BACKOFF_MS: readonly number[] = [250, 1_000];
const QUEUE_LIMIT = 1_000;
const MESSAGE_MAX = 300;
const FIELD_MAX = 256;

/** Free text: credential-shaped parts go, and the length is capped. */
const clean = (value: string | null | undefined, max: number): string | null => {
  if (value === undefined || value === null) return null;
  const text = redactText(value, max);
  return text === "" ? null : text;
};

/** A name or an ID: it is kept as it is, with control characters removed and the length capped. */
const field = (value: string | null | undefined, max: number): string | null => {
  const text = value?.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
  return text ? text : null;
};

export function createResetLogger(options: ResetLoggerOptions): ResetLogger {
  const { store, metrics, usageFor } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.warn(line));
  const timeoutMs = options.storeTimeoutMs ?? 2_000;
  const resyncMs = options.resyncMs ?? 5 * 60_000;
  const backoff = options.retryBackoffMs ?? RETRY_BACKOFF_MS;
  const queueLimit = options.queueLimit ?? QUEUE_LIMIT;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const key = (provider: string, identity: string): string => `${provider}\u0000${identity}`;
  const waiting = new Map<string, { provider: ResetLogProvider; identity: string }>();
  const filling = new Set<string>();
  /** Writes that have started and not ended. `drain` waits for them. */
  const pending = new Set<Promise<void>>();
  /** Counts the rows that this replica has inserted for one member. A fill that overlaps an insert must keep the member in `waiting`. */
  const generation = new Map<string, number>();
  let syncedAt = Number.NEGATIVE_INFINITY;
  let syncing = false;

  const isProvider = (provider: string): provider is ResetLogProvider => (RESET_LOG_PROVIDERS as readonly string[]).includes(provider);

  async function resync(): Promise<void> {
    if (syncing) return;
    syncing = true;
    try {
      const members = await bounded(store.pendingMembers(), timeoutMs, "reset log members");
      for (const member of members) waiting.set(key(member.provider, member.identity), member);
      syncedAt = now();
    } catch {
      // The next reading tries again.
    } finally {
      syncing = false;
    }
  }

  const reportFailure = (entry: ResetLogEntry, error: unknown, note: string): void => {
    try {
      metrics?.resetLogWriteFailure?.(entry.provider);
    } catch {
      // Counted nowhere else.
    }
    const reason = clean(error instanceof Error ? error.message : String(error), 120) ?? "unknown error";
    try {
      log(`gateway: reset log write failed${note} (${entry.provider} ${entry.trigger} ${entry.outcome}): ${reason}`);
    } catch {
      // A logger failure never blocks the reset.
    }
  };

  /** Inserts one row: three tries with a short wait between them. Never rejects. */
  async function writeEntry(entry: ResetLogEntry): Promise<void> {
    if (pending.size > queueLimit) {
      reportFailure(entry, new Error("the reset log write queue is full"), " (dropped)");
      return;
    }
    let lastError: unknown;
    for (let attempt = 0; attempt <= backoff.length; attempt += 1) {
      try {
        await bounded(store.insert(entry), timeoutMs, "reset log write");
        const id = key(entry.provider, entry.identity);
        generation.set(id, (generation.get(id) ?? 0) + 1);
        // Only a reset row has an `after` to fill.
        if (entry.outcome === "reset") waiting.set(id, { provider: entry.provider, identity: entry.identity });
        return;
      } catch (error) {
        lastError = error;
        const wait = backoff[attempt];
        if (wait === undefined) break;
        try {
          await sleep(wait);
        } catch {
          break;
        }
      }
    }
    reportFailure(entry, lastError, "");
  }

  return {
    async warm() {
      await resync();
    },

    async drain() {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },

    async begin(start) {
      const startedAt = new Date(now()).toISOString();
      let windows: ResetLogWindow[] = [];
      try {
        const reading = start.before !== undefined
          ? start.before
          : usageFor ? await bounded(usageFor(start.provider, start.identity), timeoutMs, "reset log usage") : undefined;
        windows = resetLogWindows(reading);
      } catch {
        // A missing reading leaves the windows empty. It never stops the reset.
      }
      let written = false;
      return {
        async finish(result) {
          if (written) return;
          written = true;
          const entry: ResetLogEntry = {
            at: new Date(now()).toISOString(),
            startedAt,
            provider: start.provider,
            trigger: start.trigger,
            actor: field(start.actor, FIELD_MAX) ?? "unknown",
            identity: start.identity,
            account: field(result.account ?? start.account, FIELD_MAX),
            pool: field(start.pool, FIELD_MAX),
            grantId: field(result.grantId ?? start.grantId, FIELD_MAX),
            before: result.before ? resetLogWindows(result.before) : windows,
            outcome: result.outcome,
            message: clean(result.message, MESSAGE_MAX),
            resetsLeftAfter: typeof result.resetsLeftAfter === "number" && Number.isSafeInteger(result.resetsLeftAfter) ? result.resetsLeftAfter : null,
          };
          try {
            metrics?.resetAttempt?.(entry.provider, entry.trigger, entry.outcome);
          } catch {
            // A metric failure never blocks the reset.
          }
          const write = writeEntry(entry);
          pending.add(write);
          try {
            await write;
          } finally {
            pending.delete(write);
          }
        },
      };
    },

    onReading(provider, identity, reading) {
      try {
        if (!isProvider(provider)) return;
        if (now() - syncedAt >= resyncMs) void resync();
        const id = key(provider, identity);
        if (!waiting.has(id) || filling.has(id)) return;
        if (reading.stale || reading.status === "unavailable") return;
        const after = resetLogWindows(reading);
        const readingAt = Date.parse(reading.capturedAt);
        if (!after.length || !Number.isFinite(readingAt)) return;
        filling.add(id);
        const seen = generation.get(id) ?? 0;
        void bounded(store.fillAfter(provider, identity, after, new Date(readingAt).toISOString()), timeoutMs, "reset log fill")
          // A row inserted during the fill may have missed it: the member then stays in the list.
          .then((filled) => { if (!filled.pending && (generation.get(id) ?? 0) === seen) waiting.delete(id); })
          .catch(() => undefined)
          .finally(() => filling.delete(id));
      } catch {
        // A reading never fails because of the log.
      }
    },
  };
}

/* ------------------------------- result mapping ----------------------------- */

const CLAUDE_RESET = /^(?:reset|ok|success|applied|redeemed|used)$/i;
const CLAUDE_NOTHING = /^(?:nothing_to_reset|no_reset_needed|not_limited)$/i;
const CLAUDE_NO_CREDIT = /^(?:no_credit|no_grant|grant_exhausted|exhausted)$/i;

/** Maps the answer of a manual Claude reset to an outcome. An unclear answer with cleared windows counts as a reset. */
export function claudeManualOutcome(result: { result?: unknown; cleared?: unknown; resetsLeft?: unknown }): ResetAttemptResult {
  const name = typeof result.result === "string" ? result.result : "";
  const resetsLeftAfter = typeof result.resetsLeft === "number" ? result.resetsLeft : null;
  const cleared = Array.isArray(result.cleared) && result.cleared.length > 0;
  if (CLAUDE_RESET.test(name) || ((name === "" || name === "unknown") && cleared)) return { outcome: "reset", resetsLeftAfter };
  if (CLAUDE_NO_CREDIT.test(name)) return { outcome: "no_credit", message: name, resetsLeftAfter };
  if (/^already_redeemed$/i.test(name)) return { outcome: "already_redeemed", message: name, resetsLeftAfter };
  if (CLAUDE_NOTHING.test(name)) return { outcome: "rejected", message: name, resetsLeftAfter };
  return { outcome: "error", message: name === "" || name === "unknown" ? "The reset answer was not recognised" : `The reset answer was not recognised: ${name}`, resetsLeftAfter };
}

/** Maps the answer of a Codex reset (manual identity route or pool route) to an outcome. */
export function codexResultOutcome(result: string): ResetAttemptResult {
  if (result === "reset") return { outcome: "reset" };
  if (result === "no_credit") return { outcome: "no_credit", message: result };
  if (result === "already_redeemed") return { outcome: "already_redeemed", message: result };
  if (result === "nothing_to_reset") return { outcome: "rejected", message: result };
  return { outcome: "error", message: `The reset answer was not recognised: ${result}` };
}

/**
 * Maps a thrown error to an outcome. A refusal that came before any POST, or a provider refusal (400, 403, 404, 409, 429), is `rejected`.
 * Every other failure leaves the outcome unknown, so it is `error`.
 */
export function failureOutcome(error: unknown): ResetAttemptResult {
  const status = (error as { status?: unknown } | null)?.status;
  const unsent = (error as { postAttempted?: unknown } | null)?.postAttempted === false;
  const message = error instanceof Error ? error.message : "reset failed";
  const refused = status === 400 || status === 403 || status === 404 || status === 409 || status === 429;
  return { outcome: refused || unsent ? "rejected" : "error", message };
}

/**
 * Maps the end of an automatic claim to an outcome. `status` and `outcome` are the values that the claim store keeps.
 * A reset is `reset`. A provider answer `no_credit` or `already_redeemed` keeps its name. A refusal before or by the provider is `rejected`.
 * A claim with no recorded answer (`unknown`) is `error`.
 */
export function autoResetOutcome(status: "reset" | "rejected" | "unknown", outcome: string, failure?: string): ResetAttemptResult {
  if (status === "reset") return { outcome: "reset" };
  const message = failure ? `${outcome}: ${failure}` : outcome;
  if (outcome === "no_credit") return { outcome: "no_credit", message };
  if (outcome === "already_redeemed") return { outcome: "already_redeemed", message };
  return { outcome: status === "rejected" ? "rejected" : "error", message };
}

const ACTOR_HEADER = "x-ais-actor";

/**
 * The actor of a manual reset. `base` is the route's own name (`user`, `pool-route`). A console that knows its user or app
 * sends it in the `X-AIS-Actor` header, and the actor becomes `base:name`. Any other header value is ignored.
 */
export function resetActor(request: Request, base: string): string {
  const given = request.headers.get(ACTOR_HEADER)?.trim();
  return given && /^[A-Za-z0-9._-]{1,64}$/.test(given) ? `${base}:${given}` : base;
}
