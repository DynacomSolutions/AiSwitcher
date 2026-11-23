// Composer: pure state rules plus the DOM of the message box.
import { MAX_CHAT_TEXT } from "../../../../../src/browser/chat-protocol.ts";
import type { ChatView } from "../../shared/chat.ts";
import { icon } from "./icons.ts";

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
export interface Composer {
  root: HTMLElement;
  box: HTMLTextAreaElement;
  /** The left side of the bottom row. The owner puts the model picker here. */
  tools: HTMLElement;
  send: HTMLButtonElement;
  stop: HTMLButtonElement;
  update(mode: { send: boolean; stop: boolean; hint?: string }): void;
  focus(): void;
}

/**
 * Builds the message box: one rounded card with the text on top and a bottom row inside it.
 * The tools (model and effort) are on the left of the row, Send or Stop on the right.
 * Enter sends, Shift+Enter adds a line. The draft stays when the mode changes or a send fails.
 */
export function createComposer(doc: Document, h: ComposerHandlers): Composer {
  const root = doc.createElement("div");
  root.className = "composer";
  const hint = doc.createElement("p");
  hint.className = "hint composer-hint";
  const card = doc.createElement("div");
  card.className = "composer-card";
  const box = doc.createElement("textarea");
  box.className = "composer-box";
  box.rows = 2;
  box.maxLength = MAX_CHAT_TEXT;
  box.placeholder = "Message the agent";
  box.setAttribute("aria-label", "Message");
  const tools = doc.createElement("div");
  tools.className = "composer-tools";
  const send = doc.createElement("button");
  send.type = "button";
  send.className = "composer-send";
  send.setAttribute("aria-label", "Send");
  send.append(icon(doc, "send", 30));
  const stop = doc.createElement("button");
  stop.type = "button";
  stop.className = "composer-stop";
  stop.setAttribute("aria-label", "Stop");
  const stopLabel = doc.createElement("span");
  stopLabel.textContent = "Stop";
  stop.append(icon(doc, "stop", 16), stopLabel);
  stop.hidden = true;
  const bar = doc.createElement("div");
  bar.className = "composer-bar";
  bar.append(tools, send, stop);
  card.append(box, bar);
  root.append(hint, card);
  let mode = { send: false, stop: false } as { send: boolean; stop: boolean };
  let sending = false;
  /** Send looks dim while the box is empty. It stays clickable: an empty send does nothing. */
  const paintSend = (): void => { send.className = box.value.trim() === "" ? "composer-send idle" : "composer-send"; };
  paintSend();
  const submit = (): void => {
    const text = box.value.trim();
    if (!mode.send || sending || text.length === 0 || text.length > MAX_CHAT_TEXT) return;
    sending = true;
    void h.onSend(text).then(ok => { if (ok && box.value.trim() === text) { box.value = ""; paintSend(); } }, () => { /* the draft stays */ }).finally(() => { sending = false; });
  };
  box.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
  });
  box.addEventListener("input", paintSend);
  send.addEventListener("click", submit);
  stop.addEventListener("click", () => { if (mode.stop) h.onStop(); });
  return {
    root,
    box,
    tools,
    send,
    stop,
    update(m) {
      mode = m;
      send.hidden = m.stop;
      stop.hidden = !m.stop;
      send.disabled = !m.send;
      hint.textContent = m.hint ?? "";
      hint.hidden = m.hint === undefined;
    },
    focus: () => box.focus(),
  };
}
