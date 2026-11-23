import { ENRICH_ERROR_KINDS, type EnrichErrorKind, type EnrichMetrics } from "./enrich.ts";
import type { EnrichBacklog } from "./session-store.ts";

/**
 * Prometheus text for the enrichment loop (job `ais-gateway`). Every replica exposes the counters. Only the leader sets
 * the backlog gauges, so a query takes the maximum over the replicas for them.
 */
export class SessionsEnrichMetrics implements EnrichMetrics {
  private files = 0;
  private parts = 0;
  private plainBytes = 0;
  private objectBytes = 0;
  private readonly errors = new Map<EnrichErrorKind, number>(ENRICH_ERROR_KINDS.map((k) => [k, 0]));
  private lastSuccessSeconds: number | undefined;
  private backlogSample: { files: number; bytes: number; lagSeconds: number } | undefined;
  private isLeader = 0;

  fileEnriched(plainBytes: number, objectBytes: number, parts: number): void {
    this.files += 1;
    this.parts += parts;
    this.plainBytes += plainBytes;
    this.objectBytes += objectBytes;
  }

  error(kind: EnrichErrorKind): void {
    const k = this.errors.has(kind) ? kind : "other";
    this.errors.set(k, (this.errors.get(k) ?? 0) + 1);
  }

  success(atMs: number): void {
    this.lastSuccessSeconds = Math.floor(atMs / 1000);
  }

  backlog(b: EnrichBacklog, nowMs: number): void {
    this.backlogSample = { files: b.files, bytes: b.bytes, lagSeconds: b.oldestIngestAt === null ? 0 : Math.max(0, (nowMs - b.oldestIngestAt) / 1000) };
  }

  leader(isLeader: boolean): void {
    this.isLeader = isLeader ? 1 : 0;
    // A replica that lost leadership must not keep reporting an old backlog.
    if (!isLeader) this.backlogSample = undefined;
  }

  render(): string[] {
    const out: string[] = [
      "# HELP ais_sessions_enrich_leader 1 on the replica that runs the session enrichment loop.",
      "# TYPE ais_sessions_enrich_leader gauge",
      `ais_sessions_enrich_leader ${this.isLeader}`,
      "# HELP ais_sessions_files_enriched_total Session files that the enrichment moved forward.",
      "# TYPE ais_sessions_files_enriched_total counter",
      `ais_sessions_files_enriched_total ${this.files}`,
      "# HELP ais_sessions_enrich_parts_total Session parts the enrichment read.",
      "# TYPE ais_sessions_enrich_parts_total counter",
      `ais_sessions_enrich_parts_total ${this.parts}`,
      "# HELP ais_sessions_enrich_bytes_total Bytes the enrichment read, plain (after decrypt and gunzip) and object (as stored).",
      "# TYPE ais_sessions_enrich_bytes_total counter",
      `ais_sessions_enrich_bytes_total{kind="plain"} ${this.plainBytes}`,
      `ais_sessions_enrich_bytes_total{kind="object"} ${this.objectBytes}`,
      "# HELP ais_sessions_indexer_errors_total Enrichment errors by kind.",
      "# TYPE ais_sessions_indexer_errors_total counter",
      ...[...this.errors].map(([k, n]) => `ais_sessions_indexer_errors_total{kind="${k}"} ${n}`),
    ];
    if (this.lastSuccessSeconds !== undefined) {
      out.push(
        "# HELP ais_sessions_indexer_last_success_timestamp_seconds Unix time of the last enrichment pass that reached the database.",
        "# TYPE ais_sessions_indexer_last_success_timestamp_seconds gauge",
        `ais_sessions_indexer_last_success_timestamp_seconds ${this.lastSuccessSeconds}`,
      );
    }
    if (this.backlogSample) {
      out.push(
        "# HELP ais_sessions_unindexed_files Session files with bytes the enrichment has not read (leader only).",
        "# TYPE ais_sessions_unindexed_files gauge",
        `ais_sessions_unindexed_files ${this.backlogSample.files}`,
        "# HELP ais_sessions_unindexed_bytes Stored bytes the enrichment has not read yet (leader only).",
        "# TYPE ais_sessions_unindexed_bytes gauge",
        `ais_sessions_unindexed_bytes ${this.backlogSample.bytes}`,
        "# HELP ais_sessions_enrich_lag_seconds Age of the oldest ingest the enrichment has not read yet, 0 when none (leader only).",
        "# TYPE ais_sessions_enrich_lag_seconds gauge",
        `ais_sessions_enrich_lag_seconds ${this.backlogSample.lagSeconds}`,
      );
    }
    return out;
  }
}
