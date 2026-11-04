// Pause/Stop state. Pause is persisted so a paused profile stays paused across service-worker restarts.
import type { ChromeApi } from "./chrome-api.ts";

const PAUSED_KEY = "paused";

export class State {
  private _paused = false;
  private readonly inflight = new Map<string, AbortController>();
  private readonly changeListeners = new Set<(paused: boolean) => void>();
  private readonly stopListeners = new Set<() => void | Promise<void>>();

  constructor(private readonly storage?: ChromeApi["storage"]) {}

  get paused(): boolean { return this._paused; }

  /** Restore persisted pause state. Call once at start-up before connecting. */
  async load(): Promise<void> {
    if (!this.storage) return;
    this._paused = (await this.storage.get([PAUSED_KEY]))[PAUSED_KEY] === true;
  }

  onChange(listener: (paused: boolean) => void): void { this.changeListeners.add(listener); }
  onStop(listener: () => void | Promise<void>): void { this.stopListeners.add(listener); }

  pause(): void { this.setPaused(true); }
  resume(): void { this.setPaused(false); }

  private setPaused(paused: boolean): void {
    if (this._paused === paused) return;
    this._paused = paused;
    void this.storage?.set({ [PAUSED_KEY]: paused });
    for (const l of this.changeListeners) l(paused);
  }

  /** Register an in-flight call. The signal aborts with reason "stopped" on stop() or "aborted" on abort(). */
  track(id: string): AbortController {
    const controller = new AbortController();
    this.inflight.set(id, controller);
    return controller;
  }

  untrack(id: string): void { this.inflight.delete(id); }

  /** Gateway asked to abort one call. */
  abort(id: string): void { this.inflight.get(id)?.abort("aborted"); }

  /** Abort every in-flight call with stopped_by_user, detach the debugger from all tabs and pause (user resumes from the UI). */
  async stop(): Promise<void> {
    for (const c of this.inflight.values()) c.abort("stopped");
    this.inflight.clear();
    this.pause();
    await Promise.all([...this.stopListeners].map(async l => { try { await l(); } catch { /* best effort */ } }));
  }
}
