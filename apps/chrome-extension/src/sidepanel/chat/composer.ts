// Composer: pure state rules plus the DOM of the message box.
import { MAX_CHAT_TEXT } from "../../../../../src/browser/chat-protocol.ts";
import type { ChatView } from "../../shared/chat.ts";

export const NO_PAGES_HINT = "No pages are linked. The agent cannot see any tab.";
export const PAUSED_HINT = "Browser control is paused. The agent can still reply.";

export function composerMode(c: ChatView | undefined, paused: boolean): { send: boolean; stop: boolean; hint?: string } {
  if (!c) return { send: false, stop: false };
  const s = c.summary.state;
  const running = s === "thinking" || s === "waiting";
  // A new chat reads "starting" until its first prompt: the gateway starts the agent then. So that first prompt must be possible.
  // Once the user has prompted, "starting" means the agent is on its way up, and Send waits.
  const starting = s === "starting" && c.items.some(i => i.body.k === "user");
  const hint = paused ? PAUSED_HINT : c.summary.tabIds.length === 0 ? NO_PAGES_HINT : undefined;
  return { send: !running && !starting && s !== "closed", stop: running, ...(hint ? { hint } : {}) };
}

export interface ComposerHandlers {
  /** Resolves true when the message was accepted. The draft stays until then. */
  onSend(text: string): Promise<boolean>;
  onStop(): void;
}
export interface Composer { root: HTMLElement; box: HTMLTextAreaElement; update(mode: { send: boolean; stop: boolean; hint?: string }): void; focus(): void }

/** Builds the message box. Enter sends, Shift+Enter adds a line. The draft stays when the mode changes or a send fails. */
export function createComposer(doc: Document, h: ComposerHandlers): Composer {
  const root = doc.createElement("div");
  root.className = "composer";
  const hint = doc.createElement("p");
  hint.className = "hint composer-hint";
  const box = doc.createElement("textarea");
  box.className = "composer-box";
  box.rows = 2;
  box.maxLength = MAX_CHAT_TEXT;
  box.placeholder = "Message the agent";
  box.setAttribute("aria-label", "Message");
  const button = doc.createElement("button");
  button.type = "button";
  const row = doc.createElement("div");
  row.className = "composer-row";
  row.append(box, button);
  root.append(hint, row);
  let mode = { send: false, stop: false } as { send: boolean; stop: boolean };
  let sending = false;
  const submit = (): void => {
    const text = box.value.trim();
    if (!mode.send || sending || text.length === 0 || text.length > MAX_CHAT_TEXT) return;
    sending = true;
    void h.onSend(text).then(ok => { if (ok && box.value.trim() === text) box.value = ""; }, () => { /* the draft stays */ }).finally(() => { sending = false; });
  };
  box.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
  });
  button.addEventListener("click", () => { if (mode.stop) h.onStop(); else submit(); });
  return {
    root,
    box,
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
