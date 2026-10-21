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

export interface DriveRecordView { driveId: string; generation: number; escrowState: string }
export interface FlowTarget { id: string; label: string; kind: "local" | "ssh" }

export type ConflictChoice = "keepDrive" | "useSource" | "defer";
export interface RefreshConflict { path: string; class: string; reason: string; choice: ConflictChoice }
export interface RefreshPreview {
  acknowledgedSeq: number;
  pendingSeq: number | null;
  outboxCreatedAt: string | null;
  conflicts: RefreshConflict[];
  sourceDigest: string;
  disposition: "ready" | "reusePending" | "awaitingAcknowledgement" | "noSafeEntries";
  replacesPending: boolean;
  deferredPaths: string[];
  outboxCurrent: boolean;
}
export interface RefreshChoices { configuration: Record<string, ConflictChoice>; replacePending: boolean }
export interface RefreshCommandPreview { previewId: string; preview: RefreshPreview }
export interface RefreshResult { sequence: number | null; acknowledged: boolean; reusedPending: boolean; deferredPaths: string[] }

export interface PullLogsResult {
  imported: number;
  duplicates: number;
  truncated: boolean;
  capturedAt: string;
  freshness: "current" | "stale" | "unknown";
  conflicts: string[];
  complete: boolean;
}

export interface RemoveOptions { pullLogs: boolean; eraseStorage: boolean; revokeCredentials: boolean; forgetDrive: boolean }
export interface ResumeRemoval { retryFailedLogs: boolean; continueWithoutLogs: boolean }
export interface ResetSupport { supported: boolean; reason: string }
export interface CredentialScopeView { handle: string; provider: string; affectedIdentities: string[]; method: string }
export interface RemoveReviewView {
  drive: { driveId: string; generation: number };
  options: RemoveOptions;
  credentials: { scopes: CredentialScopeView[]; digest: string };
  digest: string;
  eraseSupport: ResetSupport;
}
export interface RemovalCommandPreview { previewId: string; review: RemoveReviewView }
export type StepResult = { status: "completed" } | { status: "failed"; reason: string } | { status: "skipped"; reason: string };
export interface RemoveResult {
  pullLogs: StepResult;
  eraseStorage: StepResult;
  revokeCredentials: StepResult;
  forgetDrive: StepResult;
  providers: { handle: string; provider: string; effect: string; nextAction: string | null }[];
  pausedForLogs: boolean;
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
  listDriveRecords(): Promise<DriveRecordView[]>;
  listFlowTargets(): Promise<FlowTarget[]>;
  previewRefresh(driveId: string, sourceId: string, choices: RefreshChoices): Promise<RefreshCommandPreview>;
  publishRefresh(previewId: string): Promise<RefreshResult>;
  pullLogs(driveId: string, destinationId: string): Promise<PullLogsResult>;
  previewRemoval(driveId: string, options: RemoveOptions, resume: boolean): Promise<RemovalCommandPreview>;
  executeRemoval(previewId: string, reviewDigest: string, consentedIdentities: string[], resume: ResumeRemoval): Promise<RemoveResult>;
  invalidateFlowPreview(): Promise<void>;
  resetSupport(): Promise<ResetSupport>;
  resetStorage(): Promise<void>;
}
