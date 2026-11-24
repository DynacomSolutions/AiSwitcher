import { linesOfText } from "../../cli/sessions/lines.ts";
import { decodePart, PartReadError, type PartSource } from "../../gateway/sessions/part-reader.ts";
import type { SessionPartRow } from "../../gateway/sessions/session-store.ts";
import type { ReadErrorKind, SessionsReaderMetrics } from "./metrics.ts";
import type { PartCache } from "./part-cache.ts";

/** A read that cannot give correct text. The page shows an error, never partial or wrong text. */
export class SessionsReadError extends Error {
  constructor(
    readonly kind: ReadErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "SessionsReadError";
  }
}

/** The error kind of anything a read can throw, for the metrics. */
export function readErrorKind(err: unknown): ReadErrorKind {
  if (err instanceof SessionsReadError) return err.kind;
  if (err instanceof PartReadError) return err.kind;
  return "other";
}

export interface PartLoaderDeps {
  source: PartSource;
  /** The private age identity. */
  identity: string;
  cache: PartCache;
  metrics: SessionsReaderMetrics;
  /** Test seam for the clock (ms). */
  now?: () => number;
}

/**
 * Turns part rows into the lines of the session text: fetch, age decrypt, gunzip, check length and SHA-256 against the
 * row, split into lines. Memory holds one part at a time (plus the cache), never the whole session. The parts must be
 * in byte order and contiguous. A part that fails any check throws, so a reader never sees wrong text.
 */
export class PartLoader {
  constructor(private readonly deps: PartLoaderDeps) {}

  /** One checked part as text. A hit in the cache skips the fetch. */
  async text(part: SessionPartRow): Promise<string> {
    const key = `${part.objectKey}|${part.plainSha256}`;
    const hit = this.deps.cache.get(key);
    if (hit !== undefined) {
      this.deps.metrics.cacheHit();
      return hit;
    }
    const now = this.deps.now ?? Date.now;
    const t0 = now();
    const stored = await this.deps.source.read(part.objectKey);
    const text = await decodePart(stored, part, this.deps.identity);
    this.deps.metrics.partFetched(Math.max(0, now() - t0) / 1000, part.plainBytes, stored.byteLength);
    this.deps.cache.set(key, text, part.plainBytes);
    return text;
  }

  /**
   * The lines of the parts in order. A part ends on a line end, so each part gives whole lines. If one does not (a
   * torn last line), the partial line joins the next part, so a line is never cut in two.
   */
  async *lines(parts: readonly SessionPartRow[]): AsyncGenerator<string, void, undefined> {
    let carry = "";
    let expected: number | undefined;
    for (const part of parts) {
      if (expected !== undefined && part.startOffset !== expected) {
        throw new SessionsReadError("gap", "the stored parts are not contiguous");
      }
      expected = part.endOffset;
      let text = await this.text(part);
      if (carry !== "") {
        text = carry + text;
        carry = "";
      }
      const endsOnLine = text.endsWith("\n");
      let pending: string | undefined;
      for (const line of linesOfText(text)) {
        if (pending !== undefined) yield pending;
        pending = line;
      }
      if (pending !== undefined) {
        if (endsOnLine) yield pending;
        else carry = pending;
      }
      // Let the event loop run between parts, as the file adapter does between chunks.
      await Bun.sleep(0);
    }
    if (carry !== "") yield carry;
  }
}
