export interface DeviceSummary {
  id: string;
  displayIdentifier: string;
  model: string | null;
  capacityBytes: number;
  transport: string;
  system: boolean;
  writable: boolean;
  serial: string | null;
  layoutStatus: string;
  updateError?: string;
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

export interface PartitionReview { name: string; sizeBytes: number; kind: string }

/** Presentation of a native-owned preview. The webview never supplies a plan. */
export interface WritePreview {
  previewId: string;
  operation: "createLayout" | "replaceBase" | "resetPersist";
  displayIdentifier: string;
  model: string | null;
  serial: string | null;
  connectionIdentity: string;
  capacityBytes: number;
  partitions: PartitionReview[];
  partitionDetailsAvailable: boolean;
  ranges: { start: number; length: number }[];
  imageDigest: string;
  confirmationTtlSeconds: number;
}

export interface ConfirmationReceipt { expiresInSeconds: number }

export interface ModelChoice {
  id: string;
  name: string;
  quality: string;
  sizeBytes: number;
  licenceName: string;
  licenceText: string;
}

export interface HostBridge {
  listModels(): Promise<ModelChoice[]>;
  /** Validated natively and held there only until the write finishes. */
  setCreateOptions(modelId: string | null, licenceAccepted: boolean, passphrase: string, confirmation: string): Promise<void>;
  previewWrite(deviceId: string): Promise<WritePreview>;
  previewUpdate(deviceId: string): Promise<WritePreview>;
  confirmWrite(previewId: string, typedIdentifier: string): Promise<ConfirmationReceipt>;
  /** Hands the confirmed native preview to the privileged helper; native code checks every precondition. */
  startWrite(previewId: string): Promise<void>;
  invalidateConfirmation(): Promise<void>;
  listDevices(): Promise<DeviceSummary[]>;
  subscribeToOperations(listener: (operation: OperationView) => void, onError?: (error: unknown) => void): () => void;
  reportReady(): Promise<void>;
}
