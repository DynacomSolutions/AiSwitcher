import { describe, expect, test } from "bun:test";
import { defaultChatTabs, splitPartners, SPLIT_VIEW_NONE } from "../src/shared/split-view.ts";
import { FakeChrome } from "./fakes.ts";

function tabs(...specs: Array<[number, { splitViewId?: number; windowId?: number; url?: string }]>) {
  const c = new FakeChrome();
  for (const [id, o] of specs) c.addTab(id, o.url ?? "https://example.test/", "T", o);
  return [...c.tabList.values()];
}

describe("split view context", () => {
  test("a split pair gives both tabs, active first", () => {
    const t = tabs([1, { splitViewId: 7 }], [2, { splitViewId: 7 }], [3, {}]);
    expect(defaultChatTabs(t, 2)).toEqual([2, 1]);
    expect(splitPartners(t, 1)).toEqual([2]);
  });
  test("a tab with splitViewId -1 gives only itself", () => {
    const t = tabs([1, { splitViewId: SPLIT_VIEW_NONE }], [2, { splitViewId: SPLIT_VIEW_NONE }]);
    expect(defaultChatTabs(t, 1)).toEqual([1]);
    expect(splitPartners(t, 1)).toEqual([]);
  });
  test("Chrome below 140 (field undefined everywhere) gives only the active tab and does not throw", () => {
    const t = tabs([1, {}], [2, {}]);
    expect(() => defaultChatTabs(t, 1)).not.toThrow();
    expect(defaultChatTabs(t, 1)).toEqual([1]);
  });
  test("partners in another window are ignored", () => {
    const t = tabs([1, { splitViewId: 7 }], [2, { splitViewId: 7, windowId: 2 }]);
    expect(defaultChatTabs(t, 1)).toEqual([1]);
  });
  test("three tabs with one id (corrupt data) gives at most the active tab plus the others once", () => {
    const t = tabs([1, { splitViewId: 7 }], [2, { splitViewId: 7 }], [3, { splitViewId: 7 }]);
    const r = defaultChatTabs(t, 1);
    expect(r[0]).toBe(1);
    expect([...r].sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(new Set(r).size).toBe(r.length);
  });
  test("an unknown active tab gives an empty list", () => {
    expect(defaultChatTabs(tabs([1, {}]), 99)).toEqual([]);
  });
  test("a chrome:// tab with no partner gives an empty list", () => {
    expect(defaultChatTabs(tabs([1, { url: "chrome://newtab/" }, ]), 1)).toEqual([]);
  });
  test("chrome:// and the new tab page are not linked by default", () => {
    const t = tabs([1, { splitViewId: 7, url: "https://example.test/" }], [2, { splitViewId: 7, url: "chrome://newtab/" }]);
    expect(defaultChatTabs(t, 1)).toEqual([1]);
    const u = tabs([1, { splitViewId: 7, url: "chrome://settings" }], [2, { splitViewId: 7 }]);
    expect(defaultChatTabs(u, 1)).toEqual([2]);
    const f = tabs([1, { url: "file:///a.html" }]);
    expect(defaultChatTabs(f, 1)).toEqual([1]);
  });
});
