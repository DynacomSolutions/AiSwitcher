import { describe, expect, test } from "bun:test";
import type { ChatCatalogProvider } from "../../../src/browser/chat-protocol.ts";
import { selectable } from "../../../src/browser/chat-protocol.ts";
import { buildPicker, choose, FAVOURITES, favKey, matchesQuery, menuKey, parseFavourites, pickerEntries, pickerRows, startTab, toggleFavourite } from "../src/sidepanel/chat/picker.ts";
import { createPicker } from "../src/sidepanel/chat/picker-view.ts";
import { asDoc, asEl, fakeDoc, walk } from "./fake-dom.ts";
import type { FakeNode } from "./fake-dom.ts";

const catalog: ChatCatalogProvider[] = [
  { provider: "claude", efforts: ["low", "high"], identities: [
    { name: "work", kind: "identity", models: [{ id: "m1", name: "Model One" }, { id: "m2", name: "Model Two" }] },
    { name: "pool-a", kind: "pool", models: [{ id: "m3", name: "Model Three" }] },
  ] },
  { provider: "kimi", efforts: [], identities: [{ name: "work", kind: "identity", models: [{ id: "k1", name: "Kimi One" }], modelsError: "Models are not available. The agent default is used." }] },
];

describe("buildPicker", () => {
  test("groups by provider with identities then models", () => {
    const m = buildPicker(catalog, { provider: "claude", identity: "work", model: "m2" });
    expect(m.groups.map(g => g.provider)).toEqual(["claude", "kimi"]);
    expect(m.groups[0]!.identities.map(i => i.name)).toEqual(["work", "pool-a"]);
    const work = m.groups[0]!.identities[0]!;
    expect(work.selected).toBe(true);
    expect(work.models.map(x => [x.id, x.selected])).toEqual([["m1", false], ["m2", true]]);
    expect(m.button.label).toBe("Model Two");
    expect(m.efforts).toEqual(["low", "high"]);
  });
  test("a pool identity is kind pool", () => {
    expect(buildPicker(catalog, undefined).groups[0]!.identities[1]!.kind).toBe("pool");
  });
  test("live config replaces the catalog models and marks the current model", () => {
    const m = buildPicker(catalog, { provider: "claude", identity: "work", model: "m1" }, { models: [{ id: "x1", name: "Live One" }, { id: "x2", name: "Live Two" }], efforts: ["deep"], current: { model: "x2", effort: "deep" } });
    expect(m.groups[0]!.identities[0]!.models.map(x => [x.id, x.selected])).toEqual([["x1", false], ["x2", true]]);
    expect(m.groups[0]!.identities[1]!.models.map(x => x.id)).toEqual(["m3"]);
    expect(m.button.label).toBe("Live Two");
    expect(m.efforts).toEqual(["deep"]);
    expect(m.effort).toBe("deep");
  });
  test("no efforts means no effort section", () => {
    const m = buildPicker(catalog, { provider: "kimi", identity: "work" });
    expect(m.efforts).toEqual([]);
    expect(m.effort).toBeUndefined();
  });
  test("loading is true until the catalog arrives and the button says Choose a model", () => {
    const m = buildPicker(undefined, undefined);
    expect(m.loading).toBe(true);
    expect(m.button.label).toBe("Choose a model");
    expect(buildPicker(catalog, undefined).loading).toBe(false);
  });
  test("modelsError is shown as the notice", () => {
    expect(buildPicker(catalog, { provider: "kimi", identity: "work" }).notice).toBe("Models are not available. The agent default is used.");
    expect(buildPicker(catalog, { provider: "claude", identity: "work" }).notice).toBeUndefined();
  });
});

describe("selectable ids", () => {
  const odd: ChatCatalogProvider[] = [{ provider: "claude", efforts: ["ok", "bad effort"], identities: [{ name: "work", kind: "identity", models: [{ id: "a b", name: "Spaced" }, { id: "x".repeat(129), name: "Long" }, { id: "fine", name: "Fine" }] }, { name: "bad name", kind: "identity", models: [] }] }];
  test("selectable follows the protocol rule", () => {
    expect(selectable("a b")).toBe(false);
    expect(selectable("x".repeat(129))).toBe(false);
    expect(selectable("x".repeat(128))).toBe(true);
  });
  test("catalogue model ids a b and 129 characters are not pickable", () => {
    const m = buildPicker(odd, { provider: "claude", identity: "work" });
    expect(m.groups[0]!.identities.map(i => i.name)).toEqual(["work"]);
    expect(m.groups[0]!.identities[0]!.models.map(x => x.id)).toEqual(["fine"]);
    expect(m.efforts).toEqual(["ok"]);
    expect(choose(undefined, { provider: "claude", identity: "work", model: "a b" }, odd).model).toBe("fine");
  });
  test("live config ids are checked the same way", () => {
    const m = buildPicker(odd, { provider: "claude", identity: "work" }, { models: [{ id: "a b", name: "x" }, { id: "ok1", name: "Ok" }], efforts: ["no way", "hi"], current: {} });
    expect(m.groups[0]!.identities[0]!.models.map(x => x.id)).toEqual(["ok1"]);
    expect(m.efforts).toEqual(["hi"]);
  });
  test("an empty model list without an error says the default model is used", () => {
    const m = buildPicker([{ provider: "claude", efforts: [], identities: [{ name: "work", kind: "identity", models: [] }] }], { provider: "claude", identity: "work" });
    expect(m.notice).toBe("The agent's default model will be used.");
  });
});

describe("choose", () => {
  test("keeps the effort when the new group offers it too", () => {
    const two: ChatCatalogProvider[] = [catalog[0]!, { provider: "codex", efforts: ["low", "max"], identities: [{ name: "work", kind: "identity", models: [{ id: "c1", name: "C" }] }] }];
    expect(choose({ provider: "claude", identity: "work", model: "m1", effort: "low" }, { provider: "codex", identity: "work" }, two)).toEqual({ provider: "codex", identity: "work", model: "c1", effort: "low" });
    expect(choose({ provider: "claude", identity: "work", model: "m1", effort: "high" }, { provider: "codex", identity: "work" }, two).effort).toBeUndefined();
  });
  test("resets the model when the provider changes and clears an unsupported effort", () => {
    const r = choose({ provider: "claude", identity: "work", model: "m2", effort: "high" }, { provider: "kimi", identity: "work" }, catalog);
    expect(r).toEqual({ provider: "kimi", identity: "work", model: "k1" });
  });
  test("a new identity starts on its first model", () => {
    expect(choose({ provider: "claude", identity: "work", model: "m2" }, { provider: "claude", identity: "pool-a" }, catalog)).toEqual({ provider: "claude", identity: "pool-a", model: "m3" });
  });
  test("a model pick in the same identity keeps a supported effort", () => {
    expect(choose({ provider: "claude", identity: "work", model: "m1", effort: "low" }, { provider: "claude", identity: "work", model: "m2" }, catalog)).toEqual({ provider: "claude", identity: "work", model: "m2", effort: "low" });
  });
});

describe("menuKey", () => {
  test("wraps and Escape closes", () => {
    const s = { open: true, index: 2, count: 3 };
    expect(menuKey(s, "ArrowDown").index).toBe(0);
    expect(menuKey({ ...s, index: 0 }, "ArrowUp").index).toBe(2);
    expect(menuKey(s, "Home").index).toBe(0);
    expect(menuKey({ ...s, index: 0 }, "End").index).toBe(2);
    expect(menuKey(s, "Escape").open).toBe(false);
    expect(menuKey(s, "Enter").open).toBe(false);
    expect(menuKey({ open: false, index: 0, count: 3 }, "ArrowDown")).toEqual({ open: true, index: 0 });
  });
});

describe("favourites", () => {
  const f = (provider: "claude" | "kimi", identity: string, model: string) => ({ provider, identity, model });
  test("parseFavourites keeps valid entries, drops bad ones and duplicates", () => {
    const raw = [f("claude", "work", "m1"), f("claude", "work", "m1"), { provider: "nope", identity: "work", model: "m1" }, { provider: "claude", identity: "bad name", model: "m1" }, { provider: "claude", identity: "work", model: "a b" }, 7, null];
    expect(parseFavourites(raw)).toEqual([f("claude", "work", "m1")]);
    expect(parseFavourites("x")).toEqual([]);
    expect(parseFavourites(undefined)).toEqual([]);
  });
  test("toggleFavourite adds, then removes", () => {
    const one = toggleFavourite([], f("kimi", "work", "k1"));
    expect(one).toEqual([f("kimi", "work", "k1")]);
    expect(toggleFavourite(one, f("kimi", "work", "k1"))).toEqual([]);
  });
  test("one model in two identities is two favourites", () => {
    expect(favKey(f("claude", "work", "m1"))).not.toBe(favKey(f("claude", "pool-a", "m1")));
  });
});

describe("picker rows", () => {
  const model = (extra: Partial<ReturnType<typeof buildPicker>> = {}) => ({ ...buildPicker(catalog, { provider: "claude", identity: "work", model: "m2" }), ...extra });
  test("a provider tab groups the rows under identity headings, a pool is marked", () => {
    const rows = pickerRows(model(), "claude", "");
    expect(rows.map(r => r.heading)).toEqual(["work", "pool-a (pool)"]);
    expect(rows[0]!.entries.map(e => [e.name, e.sub, e.selected])).toEqual([["Model One", "m1", false], ["Model Two", "m2", true]]);
  });
  test("an identity with no model list gets one default row", () => {
    const rows = pickerRows(buildPicker([{ provider: "claude", efforts: [], identities: [{ name: "work", kind: "identity", models: [] }] }], { provider: "claude", identity: "work" }), "claude", "");
    expect(rows[0]!.entries.map(e => [e.name, e.model, e.selected])).toEqual([["Default model", undefined, true]]);
  });
  test("search spans every provider and groups by provider and identity", () => {
    const rows = pickerRows(model(), "claude", "one");
    expect(rows.map(r => r.heading)).toEqual(["Claude · work", "Kimi · work"]);
    expect(rows.flatMap(r => r.entries.map(e => e.name))).toEqual(["Model One", "Kimi One"]);
    expect(pickerRows(model(), "claude", "zzz")).toEqual([]);
  });
  test("search matches the id, the identity and the provider name, every word", () => {
    const e = pickerEntries(model())[0]!;
    expect(matchesQuery(e, "m1")).toBe(true);
    expect(matchesQuery(e, "claude work")).toBe(true);
    expect(matchesQuery(e, "claude pool")).toBe(false);
    expect(matchesQuery(e, "  ")).toBe(true);
  });
  test("the favourites tab lists the starred models that the catalogue still has", () => {
    const rows = pickerRows(model({ favourites: [{ provider: "kimi", identity: "work", model: "k1" }, { provider: "kimi", identity: "gone", model: "k9" }] }), FAVOURITES, "");
    expect(rows.flatMap(r => r.entries.map(e => e.name))).toEqual(["Kimi One"]);
    expect(pickerRows(model(), FAVOURITES, "")).toEqual([]);
  });
  test("a locked chat disables the entries of other identities", () => {
    const entries = pickerEntries(model({ locked: true }));
    expect(entries.filter(e => e.disabled).map(e => e.identity)).toEqual(["pool-a", "work"]);
    expect(entries.filter(e => e.provider === "claude" && e.identity === "work").every(e => !e.disabled)).toBe(true);
  });
  test("startTab: the selected provider, else favourites when there are any, else the first provider", () => {
    expect(startTab(model())).toBe("claude");
    const none = buildPicker(catalog, undefined);
    expect(startTab(none)).toBe("claude");
    expect(startTab({ ...none, favourites: [{ provider: "kimi", identity: "work", model: "k1" }] })).toBe(FAVOURITES);
    expect(startTab({ ...none, favourites: [{ provider: "kimi", identity: "work", model: "gone" }] })).toBe("claude");
  });
});

describe("picker view", () => {
  const SEARCH = "picker-search-input";
  const setup = (sel: Parameters<typeof buildPicker>[1] = { provider: "claude", identity: "work", model: "m1" }, extra: Partial<ReturnType<typeof buildPicker>> = {}, cat: ChatCatalogProvider[] = catalog) => {
    const doc = fakeDoc();
    const picks: unknown[] = [];
    let opened = 0;
    const p = createPicker(asDoc(doc), { onOpen: () => { opened++; }, onPick: x => picks.push(x), onEffort: e => picks.push({ effort: e }), onFavourite: f => picks.push({ star: f }) }, "Model");
    p.update({ ...buildPicker(cat, sel), ...extra });
    const root = p.root as unknown as FakeNode;
    const tabs = () => walk(root).filter(n => n.attrs.role === "tab");
    const options = () => walk(root).filter(n => n.attrs.role === "option");
    const optionText = () => options().map(n => n.textContent);
    const lit = () => walk(root).filter(n => n.attrs["data-highlighted"] === "true");
    const search = () => walk(root).find(n => n.className === SEARCH)!;
    const pop = () => walk(root).find(n => n.className.startsWith("picker-pop"))!;
    const star = (name: string) => walk(root).find(n => n.attrs["aria-label"] === name)!;
    const typeQuery = (q: string) => { search().value = q; search().dispatch("input"); };
    const key = (k: string) => search().dispatch("keydown", { key: k });
    return { doc, p, picks, root, tabs, options, optionText, lit, search, pop, star, typeQuery, key, btn: p.button as unknown as FakeNode, effort: p.effortButton as unknown as FakeNode, opened: () => opened };
  };
  const selectedTab = (s: ReturnType<typeof setup>) => s.tabs().find(t => t.attrs["aria-selected"] === "true")?.attrs["aria-label"];

  test("the button shows the model name, or Choose a model, and opens a dialog", () => {
    const s = setup();
    expect(s.btn.textContent).toContain("Model One");
    expect(s.btn.attrs["aria-haspopup"]).toBe("dialog");
    expect(s.btn.attrs["aria-expanded"]).toBe("false");
    expect(s.pop().hidden).toBe(true);
    expect(setup({ provider: "claude", identity: "nobody" }).btn.textContent).toContain("Choose a model");
    s.btn.click();
    expect(s.btn.attrs["aria-expanded"]).toBe("true");
    expect(s.pop().hidden).toBe(false);
    expect(s.pop().attrs.role).toBe("dialog");
    expect(s.opened()).toBe(1);
  });
  test("the popover has a tab list, a focused search box and a model list", () => {
    const s = setup();
    s.btn.click();
    expect(walk(s.root).find(n => n.attrs.role === "tablist")!.attrs["aria-label"]).toBe("Providers");
    expect(walk(s.root).find(n => n.attrs.role === "listbox")!.attrs["aria-label"]).toBe("Models");
    expect(s.search().attrs["aria-label"]).toBe("Search models");
    expect((s.search() as unknown as { placeholder: string }).placeholder).toBe("Search models...");
    expect(s.doc.activeElement).toBe(s.search());
  });
  test("opens on the selected provider and marks the selected model", () => {
    const s = setup();
    s.btn.click();
    expect(s.optionText().join("|")).toContain("Model Three");
    expect(s.optionText().join("|")).not.toContain("Kimi One");
    const selected = s.options().filter(n => n.attrs["aria-selected"] === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0]!.textContent).toContain("Model One");
    expect(walk(selected[0]!).some(n => n.attrs.class === "icon icon-check")).toBe(true);
  });
  test("rows show the name with the id under it, under identity headings", () => {
    const s = setup();
    s.btn.click();
    expect(walk(s.root).filter(n => n.className === "picker-heading").map(n => n.textContent)).toEqual(["work", "pool-a (pool)"]);
    expect(s.options()[0]!.textContent).toBe("Model Onem1");
  });
  test("highlights the selected model on open, not the first row", () => {
    const s = setup({ provider: "claude", identity: "work", model: "m2" });
    s.btn.click();
    expect(s.lit()).toHaveLength(1);
    expect(s.lit()[0]!.textContent).toContain("Model Two");
  });
  test("moves the highlight to the first result when the search text changes", () => {
    const s = setup({ provider: "claude", identity: "work", model: "m2" });
    s.btn.click();
    s.typeQuery("model");
    expect(s.lit()).toHaveLength(1);
    expect(s.lit()[0]!.textContent).toContain("Model One");
  });
  test("switches provider from the sidebar", () => {
    const s = setup();
    s.btn.click();
    s.tabs().find(t => t.attrs["aria-label"] === "Kimi")!.click();
    expect(s.optionText().join("|")).toContain("Kimi One");
    expect(s.optionText().join("|")).not.toContain("Model One");
    expect(selectedTab(s)).toBe("Kimi");
  });
  test("lists Favourites first in the sidebar with an empty state", () => {
    const s = setup(undefined);
    s.btn.click();
    const [first, ...rest] = s.tabs();
    expect(first!.attrs["aria-label"]).toBe("Favourites");
    expect(rest.map(t => t.attrs["aria-label"])).toEqual(["Claude", "Kimi"]);
    first!.click();
    expect(walk(s.root).some(n => n.textContent === "No favourites yet")).toBe(true);
  });
  test("shows favourites and toggles a star", () => {
    const s = setup({ provider: "claude", identity: "work", model: "m1" }, { favourites: [{ provider: "kimi", identity: "work", model: "k1" }] });
    s.btn.click();
    s.tabs().find(t => t.attrs["aria-label"] === "Favourites")!.click();
    expect(s.optionText().join("|")).toContain("Kimi One");
    const remove = s.star("Remove Kimi One from favourites");
    expect(remove.attrs["aria-pressed"]).toBe("true");
    remove.click();
    expect(s.picks).toEqual([{ star: { provider: "kimi", identity: "work", model: "k1" } }]);
  });
  test("adds a favourite from a provider list, and the star keeps the popover open", () => {
    const s = setup();
    s.btn.click();
    s.star("Add Model Two to favourites").click();
    expect(s.picks).toEqual([{ star: { provider: "claude", identity: "work", model: "m2" } }]);
    expect(s.btn.attrs["aria-expanded"]).toBe("true");
    expect(s.doc.activeElement).toBe(s.search());
  });
  test("searches across providers and groups by provider", () => {
    const s = setup();
    s.btn.click();
    s.typeQuery("one");
    expect(walk(s.root).filter(n => n.className === "picker-heading").map(n => n.textContent)).toEqual(["Claude · work", "Kimi · work"]);
    expect(s.optionText()).toEqual(["Model Onem1", "Kimi Onek1"]);
    expect(s.tabs().every(t => t.attrs["aria-selected"] === "false")).toBe(true);
    s.typeQuery("zzz");
    expect(walk(s.root).some(n => n.textContent === "No models found")).toBe(true);
  });
  test("a click on a tab while searching clears the search", () => {
    const s = setup();
    s.btn.click();
    s.typeQuery("one");
    s.tabs().find(t => t.attrs["aria-label"] === "Kimi")!.click();
    expect(s.search().value).toBe("");
    expect(s.optionText()).toEqual(["Kimi Onek1"]);
  });
  test("selects with the keyboard and closes", () => {
    const s = setup({ provider: "claude", identity: "work", model: "m2" });
    s.btn.click();
    s.key("ArrowUp");
    s.key("Enter");
    expect(s.picks).toEqual([{ provider: "claude", identity: "work", model: "m1" }]);
    expect(s.btn.attrs["aria-expanded"]).toBe("false");
  });
  test("ArrowDown and ArrowUp wrap around the rows", () => {
    const s = setup({ provider: "claude", identity: "pool-a", model: "m3" });
    s.btn.click();
    expect(s.lit()[0]!.textContent).toContain("Model Three");
    s.key("ArrowDown");
    expect(s.lit()[0]!.textContent).toContain("Model One");
    s.key("ArrowUp");
    expect(s.lit()[0]!.textContent).toContain("Model Three");
  });
  test("switches provider with ArrowRight and selects the first row", () => {
    const s = setup();
    s.btn.click();
    s.key("ArrowRight");
    expect(s.optionText().join("|")).toContain("Kimi One");
    s.key("Enter");
    expect(s.picks).toEqual([{ provider: "kimi", identity: "work", model: "k1" }]);
  });
  test("ArrowLeft and ArrowRight wrap over the tabs, and do nothing while searching", () => {
    const s = setup();
    s.btn.click();
    s.key("ArrowLeft");
    expect(selectedTab(s)).toBe("Favourites");
    s.key("ArrowLeft");
    expect(selectedTab(s)).toBe("Kimi");
    s.typeQuery("one");
    s.key("ArrowRight");
    expect(s.optionText()).toEqual(["Model Onem1", "Kimi Onek1"]);
  });
  test("selects by click and closes", () => {
    const s = setup();
    s.btn.click();
    s.options().find(n => n.textContent.includes("Model Two"))!.click();
    expect(s.picks).toEqual([{ provider: "claude", identity: "work", model: "m2" }]);
    expect(s.btn.attrs["aria-expanded"]).toBe("false");
  });
  test("an identity with no models shows one default row that picks the identity", () => {
    const s = setup(undefined, {}, [{ provider: "claude", efforts: [], identities: [{ name: "work", kind: "identity", models: [] }] }]);
    s.btn.click();
    expect(s.options()).toHaveLength(1);
    expect(s.options()[0]!.textContent).toContain("Default model");
    s.options()[0]!.click();
    expect(s.picks).toEqual([{ provider: "claude", identity: "work" }]);
  });
  test("shows the provider empty state when no identity is pickable", () => {
    const s = setup(undefined, {}, [{ provider: "claude", efforts: [], identities: [{ name: "bad name", kind: "identity", models: [] }] }]);
    s.btn.click();
    expect(walk(s.root).some(n => n.textContent === "No models are available for this provider.")).toBe(true);
  });
  test("Escape closes the popover and returns focus to the button", () => {
    const s = setup();
    s.btn.click();
    s.key("Escape");
    expect(s.btn.attrs["aria-expanded"]).toBe("false");
    expect(s.doc.activeElement).toBe(s.btn);
  });
  test("the button keydown opens the popover on ArrowDown", () => {
    const s = setup();
    s.btn.dispatch("keydown", { key: "ArrowDown" });
    expect(s.btn.attrs["aria-expanded"]).toBe("true");
    expect(s.doc.activeElement).toBe(s.search());
  });
  test("a catalogue that arrives after the popover opened moves it to the start tab", () => {
    const s = setup({ provider: "claude", identity: "work" }, {}, []);
    s.btn.click();
    expect(selectedTab(s)).toBe("Favourites");
    s.p.update(buildPicker(catalog, { provider: "claude", identity: "work", model: "m1" }));
    expect(selectedTab(s)).toBe("Claude");
    expect(s.optionText().join("|")).toContain("Model One");
    s.tabs().find(t => t.attrs["aria-label"] === "Kimi")!.click();
    s.p.update({ ...buildPicker(catalog, { provider: "claude", identity: "work", model: "m1" }), notice: "x" });
    expect(selectedTab(s)).toBe("Kimi");
  });
  test("a rebuild while open keeps the search text and the open tab", () => {
    const s = setup();
    s.btn.click();
    s.typeQuery("one");
    s.p.update({ ...buildPicker(catalog, { provider: "claude", identity: "work", model: "m1" }), notice: "Changed" });
    expect(s.search().value).toBe("one");
    expect(s.optionText()).toEqual(["Model Onem1", "Kimi Onek1"]);
    expect(s.doc.activeElement).toBe(s.search());
    expect(walk(s.root).some(n => n.className === "hint" && n.textContent === "Changed")).toBe(true);
  });
  test("a click outside closes the popover, a click inside does not", () => {
    const s = setup();
    s.btn.click();
    s.doc.dispatch("click");
    expect(s.btn.attrs["aria-expanded"]).toBe("true");
    s.doc.dispatch("click");
    expect(s.btn.attrs["aria-expanded"]).toBe("false");
  });
  test("focus leaving the picker closes the popover", () => {
    const s = setup();
    s.btn.click();
    const other = s.doc.createElement("button") as unknown as FakeNode;
    s.root.dispatch("focusout", { relatedTarget: s.search() });
    expect(s.btn.attrs["aria-expanded"]).toBe("true");
    s.root.dispatch("focusout", { relatedTarget: null });
    expect(s.btn.attrs["aria-expanded"]).toBe("true");
    s.root.dispatch("focusout", { relatedTarget: other });
    expect(s.btn.attrs["aria-expanded"]).toBe("false");
  });
  test("hints and the notice sit inside the popover, outside the list", () => {
    const s = setup(undefined, { notice: "Careful", loading: true });
    s.btn.click();
    const list = walk(s.root).find(n => n.attrs.role === "listbox")!;
    expect(walk(list).some(n => n.className === "hint")).toBe(false);
    expect(walk(s.pop()).filter(n => n.className === "hint").map(n => n.textContent)).toEqual(["Loading providers", "Careful"]);
  });
  test("a locked picker disables other identities, shows the hint and sends nothing for them", () => {
    const s = setup(undefined, { locked: true });
    s.btn.click();
    const pool = s.options().find(n => n.textContent.includes("Model Three"))!;
    expect(pool.attrs["aria-disabled"]).toBe("true");
    expect(s.options().find(n => n.textContent.includes("Model Two"))!.attrs["aria-disabled"]).toBeUndefined();
    expect(walk(s.root).some(n => n.className === "hint" && n.textContent === "Start a new chat to use a different provider or identity.")).toBe(true);
    pool.click();
    expect(s.picks).toEqual([]);
    expect(s.btn.attrs["aria-expanded"]).toBe("true");
    s.options().find(n => n.textContent.includes("Model Two"))!.click();
    expect(s.picks).toEqual([{ provider: "claude", identity: "work", model: "m2" }]);
  });
  test("names go in as text, not markup", () => {
    const doc = fakeDoc();
    const p = createPicker(asDoc(doc), { onOpen() {}, onPick() {}, onEffort() {}, onFavourite() {} }, "Model");
    p.update(buildPicker([{ provider: "codex", efforts: [], identities: [{ name: "x", kind: "identity", models: [{ id: "i", name: "<img>" }] }] }], { provider: "codex", identity: "x", model: "i" }));
    p.button.click();
    expect(asEl(p.root as unknown as FakeNode)).toBeDefined();
    expect(walk(p.root as unknown as FakeNode).some(n => n.textContent === "<img>")).toBe(true);
  });

  describe("effort button", () => {
    const items = (s: ReturnType<typeof setup>) => walk(s.root).filter(n => n.attrs.role === "menuitemradio");
    const menu = (s: ReturnType<typeof setup>) => walk(s.root).find(n => n.attrs.role === "menu")!;
    test("is hidden when the selection offers no effort", () => {
      expect(walk(setup({ provider: "kimi", identity: "work" }).root).find(n => n.className === "picker-effort-wrap")!.hidden).toBe(true);
      expect(walk(setup().root).find(n => n.className === "picker-effort-wrap")!.hidden).toBe(false);
    });
    test("shows the effort, opens a small menu of the efforts and sends the pick", () => {
      const s = setup({ provider: "claude", identity: "work", model: "m1", effort: "high" });
      expect(s.effort.textContent).toContain("high");
      expect(menu(s).hidden).toBe(true);
      s.effort.click();
      expect(s.effort.attrs["aria-expanded"]).toBe("true");
      expect(items(s).map(n => [n.textContent, n.attrs["aria-checked"]])).toEqual([["low", "false"], ["high", "true"]]);
      expect(s.doc.activeElement).toBe(items(s)[1]!);
      items(s)[0]!.click();
      expect(s.picks).toEqual([{ effort: "low" }]);
      expect(menu(s).hidden).toBe(true);
    });
    test("says Effort when none is chosen, moves with the arrows and Escape closes", () => {
      const s = setup();
      expect(s.effort.textContent).toContain("Effort");
      s.effort.dispatch("keydown", { key: "ArrowDown" });
      expect(menu(s).hidden).toBe(false);
      expect(s.doc.activeElement).toBe(items(s)[0]!);
      menu(s).dispatch("keydown", { key: "ArrowDown" });
      expect(s.doc.activeElement).toBe(items(s)[1]!);
      menu(s).dispatch("keydown", { key: "Escape" });
      expect(menu(s).hidden).toBe(true);
      expect(s.doc.activeElement).toBe(s.effort);
    });
    test("the model popover and the effort menu close each other", () => {
      const s = setup();
      s.btn.click();
      s.effort.click();
      expect(s.btn.attrs["aria-expanded"]).toBe("false");
      expect(menu(s).hidden).toBe(false);
      s.btn.click();
      expect(menu(s).hidden).toBe(true);
      expect(s.pop().hidden).toBe(false);
    });
  });
});
