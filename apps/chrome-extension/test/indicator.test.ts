import { expect, test } from "bun:test";
import { displayIdentity, distinctLabels, needsRebuild, pillKey, pillSummary, type PillAgent } from "../src/content/indicator.ts";

test("pill shows the pool name for pool sessions and the identity otherwise", () => {
  expect(displayIdentity("pool:main")).toBe("main");
  expect(displayIdentity("dyn")).toBe("dyn");
});

const agent = (n: number): PillAgent => ({ sessionId: `s${n}`, label: `Chat ${n}`, color: "#111" });

test("pillSummary shows three dots and +2 for five agents", () => {
  const s = pillSummary([1, 2, 3, 4, 5].map(agent));
  expect(s.dots.map(d => d.sessionId)).toEqual(["s1", "s2", "s3"]);
  expect(s.names).toBe("Chat 1, Chat 2, Chat 3");
  expect(s.more).toBe(2);
});

test("pillSummary has no extra count for up to three agents", () => {
  expect(pillSummary([agent(1)]).more).toBe(0);
  expect(pillSummary([1, 2, 3].map(agent)).dots).toHaveLength(3);
});

test("the same agent list never rebuilds the pill, a changed list does", () => {
  const list = [1, 2].map(agent);
  const key = pillKey(list);
  expect(needsRebuild(key, [1, 2].map(agent))).toBe(false);
  expect(needsRebuild(key, [{ ...agent(1), color: "#fff" }, agent(2)])).toBe(false); // colour only
  expect(needsRebuild(key, [agent(1)])).toBe(true);
  expect(needsRebuild(key, [agent(1), { ...agent(2), label: "Renamed" }])).toBe(true);
  expect(needsRebuild(undefined, list)).toBe(true);
});

test("equal labels get a short suffix so Stop names differ", () => {
  const same = [1, 2, 3].map(n => ({ sessionId: `s${n}`, label: "Chat", color: "#111" }));
  expect(distinctLabels(same).map(a => a.label)).toEqual(["Chat", "Chat 2", "Chat 3"]);
  expect(distinctLabels([agent(1), agent(2)]).map(a => a.label)).toEqual(["Chat 1", "Chat 2"]);
  const clash = [{ sessionId: "a", label: "Chat", color: "" }, { sessionId: "b", label: "Chat", color: "" }, { sessionId: "c", label: "Chat 2", color: "" }];
  expect(new Set(distinctLabels(clash).map(a => a.label)).size).toBe(3);
});
