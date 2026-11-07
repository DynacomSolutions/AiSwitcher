import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { TokscaleHourlyEntry } from "./tokscale.ts";

/** Segmented native batches (vendor/tokscale README, `TOKSCALE_AIS_SEGMENT_DIR`).
 * The exporter cuts the `messages` array into contiguous, content-defined
 * segments named by their SHA-256 and writes a small manifest listing them in
 * order. A changed cycle writes only segments that are new, and AIS reads only
 * those: a segment it verified before is trusted while its file keeps the size
 * and mtime recorded then. */
export const NATIVE_SEGMENT_FORMAT = "ais-segmented-v1";

/** One verified segment as the snapshot records it. */
export interface NativeSegmentRecord {
  sha256: string;
  bytes: number;
  messages: number;
  /** mtime (ns), ctime (ns) and inode of the file when AIS verified it.
   * ctime cannot be set back, and the exporter's rename gives a new inode, so
   * damage whose size and mtime were restored still breaks the match. */
  mtimeNs: string;
  ctimeNs: string;
  ino: string;
}

export interface SegmentedNativeManifest {
  generatedAt: string;
  messagesSha256: string;
  segments: Array<{ sha256: string; bytes: number; messages: number }>;
  /** Tokscale's own hourly rollup of the messages (in its bucket timezone). */
  hourly: TokscaleHourlyEntry[];
}

const SHA256_RE = /^[a-f0-9]{64}$/;
const SEGMENT_FILE_RE = /^[a-f0-9]{64}\.json$/;
/** Leftover temporary files of a killed exporter. */
const SEGMENT_TEMP_RE = /^\.ais-segment-.*\.tmp$/;
const SEGMENT_TEMP_MAX_AGE_MS = 2 * 60 * 60_000;

export function nativeSegmentDir(nativeRoot: string, partitionId: string): string {
  return join(nativeRoot, partitionId, "segments");
}

export function isSegmentedNativeEnvelope(value: unknown): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).schemaVersion === 2;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Validate a segmented manifest envelope; throws `invalid-native-batch`. */
export function parseSegmentedNativeManifest(value: unknown, partitionId: string): SegmentedNativeManifest {
  const envelope = value as Record<string, unknown> | null;
  const invalid = () => new Error("invalid-native-batch");
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) || envelope.schemaVersion !== 2 ||
      envelope.format !== NATIVE_SEGMENT_FORMAT || envelope.partitionId !== partitionId || envelope.complete !== true ||
      typeof envelope.generatedAt !== "string" || !Number.isFinite(Date.parse(envelope.generatedAt)) ||
      typeof envelope.messagesSha256 !== "string" || !SHA256_RE.test(envelope.messagesSha256) ||
      !nonNegativeInteger(envelope.messageCount) || !Array.isArray(envelope.segments) || !Array.isArray(envelope.hourly)) {
    throw invalid();
  }
  let total = 0;
  const segments = envelope.segments.map((raw) => {
    const segment = raw as Record<string, unknown> | null;
    if (!segment || typeof segment !== "object" || typeof segment.sha256 !== "string" || !SHA256_RE.test(segment.sha256) ||
        !nonNegativeInteger(segment.bytes) || segment.bytes < 2 || !nonNegativeInteger(segment.messages) || segment.messages < 1) {
      throw invalid();
    }
    total += segment.messages;
    return { sha256: segment.sha256, bytes: segment.bytes, messages: segment.messages };
  });
  if (total !== envelope.messageCount) throw invalid();
  const hourly = envelope.hourly.map((raw) => {
    const hour = raw as Record<string, unknown> | null;
    if (!hour || typeof hour !== "object" || typeof hour.hour !== "string") throw invalid();
    const number = (field: unknown) => (typeof field === "number" && Number.isFinite(field) ? field : 0);
    return {
      hour: hour.hour, input: number(hour.input), output: number(hour.output), cacheRead: number(hour.cacheRead),
      cacheWrite: number(hour.cacheWrite), messageCount: number(hour.messageCount), cost: number(hour.cost),
    };
  });
  return { generatedAt: envelope.generatedAt, messagesSha256: envelope.messagesSha256, segments, hourly };
}

function segmentPath(segmentDir: string, sha256: string): string {
  return join(segmentDir, `${sha256}.json`);
}

/** Whether a recorded segment's file still has the size and mtime it had when
 * AIS verified it. */
function segmentRecordIntact(segmentDir: string, record: NativeSegmentRecord): boolean {
  try {
    const info = statSync(segmentPath(segmentDir, record.sha256), { bigint: true });
    return info.isFile() && info.size === BigInt(record.bytes) && String(info.mtimeNs) === record.mtimeNs &&
      String(info.ctimeNs) === record.ctimeNs && String(info.ino) === record.ino;
  } catch {
    return false;
  }
}

/** Every recorded segment is still the file AIS verified. One damaged or
 * missing segment makes the whole batch not intact, so the next export
 * rewrites every segment (a full rebuild) and is never offered "unchanged". */
export function nativeSegmentsIntact(segmentDir: string, records: readonly NativeSegmentRecord[]): boolean {
  return records.every((record) => segmentRecordIntact(segmentDir, record));
}

export interface SegmentVerification {
  records: NativeSegmentRecord[];
  /** Segment bytes read and hashed (the reused ones are only stat'ed). */
  bytesRead: number;
}

/** Verify the segments a manifest lists. A segment recorded for the previous
 * batch whose file is unchanged since is reused after a stat; any other is
 * read and must match its listed size, SHA-256 and message count, and parse
 * as an array of message objects. Throws `native-segment-mismatch`. */
export function verifyNativeSegments(
  manifest: SegmentedNativeManifest,
  segmentDir: string,
  prior: readonly NativeSegmentRecord[] | undefined,
): SegmentVerification {
  const trusted = new Map((prior ?? []).map((record) => [record.sha256, record]));
  const verified = new Map<string, NativeSegmentRecord>();
  let bytesRead = 0;
  const records = manifest.segments.map((segment) => {
    const known = verified.get(segment.sha256);
    if (known) return known;
    const previous = trusted.get(segment.sha256);
    if (previous && previous.bytes === segment.bytes && previous.messages === segment.messages && segmentRecordIntact(segmentDir, previous)) {
      verified.set(segment.sha256, previous);
      return previous;
    }
    const fd = openSync(segmentPath(segmentDir, segment.sha256), "r");
    let bytes: Buffer;
    let stamp: Pick<NativeSegmentRecord, "mtimeNs" | "ctimeNs" | "ino">;
    try {
      const info = fstatSync(fd, { bigint: true });
      if (!info.isFile() || info.size !== BigInt(segment.bytes)) throw new Error("native-segment-mismatch");
      stamp = { mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs), ino: String(info.ino) };
      bytes = readFileSync(fd);
    } finally {
      closeSync(fd);
    }
    bytesRead += bytes.length;
    if (bytes.length !== segment.bytes || createHash("sha256").update(bytes).digest("hex") !== segment.sha256) {
      throw new Error("native-segment-mismatch");
    }
    const messages = JSON.parse(bytes.toString("utf8")) as unknown;
    if (!Array.isArray(messages) || messages.length !== segment.messages ||
        !messages.every((message) => message !== null && typeof message === "object" && !Array.isArray(message))) {
      throw new Error("native-segment-mismatch");
    }
    const record = { ...segment, ...stamp };
    verified.set(segment.sha256, record);
    return record;
  });
  return { records, bytesRead };
}

/** The list the exporter may leave unwritten: the previous batch's segments,
 * all verified intact by the caller. */
export function writeReusableSegmentList(path: string, records: readonly NativeSegmentRecord[]): void {
  writeFileSync(path, records.map((record) => record.sha256).join("\n"), { mode: 0o600 });
}

/** Whether a batch file is a segmented manifest, from its first bytes (a
 * single-file batch can be hundreds of MB, so it is never read whole here). */
function batchFileKind(path: string): "segmented" | "single" | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const head = Buffer.alloc(24);
    const read = readSync(fd, head, 0, head.length, 0);
    const text = head.subarray(0, read).toString("utf8");
    if (text.startsWith("{\"schemaVersion\":2,")) return "segmented";
    if (text.startsWith("{\"schemaVersion\":1,")) return "single";
    return undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Segment names per manifest file, keyed by path, size and mtime: collection
 * runs on every snapshot write, and a manifest is immutable once promoted. */
const manifestSegmentCache = new Map<string, { stamp: string; names: string[] }>();

function manifestSegmentNames(batch: string): string[] | undefined {
  try {
    const info = statSync(batch, { bigint: true });
    const stamp = `${info.size}:${info.mtimeNs}:${info.ino}`;
    const cached = manifestSegmentCache.get(batch);
    if (cached?.stamp === stamp) return cached.names;
    const value = JSON.parse(readFileSync(batch, "utf8")) as { segments?: unknown };
    if (!Array.isArray(value.segments)) return undefined;
    const names: string[] = [];
    for (const segment of value.segments) {
      const sha = (segment as { sha256?: unknown } | null)?.sha256;
      if (typeof sha !== "string" || !SHA256_RE.test(sha)) return undefined;
      names.push(sha);
    }
    if (manifestSegmentCache.size > 256) manifestSegmentCache.clear();
    manifestSegmentCache.set(batch, { stamp, names });
    return names;
  } catch {
    return undefined;
  }
}

/** Remove a partition's segments that no kept batch names. `keptBatches` are
 * the batch files the caller keeps (manifest-listed, the latest generations
 * and those inside the reader grace period); their segments stay, and so does
 * any segment younger than `ageFloorMs`, which covers an export in flight and
 * a reader of a just-replaced manifest. If a kept batch cannot be classified
 * or parsed, nothing is removed. Never throws; returns the number removed. */
export function collectObsoleteNativeSegments(
  partitionDir: string,
  keptBatches: readonly string[],
  nowMs: number,
  ageFloorMs: number,
): number {
  const segmentDir = join(partitionDir, "segments");
  let names: string[];
  try { names = readdirSync(segmentDir); } catch { return 0; }
  const referenced = new Set<string>();
  for (const batch of keptBatches) {
    const kind = batchFileKind(batch);
    if (kind === "single") continue;
    if (kind === undefined) {
      // A kept batch that has vanished names nothing; any other doubt keeps everything.
      try { lstatSync(batch); } catch (error) { if ((error as { code?: string }).code === "ENOENT") continue; }
      return 0;
    }
    const names = manifestSegmentNames(batch);
    if (!names) return 0;
    for (const name of names) referenced.add(name);
  }
  let removed = 0;
  for (const name of names) {
    const isSegment = SEGMENT_FILE_RE.test(name);
    if (!isSegment && !SEGMENT_TEMP_RE.test(name)) continue;
    if (isSegment && referenced.has(name.slice(0, 64))) continue;
    const path = join(segmentDir, name);
    try {
      const info = lstatSync(path);
      if (!info.isFile() || nowMs - info.mtimeMs < (isSegment ? ageFloorMs : SEGMENT_TEMP_MAX_AGE_MS)) continue;
      rmSync(path, { force: true });
      removed++;
    } catch { /* retried on the next collection */ }
  }
  return removed;
}
