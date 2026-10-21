import type { ConfirmationReceipt, ModelChoice, DeviceSummary, HostBridge, OperationView, WritePreview, DriveRecordView, FlowTarget, RefreshChoices, RefreshCommandPreview, RefreshResult, PullLogsResult, RemoveOptions, ResumeRemoval, ResetSupport, RemovalCommandPreview, RemoveResult } from "./contract";

declare global {
  interface Window {
    __TAURI__?: {
      core: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> };
      event: { listen<T>(event: string, listener: (event: { payload: T }) => void): Promise<() => void> };
    };
  }
}

function native(): NonNullable<Window["__TAURI__"]>["core"] {
  if (!window.__TAURI__) throw new Error("The native host runtime is unavailable.");
  return window.__TAURI__.core;
}

export const productionBridge: HostBridge = {
  async listModels(): Promise<ModelChoice[]> { return native().invoke<ModelChoice[]>("list_models"); },
  async setCreateOptions(modelId: string | null, licenceAccepted: boolean, passphrase: string, confirmation: string) {
    await native().invoke<void>("set_create_options", { modelId, licenceAccepted, passphrase, confirmation });
  },
  async previewWrite(deviceId: string): Promise<WritePreview> { return native().invoke<WritePreview>("preview_write", { deviceId }); },
  async previewUpdate(deviceId: string): Promise<WritePreview> { return native().invoke<WritePreview>("preview_update", { deviceId }); },
  async previewReset(deviceId: string): Promise<WritePreview> { return native().invoke<WritePreview>("preview_reset", { deviceId }); },
  async confirmWrite(previewId: string, typedIdentifier: string): Promise<ConfirmationReceipt> {
    return native().invoke<ConfirmationReceipt>("confirm_write", { previewId, typedIdentifier });
  },
  async startWrite(previewId: string) { await native().invoke<void>("start_write", { previewId }); },
  async invalidateConfirmation() { try { await native().invoke<void>("invalidate_confirmation"); } catch { /* no native session to invalidate */ } },
  async listDevices(): Promise<DeviceSummary[]> {
    if (!window.__TAURI__) throw new Error("The native host runtime is unavailable.");
    return window.__TAURI__.core.invoke<DeviceSummary[]>("list_devices");
  },
  subscribeToOperations(listener: (operation: OperationView) => void, onError?: (error: unknown) => void): () => void {
    let closed = false;
    let unsubscribe: (() => void) | undefined;
    const tauri = window.__TAURI__;
    if (!tauri) {
      queueMicrotask(() => { if (!closed) onError?.(new Error("The native host runtime is unavailable.")); });
      return () => { closed = true; };
    }
    const listen = tauri.event.listen<OperationView>("host-operation", (event) => listener(event.payload));
    void listen.then((stop) => {
      if (closed) stop();
      else unsubscribe = stop;
    }).catch((error: unknown) => { if (!closed) onError?.(error); });
    return () => { closed = true; unsubscribe?.(); };
  },
  async reportReady() {
    try { await window.__TAURI__?.core.invoke<void>("native_smoke_ready"); } catch { /* normal app launches are not smoke runs */ }
  },
  async listDriveRecords(): Promise<DriveRecordView[]> { return native().invoke<DriveRecordView[]>("escrow_drive_records"); },
  async listFlowTargets(): Promise<FlowTarget[]> { return native().invoke<FlowTarget[]>("flow_list_targets"); },
  async previewRefresh(driveId: string, sourceId: string, choices: RefreshChoices): Promise<RefreshCommandPreview> {
    return native().invoke<RefreshCommandPreview>("flow_refresh_preview", { driveId, sourceId, choices });
  },
  async publishRefresh(previewId: string): Promise<RefreshResult> { return native().invoke<RefreshResult>("flow_refresh_publish", { previewId }); },
  async pullLogs(driveId: string, destinationId: string): Promise<PullLogsResult> { return native().invoke<PullLogsResult>("flow_pull_logs", { driveId, destinationId }); },
  async previewRemoval(driveId: string, options: RemoveOptions, resume: boolean): Promise<RemovalCommandPreview> {
    return native().invoke<RemovalCommandPreview>("flow_remove_preview", { driveId, options, resume });
  },
  async executeRemoval(previewId: string, reviewDigest: string, consentedIdentities: string[], resume: ResumeRemoval): Promise<RemoveResult> {
    return native().invoke<RemoveResult>("flow_remove_execute", { previewId, reviewDigest, consentedIdentities, resume });
  },
  async invalidateFlowPreview() { try { await native().invoke<void>("flow_invalidate_preview"); } catch { /* no native session to invalidate */ } },
  async resetSupport(): Promise<ResetSupport> { return native().invoke<ResetSupport>("flow_reset_support"); }
};
