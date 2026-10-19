export interface DeviceSummary {
  id: string;
  displayIdentifier: string;
  model: string | null;
  capacityBytes: number;
  transport: string;
  system: boolean;
  writable: boolean;
  layoutStatus: string;
}

export type OperationPhase = "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled";

export interface OperationView {
  id: string;
  phase: OperationPhase;
  completedBytes: number;
  totalBytes: number | null;
  canCancel: boolean;
  errorCode: string | null;
}

export interface HostBridge {
  listDevices(): Promise<DeviceSummary[]>;
  subscribeToOperations(listener: (operation: OperationView) => void, onError?: (error: unknown) => void): () => void;
  reportReady(): Promise<void>;
}
