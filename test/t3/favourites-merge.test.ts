import { describe, expect, test } from "bun:test";
import { applyGateway, localChanges, sameFavs } from "../../src/t3/favourites/merge.ts";
import type { MapContext } from "../../src/t3/favourites/mapping.ts";
import { CLAUDE_POOL, INSTANCES, key, names } from "./favourites-fixtures.ts";

const ctx: MapContext = { ...names(), instances: new Set(INSTANCES) };
const t3 = (...pairs: Array<[string, string]>) => pairs.map(([provider, model]) => ({ provider, model }));
const W = (m: string): [string, string] => ["t3-claude-work", m];

describe("what goes up", () => {
  test("the first run sends the stars the gateway lacks and removes nothing", () => {
    expect(localChanges(t3(W("a"), W("b")), names(), undefined, [key("b")])).toEqual([{ ...key("a"), op: "add" }]);
  });
  test("a star made in T3 since the last run goes up, one the gateway has already does not", () => {
    expect(localChanges(t3(W("a"), W("b")), names(), [key("a")], [key("a"), key("b")])).toEqual([]);
    expect(localChanges(t3(W("a"), W("b")), names(), [key("a")], [key("a")])).toEqual([{ ...key("b"), op: "add" }]);
  });
  test("a star taken away in T3 is found by the last run, and is removed at the gateway", () => {
    expect(localChanges(t3(W("a")), names(), [key("a"), key("b")], [key("a"), key("b")])).toEqual([{ ...key("b"), op: "remove" }]);
  });
  test("a star the gateway has already dropped is not removed again", () => {
    expect(localChanges(t3(W("a")), names(), [key("a"), key("b")], [key("a")])).toEqual([]);
  });
  test("a favourite of an unmapped instance never goes up, and its absence is never a removal", () => {
    expect(localChanges(t3(["claudeAgent", "x"]), names(), [], [])).toEqual([]);
    expect(localChanges(t3(), names(), [key("x")], [])).toEqual([]);
  });
});

describe("what comes down", () => {
  test("T3's order is kept, a removed star is dropped and a new star is appended", () => {
    const r = applyGateway(t3(W("a"), W("b"), W("c")), ctx, [key("c"), key("a"), key("n")]);
    expect(r.next).toEqual(t3(W("a"), W("c"), W("n")));
    expect(r.synced).toEqual([key("a"), key("c"), key("n")]);
  });
  test("an unmapped favourite stays where it is, with all its fields", () => {
    const odd = { provider: "claudeAgent", model: "x", extra: 1 };
    const r = applyGateway([W("a") as unknown as never, odd, ...t3(W("b"))].map((f) => (Array.isArray(f) ? { provider: f[0], model: f[1] } : f)), ctx, []);
    expect(r.next).toEqual([odd]);
    expect(r.next[0]).toBe(odd);
  });
  test("a new star goes to the instance of the identity, a star with no instance on this host is left out", () => {
    const r = applyGateway([], ctx, [key("a", "pool"), key("b", "stranger"), key("c", "work", "grok")]);
    expect(r.next).toEqual(t3([CLAUDE_POOL, "a"], ["t3-grok-work", "c"]));
    expect(r.synced).toEqual([key("a", "pool"), key("c", "work", "grok")]);
  });
  test("both instances of one identity keep their favourite", () => {
    const favs = t3(["t3-grok-work", "g"], ["t3-grok-work-acp", "g"]);
    expect(applyGateway(favs, ctx, [key("g", "work", "grok")]).next).toEqual(favs);
    expect(applyGateway(favs, ctx, []).next).toEqual([]);
  });
  test("an equal list gives an equal result, so nothing is written", () => {
    const favs = t3(W("a"), ["claudeAgent", "x"], W("b"));
    const r = applyGateway(favs, ctx, [key("a"), key("b")]);
    expect(sameFavs(r.next, favs)).toBe(true);
    expect(sameFavs(r.next, favs.slice(1))).toBe(false);
  });
});
