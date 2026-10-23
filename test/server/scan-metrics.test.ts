import { expect, test } from "bun:test";
import { renderScanMetrics } from "../../src/server/scan-metrics.ts";

test("exports scan pressure and cleanup metrics in Prometheus text format", () => {
  const metrics = renderScanMetrics();
  for (const name of [
    "ais_scan_workers_active",
    "ais_scan_workers_queued",
    "ais_scan_worker_timeouts_total",
    "ais_scan_worker_cleanup_failures_total",
    "ais_scan_worker_forced_kills_total",
    "ais_usage_snapshot_collector_cycles_total",
    "ais_usage_snapshot_collector_cycle_failures_total",
    "ais_usage_snapshot_collector_source_scans_total",
    "ais_usage_snapshot_collector_source_scan_failures_total",
    "ais_usage_snapshot_collector_last_cycle_duration_seconds",
    "ais_usage_snapshot_collector_last_cycle_failed",
    "ais_usage_snapshot_producer_heartbeat_age_seconds",
    "ais_usage_snapshot_producer_heartbeat_stale",
  ]) {
    expect(metrics).toContain(`# TYPE ${name} `);
    expect(metrics).toMatch(new RegExp(`^${name} [0-9]+(?:\\.[0-9]+)?$`, "m"));
  }
});

test("reports a stopped or stale managed producer without changing reader ownership", () => {
  const now = Date.UTC(2026, 0, 1, 0, 20);
  const base = {
    partitions: 1,
    partitionsWithErrors: 0,
    producerHeartbeatAt: new Date(now - 16 * 60_000).toISOString(),
  };
  const stale = renderScanMetrics(base, now);
  expect(stale).toContain("ais_usage_snapshot_producer_heartbeat_age_seconds 960");
  expect(stale).toContain("ais_usage_snapshot_producer_heartbeat_stale 1");

  const missing = renderScanMetrics({ partitions: 0, partitionsWithErrors: 0 }, now);
  expect(missing).toContain("ais_usage_snapshot_producer_heartbeat_stale 1");

  const fresh = renderScanMetrics({
    partitions: 1,
    partitionsWithErrors: 0,
    producerHeartbeatAt: new Date(now - 60_000).toISOString(),
  }, now);
  expect(fresh).toContain("ais_usage_snapshot_producer_heartbeat_age_seconds 60");
  expect(fresh).toContain("ais_usage_snapshot_producer_heartbeat_stale 0");
});
