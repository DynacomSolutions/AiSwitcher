import { describe, expect, test } from "bun:test";
import type { ChatCatalogProvider } from "../../../src/browser/chat-protocol.ts";
import { selectable } from "../../../src/browser/chat-protocol.ts";
import { buildPicker, choose, menuKey } from "../src/sidepanel/chat/picker.ts";
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

describe("picker view", () => {
  const setup = (sel: Parameters<typeof buildPicker>[1] = { provider: "claude", identity: "work", model: "m1" }, extra: Partial<ReturnType<typeof buildPicker>> = {}) => {
    const doc = fakeDoc();
    const picks: unknown[] = [];
    let opened = 0;
    const p = createPicker(asDoc(doc), { onOpen: () => { opened++; }, onPick: x => picks.push(x), onEffort: e => picks.push({ effort: e }) }, "Model");
    p.update({ ...buildPicker(catalog, sel), ...extra });
    const root = p.root as unknown as FakeNode;
    const items = () => walk(root).filter(n => n.attrs.role === "menuitemradio");
    const menu = () => walk(root).find(n => n.attrs.role === "menu")!;
    const panel = () => walk(root).find(n => n.className === "picker-menu")!;
    return { doc, p, picks, root, items, menu, panel, btn: p.button as unknown as FakeNode, opened: () => opened };
  };
  const key = (s: ReturnType<typeof setup>, k: string) => s.menu().dispatch("keydown", { key: k });
  test("the button is a menu button and the menu has radio items in groups", () => {
    const s = setup();
    expect(s.btn.attrs["aria-haspopup"]).toBe("menu");
    expect(s.btn.attrs["aria-expanded"]).toBe("false");
    expect(s.panel().hidden).toBe(true);
    s.btn.click();
    expect(s.btn.attrs["aria-expanded"]).toBe("true");
    expect(s.opened()).toBe(1);
    expect(s.panel().hidden).toBe(false);
    expect(s.items().map(n => n.textContent)).toEqual(["Clwork", "Clpool-aPool", "Kiwork", "Model One", "Model Two", "low", "high"]);
    expect(walk(s.menu()).filter(n => n.attrs.role === "group").map(n => n.attrs["aria-label"])).toEqual(["Identity", "Model", "Effort"]);
  });
  test("hints sit outside the menu element", () => {
    const s = setup(undefined, { notice: "Careful", loading: true });
    expect(walk(s.menu()).some(n => n.className === "hint")).toBe(false);
    expect(walk(s.root).filter(n => n.className === "hint").map(n => n.textContent)).toEqual(["Loading providers", "Careful"]);
  });
  test("ArrowDown, ArrowUp, Home and End move focus", () => {
    const s = setup();
    s.btn.click();
    expect(s.doc.activeElement).toBe(s.items()[0]!);
    key(s, "End");
    expect(s.doc.activeElement).toBe(s.items()[6]!);
    key(s, "ArrowDown");
    expect(s.doc.activeElement).toBe(s.items()[0]!);
    key(s, "ArrowUp");
    expect(s.doc.activeElement).toBe(s.items()[6]!);
    key(s, "Home");
    expect(s.doc.activeElement).toBe(s.items()[0]!);
  });
  test("the button keydown opens the menu", () => {
    const s = setup();
    s.btn.dispatch("keydown", { key: "ArrowDown" });
    expect(s.btn.attrs["aria-expanded"]).toBe("true");
    expect(s.doc.activeElement).toBe(s.items()[0]!);
  });
  test("Escape closes the menu and returns focus to the button", () => {
    const s = setup();
    s.btn.click();
    key(s, "ArrowDown");
    expect(s.doc.activeElement).toBe(s.items()[1]!);
    key(s, "Escape");
    expect(s.btn.attrs["aria-expanded"]).toBe("false");
    expect(s.doc.activeElement).toBe(s.btn);
  });
  test("focus stays on the same item after a rebuild while open", () => {
    const s = setup();
    s.btn.click();
    for (let k = 0; k < 4; k++) key(s, "ArrowDown");
    expect(s.doc.activeElement!.textContent).toBe("Model Two");
    s.p.update({ ...buildPicker(catalog, { provider: "claude", identity: "work", model: "m1" }), notice: "Changed" });
    expect(s.doc.activeElement!.textContent).toBe("Model Two");
    expect(s.items().includes(s.doc.activeElement as FakeNode)).toBe(true);
  });
  test("clicking a model picks it and closes; an outside click closes", () => {
    const s = setup();
    s.btn.click();
    s.doc.dispatch("click");
    expect(s.btn.attrs["aria-expanded"]).toBe("true");
    s.items().find(n => n.textContent === "Model Two")!.click();
    expect(s.picks).toEqual([{ provider: "claude", identity: "work", model: "m2" }]);
    expect(s.btn.attrs["aria-expanded"]).toBe("false");
    s.btn.click();
    s.doc.dispatch("click");
    s.doc.dispatch("click");
    expect(s.btn.attrs["aria-expanded"]).toBe("false");
  });
  test("focus leaving the picker closes the menu", () => {
    const s = setup();
    s.btn.click();
    const other = s.doc.createElement("button") as unknown as FakeNode;
    s.root.dispatch("focusout", { relatedTarget: s.items()[0]! });
    expect(s.btn.attrs["aria-expanded"]).toBe("true");
    s.root.dispatch("focusout", { relatedTarget: null });
    expect(s.btn.attrs["aria-expanded"]).toBe("true");
    s.root.dispatch("focusout", { relatedTarget: other });
    expect(s.btn.attrs["aria-expanded"]).toBe("false");
  });
  test("focus moving back to the button closes the menu and keeps focus there", () => {
    const s = setup();
    s.btn.click();
    s.btn.focus();
    s.root.dispatch("focusout", { relatedTarget: s.btn });
    expect(s.btn.attrs["aria-expanded"]).toBe("false");
    expect(s.doc.activeElement).toBe(s.btn);
  });
  test("a locked picker disables other identities and sends nothing for them", () => {
    const s = setup(undefined, { locked: true });
    s.btn.click();
    const [work, pool] = s.items();
    expect(work!.attrs["aria-disabled"]).toBeUndefined();
    expect(pool!.attrs["aria-disabled"]).toBe("true");
    expect(walk(s.root).some(n => n.className === "hint" && n.textContent === "Start a new chat to use a different provider or identity.")).toBe(true);
    pool!.click();
    expect(s.picks).toEqual([]);
    expect(s.btn.attrs["aria-expanded"]).toBe("true");
  });
  test("names go in as text, not markup", () => {
    const doc = fakeDoc();
    const p = createPicker(asDoc(doc), { onOpen() {}, onPick() {}, onEffort() {} }, "Model");
    p.update(buildPicker([{ provider: "codex", efforts: [], identities: [{ name: "x", kind: "identity", models: [{ id: "i", name: "<img>" }] }] }], { provider: "codex", identity: "x", model: "i" }));
    expect(asEl(p.root as unknown as FakeNode)).toBeDefined();
    expect(walk(p.root as unknown as FakeNode).some(n => n.textContent === "<img>")).toBe(true);
  });
});
