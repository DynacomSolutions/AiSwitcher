import { describe, expect, test } from "bun:test";
import type { ChatCatalogProvider } from "../../../src/browser/chat-protocol.ts";
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

describe("choose", () => {
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
  const setup = () => {
    const doc = fakeDoc();
    const picks: unknown[] = [];
    let opened = 0;
    const p = createPicker(asDoc(doc), { onOpen: () => { opened++; }, onPick: x => picks.push(x), onEffort: e => picks.push({ effort: e }) }, "Model");
    p.update(buildPicker(catalog, { provider: "claude", identity: "work", model: "m1" }));
    const root = p.root as unknown as FakeNode;
    const items = () => walk(root).filter(n => n.attrs.role === "menuitemradio");
    return { doc, p, picks, root, items, opened: () => opened };
  };
  test("the button is a menu button and the menu has radio items", () => {
    const s = setup();
    const btn = s.p.button as unknown as FakeNode;
    expect(btn.attrs["aria-haspopup"]).toBe("menu");
    expect(btn.attrs["aria-expanded"]).toBe("false");
    btn.click();
    expect(btn.attrs["aria-expanded"]).toBe("true");
    expect(s.opened()).toBe(1);
    expect(walk(s.root).some(n => n.attrs.role === "menu" && !n.hidden)).toBe(true);
    // work, Model One, Model Two, pool-a, kimi work, low, high
    expect(s.items().map(n => n.textContent).filter((_, k) => k !== 3)).toEqual(["Clwork", "Model One", "Model Two", "Kiwork", "low", "high"]);
    expect(s.items().some(n => n.textContent.includes("Pool"))).toBe(true);
  });
  test("Escape closes the menu and returns focus to the button", () => {
    const s = setup();
    const btn = s.p.button as unknown as FakeNode;
    btn.click();
    const menu = walk(s.root).find(n => n.attrs.role === "menu")!;
    menu.dispatch("keydown", { key: "ArrowDown" });
    expect(s.doc.activeElement).toBe(s.items()[1]!);
    menu.dispatch("keydown", { key: "Escape" });
    expect(btn.attrs["aria-expanded"]).toBe("false");
    expect(s.doc.activeElement).toBe(btn);
  });
  test("clicking a model picks it and closes; an outside click closes", () => {
    const s = setup();
    const btn = s.p.button as unknown as FakeNode;
    btn.click();
    s.doc.dispatch("click");
    expect(btn.attrs["aria-expanded"]).toBe("true");
    s.items().find(n => n.textContent === "Model Two")!.click();
    expect(s.picks).toEqual([{ provider: "claude", identity: "work", model: "m2" }]);
    expect(btn.attrs["aria-expanded"]).toBe("false");
    btn.click();
    s.doc.dispatch("click");
    s.doc.dispatch("click");
    expect(btn.attrs["aria-expanded"]).toBe("false");
  });
  test("names go in as text, not markup", () => {
    const doc = fakeDoc();
    const p = createPicker(asDoc(doc), { onOpen() {}, onPick() {}, onEffort() {} }, "Model");
    p.update(buildPicker([{ provider: "codex", efforts: [], identities: [{ name: "<b>x</b>", kind: "identity", models: [{ id: "i", name: "<img>" }] }] }], { provider: "codex", identity: "<b>x</b>", model: "i" }));
    expect(asEl(p.root as unknown as FakeNode)).toBeDefined();
    expect(walk(p.root as unknown as FakeNode).some(n => n.textContent.includes("<b>x</b>"))).toBe(true);
  });
});
