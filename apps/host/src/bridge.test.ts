import type { DeviceSummary, HostBridge, OperationView } from "./contract";

const devices: DeviceSummary[] = [{
  id: "SYNTHETIC_FIXTURE_drive_usb_1",
  displayIdentifier: "Synthetic USB Drive",
  model: "Synthetic device",
  capacityBytes: 16_000_000_000,
  transport: "usb",
  system: false,
  writable: true,
  layoutStatus: "ready",
}];
export const testBridge: HostBridge = {
  async listDevices() { return devices; },
  subscribeToOperations(listener: (operation: OperationView) => void) {
    const event: OperationView = { id: "SYNTHETIC_FIXTURE_operation_1", phase: "running", completedBytes: 2, totalBytes: 4, canCancel: true, errorCode: null };
    queueMicrotask(() => listener(event));
    return () => undefined;
  },
  async reportReady() {},
};
