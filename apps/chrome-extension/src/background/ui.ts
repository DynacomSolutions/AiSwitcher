// Hooks for the visuals task (cursor, ripple, controlled-tab indicator).

export type ActionKind = "click" | "hover" | "type" | "scroll" | "key";
export interface ActionPoint { x: number; y: number; kind: ActionKind }
export interface UiSession { id: string; identity: string; label: string }

export interface Ui {
  /** Called before the executor dispatches input; x,y are page CSS pixels. May animate; awaited. */
  beforeAction(tabId: number, point: ActionPoint): Promise<void> | void;
  /** Called when a tab joins a session and on every tab-scoped call. */
  markControlled(tabId: number, session: UiSession): Promise<void> | void;
}

export const noopUi: Ui = {
  beforeAction() {},
  markControlled() {},
};
