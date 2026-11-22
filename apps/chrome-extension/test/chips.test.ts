import { describe, expect, test } from "bun:test";
import type { TabInfo } from "../src/background/chrome-api.ts";
import { addableTabs, chipsFor } from "../src/sidepanel/chat/chips.ts";

const tab = (id: number, url: string, windowId = 1, title = `T${id}`): TabInfo => ({ id, windowId, groupId: -1, url, title, active: false });

describe("chips", () => {
  test("chipsFor marks a closed tab missing", () => {
    const r = chipsFor([1, 2], [tab(1, "https://a.test/")]);
    expect(r[0]).toEqual({ tabId: 1, label: "T1", missing: false });
    expect(r[1]).toMatchObject({ tabId: 2, missing: true });
  });
  test("addableTabs excludes linked, other-window and chrome:// tabs", () => {
    const tabs = [tab(1, "https://a.test/"), tab(2, "https://b.test/"), tab(3, "https://c.test/", 2), tab(4, "chrome://settings"), tab(5, "file:///x.html"), tab(6, "about:blank")];
    expect(addableTabs([1], tabs, 1).map(t => t.id)).toEqual([2, 5]);
  });
});
