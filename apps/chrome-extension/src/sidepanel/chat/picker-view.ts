// Picker DOM: a model button, an effort button, and a popover with a provider sidebar, a search box and a model list.
// The layout follows the model picker of the T3 Code UI. Identity names and model ids are untrusted, so they go in through textContent only.
// The popover is built once. The sidebar and the list are rebuilt only when the model changes, and the search box keeps focus.
import type { ChatProvider } from "../../../../../src/browser/chat-protocol.ts";
import { EMPTY_TEXT, FAVOURITES, LOCKED_HINT, favKey, menuKey, pickerRows, providerTabs, startTab, tabOrder } from "./picker.ts";
import type { Fav, PickerEntry, PickerModel } from "./picker.ts";
import { icon } from "./icons.ts";
import { providerIconSvg } from "./provider-icons.ts";

export interface PickerHandlers {
  /** Called each time the popover opens, so the owner can ask for the catalogue. */
  onOpen(): void;
  onPick(pick: { provider: ChatProvider; identity: string; model?: string }): void;
  onEffort(effort: string): void;
  /** Adds the model to the favourites, or removes it. */
  onFavourite(fav: Fav): void;
}
export interface Picker { root: HTMLElement; button: HTMLButtonElement; effortButton: HTMLButtonElement; update(m: PickerModel): void; close(): void }

export const SEARCH_PLACEHOLDER = "Search models...";
export const NO_PROVIDERS = "No providers are ready.";
export const LOADING_HINT = "Loading providers";

function mark(doc: Document, provider: ChatProvider | undefined, size: number): HTMLElement {
  const s = doc.createElement("span");
  s.className = "provider-mark";
  s.append(providerIconSvg(doc, provider, size));
  return s;
}

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function createPicker(doc: Document, h: PickerHandlers, label: string): Picker {
  const root = el(doc, "div", "picker");

  // The model button: the provider mark, the model name and a chevron.
  const button = el(doc, "button", "picker-button");
  button.type = "button";
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-label", label);
  const buttonMark = mark(doc, undefined, 16);
  // The mark of an unknown provider is on the button until a selection arrives.
  let markProvider: ChatProvider | undefined;
  const buttonText = el(doc, "span", "picker-label");
  button.append(buttonMark, buttonText, icon(doc, "chevron-down", 16));

  // The effort button and its small menu.
  const effortWrap = el(doc, "div", "picker-effort-wrap");
  const effortButton = el(doc, "button", "picker-button picker-effort");
  effortButton.type = "button";
  effortButton.setAttribute("aria-haspopup", "menu");
  effortButton.setAttribute("aria-expanded", "false");
  effortButton.setAttribute("aria-label", "Effort");
  const effortText = el(doc, "span", "picker-label");
  effortButton.append(effortText, icon(doc, "chevron-down", 16));
  const effortMenu = el(doc, "div", "picker-effort-menu");
  effortMenu.setAttribute("role", "menu");
  effortMenu.setAttribute("aria-label", "Effort");
  effortMenu.hidden = true;
  effortWrap.append(effortButton, effortMenu);
  effortWrap.hidden = true;

  // The popover: the sidebar, then the search box, the hints and the list.
  const pop = el(doc, "div", "picker-pop");
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Choose model");
  pop.hidden = true;
  const side = el(doc, "div", "picker-side");
  side.setAttribute("role", "tablist");
  side.setAttribute("aria-orientation", "vertical");
  side.setAttribute("aria-label", "Providers");
  const main = el(doc, "div", "picker-main");
  const searchRow = el(doc, "div", "picker-search");
  const search = el(doc, "input", "picker-search-input");
  search.type = "text";
  search.placeholder = SEARCH_PLACEHOLDER;
  search.setAttribute("aria-label", "Search models");
  search.setAttribute("autocomplete", "off");
  searchRow.append(icon(doc, "search", 18), search);
  const hints = el(doc, "div", "picker-hints");
  const list = el(doc, "div", "picker-list");
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Models");
  main.append(searchRow, hints, list);
  pop.append(side, main);
  root.append(button, effortWrap, pop);

  let model: PickerModel = { button: { label: "" }, groups: [], efforts: [], loading: true };
  let sig = "";
  let open = false;
  let effortOpen = false;
  let active = FAVOURITES;
  // True once the user picked a tab. Until then a catalogue that arrives late can still choose the start tab.
  let tabChosen = false;
  let query = "";
  let cursor = 0;
  let flat: PickerEntry[] = [];
  let rowNodes: HTMLElement[] = [];
  let effortItems: Array<{ node: HTMLButtonElement; value: string }> = [];
  let effortIndex = 0;
  let inside = false;

  const touch = (): void => { inside = true; };
  const searching = (): boolean => query.trim() !== "";
  const current = (): number => Math.min(cursor, Math.max(0, flat.length - 1));

  const scrollToRow = (block: "nearest" | "center"): void => {
    const node = rowNodes[current()] as (HTMLElement & { scrollIntoView?: (o: { block: string }) => void }) | undefined;
    node?.scrollIntoView?.({ block });
  };
  const paintHighlight = (block: "nearest" | "center" | undefined): void => {
    const at = current();
    rowNodes.forEach((n, i) => n.setAttribute("data-highlighted", String(i === at)));
    if (block !== undefined) scrollToRow(block);
  };

  /** Puts the popover above the anchor, or below it when there is no room above. The panel is narrow and short, so the popover stays inside it. */
  const place = (): void => {
    const win = doc.defaultView;
    const anchor = ((pop as HTMLElement & { offsetParent?: Element | null }).offsetParent ?? button) as Element;
    const r = anchor.getBoundingClientRect?.();
    if (!win || !r) return;
    const above = r.top - 14;
    const below = win.innerHeight - r.bottom - 14;
    const flip = above < 300 && below > above;
    pop.className = flip ? "picker-pop below" : "picker-pop";
    pop.style.maxHeight = `${Math.max(180, Math.floor(flip ? below : above))}px`;
  };

  const renderSide = (): void => {
    const tabs: HTMLElement[] = [];
    const tab = (id: string, name: string, glyph: Element): void => {
      const on = !searching() && active === id;
      const b = el(doc, "button", "picker-tab");
      b.type = "button";
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(on));
      b.setAttribute("aria-label", name);
      b.setAttribute("title", name);
      b.tabIndex = on ? 0 : -1;
      b.append(glyph, el(doc, "span", "picker-tab-label", name));
      b.addEventListener("click", () => { touch(); switchTab(id); });
      tabs.push(b);
    };
    tab(FAVOURITES, "Favourites", icon(doc, "star", 18));
    for (const t of providerTabs(model)) tab(t.provider, t.name, mark(doc, t.provider, 20));
    side.replaceChildren(...tabs);
  };

  const emptyText = (): string => (searching() ? EMPTY_TEXT.search : active === FAVOURITES ? EMPTY_TEXT.favourites : EMPTY_TEXT.provider);

  const renderHints = (): void => {
    const out: HTMLElement[] = [];
    const hint = (t: string): void => { out.push(el(doc, "p", "hint", t)); };
    if (model.loading) hint(LOADING_HINT);
    else if (model.groups.length === 0) hint(NO_PROVIDERS);
    if (model.locked) hint(LOCKED_HINT);
    if (model.notice !== undefined) hint(model.notice);
    hints.replaceChildren(...out);
    hints.hidden = out.length === 0;
  };

  const renderList = (): void => {
    const sections = pickerRows(model, active, query);
    flat = sections.flatMap(s => s.entries);
    const stars = new Set((model.favourites ?? []).map(favKey));
    rowNodes = [];
    const kids: HTMLElement[] = [];
    if (flat.length === 0 && !model.loading) kids.push(el(doc, "p", "picker-empty", emptyText()));
    let index = -1;
    for (const s of sections) {
      const group = el(doc, "div", "picker-group");
      group.setAttribute("role", "group");
      if (s.heading !== null) {
        group.setAttribute("aria-label", s.heading);
        const head = el(doc, "div", "picker-heading");
        if (s.provider !== undefined) head.append(mark(doc, s.provider, 14));
        head.append(el(doc, "span", "picker-heading-text", s.heading));
        group.append(head);
      }
      for (const e of s.entries) {
        index += 1;
        const at = index;
        const row = el(doc, "div", e.disabled ? "picker-row disabled" : "picker-row");
        row.setAttribute("role", "presentation");
        const opt = el(doc, "button", "picker-option");
        opt.type = "button";
        opt.tabIndex = -1;
        opt.setAttribute("role", "option");
        opt.setAttribute("aria-selected", String(e.selected));
        if (e.disabled) opt.setAttribute("aria-disabled", "true");
        const text = el(doc, "span", "picker-option-text");
        text.append(el(doc, "span", "picker-option-name", e.name), el(doc, "span", "picker-option-id", e.sub));
        opt.append(text);
        if (e.selected) opt.append(icon(doc, "check", 18));
        opt.addEventListener("click", () => { touch(); pickEntry(e); });
        opt.addEventListener("mousemove", () => { if (cursor !== at) { cursor = at; paintHighlight(undefined); } });
        row.append(opt);
        if (e.model !== undefined) {
          const fav: Fav = { provider: e.provider, identity: e.identity, model: e.model };
          const on = stars.has(e.key);
          const star = el(doc, "button", on ? "picker-star on" : "picker-star");
          star.type = "button";
          star.tabIndex = -1;
          star.setAttribute("aria-label", on ? `Remove ${e.name} from favourites` : `Add ${e.name} to favourites`);
          star.setAttribute("aria-pressed", String(on));
          star.append(icon(doc, on ? "star" : "star-outline", 18));
          star.addEventListener("click", () => { touch(); tabChosen = true; h.onFavourite(fav); search.focus(); });
          row.append(star);
        }
        rowNodes.push(row);
        group.append(row);
      }
      kids.push(group);
    }
    list.replaceChildren(...kids);
    paintHighlight(undefined);
  };

  const render = (): void => { renderSide(); renderHints(); renderList(); };

  const switchTab = (id: string): void => {
    active = id;
    tabChosen = true;
    query = "";
    search.value = "";
    cursor = 0;
    render();
    paintHighlight("nearest");
    search.focus();
  };

  const pickEntry = (e: PickerEntry): void => {
    if (e.disabled) return;
    h.onPick({ provider: e.provider, identity: e.identity, ...(e.model !== undefined ? { model: e.model } : {}) });
    setOpen(false, true);
  };

  const setOpen = (v: boolean, refocus: boolean): void => {
    if (v === open) return;
    if (v && effortOpen) setEffortOpen(false, false);
    open = v;
    pop.hidden = !v;
    button.setAttribute("aria-expanded", String(v));
    if (v) {
      h.onOpen();
      active = startTab(model);
      tabChosen = false;
      query = "";
      search.value = "";
      cursor = 0;
      render();
      cursor = Math.max(0, flat.findIndex(e => e.selected));
      paintHighlight(undefined);
      place();
      search.focus();
      scrollToRow("center");
    } else if (refocus) button.focus();
  };

  // ---- the effort menu ------------------------------------------------------------------------------------------

  const focusEffort = (): void => { effortItems.forEach((e, i) => { e.node.tabIndex = i === effortIndex ? 0 : -1; }); effortItems[effortIndex]?.node.focus(); };
  const renderEffort = (): void => {
    effortItems = model.efforts.map(value => {
      const b = el(doc, "button", "picker-item");
      b.type = "button";
      b.tabIndex = -1;
      b.setAttribute("role", "menuitemradio");
      b.setAttribute("aria-checked", String(value === model.effort));
      b.append(el(doc, "span", "picker-item-name", value));
      if (value === model.effort) b.append(icon(doc, "check", 16));
      b.addEventListener("click", () => { touch(); h.onEffort(value); setEffortOpen(false, true); });
      return { node: b, value };
    });
    effortMenu.replaceChildren(...effortItems.map(e => e.node));
  };
  const setEffortOpen = (v: boolean, refocus: boolean): void => {
    if (v === effortOpen) return;
    if (v && open) setOpen(false, false);
    effortOpen = v;
    effortMenu.hidden = !v;
    effortButton.setAttribute("aria-expanded", String(v));
    if (v) {
      h.onOpen();
      renderEffort();
      effortIndex = Math.max(0, effortItems.findIndex(e => e.value === model.effort));
      focusEffort();
    } else if (refocus) effortButton.focus();
  };

  // ---- events ---------------------------------------------------------------------------------------------------

  // The buttons keep the focus where it is on a mouse press, so a press on an open picker closes it instead of closing and opening it again.
  const keepFocus = (e: Event): void => { e.preventDefault(); };
  button.addEventListener("mousedown", keepFocus);
  effortButton.addEventListener("mousedown", keepFocus);
  pop.addEventListener("mousedown", e => { if ((e as MouseEvent).target !== search) e.preventDefault(); });
  pop.addEventListener("click", touch);
  effortMenu.addEventListener("click", touch);

  button.addEventListener("click", () => { touch(); setOpen(!open, false); });
  button.addEventListener("keydown", e => {
    if (open || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
    e.preventDefault();
    setOpen(true, false);
  });
  effortButton.addEventListener("click", () => { touch(); setEffortOpen(!effortOpen, false); });
  effortButton.addEventListener("keydown", e => {
    if (effortOpen) return;
    const r = menuKey({ open: false, index: 0, count: model.efforts.length }, e.key);
    if (!r.open) return;
    e.preventDefault();
    setEffortOpen(true, false);
    effortIndex = r.index;
    focusEffort();
  });
  effortMenu.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") return; // The focused item is a button and its click does the work.
    const r = menuKey({ open: effortOpen, index: effortIndex, count: effortItems.length }, e.key);
    if (r.index !== effortIndex || r.open !== effortOpen) e.preventDefault();
    effortIndex = r.index;
    if (!r.open) setEffortOpen(false, true); else focusEffort();
  });

  search.addEventListener("input", () => { query = search.value; cursor = 0; render(); paintHighlight("nearest"); });
  search.addEventListener("keydown", e => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (flat.length === 0) return;
      cursor = (current() + (e.key === "ArrowDown" ? 1 : -1) + flat.length) % flat.length;
      paintHighlight("nearest");
    } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !searching()) {
      e.preventDefault();
      const order = tabOrder(model);
      const at = Math.max(0, order.indexOf(active));
      switchTab(order[(at + (e.key === "ArrowRight" ? 1 : -1) + order.length) % order.length]!);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = flat[current()];
      if (pick) pickEntry(pick);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false, true);
    }
  });
  // Escape from a part of the popover that is not the search box (a tab or a star that took focus by the keyboard).
  pop.addEventListener("keydown", e => {
    if ((e as KeyboardEvent).key === "Escape" && (e as KeyboardEvent).target !== search) { e.preventDefault(); setOpen(false, true); }
  });
  // Focus that moves outside the picker, or to one of its two buttons (Shift+Tab), closes the popover. A null target (a removed node) does not.
  root.addEventListener("focusout", e => {
    const to = (e as FocusEvent).relatedTarget as Node | null;
    if (!to) return;
    const away = !root.contains(to) || to === button || to === effortButton;
    if (open && away) setOpen(false, false);
    if (effortOpen && away) setEffortOpen(false, false);
  });
  doc.addEventListener("click", () => { if (!inside) { setOpen(false, false); setEffortOpen(false, false); } inside = false; });

  return {
    root, button, effortButton,
    update(m) {
      model = m;
      if (m.button.provider !== markProvider) {
        markProvider = m.button.provider;
        buttonMark.replaceChildren(providerIconSvg(doc, markProvider, 16));
      }
      if (buttonText.textContent !== m.button.label) buttonText.textContent = m.button.label;
      effortWrap.hidden = m.efforts.length === 0;
      const effortLabel = m.effort ?? "Effort";
      if (effortText.textContent !== effortLabel) effortText.textContent = effortLabel;
      if (m.efforts.length === 0 && effortOpen) setEffortOpen(false, false);
      const next = JSON.stringify(m);
      if (next === sig) return;
      sig = next;
      if (open) {
        if (!tabChosen || !tabOrder(m).includes(active)) active = startTab(m);
        render();
      }
      if (effortOpen) {
        const keptValue = effortItems[effortIndex]?.value;
        const hadFocus = effortItems[effortIndex] !== undefined && doc.activeElement === effortItems[effortIndex]!.node;
        renderEffort();
        const at = keptValue === undefined ? -1 : effortItems.findIndex(e => e.value === keptValue);
        effortIndex = at >= 0 ? at : 0;
        effortItems.forEach((e, i) => { e.node.tabIndex = i === effortIndex ? 0 : -1; });
        if (hadFocus) effortItems[effortIndex]?.node.focus();
      }
    },
    close: () => { setOpen(false, false); setEffortOpen(false, false); },
  };
}
