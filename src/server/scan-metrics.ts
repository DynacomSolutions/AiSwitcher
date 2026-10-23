/** Small process-local metrics for the bounded scan worker pool. */
const state = { active: 0, queued: 0, timeouts: 0, cleanupFailures: 0, forcedKills: 0 };

export function scanMetric(name: keyof typeof state, delta = 1): void {
  state[name] += delta;
}

export function renderScanMetrics(): string {
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
    "",
  ].join("\n");
}
