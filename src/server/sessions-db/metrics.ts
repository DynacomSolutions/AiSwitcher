/**
 * Metrics of the console's database session reader (job `ais-console`), in the text exposition format of
 * `scan-metrics.ts`. Counters are process-local. The scan child that runs a read is short-lived, so it hands
 * a delta (`drain`) to the console process, which adds it (`merge`).
 */

export type ReadKind = "tree" | "transcript";
export type ReadSource = "db" | "files";
export type ReadOutcome = "ok" | "error" | "fallback";

/** Error kinds, a fixed label set. The part kinds match `PartErrorKind`. */
export const READ_ERROR_KINDS = ["store", "fetch", "missing", "decrypt", "integrity", "bad_key", "gap", "other"] as const;
export type ReadErrorKind = (typeof READ_ERROR_KINDS)[number];

/** Upper bounds (seconds) of the part fetch latency histogram. */
export const FETCH_BUCKETS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

/** What a scan child sends to the console process. Plain JSON. */
export interface ReaderMetricsDelta {
  requests: Record<string, number>;
  errors: Record<string, number>;
  parts: { fetched: number; cacheHits: number; plainBytes: number; objectBytes: number };
  fetchBuckets: number[];
  fetchSum: number;
  fetchCount: number;
}

const emptyDelta = (): ReaderMetricsDelta => ({
  requests: {},
  errors: {},
  parts: { fetched: 0, cacheHits: 0, plainBytes: 0, objectBytes: 0 },
  fetchBuckets: FETCH_BUCKETS.map(() => 0),
  fetchSum: 0,
  fetchCount: 0,
});

export class SessionsReaderMetrics {
  private d: ReaderMetricsDelta = emptyDelta();
  /** The source the console resolved at start (`ais_console_sessions_source`). */
  private chosen: ReadSource | undefined;
  private lastErrorSeconds: number | undefined;

  request(kind: ReadKind, source: ReadSource, outcome: ReadOutcome): void {
    const k = `${kind}|${source}|${outcome}`;
    this.d.requests[k] = (this.d.requests[k] ?? 0) + 1;
  }

  error(kind: ReadErrorKind): void {
    const k = (READ_ERROR_KINDS as readonly string[]).includes(kind) ? kind : "other";
    this.d.errors[k] = (this.d.errors[k] ?? 0) + 1;
    this.lastErrorSeconds = Math.floor(Date.now() / 1000);
  }

  partFetched(seconds: number, plainBytes: number, objectBytes: number): void {
    this.d.parts.fetched += 1;
    this.d.parts.plainBytes += plainBytes;
    this.d.parts.objectBytes += objectBytes;
    this.d.fetchCount += 1;
    this.d.fetchSum += seconds;
    // Cumulative buckets are made at render time: count each sample in its own bucket here.
    const i = FETCH_BUCKETS.findIndex((b) => seconds <= b);
    if (i !== -1) this.d.fetchBuckets[i] = (this.d.fetchBuckets[i] ?? 0) + 1;
  }

  cacheHit(): void {
    this.d.parts.cacheHits += 1;
  }

  /** The source the console uses. Set once at start. */
  source(source: ReadSource): void {
    this.chosen = source;
  }

  chosenSource(): ReadSource | undefined {
    return this.chosen;
  }

  /** Takes the counters since the last drain, and resets them. A scan child sends this to the console process. */
  drain(): ReaderMetricsDelta {
    const out = this.d;
    this.d = emptyDelta();
    return out;
  }

  /** Adds a delta from a scan child. A malformed delta is ignored. */
  merge(delta: unknown): void {
    if (!delta || typeof delta !== "object") return;
    const x = delta as Partial<ReaderMetricsDelta>;
    const add = (into: Record<string, number>, from: unknown): void => {
      if (!from || typeof from !== "object") return;
      for (const [k, v] of Object.entries(from as Record<string, unknown>)) {
        if (typeof v === "number" && Number.isFinite(v) && v >= 0) into[k] = (into[k] ?? 0) + v;
      }
    };
    add(this.d.requests, x.requests);
    add(this.d.errors, x.errors);
    const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
    if (x.errors && Object.keys(x.errors).length > 0) this.lastErrorSeconds = Math.floor(Date.now() / 1000);
    if (x.parts) {
      this.d.parts.fetched += num(x.parts.fetched);
      this.d.parts.cacheHits += num(x.parts.cacheHits);
      this.d.parts.plainBytes += num(x.parts.plainBytes);
      this.d.parts.objectBytes += num(x.parts.objectBytes);
    }
    if (Array.isArray(x.fetchBuckets)) {
      FETCH_BUCKETS.forEach((_, i) => {
        this.d.fetchBuckets[i] = (this.d.fetchBuckets[i] ?? 0) + num(x.fetchBuckets![i]);
      });
    }
    this.d.fetchSum += num(x.fetchSum);
    this.d.fetchCount += num(x.fetchCount);
  }

  /** Exposition text. Empty label sets are written with zero so the series exist from the start. */
  render(): string[] {
    const out: string[] = [];
    out.push(
      "# HELP ais_console_sessions_source 1 for the source the console Sessions page reads (db or files).",
      "# TYPE ais_console_sessions_source gauge",
    );
    for (const s of ["db", "files"] as const) out.push(`ais_console_sessions_source{source="${s}"} ${this.chosen === s ? 1 : 0}`);

    out.push(
      "# HELP ais_console_sessions_read_requests_total Sessions page reads by kind, source and outcome (fallback: the database failed or lacked the session and the files answered).",
      "# TYPE ais_console_sessions_read_requests_total counter",
    );
    const reqKeys = new Set<string>(Object.keys(this.d.requests));
    for (const kind of ["tree", "transcript"]) for (const source of ["db", "files"]) reqKeys.add(`${kind}|${source}|ok`);
    for (const k of [...reqKeys].sort()) {
      const [kind, source, outcome] = k.split("|");
      out.push(`ais_console_sessions_read_requests_total{kind="${kind}",source="${source}",outcome="${outcome}"} ${this.d.requests[k] ?? 0}`);
    }

    out.push(
      "# HELP ais_console_sessions_read_errors_total Errors of the database session reader by kind.",
      "# TYPE ais_console_sessions_read_errors_total counter",
      ...READ_ERROR_KINDS.map((k) => `ais_console_sessions_read_errors_total{kind="${k}"} ${this.d.errors[k] ?? 0}`),
    );

    out.push(
      "# HELP ais_console_sessions_parts_total Parts the reader used: fetched from object storage, or served from the part cache.",
      "# TYPE ais_console_sessions_parts_total counter",
      `ais_console_sessions_parts_total{source="fetch"} ${this.d.parts.fetched}`,
      `ais_console_sessions_parts_total{source="cache"} ${this.d.parts.cacheHits}`,
      "# HELP ais_console_sessions_part_bytes_total Bytes of fetched parts, plain (after decrypt and gunzip) and object (as stored).",
      "# TYPE ais_console_sessions_part_bytes_total counter",
      `ais_console_sessions_part_bytes_total{kind="plain"} ${this.d.parts.plainBytes}`,
      `ais_console_sessions_part_bytes_total{kind="object"} ${this.d.parts.objectBytes}`,
    );

    out.push(
      "# HELP ais_console_sessions_part_fetch_seconds Time to fetch, decrypt and check one part.",
      "# TYPE ais_console_sessions_part_fetch_seconds histogram",
    );
    let cumulative = 0;
    FETCH_BUCKETS.forEach((b, i) => {
      cumulative += this.d.fetchBuckets[i] ?? 0;
      out.push(`ais_console_sessions_part_fetch_seconds_bucket{le="${b}"} ${cumulative}`);
    });
    out.push(
      `ais_console_sessions_part_fetch_seconds_bucket{le="+Inf"} ${this.d.fetchCount}`,
      `ais_console_sessions_part_fetch_seconds_sum ${this.d.fetchSum}`,
      `ais_console_sessions_part_fetch_seconds_count ${this.d.fetchCount}`,
    );
    if (this.lastErrorSeconds !== undefined) {
      out.push(
        "# HELP ais_console_sessions_read_last_error_timestamp_seconds Unix time of the last database reader error.",
        "# TYPE ais_console_sessions_read_last_error_timestamp_seconds gauge",
        `ais_console_sessions_read_last_error_timestamp_seconds ${this.lastErrorSeconds}`,
      );
    }
    return out;
  }
}

/** The process-wide registry. The console renders it at `/metrics`. */
export const sessionsReaderMetrics = new SessionsReaderMetrics();
