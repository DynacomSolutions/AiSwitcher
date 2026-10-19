import type { ConfirmationReceipt, DeviceSummary, HostBridge, OperationView, WritePreview } from "./contract";

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
  async previewWrite(deviceId: string): Promise<WritePreview> { return native().invoke<WritePreview>("preview_write", { deviceId }); },
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
  }
};
