import { advanceSessionIndex, IndexOffsetError, isUsableIndexState, type IndexedKind, type SessionIndexState } from "../../cli/sessions/indexer.ts";
import { linesOfText } from "../../cli/sessions/lines.ts";
import { decodePart, PartReadError, type PartSource } from "./part-reader.ts";
import type { EnrichBacklog, EnrichCandidate, EnrichWrite, SessionPartRow } from "./session-store.ts";

/**
 * The enrichment loop. It runs on the gateway leader only. Each pass takes the files whose parts are newer than their
 * index state, reads the new parts from object storage (fetch, age decrypt, gunzip), feeds the lines to the incremental
 * indexer and writes the fields and the new state back in one statement per file.
 *
 * Safe to stop at any point: a file's state moves only with that write, so a crash means the next pass reads the same
 * parts again. Safe against a second runner (a leader change): the write only lands while `indexed_bytes` is still what
 * this pass read, so the slower runner changes nothing.
 */

/** The part of `SessionStore` the loop needs. A test gives a fake. */
export interface EnrichStore {
  enrichQueue(limit: number, skipIds?: number[]): Promise<EnrichCandidate[]>;
  enrichBacklog(): Promise<EnrichBacklog>;
  partsFrom(fileId: number, fromOffset: number, maxBytes: number): Promise<SessionPartRow[]>;
  applyEnrichment(w: EnrichWrite): Promise<boolean>;
  markIndexed(fileId: number, expectedIndexedBytes: number): Promise<boolean>;
}

/** Error kinds, a fixed label set. */
export const ENRICH_ERROR_KINDS = ["store", "fetch", "missing", "decrypt", "integrity", "bad_key", "gap", "index", "other"] as const;
export type EnrichErrorKind = (typeof ENRICH_ERROR_KINDS)[number];

export interface EnrichMetrics {
  /** One file moved forward. `plainBytes` and `objectBytes` count the parts read for it. */
  fileEnriched(plainBytes: number, objectBytes: number, parts: number): void;
  error(kind: EnrichErrorKind): void;
  /** A pass finished without a store error (even with nothing to do). `atMs` is the time. */
  success(atMs: number): void;
  backlog(b: EnrichBacklog, nowMs: number): void;
  leader(isLeader: boolean): void;
}

export interface EnricherOptions {
  store: EnrichStore;
  source: PartSource;
  /** The private age identity. */
  identity: string;
  /** True on the leader. Without it every pass does nothing. */
  isLeader: () => boolean;
  metrics?: EnrichMetrics;
  /** Files per pass (default 50). */
  batchFiles?: number;
  /** Plain bytes read per file per pass (default 16 MiB). A larger file takes several passes. */
  maxBytesPerFile?: number;
  /** Plain bytes read per pass over all files (default 128 MiB). */
  maxBytesPerPass?: number;
  /** Files read at the same time (default 2). */
  concurrency?: number;
  /** Pause between passes while idle (default 5 s). */
  intervalMs?: number;
  /** First back-off after an error, for a file and for the loop (default 30 s and 5 s). Doubles each time. */
  fileBackoffMs?: number;
  loopBackoffMs?: number;
  /** Back-off ceilings (default 30 minutes for a file, 5 minutes for the loop). */
  fileBackoffMaxMs?: number;
  loopBackoffMaxMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

export interface EnrichPassResult {
  /** False on a replica that is not the leader. */
  ran: boolean;
  /** Files that moved forward. */
  enriched: number;
  errors: number;
  /** Plain bytes read. */
  bytes: number;
  /** True when the queue may hold more work right now. */
  more: boolean;
}

const MIB = 1024 * 1024;
const NOT_RAN: EnrichPassResult = { ran: false, enriched: 0, errors: 0, bytes: 0, more: false };

const isIndexedKind = (k: string): k is IndexedKind => k === "claude" || k === "codex";
/** Files that hold no transcript lines: the Codex thread name list is read by another step. */
const isSidecar = (relPath: string): boolean => (relPath.split("/").pop() ?? relPath) === "session_index.jsonl";

class GapError extends Error {}

function classify(err: unknown): EnrichErrorKind {
  if (err instanceof PartReadError) return err.kind;
  if (err instanceof GapError) return "gap";
  if (err instanceof IndexOffsetError) return "index";
  return "other";
}

export class SessionEnricher {
  private readonly o: Required<Omit<EnricherOptions, "metrics" | "log">> & Pick<EnricherOptions, "metrics" | "log">;
  private readonly failing = new Map<number, { until: number; count: number }>();
  private loopFailures = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<unknown> | undefined;
  private stopped = true;
  /** Set by stop(): a pass in flight starts no new file. */
  private stopping = false;

  constructor(opts: EnricherOptions) {
    this.o = {
      batchFiles: 50,
      maxBytesPerFile: 16 * MIB,
      maxBytesPerPass: 128 * MIB,
      concurrency: 2,
      intervalMs: 5_000,
      fileBackoffMs: 30_000,
      loopBackoffMs: 5_000,
      fileBackoffMaxMs: 30 * 60_000,
      loopBackoffMaxMs: 5 * 60_000,
      now: Date.now,
      ...opts,
    };
  }

  /** Files that sit out the next passes after an error (their ids). */
  backedOff(): number[] {
    const now = this.o.now();
    return [...this.failing].filter(([, f]) => f.until > now).map(([id]) => id);
  }

  /** One pass. Never throws: a store error counts as an error and backs the loop off. */
  async runOnce(): Promise<EnrichPassResult> {
    const { store, metrics } = this.o;
    const leader = this.o.isLeader();
    metrics?.leader(leader);
    if (!leader) return NOT_RAN;
    let queue: EnrichCandidate[];
    try {
      queue = await store.enrichQueue(this.o.batchFiles, this.backedOff());
    } catch {
      return this.loopError();
    }
    const result: EnrichPassResult = { ran: true, enriched: 0, errors: 0, bytes: 0, more: false };
    let budget = this.o.maxBytesPerPass;
    let next = 0;
    let outage = false;
    const worker = async (): Promise<void> => {
      while (next < queue.length && budget > 0 && !this.stopping) {
        const file = queue[next++]!;
        try {
          const read = await this.enrichFile(file);
          budget -= read.bytes;
          result.bytes += read.bytes;
          if (read.moved) result.enriched += 1;
          if (read.moved) this.failing.delete(file.fileId);
          if (read.partial) result.more = true;
          if (read.error) {
            result.errors += 1;
            this.fail(file.fileId, read.error);
          }
        } catch (err) {
          const kind = classify(err);
          result.errors += 1;
          this.fail(file.fileId, kind);
          if (kind === "other" || kind === "fetch") outage = true;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, this.o.concurrency) }, worker));
    if (next < queue.length) result.more = true;
    if (queue.length >= this.o.batchFiles) result.more = true;
    // A pass in which nothing moved and storage or the database failed backs the whole loop off, not just the files.
    this.loopFailures = outage && result.enriched === 0 ? this.loopFailures + 1 : 0;
    try {
      metrics?.backlog(await store.enrichBacklog(), this.o.now());
      metrics?.success(this.o.now());
    } catch {
      metrics?.error("store");
    }
    return result;
  }

  private loopError(): EnrichPassResult {
    this.o.metrics?.error("store");
    this.loopFailures += 1;
    return { ran: true, enriched: 0, errors: 1, bytes: 0, more: false };
  }

  private fail(fileId: number, kind: EnrichErrorKind): void {
    this.o.metrics?.error(kind);
    const count = (this.failing.get(fileId)?.count ?? 0) + 1;
    const delay = Math.min(this.o.fileBackoffMs * 2 ** (count - 1), this.o.fileBackoffMaxMs);
    this.failing.set(fileId, { until: this.o.now() + delay, count });
    this.o.log?.(`sessions enrich: file ${fileId} failed (${kind}); retry in ${Math.round(delay / 1000)} s`);
  }

  private async enrichFile(c: EnrichCandidate): Promise<{ bytes: number; moved: boolean; partial: boolean; error?: EnrichErrorKind }> {
    const { store, source, identity, metrics } = this.o;
    if (isSidecar(c.relPath) || !isIndexedKind(c.kind)) {
      await store.markIndexed(c.fileId, c.indexedBytes);
      return { bytes: 0, moved: false, partial: false };
    }
    // Continue only from a state this code understands and that matches `indexed_bytes`. Anything else reads again from byte 0.
    const stored = c.scanState;
    const prev: SessionIndexState | null = isUsableIndexState(stored, c.kind, c.relPath) && stored.bytes === c.indexedBytes ? stored : null;
    let covered = prev ? prev.bytes : 0;
    const parts = await store.partsFrom(c.fileId, covered, this.o.maxBytesPerFile);
    if (parts.length === 0 || parts[0]!.startOffset !== covered) throw new GapError(`no part starts at byte ${covered}`);

    let state = prev;
    let fields = null as ReturnType<typeof advanceSessionIndex>["fields"] | null;
    let plain = 0;
    let object = 0;
    let used = 0;
    let gap = false;
    for (const part of parts) {
      if (part.startOffset !== covered) {
        gap = true;
        break;
      }
      const stored = await source.read(part.objectKey);
      const text = await decodePart(stored, part, identity);
      const step = advanceSessionIndex(c.kind, state, { startOffset: part.startOffset, endOffset: part.endOffset, lines: linesOfText(text) }, c.relPath);
      state = step.state;
      fields = step.fields;
      covered = part.endOffset;
      plain += part.plainBytes;
      object += part.objectBytes;
      used += 1;
    }
    if (!fields || !state) throw new GapError("no readable part");
    const wrote = await store.applyEnrichment({ fileId: c.fileId, expectedIndexedBytes: c.indexedBytes, fields, state });
    if (!wrote) return { bytes: plain, moved: false, partial: false };
    metrics?.fileEnriched(plain, object, used);
    // The file has more to read when it has bytes left, or when a part gap stopped the read (then the gap is the error).
    return { bytes: plain, moved: true, partial: covered < c.committedBytes && !gap, ...(gap ? { error: "gap" as const } : {}) };
  }

  /** Starts the loop. A pass that finds more work runs again at once, an idle or failing loop waits. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.stopping = false;
    const loop = async (): Promise<void> => {
      let delay = this.o.intervalMs;
      try {
        const r = await (this.running = this.runOnce());
        delay = r.ran && r.more && this.loopFailures === 0 ? 100 : this.o.intervalMs;
      } catch {
        this.loopFailures += 1;
      }
      if (this.loopFailures > 0) delay = Math.min(this.o.loopBackoffMs * 2 ** (this.loopFailures - 1), this.o.loopBackoffMaxMs);
      this.running = undefined;
      if (this.stopped) return;
      this.timer = setTimeout(() => void loop(), delay);
      this.timer.unref?.();
    };
    this.timer = setTimeout(() => void loop(), 0);
    this.timer.unref?.();
  }

  /** Stops the loop. A pass in flight ends first (no new file starts). */
  async stop(): Promise<void> {
    this.stopped = true;
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await Promise.allSettled([this.running]);
  }

  /** Current loop back-off step (0 when healthy). */
  get loopFailureCount(): number {
    return this.loopFailures;
  }
}
