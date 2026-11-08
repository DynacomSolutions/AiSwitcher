import { describe, expect, test } from "bun:test";
import { groupState, sessionsForTab } from "../src/shared/current-tab.ts";
import type { PanelSession } from "../src/shared/panel.ts";

const s = (id: string, o: Partial<PanelSession> = {}): PanelSession => ({
  id, identity: "alice", label: `alice/codex/${id}`, tabs: 1, color: "#3b82f6", group: "blue",
  groupId: -1, tabIds: [], controlledTabIds: [], attachedTabIds: [], grantedGroupIds: [], ...o,
});

describe("sessionsForTab", () => {
  test("no active tab or no sessions gives nothing", () => {
    expect(sessionsForTab([s("a", { tabIds: [1] })], undefined)).toEqual([]);
    expect(sessionsForTab([], { id: 1, groupId: -1 })).toEqual([]);
  });

  test("matches by owned tab, group, controlled mark or debugger attach", () => {
    const tab = { id: 5, groupId: 9 };
    const all = [
      s("owned", { tabIds: [5] }),
      s("group", { groupId: 9, tabIds: [6] }),
      s("marked", { controlledTabIds: [5] }),
      s("attached", { attachedTabIds: [5] }),
      s("other", { groupId: 4, tabIds: [7] }),
    ];
    expect(sessionsForTab(all, tab).map(x => x.session.id)).toEqual(["owned", "group", "marked", "attached"]);
  });

  test("an ungrouped tab never matches a session with groupId -1", () => {
    expect(sessionsForTab([s("a", { groupId: -1, tabIds: [2] })], { id: 3, groupId: -1 })).toEqual([]);
  });

  test("two sessions can share a tab; controlling vs idle", () => {
    const r = sessionsForTab([s("a", { tabIds: [1], controlledTabIds: [1] }), s("b", { tabIds: [1] })], { id: 1, groupId: -1 });
    expect(r.map(x => x.use)).toEqual(["controlling", "idle"]);
  });

  test("paused profile shows idle", () => {
    const r = sessionsForTab([s("a", { tabIds: [1], controlledTabIds: [1] })], { id: 1, groupId: -1 }, true);
    expect(r[0]!.use).toBe("idle");
  });
});

describe("groupState", () => {
  const tab = { id: 5, groupId: 9 };
  test("ungrouped tab has no grant controls", () => {
    expect(groupState([s("a")], { id: 5, groupId: -1 }).kind).toBe("ungrouped");
    expect(groupState([s("a")], undefined).kind).toBe("ungrouped");
  });
  test("free group offers every session; an agent group and a granted group name their session", () => {
    expect(groupState([s("a"), s("b")], tab)).toMatchObject({ kind: "free", candidates: [{ id: "a" }, { id: "b" }] });
    expect(groupState([s("a", { groupId: 9 })], tab)).toMatchObject({ kind: "agent", session: { id: "a" } });
    expect(groupState([s("a"), s("b", { grantedGroupIds: [9] })], tab)).toMatchObject({ kind: "granted", session: { id: "b" } });
  });
  test("a granted group puts its session in This tab", () => {
    expect(sessionsForTab([s("a", { grantedGroupIds: [9] })], tab).map(x => x.session.id)).toEqual(["a"]);
  });
});
