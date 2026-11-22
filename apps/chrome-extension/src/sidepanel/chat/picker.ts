// Provider, identity and model picker: the pure model and the key rules. The DOM is in picker-view.ts.
import { selectable } from "../../../../../src/browser/chat-protocol.ts";
import type { ChatCatalogProvider, ChatProvider, ChatSelection } from "../../../../../src/browser/chat-protocol.ts";
import { providerMark } from "./provider-icons.ts";

export interface PickerModel {
  button: { providerIcon: string; label: string };
  groups: Array<{ provider: ChatProvider; identities: Array<{ name: string; kind: "identity" | "pool"; selected: boolean; models: Array<{ id: string; name: string; selected: boolean }> }> }>;
  efforts: string[];
  effort?: string;
  loading: boolean;
  notice?: string;
  /** An open chat cannot change provider or identity. Other identities show as disabled. */
  locked?: boolean;
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
    button: { providerIcon: providerMark(sel?.provider).text, label: text },
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
