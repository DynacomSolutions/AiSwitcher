import { expect, test } from "bun:test";
import { displayIdentity, pillSummary, type PillAgent } from "../src/content/indicator.ts";

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
