import type { Hono } from "hono";
import type { GatewayMetrics } from "./metrics.ts";
import type { IngestConflictReason, IngestResult, SessionAnchor, SessionCursorInfo, SessionFileKey, SessionHold, SessionIngest, SessionPartInput } from "./sessions/session-store.ts";
import { hasBadText, SessionIngestInvalid, validateHold, validateIngest } from "./sessions/session-store.ts";

/**
 * Admin routes of the session store: the shipper of backup-client sends the index rows of the transcripts it stored
 * as part objects. They sit under `/sessions/v1/`, behind the admin bearer token or the ingest token (admin.ts), and
 * answer 404 until the feature is on (`AIS_GATEWAY_SESSIONS_INGEST`). The ingest token opens these routes and nothing else.
 *
 * One session is stored once, whatever host path or node held it. A session is named by its tool (`kind`) and its session
 * id (`sessionRef`). Every request names the path too, so the index records every path that held the session.
 *
 * - GET  /sessions/v1/ping      `{ok, flushGapSeconds, limits}`. Reads the database, so it proves the real client path.
 * - POST /sessions/v1/cursors   `{files: [{kind, sessionRef, node, root, relPath}]}` (at most 500) answers
 *                               `{flushGapSeconds, cursors: [null | {generation, committedBytes, committedLines, headSha256, held, anchor}]}`
 *                               in the order asked. null: the session is unknown, start at byte 0 of generation 0. `held`: the asked path holds
 *                               the current generation. `anchor` is `{startOffset, endOffset, plainSha256}` of the last stored part: a path that
 *                               does not hold the session hashes its own bytes in that range and sends the same shape in its record.
 * - POST /sessions/v1/ingest    `{files: [record]}` (at most 100). A record is the cursor key plus `{origin, pool?, parentRef?, generation,
 *                               headSha256, anchor?, mtimeMs?, parts}`. `anchor` is required from a path that does not hold the current generation. `parts` may be empty: the path holds a session that is stored already.
 *                               Answers `{flushGapSeconds, results: [...]}`, one result per record in order. HTTP 200 whatever the
 *                               results are: `committed` (new parts stored), `duplicate` (all parts were stored), `conflict` (with a
 *                               `reason` and the `cursor` where the session stands) or `invalid` (with an `error`). Nothing of a refused
 *                               record changes. A record is atomic. The records of one request are independent.
 *
 * The writer sends the object first and the index second, so the index never names a missing object. When the gateway
 * can reach the object store (`objectExists`), it checks each part object before it commits (`object_missing`).
 */

export const SESSIONS_MAX_CURSOR_FILES = 500;
export const SESSIONS_MAX_INGEST_FILES = 100;
export const SESSIONS_MAX_PARTS_PER_FILE = 64;
/** Largest request body in bytes. 100 records of 64 parts stay far below this. */
export const SESSIONS_MAX_BODY_BYTES = 4 * 1024 * 1024;
/** The least time between two flushes of one live file. The shipper reads it from the answers. */
export const SESSIONS_DEFAULT_FLUSH_GAP_SECONDS = 120;
/** Every part object lives under this key prefix. */
export const SESSIONS_OBJECT_PREFIX = "objects/v1/";

/** What the routes need of SessionStore. A test replaces it. */
export interface SessionsIngestStore {
  cursors(keys: SessionFileKey[]): Promise<(SessionCursorInfo | null)[]>;
  ingest(req: SessionIngest): Promise<IngestResult>;
  hold(req: SessionHold): Promise<IngestResult>;
  ping(): Promise<void>;
}

export interface SessionsAdminDeps {
  store: SessionsIngestStore;
  /** Seconds between two flushes of a live file (default 120). Sent to the shipper in every answer. */
  flushGapSeconds?: number;
  now?(): Date;
  /** Whether a part object exists in the object store. Absent: the gateway does not check. */
  objectExists?(key: string): Promise<boolean>;
  metrics?: Pick<GatewayMetrics, "sessionsRequest" | "sessionsRecord" | "sessionsParts" | "sessionsLag" | "sessionsError">;
}

/** The object store check failed (not "the object is missing"). The request fails with 503 and the writer retries. */
class ObjectCheckFailed extends Error {}

type Fail = (status: 400 | 404 | 503, message: string, extra?: object) => Response;
type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
/** A non-empty text of at most `max` characters with no control character (Postgres refuses NUL, and no name holds one). */
const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.length > 0 && v.length <= max && !hasBadText(v) ? v : undefined);
const KIND = /^[a-z][a-z0-9_-]{0,31}$/;

/** The path and session fields every record carries, or a message that names the problem. */
export function parseSessionKey(raw: unknown): SessionFileKey | string {
  if (!isRec(raw)) return "a file entry must be an object";
  const kind = typeof raw.kind === "string" && KIND.test(raw.kind) ? raw.kind : undefined;
  if (!kind) return "kind must be a short lower-case name";
  const sessionRef = str(raw.sessionRef, 512);
  if (!sessionRef) return "sessionRef must be a text of 1 to 512 characters with no control characters";
  const node = str(raw.node, 128);
  if (!node) return "node must be a text of 1 to 128 characters with no control characters";
  const root = str(raw.root, 4096);
  if (!root) return "root must be a text of 1 to 4096 characters with no control characters";
  const relPath = str(raw.relPath, 4096);
  if (!relPath) return "relPath must be a text of 1 to 4096 characters with no control characters";
  return { kind, sessionRef, node, root, relPath };
}

function parsePart(raw: unknown): SessionPartInput | string {
  if (!isRec(raw)) return "a part must be an object";
  const nums = ["startOffset", "endOffset", "lines", "plainBytes", "objectBytes"] as const;
  for (const k of nums) if (typeof raw[k] !== "number" || !Number.isSafeInteger(raw[k])) return `part.${k} must be a whole number`;
  const plainSha256 = typeof raw.plainSha256 === "string" ? raw.plainSha256 : "";
  const objectKey = str(raw.objectKey, 512);
  if (!objectKey || !objectKey.startsWith(SESSIONS_OBJECT_PREFIX) || objectKey.includes("..")) return `part.objectKey must be a key under ${SESSIONS_OBJECT_PREFIX}`;
  return {
    startOffset: raw.startOffset as number,
    endOffset: raw.endOffset as number,
    lines: raw.lines as number,
    plainBytes: raw.plainBytes as number,
    objectBytes: raw.objectBytes as number,
    plainSha256,
    objectKey,
  };
}

/** One ingest record, or a message that names the problem. The store checks the offsets and the hashes. */
export function parseIngestRecord(raw: unknown): SessionIngest | string {
  const key = parseSessionKey(raw);
  if (typeof key === "string") return key;
  const r = raw as Rec;
  const origin = str(r.origin, 64);
  if (!origin) return "origin must be a text of 1 to 64 characters with no control characters";
  if (r.pool !== undefined && r.pool !== null && !str(r.pool, 128)) return "pool must be a text of 1 to 128 characters with no control characters, or null";
  if (r.parentRef !== undefined && r.parentRef !== null && !str(r.parentRef, 512)) return "parentRef must be a text of 1 to 512 characters with no control characters, or null";
  if (typeof r.generation !== "number" || !Number.isSafeInteger(r.generation)) return "generation must be a whole number";
  if (typeof r.headSha256 !== "string") return "headSha256 must be a text";
  let anchor: SessionAnchor | undefined;
  if (r.anchor !== undefined && r.anchor !== null) {
    const a = r.anchor;
    if (!isRec(a) || typeof a.startOffset !== "number" || typeof a.endOffset !== "number" || typeof a.plainSha256 !== "string") return "anchor must be {startOffset, endOffset, plainSha256}";
    anchor = { startOffset: a.startOffset, endOffset: a.endOffset, plainSha256: a.plainSha256 };
  }
  if (r.mtimeMs !== undefined && (typeof r.mtimeMs !== "number" || !Number.isFinite(r.mtimeMs))) return "mtimeMs must be a number";
  if (!Array.isArray(r.parts)) return "parts must be a list";
  if (r.parts.length > SESSIONS_MAX_PARTS_PER_FILE) return `parts must hold at most ${SESSIONS_MAX_PARTS_PER_FILE} entries`;
  const parts: SessionPartInput[] = [];
  for (const p of r.parts) {
    const part = parsePart(p);
    if (typeof part === "string") return part;
    parts.push(part);
  }
  const rec: SessionIngest = {
    ...key,
    origin,
    ...(typeof r.pool === "string" ? { pool: r.pool } : {}),
    ...(typeof r.parentRef === "string" ? { parentRef: r.parentRef } : {}),
    generation: r.generation,
    headSha256: r.headSha256,
    ...(anchor ? { anchor } : {}),
    ...(typeof r.mtimeMs === "number" ? { mtimeMs: r.mtimeMs } : {}),
    parts,
  };
  // The store limits (int4 ranges, time range, hashes, object keys of this session) apply here too, so a value that
  // Postgres would refuse ends as an `invalid` result of this record and not as a failed request that the shipper repeats.
  try {
    if (parts.length === 0) validateHold(rec);
    else validateIngest(rec);
  } catch (e) {
    if (e instanceof SessionIngestInvalid) return e.message;
    throw e;
  }
  return rec;
}

type CursorView = { generation: number; committedBytes: number; committedLines: number; headSha256: string; held?: boolean; anchor?: SessionAnchor | null };
const cursorView = (c: { generation: number; committedBytes: number; committedLines: number; headSha256: string }, extra?: { held: boolean; anchor: SessionAnchor | null }): CursorView => ({
  generation: c.generation,
  committedBytes: c.committedBytes,
  committedLines: c.committedLines,
  headSha256: c.headSha256,
  ...(extra ? { held: extra.held, anchor: extra.anchor } : {}),
});

type RecordResult =
  | { status: "committed"; created: boolean; partsAdded: number; cursor: CursorView }
  | { status: "duplicate"; cursor: CursorView }
  | { status: "conflict"; reason: IngestConflictReason | "object_missing"; cursor: CursorView | null }
  | { status: "invalid"; error: string };

/** Reads the body up to `max` bytes. undefined: it is larger. */
async function readLimited(req: Request, max: number): Promise<string | undefined> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return undefined;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function registerSessionsAdmin(hono: Hono, deps: SessionsAdminDeps | undefined, err: Fail): void {
  if (!deps) {
    // The feature is off: the routes do not exist, for every caller.
    hono.all("/sessions/v1/*", () => err(404, "session ingest is not enabled"));
    return;
  }
  const { store, metrics } = deps;
  const flushGapSeconds = deps.flushGapSeconds ?? SESSIONS_DEFAULT_FLUSH_GAP_SECONDS;
  const now = deps.now ?? (() => new Date());
  const unavailable = (): Response => Response.json({ error: "the session store is unavailable" }, { status: 503, headers: { "retry-after": "5" } });

  /** Runs one route with its timing and outcome counted. */
  const timed = async (route: string, fn: () => Promise<{ outcome: string; res: Response }>): Promise<Response> => {
    const t0 = performance.now();
    try {
      const { outcome, res } = await fn();
      metrics?.sessionsRequest?.(route, outcome, (performance.now() - t0) / 1000);
      return res;
    } catch (e) {
      if (!(e instanceof ObjectCheckFailed)) metrics?.sessionsError?.("store");
      metrics?.sessionsRequest?.(route, "unavailable", (performance.now() - t0) / 1000);
      return unavailable();
    }
  };

  /** The JSON body, or the response that refuses it. */
  const body = async (req: Request): Promise<{ ok: true; value: Rec } | { ok: false; outcome: string; res: Response }> => {
    const text = await readLimited(req, SESSIONS_MAX_BODY_BYTES);
    if (text === undefined) {
      metrics?.sessionsError?.("body");
      return { ok: false, outcome: "too_large", res: Response.json({ error: `the body must be at most ${SESSIONS_MAX_BODY_BYTES} bytes` }, { status: 413 }) };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { ok: false, outcome: "bad_request", res: err(400, "body must be JSON") };
    }
    if (!isRec(raw)) return { ok: false, outcome: "bad_request", res: err(400, "body must be a JSON object") };
    return { ok: true, value: raw };
  };

  hono.get("/sessions/v1/ping", (c) =>
    timed("ping", async () => {
      await store.ping();
      return {
        outcome: "ok",
        res: c.json({ ok: true, flushGapSeconds, limits: { cursors: SESSIONS_MAX_CURSOR_FILES, files: SESSIONS_MAX_INGEST_FILES, parts: SESSIONS_MAX_PARTS_PER_FILE, bodyBytes: SESSIONS_MAX_BODY_BYTES } }),
      };
    }),
  );

  hono.post("/sessions/v1/cursors", (c) =>
    timed("cursors", async () => {
      const b = await body(c.req.raw);
      if (!b.ok) return b;
      const list = b.value.files;
      if (!Array.isArray(list) || list.length === 0 || list.length > SESSIONS_MAX_CURSOR_FILES) {
        return { outcome: "bad_request", res: err(400, `files must be a list of 1 to ${SESSIONS_MAX_CURSOR_FILES} entries`) };
      }
      const keys: SessionFileKey[] = [];
      for (const [i, f] of list.entries()) {
        const k = parseSessionKey(f);
        if (typeof k === "string") return { outcome: "bad_request", res: err(400, `files[${i}]: ${k}`) };
        keys.push(k);
      }
      const cursors = await store.cursors(keys);
      return { outcome: "ok", res: c.json({ flushGapSeconds, cursors: cursors.map((x) => (x ? cursorView(x, { held: x.held, anchor: x.anchor }) : null)) }) };
    }),
  );

  hono.post("/sessions/v1/ingest", (c) =>
    timed("ingest", async () => {
      const b = await body(c.req.raw);
      if (!b.ok) return b;
      const list = b.value.files;
      if (!Array.isArray(list) || list.length === 0 || list.length > SESSIONS_MAX_INGEST_FILES) {
        return { outcome: "bad_request", res: err(400, `files must be a list of 1 to ${SESSIONS_MAX_INGEST_FILES} entries`) };
      }
      const results: RecordResult[] = [];
      for (const raw of list) {
        const result = await ingestOne(raw);
        metrics?.sessionsRecord?.(result.status === "conflict" && result.reason === "object_missing" ? "object_missing" : result.status);
        results.push(result);
      }
      return { outcome: "ok", res: c.json({ flushGapSeconds, results }) };
    }),
  );

  async function ingestOne(raw: unknown): Promise<RecordResult> {
    const rec = parseIngestRecord(raw);
    if (typeof rec === "string") return { status: "invalid", error: rec };
    if (deps?.objectExists && rec.parts.length > 0) {
      try {
        for (const p of rec.parts) {
          if (!(await deps.objectExists(p.objectKey))) return { status: "conflict", reason: "object_missing", cursor: null };
        }
      } catch {
        metrics?.sessionsError?.("object_check");
        throw new ObjectCheckFailed("object check failed");
      }
    }
    let res: IngestResult;
    try {
      res = rec.parts.length === 0 ? await store.hold(rec) : await store.ingest(rec);
    } catch (e) {
      if (e instanceof SessionIngestInvalid) return { status: "invalid", error: e.message };
      throw e;
    }
    if (res.status === "conflict") return { status: "conflict", reason: res.reason, cursor: res.cursor ? cursorView(res.cursor) : null };
    if (res.status === "duplicate") return { status: "duplicate", cursor: cursorView(res.cursor) };
    // The parts this request added are the last `partsAdded`; the ones before were repeats.
    const added = rec.parts.slice(rec.parts.length - res.partsAdded);
    metrics?.sessionsParts?.(added.length, added.reduce((n, p) => n + p.plainBytes, 0), added.reduce((n, p) => n + p.objectBytes, 0));
    if (rec.mtimeMs !== undefined) metrics?.sessionsLag?.((now().getTime() - rec.mtimeMs) / 1000);
    return { status: "committed", created: res.created, partsAdded: res.partsAdded, cursor: cursorView(res.cursor) };
  }
}
