import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { aisCacheDir } from "../../shared/ais-home.ts";

export interface UsageSnapshotMetricsStatus {
  producerStartedAt?: string;
  producerHeartbeatAt?: string;
  producerCompletedAt?: string;
  refreshCyclesTotal?: number;
  refreshCyclesFailedTotal?: number;
  sourceScansTotal?: number;
  sourceScanFailuresTotal?: number;
  lastCycleError?: string;
  latestSuccessAt?: string;
  oldestSuccessAt?: string;
  partitions: number;
  partitionsWithErrors: number;
}

/** Read the tiny status projection, avoiding a parse of provider rows on each scrape. */
export function readUsageSnapshotMetricsStatus(path = join(aisCacheDir(), "usage", "snapshot.json")): UsageSnapshotMetricsStatus {
  try {
    const value = JSON.parse(readFileSync(join(dirname(path), "status.json"), "utf8")) as Partial<UsageSnapshotMetricsStatus>;
    return {
      ...(typeof value.producerHeartbeatAt === "string" ? { producerHeartbeatAt: value.producerHeartbeatAt } : {}),
      ...(typeof value.producerStartedAt === "string" ? { producerStartedAt: value.producerStartedAt } : {}),
      ...(typeof value.producerCompletedAt === "string" ? { producerCompletedAt: value.producerCompletedAt } : {}),
      ...(Number.isFinite(value.refreshCyclesTotal) ? { refreshCyclesTotal: Number(value.refreshCyclesTotal) } : {}),
      ...(Number.isFinite(value.refreshCyclesFailedTotal) ? { refreshCyclesFailedTotal: Number(value.refreshCyclesFailedTotal) } : {}),
      ...(Number.isFinite(value.sourceScansTotal) ? { sourceScansTotal: Number(value.sourceScansTotal) } : {}),
      ...(Number.isFinite(value.sourceScanFailuresTotal) ? { sourceScanFailuresTotal: Number(value.sourceScanFailuresTotal) } : {}),
      ...(typeof value.lastCycleError === "string" ? { lastCycleError: value.lastCycleError } : {}),
      ...(typeof value.latestSuccessAt === "string" ? { latestSuccessAt: value.latestSuccessAt } : {}),
      ...(typeof value.oldestSuccessAt === "string" ? { oldestSuccessAt: value.oldestSuccessAt } : {}),
      partitions: Number.isFinite(value.partitions) ? Number(value.partitions) : 0,
      partitionsWithErrors: Number.isFinite(value.partitionsWithErrors) ? Number(value.partitionsWithErrors) : 0,
    };
  } catch {
    return { partitions: 0, partitionsWithErrors: 0 };
  }
}
