// Composer: pure state rules plus the DOM of the message box.
import type { ChatView } from "../../shared/chat.ts";

export const NO_PAGES_HINT = "No pages are linked. The agent cannot see any tab.";
export const PAUSED_HINT = "Browser control is paused. The agent can still reply.";

export function composerMode(c: ChatView | undefined, paused: boolean): { send: boolean; stop: boolean; hint?: string } {
  if (!c) return { send: false, stop: false };
  const s = c.summary.state;
  const running = s === "thinking" || s === "waiting";
  const hint = paused ? PAUSED_HINT : c.summary.tabIds.length === 0 ? NO_PAGES_HINT : undefined;
  return { send: !running && s !== "starting" && s !== "closed", stop: running, ...(hint ? { hint } : {}) };
}

export interface ComposerHandlers { onSend(text: string): void; onStop(): void }
export interface Composer { root: HTMLElement; update(mode: { send: boolean; stop: boolean; hint?: string }): void; focus(): void }

/** Builds the message box. Enter sends, Shift+Enter adds a line. The draft stays when the mode changes. */
export function createComposer(doc: Document, h: ComposerHandlers): Composer {
  const root = doc.createElement("div");
  root.className = "composer";
  const hint = doc.createElement("p");
  hint.className = "hint composer-hint";
  const box = doc.createElement("textarea");
  box.className = "composer-box";
  box.rows = 2;
  box.placeholder = "Message the agent";
  box.setAttribute("aria-label", "Message");
  const button = doc.createElement("button");
  button.type = "button";
  const row = doc.createElement("div");
  row.className = "composer-row";
  row.append(box, button);
  root.append(hint, row);
  let mode = { send: false, stop: false } as { send: boolean; stop: boolean };
  const submit = (): void => {
    const text = box.value.trim();
    if (!mode.send || text.length === 0) return;
    box.value = "";
    h.onSend(text);
  };
  box.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
  });
  button.addEventListener("click", () => { if (mode.stop) h.onStop(); else submit(); });
  return {
    root,
    update(m) {
      mode = m;
      button.textContent = m.stop ? "Stop" : "Send";
      button.className = m.stop ? "danger" : "primary-small";
      button.disabled = !m.stop && !m.send;
      hint.textContent = m.hint ?? "";
      hint.hidden = m.hint === undefined;
    },
    focus: () => box.focus(),
  };
}
