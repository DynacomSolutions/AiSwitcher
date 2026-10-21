import type { ConfirmationReceipt, ModelChoice, DeviceSummary, HostBridge, OperationView, WritePreview, RemoveResult } from "./contract";

const devices: DeviceSummary[] = [{
  id: "SYNTHETIC_FIXTURE_drive_usb_1",
  displayIdentifier: "Synthetic USB Drive",
  model: "Synthetic device",
  capacityBytes: 16_000_000_000,
  transport: "usb",
  system: false,
  writable: true,
  serial: "SYNTHETIC_FIXTURE_serial_1",
  layoutStatus: "ready",
}, {
  id: "SYNTHETIC_FIXTURE_drive_system_1",
  displayIdentifier: "Synthetic System Disk",
  model: "Synthetic internal",
  capacityBytes: 512_000_000_000,
  transport: "nvme",
  system: true,
  writable: true,
  serial: null,
  layoutStatus: "unknown",
}];
let previews = 0;
let current: string | null = null;
const models: ModelChoice[] = [{
  id: "SYNTHETIC_FIXTURE_model", name: "Synthetic model", quality: "fixture", sizeBytes: 3_000_000_000,
  licenceName: "Synthetic licence", licenceText: "SYNTHETIC_FIXTURE licence: use only for tests.",
}];
export const testBridge: HostBridge = {
  async listModels() { return models; },
  async setCreateOptions() {},
  async previewWrite(deviceId: string): Promise<WritePreview> {
    const device = devices.find((item) => item.id === deviceId && !item.system);
    if (!device) throw new Error("The selected device is unavailable.");
    current = `SYNTHETIC_FIXTURE_preview_${++previews}`;
    return {
      previewId: current, operation: "createLayout", displayIdentifier: device.displayIdentifier, model: device.model,
      serial: device.serial, connectionIdentity: "SYNTHETIC_FIXTURE_CONNECTION",
      capacityBytes: device.capacityBytes, partitions: [{ name: "SYNTHETIC_FIXTURE_part_1", sizeBytes: 1_000_000, kind: "data" }],
      partitionDetailsAvailable: true, ranges: [{ start: 0, length: 17_408 }], imageDigest: "0".repeat(64), confirmationTtlSeconds: 90,
    };
  },
  async previewUpdate(deviceId: string): Promise<WritePreview> {
    return {
      ...await this.previewWrite(deviceId), operation: "replaceBase",
      ranges: [{ start: 1_048_576, length: 200_000_000 }],
      partitions: [
        { name: "AISBASE", sizeBytes: 100_000_000, kind: "replace" },
        { name: "AISX", sizeBytes: 600_000_000, kind: "preserve" },
        { name: "AISPERSIST", sizeBytes: 2_147_483_648, kind: "preserve" },
      ],
    };
  },
  async confirmWrite(previewId: string, typedIdentifier: string): Promise<ConfirmationReceipt> {
    if (previewId !== current || typedIdentifier !== "Synthetic USB Drive") throw new Error("Type the exact displayed device identifier.");
    return { expiresInSeconds: 90 };
  },
  async startWrite() { throw new Error("Writing is disabled in this build."); },
  async invalidateConfirmation() { current = null; },
  async listDevices() { return devices; },
  subscribeToOperations(listener: (operation: OperationView) => void) {
    const event: OperationView = { id: "SYNTHETIC_FIXTURE_operation_1", phase: "running", completedBytes: 2, totalBytes: 4, canCancel: true, errorCode: null };
    queueMicrotask(() => listener(event));
    return () => undefined;
  },
  async reportReady() {},
  async listDriveRecords() { return [{ driveId: "SYNTHETIC_FIXTURE_record_1", generation: 1, escrowState: "disabled" }]; },
  async listFlowTargets() { return [{ id: "local", label: "This computer", kind: "local" }]; },
  async previewRefresh() {
    return { previewId: "SYNTHETIC_FIXTURE_refresh_1", preview: { acknowledgedSeq: 0, pendingSeq: null, outboxCreatedAt: null, conflicts: [], sourceDigest: "0".repeat(64), disposition: "ready", replacesPending: false, deferredPaths: [], outboxCurrent: true } };
  },
  async publishRefresh() { return { sequence: 1, acknowledged: false, reusedPending: false, deferredPaths: [] }; },
  async pullLogs() { return { imported: 1, duplicates: 0, truncated: false, capturedAt: "2026-10-19T00:00:00.000Z", freshness: "unknown", conflicts: [], complete: true }; },
  async previewRemoval(driveId, options) {
    return { previewId: "SYNTHETIC_FIXTURE_removal_1", review: { drive: { driveId, generation: 1 }, options, credentials: { scopes: [], digest: "0".repeat(64) }, digest: "1".repeat(64), eraseSupport: { supported: false, reason: "Not yet supported." } } };
  },
  async executeRemoval(): Promise<RemoveResult> {
    const skipped = { status: "skipped", reason: "Not selected." } as const;
    return { pullLogs: skipped, eraseStorage: skipped, revokeCredentials: skipped, forgetDrive: { status: "completed" }, providers: [], pausedForLogs: false };
  },
  async invalidateFlowPreview() {},
  async resetSupport() { return { supported: false, reason: "Persist erasure and lost-key reset are not yet supported." }; },
  async resetStorage() { throw new Error("Persist erasure and lost-key reset are not yet supported."); },
};
