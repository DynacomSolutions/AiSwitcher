// Picker DOM: a button and a menu. Identity names and model ids are untrusted, so they go in through textContent only.
// The button is built once. The menu items are rebuilt only when the model changes, and focus stays on the same item.
import type { ChatProvider } from "../../../../../src/browser/chat-protocol.ts";
import { LOCKED_HINT, menuKey } from "./picker.ts";
import type { PickerModel } from "./picker.ts";
import { providerMark } from "./provider-icons.ts";

export interface PickerHandlers {
  /** Called each time the menu opens, so the owner can ask for the catalogue. */
  onOpen(): void;
  onPick(pick: { provider: ChatProvider; identity: string; model?: string }): void;
  onEffort(effort: string): void;
}
export interface Picker { root: HTMLElement; button: HTMLButtonElement; update(m: PickerModel): void; close(): void }

interface Entry { key: string; node: HTMLButtonElement; act(): void }

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
  // The panel holds the hints and the menu. Hints stay outside the role="menu" element.
  const panel = doc.createElement("div");
  panel.className = "picker-menu";
  panel.hidden = true;
  const hints = doc.createElement("div");
  hints.className = "picker-hints";
  const menu = doc.createElement("div");
  menu.className = "picker-items";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", label);
  panel.append(hints, menu);
  root.append(button, panel);

  let sig = "";
  let open = false;
  let index = 0;
  let entries: Entry[] = [];
  let inside = false;

  const focusIndex = (): void => { entries.forEach((e, i) => { e.node.tabIndex = i === index ? 0 : -1; }); entries[index]?.node.focus(); };
  const setOpen = (v: boolean, refocus: boolean): void => {
    if (v === open) return;
    open = v;
    panel.hidden = !v;
    button.setAttribute("aria-expanded", String(v));
    if (v) { h.onOpen(); index = Math.max(0, entries.findIndex(e => e.node.getAttribute("aria-checked") === "true")); focusIndex(); }
    else if (refocus) button.focus();
  };

  const rebuild = (m: PickerModel): void => {
    const keptKey = open ? entries[index]?.key : undefined;
    const hadFocus = open && entries[index] !== undefined && doc.activeElement === entries[index]!.node;
    const next: Entry[] = [];
    const hintNodes: HTMLElement[] = [];
    const hint = (t: string): void => { const p = doc.createElement("p"); p.className = "hint"; p.textContent = t; hintNodes.push(p); };
    const groups: HTMLElement[] = [];
    const group = (name: string): HTMLElement => {
      const g = doc.createElement("div");
      g.setAttribute("role", "group");
      g.setAttribute("aria-label", name);
      groups.push(g);
      return g;
    };
    const heading = (g: HTMLElement, t: string): void => { const p = doc.createElement("div"); p.className = "picker-heading"; p.setAttribute("role", "presentation"); p.textContent = t; g.append(p); };
    const radio = (g: HTMLElement, key: string, cls: string, checked: boolean, disabled: boolean, act: () => void, ...kids: Array<HTMLElement | string>): void => {
      const b = doc.createElement("button");
      b.type = "button";
      b.className = cls;
      b.setAttribute("role", "menuitemradio");
      b.setAttribute("aria-checked", String(checked));
      if (disabled) b.setAttribute("aria-disabled", "true");
      b.tabIndex = -1;
      for (const k of kids) { if (typeof k === "string") { const s = doc.createElement("span"); s.textContent = k; b.append(s); } else b.append(k); }
      const e: Entry = { key, node: b, act: () => { if (!disabled) act(); } };
      b.addEventListener("click", () => { if (disabled) return; e.act(); setOpen(false, true); });
      next.push(e);
      g.append(b);
    };
    if (m.loading) hint("Loading providers");
    else if (m.groups.length === 0) hint("No providers are ready.");
    if (m.locked) hint(LOCKED_HINT);
    if (m.notice !== undefined) hint(m.notice);
    const ids = group("Identity");
    for (const g of m.groups) {
      heading(ids, providerMark(g.provider).name);
      for (const i of g.identities) {
        const kids: Array<HTMLElement | string> = [mark(doc, g.provider), i.name];
        if (i.kind === "pool") { const badge = doc.createElement("span"); badge.className = "picker-badge"; badge.textContent = "Pool"; kids.push(badge); }
        radio(ids, `i:${g.provider}:${i.name}`, "picker-item", i.selected, m.locked === true && !i.selected, () => h.onPick({ provider: g.provider, identity: i.name }), ...kids);
      }
    }
    const current = m.groups.flatMap(g => g.identities.map(i => ({ g, i }))).find(x => x.i.selected);
    if (current && current.i.models.length > 0) {
      const mg = group("Model");
      heading(mg, "Model");
      for (const mo of current.i.models) radio(mg, `m:${mo.id}`, "picker-item", mo.selected, false, () => h.onPick({ provider: current.g.provider, identity: current.i.name, model: mo.id }), mo.name);
    }
    if (m.efforts.length > 0) {
      const eg = group("Effort");
      heading(eg, "Effort");
      for (const e of m.efforts) radio(eg, `e:${e}`, "picker-item", e === m.effort, false, () => h.onEffort(e), e);
    }
    entries = next;
    hints.replaceChildren(...hintNodes);
    for (const g of groups) if (g.children.length === 0) g.remove();
    menu.replaceChildren(...groups);
    const byKey = keptKey === undefined ? -1 : entries.findIndex(e => e.key === keptKey);
    index = byKey >= 0 ? byKey : Math.min(index, Math.max(0, entries.length - 1));
    if (open) { entries.forEach((e, i) => { e.node.tabIndex = i === index ? 0 : -1; }); if (hadFocus) entries[index]?.node.focus(); }
  };

  button.addEventListener("click", () => { inside = true; setOpen(!open, false); });
  button.addEventListener("keydown", e => {
    if (open) return;
    const r = menuKey({ open, index, count: entries.length }, e.key);
    if (r.open) { e.preventDefault(); setOpen(true, false); index = r.index; focusIndex(); }
  });
  panel.addEventListener("click", () => { inside = true; });
  menu.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") return; // The focused item is a button and its click does the work.
    const r = menuKey({ open, index, count: entries.length }, e.key);
    if (r.index !== index || r.open !== open) e.preventDefault();
    index = r.index;
    if (!r.open) setOpen(false, true); else focusIndex();
  });
  menu.addEventListener("focusin", e => {
    const i = entries.findIndex(en => en.node === (e as FocusEvent).target);
    if (i >= 0) index = i;
  });
  // Focus that moves to the button (Shift+Tab) or to another element outside the picker closes the menu. A null target (a removed node) does not.
  root.addEventListener("focusout", e => {
    const to = (e as FocusEvent).relatedTarget as Node | null;
    if (open && to && (to === button || !root.contains(to))) setOpen(false, false);
  });
  doc.addEventListener("click", () => { if (!inside) setOpen(false, false); inside = false; });

  return {
    root, button,
    update(m) {
      icon.textContent = m.button.providerIcon;
      icon.style.background = providerMark(m.groups.find(g => g.identities.some(i => i.selected))?.provider).colour;
      if (text.textContent !== m.button.label) text.textContent = m.button.label;
      const next = JSON.stringify(m);
      if (next !== sig) { sig = next; rebuild(m); }
    },
    close: () => setOpen(false, false),
  };
}
