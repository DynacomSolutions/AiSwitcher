import { readUsageSnapshotMetricsStatus } from "../cli/usage/snapshot-status.ts";

/** Small process-local metrics for the bounded scan worker pool. */
const state = { active: 0, queued: 0, timeouts: 0, cleanupFailures: 0, forcedKills: 0 };

export function scanMetric(name: keyof typeof state, delta = 1): void {
  state[name] += delta;
}

export function renderScanMetrics(usage = readUsageSnapshotMetricsStatus(), now = Date.now()): string {
  const timestamp = (value: string | undefined): number => {
    if (!value) return 0;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed / 1000 : 0;
  };
  const oldestSuccess = timestamp(usage.oldestSuccessAt);
  const latestSuccess = timestamp(usage.latestSuccessAt);
  const heartbeat = timestamp(usage.producerHeartbeatAt);
  const heartbeatAge = heartbeat ? Math.max(0, now / 1000 - heartbeat) : 0;
  // Managed ownership remains sticky so readers cannot start duplicate scans.
  // Expose a stopped or unhealthy producer as stale health instead.
  const heartbeatStale = heartbeat === 0 || heartbeatAge > 15 * 60 ? 1 : 0;
  const completed = timestamp(usage.producerCompletedAt);
  const started = timestamp(usage.producerStartedAt);
  const lastCycleDuration = completed && started
    ? Math.max(0, completed - started)
    : 0;
  return [
    "# HELP ais_scan_workers_active Scan worker processes currently holding a slot.",
    "# TYPE ais_scan_workers_active gauge",
    `ais_scan_workers_active ${state.active}`,
    "# HELP ais_scan_workers_queued Scan requests waiting for a worker slot.",
    "# TYPE ais_scan_workers_queued gauge",
    `ais_scan_workers_queued ${state.queued}`,
    "# HELP ais_scan_worker_timeouts_total Scan worker deadline expirations.",
    "# TYPE ais_scan_worker_timeouts_total counter",
    `ais_scan_worker_timeouts_total ${state.timeouts}`,
    "# HELP ais_scan_worker_cleanup_failures_total Scan worker cleanup failures.",
    "# TYPE ais_scan_worker_cleanup_failures_total counter",
    `ais_scan_worker_cleanup_failures_total ${state.cleanupFailures}`,
    "# HELP ais_scan_worker_forced_kills_total Scan workers requiring SIGKILL.",
    "# TYPE ais_scan_worker_forced_kills_total counter",
    `ais_scan_worker_forced_kills_total ${state.forcedKills}`,
    "# HELP ais_usage_snapshot_producer_heartbeat_timestamp_seconds Unix timestamp of the last shared usage collector heartbeat.",
    "# TYPE ais_usage_snapshot_producer_heartbeat_timestamp_seconds gauge",
    `ais_usage_snapshot_producer_heartbeat_timestamp_seconds ${heartbeat}`,
    "# HELP ais_usage_snapshot_producer_heartbeat_age_seconds Age of the last shared usage collector heartbeat.",
    "# TYPE ais_usage_snapshot_producer_heartbeat_age_seconds gauge",
    "ais_usage_snapshot_producer_heartbeat_age_seconds " + heartbeatAge,
    "# HELP ais_usage_snapshot_producer_heartbeat_stale Whether the shared usage collector has no heartbeat or its heartbeat is older than 15 minutes.",
    "# TYPE ais_usage_snapshot_producer_heartbeat_stale gauge",
    "ais_usage_snapshot_producer_heartbeat_stale " + heartbeatStale,
    "# HELP ais_usage_snapshot_last_success_timestamp_seconds Unix timestamp of the latest successful usage partition refresh.",
    "# TYPE ais_usage_snapshot_last_success_timestamp_seconds gauge",
    `ais_usage_snapshot_last_success_timestamp_seconds ${latestSuccess}`,
    "# HELP ais_usage_snapshot_oldest_partition_age_seconds Age of the oldest successful usage partition, or zero if none exists.",
    "# TYPE ais_usage_snapshot_oldest_partition_age_seconds gauge",
    `ais_usage_snapshot_oldest_partition_age_seconds ${oldestSuccess ? Math.max(0, now / 1000 - oldestSuccess) : 0}`,
    "# HELP ais_usage_snapshot_partitions Number of source partitions in the shared usage snapshot.",
    "# TYPE ais_usage_snapshot_partitions gauge",
    `ais_usage_snapshot_partitions ${usage.partitions}`,
    "# HELP ais_usage_snapshot_partitions_with_errors Number of source partitions with a retained refresh error.",
    "# TYPE ais_usage_snapshot_partitions_with_errors gauge",
    `ais_usage_snapshot_partitions_with_errors ${usage.partitionsWithErrors}`,
    "# HELP ais_usage_snapshot_collector_cycles_total Shared usage collector cycles started by the host producer.",
    "# TYPE ais_usage_snapshot_collector_cycles_total counter",
    `ais_usage_snapshot_collector_cycles_total ${usage.refreshCyclesTotal ?? 0}`,
    "# HELP ais_usage_snapshot_collector_cycle_failures_total Shared usage collector cycles that completed with a source or discovery error.",
    "# TYPE ais_usage_snapshot_collector_cycle_failures_total counter",
    `ais_usage_snapshot_collector_cycle_failures_total ${usage.refreshCyclesFailedTotal ?? 0}`,
    "# HELP ais_usage_snapshot_collector_source_scans_total Source partition collection attempts made by the shared host producer.",
    "# TYPE ais_usage_snapshot_collector_source_scans_total counter",
    `ais_usage_snapshot_collector_source_scans_total ${usage.sourceScansTotal ?? 0}`,
    "# HELP ais_usage_snapshot_collector_source_scan_failures_total Source partition collection or required native capture failures recorded by the shared host producer.",
    "# TYPE ais_usage_snapshot_collector_source_scan_failures_total counter",
    `ais_usage_snapshot_collector_source_scan_failures_total ${usage.sourceScanFailuresTotal ?? 0}`,
    "# HELP ais_usage_snapshot_collector_last_cycle_duration_seconds Duration of the last completed shared collector cycle.",
    "# TYPE ais_usage_snapshot_collector_last_cycle_duration_seconds gauge",
    `ais_usage_snapshot_collector_last_cycle_duration_seconds ${lastCycleDuration}`,
    "# HELP ais_usage_snapshot_collector_last_cycle_failed Whether the last completed shared collector cycle recorded an error.",
    "# TYPE ais_usage_snapshot_collector_last_cycle_failed gauge",
    `ais_usage_snapshot_collector_last_cycle_failed ${usage.lastCycleError ? 1 : 0}`,
    "",
  ].join("\n");
}
