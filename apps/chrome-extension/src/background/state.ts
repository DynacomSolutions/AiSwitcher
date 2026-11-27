// Pause/Stop state. Pause is persisted so a paused profile stays paused across service-worker restarts.
import type { ChromeApi } from "./chrome-api.ts";

const PAUSED_KEY = "paused";
export const MAX_STOPPED = 256;

export class State {
  private _paused = false;
  private readonly inflight = new Map<string, AbortController>();
  private readonly sessionOf = new Map<string, string>();
  private readonly tabOf = new Map<string, number>();
  /** Stopped sessions, with the identity that was known when the user stopped them. Oldest entries go first at the cap. */
  private readonly stopped = new Map<string, string | undefined>();
  private readonly identityOf = new Map<string, string>();
  private readonly sessionStopListeners = new Set<(sessionId: string) => void>();
  private sessionsOnTab: (tabId: number) => string[] = () => [];
  private readonly changeListeners = new Set<(paused: boolean) => void>();
  private readonly stopListeners = new Set<() => void | Promise<void>>();

  constructor(private readonly storage?: ChromeApi["storage"]) {}

  get paused(): boolean { return this._paused; }

  /** Calls currently running. */
  get inflightCount(): number { return this.inflight.size; }

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
  track(id: string, sessionId?: string, identity?: string, tabId?: number): AbortController {
    const controller = new AbortController();
    this.inflight.set(id, controller);
    if (sessionId !== undefined) this.sessionOf.set(id, sessionId);
    if (tabId !== undefined) this.tabOf.set(id, tabId);
    if (sessionId !== undefined && identity !== undefined) {
      this.identityOf.delete(sessionId);
      this.identityOf.set(sessionId, identity);
      while (this.identityOf.size > MAX_STOPPED) this.identityOf.delete(this.identityOf.keys().next().value as string);
    }
    return controller;
  }

  untrack(id: string): void {
    this.inflight.delete(id);
    this.sessionOf.delete(id);
    this.tabOf.delete(id);
  }

  /** True after the user stopped this session and until it resumes or ends. The executor rejects its new calls. */
  isStopped(sessionId: string): boolean { return this.stopped.has(sessionId); }

  /** Clears the block set by stopSession. Called when the user prompts that chat again, and when the session ends. */
  resumeSession(sessionId: string, identity?: string): void {
    // A session end from another identity must not lift the user's block.
    const stopper = this.stopped.get(sessionId);
    if (identity !== undefined && stopper !== undefined && stopper !== identity) return;
    this.stopped.delete(sessionId);
  }

  onSessionStop(listener: (sessionId: string) => void): void { this.sessionStopListeners.add(listener); }

  /** Lookup of the sessions marked on a tab. Used by stopTab. */
  setSessionsOnTab(fn: (tabId: number) => string[]): void { this.sessionsOnTab = fn; }

  /** Abort the in-flight calls of one session with stopped_by_user and block its new calls. Does not pause and does not detach. */
  stopSession(sessionId: string): void {
    this.stopped.delete(sessionId);
    this.stopped.set(sessionId, this.identityOf.get(sessionId));
    while (this.stopped.size > MAX_STOPPED) this.stopped.delete(this.stopped.keys().next().value as string);
    for (const l of this.sessionStopListeners) { try { l(sessionId); } catch { /* best effort */ } }
    for (const [id, c] of [...this.inflight]) {
      if (this.sessionOf.get(id) !== sessionId) continue;
      c.abort("stopped");
      this.untrack(id);
    }
  }

  /** Abort the calls of every session marked on the tab. */
  stopTab(tabId: number): void { for (const s of this.sessionsOnTab(tabId)) this.stopSession(s); }

  /** Chrome can detach before the call marks its tab. End those calls too. */
  abortTab(tabId: number): void {
    for (const [id, target] of this.tabOf) {
      if (target === tabId) this.inflight.get(id)?.abort("stopped");
    }
  }

  /** Gateway asked to abort one call. */
  abort(id: string): void { this.inflight.get(id)?.abort("aborted"); }

  /** Abort every in-flight call with stopped_by_user, detach the debugger from all tabs and pause (user resumes from the UI). */
  async stop(): Promise<void> {
    for (const c of this.inflight.values()) c.abort("stopped");
    this.inflight.clear();
    this.sessionOf.clear();
    this.tabOf.clear();
    this.pause();
    await Promise.all([...this.stopListeners].map(async l => { try { await l(); } catch { /* best effort */ } }));
  }
}
