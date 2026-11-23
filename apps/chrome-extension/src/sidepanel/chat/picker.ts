// Provider, identity and model picker: the pure model and the key rules. The DOM is in picker-view.ts.
import { CHAT_PROVIDERS, selectable } from "../../../../../src/browser/chat-protocol.ts";
import type { ChatCatalogProvider, ChatProvider, ChatSelection } from "../../../../../src/browser/chat-protocol.ts";
import { providerMark } from "./provider-icons.ts";

export interface PickerModel {
  button: { provider?: ChatProvider; label: string };
  groups: Array<{ provider: ChatProvider; identities: Array<{ name: string; kind: "identity" | "pool"; selected: boolean; models: Array<{ id: string; name: string; selected: boolean }> }> }>;
  efforts: string[];
  effort?: string;
  loading: boolean;
  notice?: string;
  /** An open chat cannot change provider or identity. Other identities show as disabled. */
  locked?: boolean;
  /** The starred models. They live in local storage, so they are not part of the catalogue. */
  favourites?: Fav[];
}
export interface LiveConfig { models: Array<{ id: string; name: string }>; efforts: string[]; current: { model?: string; effort?: string } }
export const NO_MODEL = "Choose a model";
export const DEFAULT_MODEL_NOTICE = "The agent's default model will be used.";
export const LOCKED_HINT = "Start a new chat to use a different provider or identity.";

const okModels = (m: Array<{ id: string; name: string }>): Array<{ id: string; name: string }> => m.filter(x => selectable(x.id));

/** The live ACP config replaces the catalog models of the selected identity. */
export function buildPicker(catalog: ChatCatalogProvider[] | undefined, sel: ChatSelection | undefined, live?: LiveConfig): PickerModel {
  const currentModel = live ? (live.current.model ?? sel?.model) : sel?.model;
  const effort = live ? (live.current.effort ?? sel?.effort) : sel?.effort;
  let efforts: string[] = live ? live.efforts.filter(selectable) : [];
  let notice: string | undefined;
  let label: string | undefined;
  const groups: PickerModel["groups"] = [];
  for (const p of catalog ?? []) {
    if (p.identities.length === 0) continue;
    const identities = p.identities.filter(i => selectable(i.name)).map(i => {
      const selected = sel !== undefined && sel.provider === p.provider && sel.identity === i.name;
      const source = okModels(selected && live ? live.models : i.models);
      const models = source.map(m => ({ id: m.id, name: m.name, selected: selected && m.id === currentModel }));
      if (selected) {
        if (!live) efforts = p.efforts.filter(selectable);
        if (i.modelsError && !live) notice = i.modelsError;
        else if (models.length === 0) notice = DEFAULT_MODEL_NOTICE;
        label = models.find(m => m.selected)?.name;
      }
      return { name: i.name, kind: i.kind, selected, models };
    });
    groups.push({ provider: p.provider, identities });
  }
  const text = label ?? (sel && currentModel) ?? NO_MODEL;
  return {
    button: { ...(sel !== undefined ? { provider: sel.provider } : {}), label: text },
    groups, efforts, ...(effort !== undefined && efforts.includes(effort) ? { effort } : {}),
    loading: catalog === undefined,
    ...(notice !== undefined ? { notice } : {}),
  };
}

/** Applies a pick. A new provider or identity starts on its first model and drops an effort it does not offer. */
export function choose(sel: ChatSelection | undefined, pick: { provider: ChatProvider; identity: string; model?: string }, catalog: ChatCatalogProvider[]): ChatSelection {
  const group = catalog.find(p => p.provider === pick.provider);
  const identity = group?.identities.find(i => i.name === pick.identity);
  const changed = !sel || sel.provider !== pick.provider || sel.identity !== pick.identity;
  const picked = pick.model !== undefined && selectable(pick.model) ? pick.model : undefined;
  const model = picked ?? (changed ? okModels(identity?.models ?? [])[0]?.id : sel?.model);
  const effort = sel?.effort !== undefined && selectable(sel.effort) && group?.efforts.includes(sel.effort) ? sel.effort : undefined;
  return { provider: pick.provider, identity: pick.identity, ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}) };
}

/** Keyboard rules of the menu. A closed menu opens on an arrow key or Enter. */
export function menuKey(state: { open: boolean; index: number; count: number }, key: string): { open: boolean; index: number } {
  const { open, index, count } = state;
  const last = Math.max(0, count - 1);
  if (!open) return key === "ArrowDown" || key === "ArrowUp" || key === "Enter" ? { open: true, index: key === "ArrowUp" ? last : 0 } : { open, index };
  switch (key) {
    case "ArrowDown": return { open, index: count === 0 ? 0 : (index + 1) % count };
    case "ArrowUp": return { open, index: count === 0 ? 0 : (index - 1 + count) % count };
    case "Home": return { open, index: 0 };
    case "End": return { open, index: last };
    case "Escape": case "Enter": return { open: false, index };
    default: return { open, index };
  }
}


// ---- the model list of the popover ----------------------------------------------------------------------------

/** A starred model: the pick that a click makes. */
export interface Fav { provider: ChatProvider; identity: string; model: string }
/** The id of the Favourites tab. A provider id never equals it. */
export const FAVOURITES = "favourites";
export const EMPTY_TEXT = {
  favourites: "No favourites yet",
  search: "No models found",
  provider: "No models are available for this provider.",
};
export const DEFAULT_ROW_NAME = "Default model";
export const DEFAULT_ROW_SUB = "Chosen by the agent";
const MAX_FAVOURITES = 200;

export const favKey = (f: Fav): string => [f.provider, f.identity, f.model].join("\u0000");

/** Accepts stored favourites only when each has a known provider and selectable names. A bad entry is dropped. */
export function parseFavourites(v: unknown): Fav[] {
  if (!Array.isArray(v)) return [];
  const out: Fav[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    if (!(CHAT_PROVIDERS as readonly unknown[]).includes(r.provider) || typeof r.identity !== "string" || typeof r.model !== "string" || !selectable(r.identity) || !selectable(r.model)) continue;
    const f: Fav = { provider: r.provider as ChatProvider, identity: r.identity, model: r.model };
    if (seen.has(favKey(f))) continue;
    seen.add(favKey(f));
    out.push(f);
    if (out.length >= MAX_FAVOURITES) break;
  }
  return out;
}

/** Adds the favourite when it is new, else removes it. */
export function toggleFavourite(list: Fav[], f: Fav): Fav[] {
  const key = favKey(f);
  return list.some(x => favKey(x) === key) ? list.filter(x => favKey(x) !== key) : [...list, f].slice(-MAX_FAVOURITES);
}

/** One row of the model list. An identity with no model list gets one default row, so it stays pickable. */
export interface PickerEntry {
  key: string;
  provider: ChatProvider;
  providerName: string;
  identity: string;
  kind: "identity" | "pool";
  /** Absent on the default row. */
  model?: string;
  name: string;
  sub: string;
  selected: boolean;
  /** A locked chat cannot move to another identity. */
  disabled: boolean;
}
/** A search or favourites heading names a provider, so it carries the provider for its mark. */
export interface PickerSection { heading: string | null; provider?: ChatProvider; entries: PickerEntry[] }

export function pickerEntries(m: PickerModel): PickerEntry[] {
  const out: PickerEntry[] = [];
  for (const g of m.groups) {
    const providerName = providerMark(g.provider).name;
    for (const i of g.identities) {
      const disabled = m.locked === true && !i.selected;
      const base = { provider: g.provider, providerName, identity: i.name, kind: i.kind, disabled };
      if (i.models.length === 0) out.push({ ...base, key: `${g.provider}\u0000${i.name}`, name: DEFAULT_ROW_NAME, sub: DEFAULT_ROW_SUB, selected: i.selected });
      else for (const mo of i.models) out.push({ ...base, key: favKey({ provider: g.provider, identity: i.name, model: mo.id }), model: mo.id, name: mo.name, sub: mo.id, selected: mo.selected });
    }
  }
  return out;
}

/** The tabs of the sidebar after Favourites: the providers that have an identity. */
export function providerTabs(m: PickerModel): Array<{ provider: ChatProvider; name: string }> {
  return m.groups.map(g => ({ provider: g.provider, name: providerMark(g.provider).name }));
}

/** Every word of the query must appear in the name, the id, the identity or the provider name. */
export function matchesQuery(e: PickerEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = `${e.name} ${e.model ?? ""} ${e.identity} ${e.providerName}`.toLowerCase();
  return q.split(/\s+/).every(t => hay.includes(t));
}

const where = (e: PickerEntry): string => `${e.providerName} \u00b7 ${e.identity}`;
const identityHeading = (e: PickerEntry): string => (e.kind === "pool" ? `${e.identity} (pool)` : e.identity);

/** Sections of the list: search results from every provider, the favourites, or one provider by identity. */
export function pickerRows(m: PickerModel, active: string, query: string): PickerSection[] {
  const all = pickerEntries(m);
  const sections: PickerSection[] = [];
  const add = (heading: string | null, entry: PickerEntry, marked = false): void => {
    const last = sections[sections.length - 1];
    if (last && last.heading === heading) last.entries.push(entry);
    else sections.push({ heading, ...(marked ? { provider: entry.provider } : {}), entries: [entry] });
  };
  if (query.trim() !== "") {
    for (const e of all.filter(x => matchesQuery(x, query))) add(where(e), e, true);
  } else if (active === FAVOURITES) {
    const stars = new Set((m.favourites ?? []).map(favKey));
    for (const e of all.filter(x => x.model !== undefined && stars.has(x.key))) add(where(e), e, true);
  } else {
    for (const e of all.filter(x => x.provider === active)) add(identityHeading(e), e);
  }
  return sections;
}

/** The tab to open on: the provider of the selected model, else Favourites when it has a row, else the first provider. */
export function startTab(m: PickerModel): string {
  const selected = m.groups.find(g => g.identities.some(i => i.selected));
  if (selected) return selected.provider;
  const stars = new Set((m.favourites ?? []).map(favKey));
  if (pickerEntries(m).some(e => e.model !== undefined && stars.has(e.key))) return FAVOURITES;
  return m.groups[0]?.provider ?? FAVOURITES;
}

/** The sidebar order: Favourites, then the providers. */
export function tabOrder(m: PickerModel): string[] { return [FAVOURITES, ...providerTabs(m).map(t => t.provider)]; }
