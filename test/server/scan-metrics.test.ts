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
  ]) {
    expect(metrics).toContain(`# TYPE ${name} `);
    expect(metrics).toMatch(new RegExp(`^${name} \\d+$`, "m"));
  }
});
