// Visual hooks: the executor calls these around tool actions. Implementations must never throw into a tool call.
import { colorForIdentity } from "./tabs.ts";

export type ActionKind = "click" | "hover" | "type" | "scroll" | "key";
export interface ActionPoint { x: number; y: number; kind: ActionKind; sessionId: string }
export interface UiSession { id: string; identity: string; label: string; color?: string }

export interface Ui {
  /** Called before the executor dispatches input; x,y are viewport CSS pixels. Awaited; must settle within BEFORE_ACTION_MAX_MS and honour the signal. */
  beforeAction(tabId: number, point: ActionPoint, signal?: AbortSignal): Promise<void> | void;
  /** Called when a tab joins a session and on every tab-scoped call. */
  markControlled(tabId: number, session: UiSession): Promise<void> | void;
  /** Clears cursor and indicator from one tab (tab released, closed or session ended). */
  unmark(tabId: number): Promise<void> | void;
  /** Chrome gave the tab a new id: move the marks. Optional for test doubles. */
  replaceTab?(addedTabId: number, removedTabId: number): Promise<void> | void;
  /** Clears one session from one tab. The other sessions on the tab stay marked. */
  unmarkSession(tabId: number, sessionId: string): Promise<void> | void;
  /** Clears every marked tab (Stop, Pause). */
  unmarkAll(): Promise<void> | void;
  /** Hides the overlay so it is neither captured by a screenshot nor hit by synthetic mouse input. Best effort, capped at SUSPEND_MAX_MS. */
  suspend(tabId: number): Promise<void> | void;
  /** Undoes suspend. Always called, including after an abort. */
  restore(tabId: number): Promise<void> | void;
  /** Tabs of this session that currently show the overlay; used to refresh the pill after a rename. */
  markedTabs?(sessionId: string): number[];
}

export const BEFORE_ACTION_MAX_MS = 350;
export const SUSPEND_MAX_MS = 150;
/** No tool call for this long: the agent session is treated as over and the overlay is not redrawn. */
export const SESSION_IDLE_MS = 90_000;

export const noopUi: Ui = {
  beforeAction() {},
  markControlled() {},
  unmark() {},
  unmarkSession() {},
  unmarkAll() {},
  suspend() {},
  restore() {},
};

/** Glow and cursor colours, matching the tab group colour for the identity. */
export const GROUP_HEX: Record<string, string> = {
  grey: "#8b8f98", blue: "#3b82f6", red: "#ef4444", yellow: "#eab308", green: "#22c55e",
  pink: "#ec4899", purple: "#8b5cf6", cyan: "#06b6d4", orange: "#f97316",
};
export const hexForIdentity = (identity: string): string => GROUP_HEX[colorForIdentity(identity)] ?? "#3b82f6";

/** Runs a method of the in-page overlay (isolated world). Resolves "missing" when the overlay is not injected. */
export interface Scripting {
  call(tabId: number, method: string, arg: unknown): Promise<unknown>;
  inject(tabId: number): Promise<void>;
}

export function realScripting(): Scripting {
  return {
    async call(tabId, method, arg) {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (m: string, a: unknown) => {
          const g = (globalThis as unknown as { __aisOverlay?: Record<string, (x: unknown) => unknown> }).__aisOverlay;
          return g ? g[m]!(a) : "missing";
        },
        args: [method, arg],
      });
      return r?.result;
    },
    async inject(tabId) {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    },
  };
}

const withTimeout = <T>(p: Promise<T>, ms: number, signal?: AbortSignal): Promise<T | undefined> =>
  new Promise(resolve => {
    const done = (v: T | undefined) => { clearTimeout(t); signal?.removeEventListener("abort", onAbort); resolve(v); };
    const t = setTimeout(() => done(undefined), ms);
    const onAbort = () => done(undefined);
    if (signal?.aborted) return done(undefined);
    signal?.addEventListener("abort", onAbort, { once: true });
    p.then(done, () => done(undefined));
  });

/** In-page overlay: cursor, ripple, border glow and the controlling pill. Everything is best effort. */
export class OverlayUi implements Ui {
  /** tabId -> sessions marked on it, in mark order. */
  private readonly marked = new Map<number, Map<string, UiSession>>();
  private readonly lastActive = new Map<number, number>();

  constructor(private readonly scripting: Scripting = realScripting(), private readonly now: () => number = Date.now) {}

  has(tabId: number): boolean { return this.marked.has(tabId); }

  /** Sessions marked on one tab, in mark order. */
  sessionsOn(tabId: number): string[] { return [...(this.marked.get(tabId)?.keys() ?? [])]; }

  /** Tabs currently marked as controlled by the given session. */
  markedTabs(sessionId: string): number[] {
    return [...this.marked].filter(([, m]) => m.has(sessionId)).map(([id]) => id);
  }

  /** `inject` allows a first-time content script injection; `wanted` is re-checked after it so a concurrent unmark wins. */
  private async run(tabId: number, method: string, arg: unknown, inject = true, wanted: () => boolean = () => true): Promise<unknown> {
    try {
      let r = await this.scripting.call(tabId, method, arg);
      if (r === "missing" && inject) {
        await this.scripting.inject(tabId);
        if (!wanted()) return undefined;
        r = await this.scripting.call(tabId, method, arg);
      }
      return r;
    } catch {
      return undefined; // chrome:// pages, closed tabs, discarded tabs
    }
  }

  /** A chat session has its own colour and shows its chat name. An external agent keeps the identity colour and tag. */
  private payload(s: UiSession): { sessionId: string; identity: string; label: string; color: string; tag: string } {
    return { sessionId: s.id, identity: s.identity, label: s.label, color: s.color ?? hexForIdentity(s.identity), tag: s.color ? (s.label.trim() || s.identity) : s.identity };
  }

  async markControlled(tabId: number, session: UiSession): Promise<void> {
    let m = this.marked.get(tabId);
    if (!m) this.marked.set(tabId, m = new Map());
    m.set(session.id, session);
    this.lastActive.set(tabId, this.now());
    await this.run(tabId, "mark", this.payload(session), true, () => this.marked.get(tabId)?.has(session.id) === true);
  }

  async beforeAction(tabId: number, point: ActionPoint, signal?: AbortSignal): Promise<void> {
    const session = this.marked.get(tabId)?.get(point.sessionId);
    if (!session || signal?.aborted) return;
    this.lastActive.set(tabId, this.now());
    await withTimeout(this.run(tabId, "action", { x: point.x, y: point.y, kind: point.kind, ...this.payload(session) }, true, () => this.marked.get(tabId)?.has(session.id) === true), BEFORE_ACTION_MAX_MS, signal);
  }

  async suspend(tabId: number): Promise<void> {
    if (!this.marked.has(tabId)) return;
    await withTimeout(this.run(tabId, "suspend", null, false), SUSPEND_MAX_MS);
  }

  async restore(tabId: number): Promise<void> {
    if (!this.marked.has(tabId)) return;
    await withTimeout(this.run(tabId, "restore", null, false), SUSPEND_MAX_MS);
  }

  async unmark(tabId: number): Promise<void> {
    this.lastActive.delete(tabId);
    if (!this.marked.delete(tabId)) return;
    await this.run(tabId, "unmark", null, false);
  }

  async unmarkSession(tabId: number, sessionId: string): Promise<void> {
    const m = this.marked.get(tabId);
    if (!m?.delete(sessionId)) return;
    if (m.size === 0) {
      this.marked.delete(tabId);
      this.lastActive.delete(tabId);
    }
    await this.run(tabId, "unmark", { sessionId }, false);
  }

  /** Chrome gave the tab a new id: the marks follow it and the overlay is drawn again in the restored page. */
  async replaceTab(addedTabId: number, removedTabId: number): Promise<void> {
    const m = this.marked.get(removedTabId);
    if (!m) return;
    this.marked.delete(removedTabId);
    this.marked.set(addedTabId, m);
    const last = this.lastActive.get(removedTabId);
    this.lastActive.delete(removedTabId);
    if (last !== undefined) this.lastActive.set(addedTabId, last);
    await this.refresh(addedTabId);
  }

  async unmarkAll(): Promise<void> {
    const ids = [...this.marked.keys()];
    this.marked.clear();
    this.lastActive.clear();
    await Promise.all(ids.map(id => this.run(id, "unmark", null, false)));
  }

  /** A controlled tab finished loading a new page: the overlay died with the old document, so draw it again, unless the session went quiet. */
  async refresh(tabId: number): Promise<void> {
    const m = this.marked.get(tabId);
    if (!m) return;
    if (this.now() - (this.lastActive.get(tabId) ?? 0) > SESSION_IDLE_MS) {
      this.marked.delete(tabId);
      this.lastActive.delete(tabId);
      return;
    }
    for (const s of [...m.values()]) await this.run(tabId, "mark", this.payload(s), true, () => this.marked.get(tabId)?.has(s.id) === true);
  }
}
