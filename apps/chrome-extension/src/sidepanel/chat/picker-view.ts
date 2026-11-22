// Picker DOM: a button and a menu. Identity names and model ids are untrusted, so they go in through textContent only.
// The button is built once. The menu items are rebuilt only when the model changes, and focus stays on the same index.
import type { ChatProvider } from "../../../../../src/browser/chat-protocol.ts";
import { menuKey } from "./picker.ts";
import type { PickerModel } from "./picker.ts";
import { providerMark } from "./provider-icons.ts";

export interface PickerHandlers {
  /** Called each time the menu opens, so the owner can ask for the catalogue. */
  onOpen(): void;
  onPick(pick: { provider: ChatProvider; identity: string; model?: string }): void;
  onEffort(effort: string): void;
}
export interface Picker { root: HTMLElement; button: HTMLButtonElement; update(m: PickerModel): void; close(): void }

interface Entry { node: HTMLButtonElement; act(): void }

function mark(doc: Document, provider: ChatProvider | undefined): HTMLElement {
  const m = providerMark(provider);
  const s = doc.createElement("span");
  s.className = "provider-mark";
  s.textContent = m.text;
  s.style.background = m.colour;
  s.setAttribute("aria-hidden", "true");
  return s;
}

export function createPicker(doc: Document, h: PickerHandlers, label: string): Picker {
  const root = doc.createElement("div");
  root.className = "picker";
  const button = doc.createElement("button");
  button.type = "button";
  button.className = "picker-button";
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-label", label);
  const icon = doc.createElement("span");
  icon.className = "provider-mark";
  icon.setAttribute("aria-hidden", "true");
  const text = doc.createElement("span");
  text.className = "picker-label";
  button.append(icon, text);
  const menu = doc.createElement("div");
  menu.className = "picker-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", label);
  menu.hidden = true;
  root.append(button, menu);

  let sig = "";
  let open = false;
  let index = 0;
  let entries: Entry[] = [];
  let inside = false;

  const focusIndex = (): void => { entries.forEach((e, i) => { e.node.tabIndex = i === index ? 0 : -1; }); entries[index]?.node.focus(); };
  const setOpen = (v: boolean, refocus: boolean): void => {
    if (v === open) return;
    open = v;
    menu.hidden = !v;
    button.setAttribute("aria-expanded", String(v));
    if (v) { h.onOpen(); index = Math.max(0, entries.findIndex(e => e.node.getAttribute("aria-checked") === "true")); focusIndex(); }
    else if (refocus) button.focus();
  };

  const rebuild = (m: PickerModel): void => {
    const items: HTMLElement[] = [];
    const next: Entry[] = [];
    const add = (node: HTMLButtonElement, act: () => void): void => { next.push({ node, act }); items.push(node); };
    const radio = (cls: string, checked: boolean, ...kids: Array<HTMLElement | string>): HTMLButtonElement => {
      const b = doc.createElement("button");
      b.type = "button";
      b.className = cls;
      b.setAttribute("role", "menuitemradio");
      b.setAttribute("aria-checked", String(checked));
      b.tabIndex = -1;
      for (const k of kids) { if (typeof k === "string") { const s = doc.createElement("span"); s.textContent = k; b.append(s); } else b.append(k); }
      return b;
    };
    const heading = (t: string): HTMLElement => { const p = doc.createElement("div"); p.className = "picker-heading"; p.setAttribute("role", "presentation"); p.textContent = t; return p; };
    if (m.loading) { const p = doc.createElement("p"); p.className = "hint"; p.textContent = "Loading providers"; items.push(p); }
    else if (m.groups.length === 0) { const p = doc.createElement("p"); p.className = "hint"; p.textContent = "No providers are ready."; items.push(p); }
    for (const g of m.groups) {
      items.push(heading(providerMark(g.provider).name));
      for (const i of g.identities) {
        const kids: Array<HTMLElement | string> = [mark(doc, g.provider), i.name];
        if (i.kind === "pool") { const badge = doc.createElement("span"); badge.className = "picker-badge"; badge.textContent = "Pool"; kids.push(badge); }
        add(radio("picker-item", i.selected, ...kids), () => h.onPick({ provider: g.provider, identity: i.name }));
        if (i.selected) for (const mo of i.models) add(radio("picker-item picker-model", mo.selected, mo.name), () => h.onPick({ provider: g.provider, identity: i.name, model: mo.id }));
      }
    }
    if (m.notice !== undefined) { const p = doc.createElement("p"); p.className = "hint"; p.textContent = m.notice; items.push(p); }
    if (m.efforts.length > 0) {
      items.push(heading("Effort"));
      for (const e of m.efforts) add(radio("picker-item picker-model", e === m.effort, e), () => h.onEffort(e));
    }
    for (const e of next) e.node.addEventListener("click", () => { e.act(); setOpen(false, true); });
    entries = next;
    menu.replaceChildren(...items);
    index = Math.min(index, Math.max(0, entries.length - 1));
    if (open) focusIndex();
  };

  button.addEventListener("click", () => { inside = true; setOpen(!open, false); });
  button.addEventListener("keydown", e => {
    if (open) return;
    const r = menuKey({ open, index, count: entries.length }, e.key);
    if (r.open) { e.preventDefault(); setOpen(true, false); index = r.index; focusIndex(); }
  });
  menu.addEventListener("click", () => { inside = true; });
  menu.addEventListener("keydown", e => {
    if (e.key === "Tab") { setOpen(false, false); return; }
    if (e.key === "Enter" || e.key === " ") return; // The focused item is a button and its click does the work.
    const r = menuKey({ open, index, count: entries.length }, e.key);
    if (r.index !== index || r.open !== open) e.preventDefault();
    index = r.index;
    if (!r.open) setOpen(false, true); else focusIndex();
  });
  doc.addEventListener("click", () => { if (!inside) setOpen(false, false); inside = false; });

  return {
    root, button,
    update(m) {
      icon.textContent = m.button.providerIcon;
      const colour = providerMark(m.groups.find(g => g.identities.some(i => i.selected))?.provider).colour;
      icon.style.background = colour;
      if (text.textContent !== m.button.label) text.textContent = m.button.label;
      const next = JSON.stringify(m);
      if (next !== sig) { sig = next; rebuild(m); }
    },
    close: () => setOpen(false, false),
  };
}
