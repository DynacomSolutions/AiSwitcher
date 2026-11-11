import { chmodSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Identity, ToolConfig } from "../../identities/types.ts";
import { NATIVE_SEGMENT_FORMAT, type SegmentedNativeManifest } from "./native-segments.ts";
import { canonicalUsageProvider, providerForTool } from "./providers.ts";
import type { UsageResult } from "./run.ts";
import { hourlyEntriesFromNativeMessages, LOCAL_RECOVERY_DAILY_PREFIX, type TokscaleEntry, type TokscaleHourlyEntry, type TokscaleReport } from "./tokscale.ts";

/** Retained sessions (docs/agents/usage-tokscale.md, "Recorded usage is never
 * lost"). A Tokscale export holds what Tokscale can still read: its message
 * cache keeps a deleted transcript's usage only while its entry carries
 * retained history, so a cache rewrite can drop whole sessions whose
 * transcripts are long gone. When a new export lacks a whole session the
 * committed batch had, and no transcript of that session is under the
 * source's scan roots, AIS keeps the session's messages in a segment of its
 * own and lists it in every later manifest of the partition, after the
 * export's segments. A session that the export holds again replaces its
 * retained copy. */

/** One session AIS keeps after the export stopped holding it. */
export interface RetainedSession {
  sessionId: string;
  /** Its messages, as one segment file in the partition's segment directory. */
  sha256: string;
  bytes: number;
  messages: number;
  /** When AIS first retained it. */
  retainedAt: string;
  /** The bucket timezone `hourly` was computed in (absent: local time). */
  bucketTimezone?: string;
  /** The session's part of Tokscale's hourly rollup, which daily figures read. */
  hourly: TokscaleHourlyEntry[];
  /** The session's part of the report, per client, model and provider. */
  entries: TokscaleEntry[];
}

export interface SegmentRef {
  sha256: string;
  bytes: number;
  messages: number;
}

/** A segmented manifest split into Tokscale's export and the retained sessions. */
export interface NativeManifestParts {
  exportSegments: SegmentRef[];
  /** Tokscale's digest of its own messages, which its `unchanged` answer compares. */
  exportMessagesSha256: string;
  exportHourly: TokscaleHourlyEntry[];
  retained: RetainedSession[];
}

const SHA256_RE = /^[a-f0-9]{64}$/;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const UUID_EXACT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function invalid(): Error {
  return new Error("invalid-native-batch");
}

function parseHourly(value: unknown): TokscaleHourlyEntry[] {
  if (!Array.isArray(value)) throw invalid();
  return value.map((raw) => {
    const hour = raw as Record<string, unknown> | null;
    if (!hour || typeof hour !== "object" || typeof hour.hour !== "string") throw invalid();
    return {
      hour: hour.hour, input: finite(hour.input), output: finite(hour.output), cacheRead: finite(hour.cacheRead),
      cacheWrite: finite(hour.cacheWrite), messageCount: finite(hour.messageCount), cost: finite(hour.cost),
    };
  });
}

function parseEntries(value: unknown): TokscaleEntry[] {
  if (!Array.isArray(value)) throw invalid();
  return value.map((raw) => {
    const entry = raw as Record<string, unknown> | null;
    if (!entry || typeof entry !== "object" || typeof entry.model !== "string" || typeof entry.provider !== "string" || typeof entry.client !== "string") throw invalid();
    return {
      client: entry.client, model: entry.model, provider: entry.provider, input: finite(entry.input), output: finite(entry.output),
      cacheRead: finite(entry.cacheRead), cacheWrite: finite(entry.cacheWrite), reasoning: finite(entry.reasoning),
      messageCount: finite(entry.messageCount), cost: finite(entry.cost),
    };
  });
}

/** Split a validated segmented manifest into its parts. A manifest without
 * retained sessions is all export. Throws `invalid-native-batch` when the
 * retained list does not match the manifest's trailing segments. */
export function nativeManifestParts(envelope: unknown, manifest: SegmentedNativeManifest): NativeManifestParts {
  const raw = envelope as Record<string, unknown>;
  if (raw.retainedSessions === undefined) {
    return { exportSegments: manifest.segments, exportMessagesSha256: manifest.messagesSha256, exportHourly: manifest.hourly, retained: [] };
  }
  if (!Array.isArray(raw.retainedSessions) || !Number.isSafeInteger(raw.exportSegmentCount) ||
      typeof raw.exportMessagesSha256 !== "string" || !SHA256_RE.test(raw.exportMessagesSha256)) throw invalid();
  const exportCount = raw.exportSegmentCount as number;
  if (exportCount < 0 || exportCount + raw.retainedSessions.length !== manifest.segments.length) throw invalid();
  const retained = raw.retainedSessions.map((value, index): RetainedSession => {
    const session = value as Record<string, unknown> | null;
    const segment = manifest.segments[exportCount + index]!;
    if (!session || typeof session !== "object" || typeof session.sessionId !== "string" || !session.sessionId ||
        session.sha256 !== segment.sha256 || session.bytes !== segment.bytes || session.messages !== segment.messages ||
        typeof session.retainedAt !== "string" || (session.bucketTimezone !== undefined && typeof session.bucketTimezone !== "string")) throw invalid();
    return {
      sessionId: session.sessionId, sha256: segment.sha256, bytes: segment.bytes, messages: segment.messages,
      retainedAt: session.retainedAt, ...(typeof session.bucketTimezone === "string" ? { bucketTimezone: session.bucketTimezone } : {}),
      hourly: parseHourly(session.hourly), entries: parseEntries(session.entries),
    };
  });
  return {
    exportSegments: manifest.segments.slice(0, exportCount),
    exportMessagesSha256: raw.exportMessagesSha256,
    exportHourly: parseHourly(raw.exportHourly),
    retained,
  };
}

/** Tokscale's hourly rollup plus the retained sessions' parts, hours sorted. */
export function combinedHourly(parts: Pick<NativeManifestParts, "exportHourly" | "retained">): TokscaleHourlyEntry[] {
  if (parts.retained.length === 0) return parts.exportHourly;
  const hours = new Map<string, Required<TokscaleHourlyEntry>>();
  for (const entry of [...parts.exportHourly, ...parts.retained.flatMap((session) => session.hourly)]) {
    let hour = hours.get(entry.hour);
    if (!hour) {
      hour = { hour: entry.hour, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messageCount: 0, cost: 0 };
      hours.set(entry.hour, hour);
    }
    hour.input += entry.input;
    hour.output += entry.output;
    hour.cacheRead += entry.cacheRead ?? 0;
    hour.cacheWrite += entry.cacheWrite ?? 0;
    hour.messageCount += entry.messageCount ?? 0;
    hour.cost += entry.cost ?? 0;
  }
  return [...hours.values()].sort((a, b) => (a.hour < b.hour ? -1 : a.hour > b.hour ? 1 : 0));
}

/** The manifest AIS writes for an export with retained sessions: the export's
 * segments, then one segment per retained session. `messagesSha256` names the
 * combination (the export digest and the retained segments); Tokscale's own
 * digest stays in `exportMessagesSha256`. Without retained sessions this is
 * the plain export manifest. */
export function retainedManifestJson(base: { partitionId: string; generatedAt: string }, parts: NativeManifestParts): string {
  const retainedRefs = parts.retained.map(({ sha256, bytes, messages }) => ({ sha256, bytes, messages }));
  const segments = [...parts.exportSegments, ...retainedRefs];
  const messageCount = segments.reduce((sum, segment) => sum + segment.messages, 0);
  const messagesSha256 = parts.retained.length === 0
    ? parts.exportMessagesSha256
    : createHash("sha256").update(`ais-retained-v1\0${parts.exportMessagesSha256}\0${retainedRefs.map((ref) => ref.sha256).join("\0")}`).digest("hex");
  return JSON.stringify({
    schemaVersion: 2,
    format: NATIVE_SEGMENT_FORMAT,
    partitionId: base.partitionId,
    generatedAt: base.generatedAt,
    complete: true,
    messagesSha256,
    messageCount,
    segments,
    hourly: combinedHourly(parts),
    ...(parts.retained.length === 0 ? {} : {
      exportSegmentCount: parts.exportSegments.length,
      exportMessagesSha256: parts.exportMessagesSha256,
      exportHourly: parts.exportHourly,
      retainedSessions: parts.retained,
    }),
  });
}

/** Where Tokscale v4.20.0 reads a source's transcripts. A retained session
 * must have no file or directory named after it under these. Undefined for
 * tools whose sessions AIS cannot look for (no new session is retained). */
export function nativeTranscriptRoots(toolName: ToolConfig["toolName"], identity: Pick<Identity, "configDir"> | undefined): string[] | undefined {
  if (!identity?.configDir) return undefined;
  switch (toolName) {
    case "claude": return [join(identity.configDir, "projects"), join(identity.configDir, "transcripts")];
    case "codex": return [join(identity.configDir, "sessions"), join(identity.configDir, "archived_sessions")];
    case "grok":
    case "kimi": return [join(identity.configDir, "sessions")];
    default: return undefined;
  }
}

/** The sessions among `ids` that still have a file or directory whose name
 * holds the session id under one of `roots` (Claude `<id>.jsonl` and `<id>/`,
 * Codex `rollout-...-<id>.jsonl`). A missing root holds nothing; any other
 * read error throws, so the caller retries rather than guessing. Symlinks are
 * not followed. */
export function sessionsOnDisk(roots: readonly string[], ids: ReadonlySet<string>): Set<string> {
  const found = new Set<string>();
  if (ids.size === 0) return found;
  const uuids = new Set([...ids].filter((id) => UUID_EXACT_RE.test(id)).map((id) => id.toLowerCase()));
  const others = [...ids].filter((id) => !UUID_EXACT_RE.test(id));
  const byLower = new Map([...ids].map((id) => [id.toLowerCase(), id]));
  const visit = (name: string) => {
    for (const match of name.matchAll(UUID_RE)) {
      const lower = match[0].toLowerCase();
      if (uuids.has(lower)) found.add(byLower.get(lower)!);
    }
    for (const id of others) if (name.includes(id)) found.add(id);
  };
  for (const root of roots) {
    const stack = [root];
    while (stack.length > 0) {
      const directory = stack.pop()!;
      let entries;
      try {
        entries = readdirSync(directory, { withFileTypes: true });
      } catch (error) {
        if (directory === root && (error as { code?: string }).code === "ENOENT") break;
        throw error;
      }
      for (const entry of entries) {
        visit(entry.name);
        if (entry.isDirectory()) stack.push(join(directory, entry.name));
      }
    }
  }
  return found;
}

type Message = Record<string, unknown>;

function sessionIdOf(message: Message): string | undefined {
  const id = message.session_id;
  if (typeof id !== "string" || !id) return undefined;
  // Synthetic per-day recovery rows are Tokscale's own bookkeeping, rebuilt
  // every scan: never retained.
  if (id.startsWith(LOCAL_RECOVERY_DAILY_PREFIX)) return undefined;
  return id;
}

/** A message's identity across batches: its dedup key, else its content. */
function messageKey(message: Message): string {
  return typeof message.dedup_key === "string" && message.dedup_key ? `k\0${message.dedup_key}` : `j\0${JSON.stringify(message)}`;
}

/** Read one segment file and check it against its listed size and SHA-256. */
export function readSegmentMessages(segmentDir: string, ref: SegmentRef): Message[] {
  const bytes = readFileSync(join(segmentDir, `${ref.sha256}.json`));
  if (bytes.length !== ref.bytes || createHash("sha256").update(bytes).digest("hex") !== ref.sha256) throw new Error("native-segment-mismatch");
  const messages = JSON.parse(bytes.toString("utf8")) as unknown;
  if (!Array.isArray(messages) || messages.length !== ref.messages) throw new Error("native-segment-mismatch");
  return messages.filter((message): message is Message => !!message && typeof message === "object" && !Array.isArray(message));
}

/** The report entries of a set of messages, per client, model and provider,
 * as Tokscale sums them (cache writes without the 1-hour split; message
 * counts never negative). */
export function reportEntriesFromMessages(messages: readonly Message[], fallbackClient: string): TokscaleEntry[] {
  const entries = new Map<string, TokscaleEntry>();
  for (const message of messages) {
    const client = typeof message.client === "string" && message.client ? message.client : fallbackClient;
    const model = typeof message.model_id === "string" ? message.model_id : "";
    const provider = typeof message.provider_id === "string" ? message.provider_id : "";
    const key = `${client}\0${model}\0${provider}`;
    let entry = entries.get(key);
    if (!entry) {
      entry = { client, model, provider, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, messageCount: 0, cost: 0 };
      entries.set(key, entry);
    }
    const tokens = (message.tokens && typeof message.tokens === "object" ? message.tokens : {}) as Record<string, unknown>;
    entry.input += finite(tokens.input);
    entry.output += finite(tokens.output);
    entry.cacheRead += finite(tokens.cache_read);
    entry.cacheWrite += finite(tokens.cache_write);
    entry.reasoning += finite(tokens.reasoning);
    entry.messageCount += Math.max(0, typeof message.message_count === "number" && Number.isFinite(message.message_count) ? message.message_count : 1);
    entry.cost += finite(message.cost);
  }
  return [...entries.values()];
}

/** A retained session built from its messages, with the segment bytes to store. */
export function retainedSessionFromMessages(
  sessionId: string,
  messages: readonly Message[],
  options: { tool: string; bucketTimezone?: string; now: string },
): { session: RetainedSession; body: string } {
  const body = JSON.stringify(messages);
  return {
    body,
    session: {
      sessionId,
      sha256: createHash("sha256").update(body).digest("hex"),
      bytes: Buffer.byteLength(body),
      messages: messages.length,
      retainedAt: options.now,
      ...(options.bucketTimezone ? { bucketTimezone: options.bucketTimezone } : {}),
      hourly: hourlyEntriesFromNativeMessages(messages, options.bucketTimezone),
      entries: reportEntriesFromMessages(messages, options.tool),
    },
  };
}

/** Store a retained session's segment: temporary file, then rename, 0600, the
 * way the exporter writes its own (an interrupted write leaves a temporary
 * file the segment collection sweeps). */
export function writeRetainedSegment(segmentDir: string, session: RetainedSession, body: string): void {
  const temporary = join(segmentDir, `.ais-segment-retained-${crypto.randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, body, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, join(segmentDir, `${session.sha256}.json`));
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* nothing left */ }
    throw error;
  }
}

function sortedSessions(sessions: RetainedSession[]): RetainedSession[] {
  return sessions.sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
}

export interface RetentionInput {
  segmentDir: string;
  tool: string;
  /** The committed manifest's parts. `exportReadable` is false when its export
   * segments are not all intact: then no new session is retained (its
   * messages cannot be read back), but retained sessions are still carried. */
  prior: NativeManifestParts | undefined;
  priorExportReadable: boolean;
  /** The new export's segments (already verified). */
  next: SegmentRef[];
  /** See nativeTranscriptRoots; undefined: no new session is retained. */
  transcriptRoots: readonly string[] | undefined;
  bucketTimezone?: string;
  now: string;
}

/** The retained sessions of the batch that replaces `prior`.
 *
 * Carried: every session `prior` retained, unless the new export holds a
 * message of that session again (it then counts from the export), with its
 * hourly part recomputed when the bucket timezone changed.
 *
 * Added: a session whose messages were in the prior export and none of them is
 * in the new one, whose id is not a synthetic recovery row, and which has no
 * transcript under the source's scan roots. Its messages that the new export
 * holds under another session (same dedup key) are left out. Its segment is
 * written to `segmentDir`.
 *
 * Only segments that differ between the two exports are read, so an
 * unchanged batch reads nothing, and the kept segments are read only when a
 * session would be added. Throws on a read error. */
export function retainedSessionsForExport(input: RetentionInput): RetainedSession[] {
  const prior = input.prior;
  if (!prior) return [];
  const priorShas = new Set(prior.exportSegments.map((segment) => segment.sha256));
  const nextShas = new Set(input.next.map((segment) => segment.sha256));
  const fresh = input.next.filter((segment) => !priorShas.has(segment.sha256));
  const dropped = input.priorExportReadable ? prior.exportSegments.filter((segment) => !nextShas.has(segment.sha256)) : [];
  if (prior.retained.length === 0 && dropped.length === 0) return [];

  const freshSessions = new Set<string>();
  const freshKeys = new Set<string>();
  for (const segment of fresh) {
    for (const message of readSegmentMessages(input.segmentDir, segment)) {
      const id = sessionIdOf(message);
      if (id) freshSessions.add(id);
      freshKeys.add(messageKey(message));
    }
  }

  const sameZone = (session: RetainedSession) => (session.bucketTimezone ?? "") === (input.bucketTimezone ?? "");
  const carried = prior.retained
    .filter((session) => !freshSessions.has(session.sessionId))
    .map((session) => {
      if (sameZone(session)) return session;
      const { bucketTimezone: _previousZone, ...rest } = session;
      return {
        ...rest,
        ...(input.bucketTimezone ? { bucketTimezone: input.bucketTimezone } : {}),
        hourly: hourlyEntriesFromNativeMessages(readSegmentMessages(input.segmentDir, session), input.bucketTimezone),
      };
    });
  const known = new Set(carried.map((session) => session.sessionId));

  // Messages of the prior export that the new one no longer holds, per session.
  const lost = new Map<string, Message[]>();
  for (const segment of dropped) {
    for (const message of readSegmentMessages(input.segmentDir, segment)) {
      const id = sessionIdOf(message);
      if (!id || freshSessions.has(id) || known.has(id) || freshKeys.has(messageKey(message))) continue;
      const list = lost.get(id);
      if (list) list.push(message);
      else lost.set(id, [message]);
    }
  }
  if (lost.size > 0 && input.transcriptRoots) {
    for (const id of sessionsOnDisk(input.transcriptRoots, new Set(lost.keys()))) lost.delete(id);
  } else {
    lost.clear();
  }
  if (lost.size > 0) {
    // A session with a message in a segment both exports share is still exported.
    for (const segment of input.next) {
      if (!priorShas.has(segment.sha256)) continue;
      for (const message of readSegmentMessages(input.segmentDir, segment)) {
        const id = sessionIdOf(message);
        if (id) lost.delete(id);
      }
      if (lost.size === 0) break;
    }
  }
  const added = [...lost].map(([sessionId, messages]) => {
    const { session, body } = retainedSessionFromMessages(sessionId, messages, {
      tool: input.tool, now: input.now, ...(input.bucketTimezone ? { bucketTimezone: input.bucketTimezone } : {}),
    });
    writeRetainedSegment(input.segmentDir, session, body);
    return session;
  });
  return sortedSessions([...carried, ...added]);
}

function emptyReport(): TokscaleReport {
  return { entries: [], totalInput: 0, totalOutput: 0, totalCacheRead: 0, totalCacheWrite: 0, totalMessages: 0, totalCost: 0 };
}

/** A partition's report rows with the retained sessions' usage added. Each
 * entry joins the row of its provider (a new row when the export has none)
 * and the entry of the same client and model there; totals and message
 * counts move with it. Error rows are left alone. */
export function withRetainedUsage(
  results: UsageResult[],
  retained: readonly RetainedSession[],
  tool: ToolConfig["toolName"],
  identity: UsageResult["identity"],
): UsageResult[] {
  if (retained.length === 0) return results;
  const rows = results.map((row) => ({ ...row }));
  for (const session of retained) {
    for (const raw of session.entries) {
      const provider = canonicalUsageProvider(raw.provider || providerForTool(tool));
      let row = rows.find((candidate) => candidate.provider === provider && !candidate.error && !candidate.sourceOnlyError);
      if (!row) {
        row = { provider, identity: rows[0]?.identity ?? identity, sourceTool: tool, report: emptyReport() };
        rows.push(row);
      }
      const report: TokscaleReport = row.report
        ? { ...row.report, entries: row.report.entries.map((entry) => ({ ...entry })) }
        : emptyReport();
      let entry = report.entries.find((candidate) => candidate.client === raw.client && candidate.model === raw.model &&
        canonicalUsageProvider(candidate.provider || providerForTool(tool)) === provider);
      if (!entry) {
        entry = { ...raw, provider, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, messageCount: 0, cost: 0 };
        report.entries.push(entry);
      }
      entry.input += raw.input;
      entry.output += raw.output;
      entry.cacheRead += raw.cacheRead;
      entry.cacheWrite += raw.cacheWrite;
      entry.reasoning += raw.reasoning;
      entry.messageCount += raw.messageCount;
      entry.cost += raw.cost;
      report.totalInput += raw.input;
      report.totalOutput += raw.output;
      report.totalCacheRead += raw.cacheRead;
      report.totalCacheWrite += raw.cacheWrite;
      report.totalMessages += raw.messageCount;
      report.totalCost += raw.cost;
      row.report = report;
    }
  }
  return rows;
}

export interface BatchImportPlan {
  /** Sessions to add, with the segment bytes to store. */
  sessions: Array<{ session: RetainedSession; body: string }>;
  /** Backup sessions the current batch already holds (export or retained). */
  present: number;
  /** Backup sessions that still have a transcript on disk. */
  onDisk: number;
}

/** Which sessions of an older batch (`backup`) the current batch lacks. A
 * backup session is added when no message of the current batch (export or
 * retained) belongs to it, and it has no transcript under `transcriptRoots`
 * (when given); its messages whose dedup key the current batch holds are
 * left out. Reads every segment of both batches. */
export function planBatchImport(input: {
  backupSegmentDir: string;
  backupSegments: readonly SegmentRef[];
  currentSegmentDir: string;
  currentSegments: readonly SegmentRef[];
  transcriptRoots: readonly string[] | undefined;
  tool: string;
  bucketTimezone?: string;
  now: string;
}): BatchImportPlan {
  const sessions = new Set<string>();
  const keys = new Set<string>();
  for (const segment of input.currentSegments) {
    for (const message of readSegmentMessages(input.currentSegmentDir, segment)) {
      const id = sessionIdOf(message);
      if (id) sessions.add(id);
      keys.add(messageKey(message));
    }
  }
  const missing = new Map<string, Message[]>();
  const present = new Set<string>();
  for (const segment of input.backupSegments) {
    for (const message of readSegmentMessages(input.backupSegmentDir, segment)) {
      const id = sessionIdOf(message);
      if (!id) continue;
      if (sessions.has(id)) { present.add(id); continue; }
      if (keys.has(messageKey(message))) continue;
      const list = missing.get(id);
      if (list) list.push(message);
      else missing.set(id, [message]);
    }
  }
  let onDisk = 0;
  if (input.transcriptRoots && missing.size > 0) {
    for (const id of sessionsOnDisk(input.transcriptRoots, new Set(missing.keys()))) {
      missing.delete(id);
      onDisk++;
    }
  }
  const planned = [...missing].map(([sessionId, messages]) => retainedSessionFromMessages(sessionId, messages, {
    tool: input.tool, now: input.now, ...(input.bucketTimezone ? { bucketTimezone: input.bucketTimezone } : {}),
  }));
  planned.sort((a, b) => (a.session.sessionId < b.session.sessionId ? -1 : a.session.sessionId > b.session.sessionId ? 1 : 0));
  return { sessions: planned, present: present.size, onDisk };
}

/** Merge newly retained sessions into a list, sorted by session id. */
export function mergeRetainedSessions(current: readonly RetainedSession[], added: readonly RetainedSession[]): RetainedSession[] {
  const byId = new Map(current.map((session) => [session.sessionId, session]));
  for (const session of added) if (!byId.has(session.sessionId)) byId.set(session.sessionId, session);
  return sortedSessions([...byId.values()]);
}
