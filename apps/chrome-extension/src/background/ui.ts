// Visual hooks: the executor calls these around tool actions. Implementations must never throw into a tool call.
import { colorForIdentity } from "./tabs.ts";

export type ActionKind = "click" | "hover" | "type" | "scroll" | "key";
export interface ActionPoint { x: number; y: number; kind: ActionKind }
export interface UiSession { id: string; identity: string; label: string }

export interface Ui {
  /** Called before the executor dispatches input; x,y are viewport CSS pixels. Awaited; must settle within BEFORE_ACTION_MAX_MS and honour the signal. */
  beforeAction(tabId: number, point: ActionPoint, signal?: AbortSignal): Promise<void> | void;
  /** Called when a tab joins a session and on every tab-scoped call. */
  markControlled(tabId: number, session: UiSession): Promise<void> | void;
  /** Clears cursor and indicator from one tab (tab released, closed or session ended). */
  unmark(tabId: number): Promise<void> | void;
  /** Clears every marked tab (Stop, Pause). */
  unmarkAll(): Promise<void> | void;
  /** Hides the overlay so it is neither captured by a screenshot nor hit by synthetic mouse input. Best effort, capped at SUSPEND_MAX_MS. */
  suspend(tabId: number): Promise<void> | void;
  /** Undoes suspend. Always called, including after an abort. */
  restore(tabId: number): Promise<void> | void;
}

export const BEFORE_ACTION_MAX_MS = 350;
export const SUSPEND_MAX_MS = 150;
/** No tool call for this long: the agent session is treated as over and the overlay is not redrawn. */
export const SESSION_IDLE_MS = 90_000;

export const noopUi: Ui = {
  beforeAction() {},
  markControlled() {},
  unmark() {},
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
  private readonly marked = new Map<number, UiSession>();
  private readonly lastActive = new Map<number, number>();

  constructor(private readonly scripting: Scripting = realScripting(), private readonly now: () => number = Date.now) {}

  has(tabId: number): boolean { return this.marked.has(tabId); }

  /** Tabs currently marked as controlled by the given session. */
  markedTabs(sessionId: string): number[] {
    return [...this.marked].filter(([, s]) => s.id === sessionId).map(([id]) => id);
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

  private payload(s: UiSession): { identity: string; label: string; color: string } {
    return { identity: s.identity, label: s.label, color: hexForIdentity(s.identity) };
  }

  async markControlled(tabId: number, session: UiSession): Promise<void> {
    this.marked.set(tabId, session);
    this.lastActive.set(tabId, this.now());
    await this.run(tabId, "mark", this.payload(session), true, () => this.marked.has(tabId));
  }

  async beforeAction(tabId: number, point: ActionPoint, signal?: AbortSignal): Promise<void> {
    const session = this.marked.get(tabId);
    if (!session || signal?.aborted) return;
    this.lastActive.set(tabId, this.now());
    await withTimeout(this.run(tabId, "action", { ...point, ...this.payload(session) }, true, () => this.marked.has(tabId)), BEFORE_ACTION_MAX_MS, signal);
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

  async unmarkAll(): Promise<void> {
    const ids = [...this.marked.keys()];
    this.marked.clear();
    this.lastActive.clear();
    await Promise.all(ids.map(id => this.run(id, "unmark", null, false)));
  }

  /** A controlled tab finished loading a new page: the overlay died with the old document, so draw it again, unless the session went quiet. */
  async refresh(tabId: number): Promise<void> {
    const s = this.marked.get(tabId);
    if (!s) return;
    if (this.now() - (this.lastActive.get(tabId) ?? 0) > SESSION_IDLE_MS) {
      this.marked.delete(tabId);
      this.lastActive.delete(tabId);
      return;
    }
    await this.run(tabId, "mark", this.payload(s), true, () => this.marked.has(tabId));
  }
}
