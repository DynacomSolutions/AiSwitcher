// The approval card for request_group. The side panel and the popup page render the same markup. Plain DOM.
import type { PendingRequest } from "./request.ts";
import { countdownText, REQUEST_TITLE } from "./request.ts";

function el(doc: Document, tag: string, cls: string, ...kids: Array<Node | string>): HTMLElement {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  e.append(...kids.map(k => (typeof k === "string" ? doc.createTextNode(k) : k)));
  return e;
}

export function renderRequest(doc: Document, r: PendingRequest, now: number, onAnswer: (id: string, approve: boolean) => void): HTMLElement {
  const approve = el(doc, "button", "primary", "Approve");
  approve.setAttribute("type", "button");
  const deny = el(doc, "button", "danger", "Deny");
  deny.setAttribute("type", "button");
  let answered = false;
  const lock = (): boolean => {
    if (answered) return false;
    answered = true; (approve as HTMLButtonElement).disabled = true; (deny as HTMLButtonElement).disabled = true;
    return true;
  };
  approve.addEventListener("click", () => { if (lock()) onAnswer(r.id, true); });
  deny.addEventListener("click", () => { if (lock()) onAnswer(r.id, false); });
  const card = el(doc, "section", "card request",
    el(doc, "h2", "", REQUEST_TITLE),
    el(doc, "dl", "kv",
      el(doc, "dt", "", "Agent"), el(doc, "dd", "", r.agentLabel),
      el(doc, "dt", "", "Group"), el(doc, "dd", "", r.groupTitle === "" ? "Untitled group" : r.groupTitle),
      el(doc, "dt", "", "Tabs"), el(doc, "dd", "", String(r.tabCount))),
    el(doc, "p", r.allowClose ? "consent close" : "consent", r.consent));
  if (r.note) card.append(el(doc, "p", "hint", r.note));
  const left = el(doc, "span", "countdown", countdownText(r.deadline, now));
  card.append(el(doc, "div", "actions", approve, deny, left));
  card.setAttribute("role", "group");
  card.setAttribute("aria-label", REQUEST_TITLE);
  return card;
}

/** Fills `root` with one card per request, or leaves it empty. */
export function renderRequests(doc: Document, root: HTMLElement, list: PendingRequest[], now: number, onAnswer: (id: string, approve: boolean) => void): void {
  root.hidden = list.length === 0;
  root.replaceChildren(...list.map(r => renderRequest(doc, r, now, onAnswer)));
}

export interface RequestViewDeps {
  doc: Document;
  root: HTMLElement;
  fetch(): Promise<PendingRequest[]>;
  answer(id: string, approve: boolean): Promise<unknown>;
  now(): number;
  /** Keeps only the requests this view shows (the popup shows one). */
  only?: string;
  /** Called when the list becomes empty after it held a request. */
  onEmpty?: () => void;
}

/** Keeps the cards current. `refresh` reloads the list; `tick` redraws the countdown. */
export function createRequestView(d: RequestViewDeps): { refresh(): Promise<void>; tick(): void } {
  let list: PendingRequest[] = [];
  let seen = false;
  const draw = (): void => {
    renderRequests(d.doc, d.root, list, d.now(), (id, approve) => { void d.answer(id, approve).then(() => refresh(), () => refresh()); });
  };
  async function refresh(): Promise<void> {
    try { list = (await d.fetch()).filter(r => d.only === undefined || r.id === d.only); } catch { list = []; }
    draw();
    if (list.length > 0) seen = true;
    else if (seen || d.only !== undefined) d.onEmpty?.();
  }
  return { refresh, tick: () => { if (list.length > 0) draw(); } };
}
