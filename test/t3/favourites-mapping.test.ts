import { describe, expect, test } from "bun:test";
import { favToKey, instanceToAis, keyToFav, mappedKeys, type MapContext } from "../../src/t3/favourites/mapping.ts";
import { CLAUDE_POOL, CODEX_POOL, INSTANCES, key, names } from "./favourites-fixtures.ts";

const ctx = (over: Partial<Record<string, string>> = {}, instances: string[] = INSTANCES): MapContext => ({ ...names(over), instances: new Set(instances) });

describe("instance id to AIS", () => {
  test.each([
    ["t3-claude-work", "claude", "work"],
    ["t3-codex-work", "codex", "work"],
    ["t3-kimi-work-acp", "kimi", "work"],
    ["t3-grok-work", "grok", "work"],
    ["t3-grok-work-acp", "grok", "work"],
    ["t3-zai-work-acp", "zai", "work"],
    ["t3-opencode-work", "opencode", "work"],
    ["t3-claude-two-part-name", "claude", "two-part-name"],
    ["t3-kimi-a-b-acp", "kimi", "a-b"],
  ])("%s is %s / %s", (id, provider, identity) => {
    expect(instanceToAis(id, names())).toEqual({ provider, identity } as never);
  });

  test("a pool instance is the pool name of its provider", () => {
    const n = names({ claude: "main-pool", codex: "cx-pool" });
    expect(instanceToAis(CLAUDE_POOL, n)).toEqual({ provider: "claude", identity: "main-pool" });
    expect(instanceToAis(CODEX_POOL, n)).toEqual({ provider: "codex", identity: "cx-pool" });
    expect(instanceToAis("t3-kimi-pool-acp", n)).toEqual({ provider: "kimi", identity: "pool" });
    expect(instanceToAis("t3-grok-pool", n)).toEqual({ provider: "grok", identity: "pool" });
    expect(instanceToAis("t3-opencode-pool", n)).toEqual({ provider: "opencode", identity: "pool" });
  });

  test("an alias becomes the canonical identity name", () => {
    expect(instanceToAis("t3-claude-wk", names())).toEqual({ provider: "claude", identity: "work" });
  });

  test.each(["claudeAgent", "codex", "t3-claude-kimi-work", "t3-claude-zai-pool", "t3-claude-kimi", "t3-zcode-work-acp", "something-else", "t3-kimi-work", ""])("%p is not mapped", (id) => {
    expect(instanceToAis(id, names())).toBeUndefined();
  });
});

describe("favourites", () => {
  test("a favourite of a mapped instance maps to an AIS key, one of an unknown instance does not", () => {
    expect(favToKey({ provider: "t3-claude-work", model: "m1" }, names())).toEqual(key("m1"));
    expect(favToKey({ provider: "claudeAgent", model: "m1" }, names())).toBeUndefined();
    expect(favToKey({ provider: "t3-claude-work", model: "" }, names())).toBeUndefined();
  });

  test("a favourite whose model or identity the gateway would refuse has no key", () => {
    for (const model of ["opus[1m]", "a b", "x".repeat(129), "caf\u00e9"]) expect(favToKey({ provider: "t3-claude-work", model }, names())).toBeUndefined();
    expect(favToKey({ provider: "t3-claude-bad name", model: "m" }, names())).toBeUndefined();
    expect(favToKey({ provider: "t3-claude-work", model: "claude-opus-4-5:high/x@1+2.3_4" }, names())).toBeDefined();
    expect(mappedKeys([{ provider: "t3-claude-work", model: "opus[1m]" }, { provider: "t3-claude-work", model: "ok" }], names())).toEqual([key("ok")]);
  });

  test("mappedKeys keeps T3's order, skips unmapped ones and lists a key once", () => {
    const favs = [{ provider: "t3-claude-work", model: "a" }, { provider: "claudeAgent", model: "x" }, { provider: "t3-grok-work", model: "g" }, { provider: "t3-grok-work-acp", model: "g" }, { provider: "t3-codex-work", model: "a" }];
    expect(mappedKeys(favs, names())).toEqual([key("a"), key("g", "work", "grok"), key("a", "work", "codex")]);
  });

  test("a key goes to the instance that exists, in order of preference", () => {
    expect(keyToFav(key("m"), ctx())).toEqual({ provider: "t3-claude-work", model: "m" });
    expect(keyToFav(key("m", "pool"), ctx())).toEqual({ provider: CLAUDE_POOL, model: "m" });
    expect(keyToFav(key("m", "work", "grok"), ctx())).toEqual({ provider: "t3-grok-work", model: "m" });
    // Without the driver instance the ACP twin holds it.
    expect(keyToFav(key("m", "work", "grok"), ctx({}, ["t3-grok-work-acp"]))).toEqual({ provider: "t3-grok-work-acp", model: "m" });
    expect(keyToFav(key("m", "work", "kimi"), ctx())).toEqual({ provider: "t3-kimi-work-acp", model: "m" });
    expect(keyToFav(key("m", "work", "zai"), ctx())).toEqual({ provider: "t3-zai-work-acp", model: "m" });
    expect(keyToFav(key("m", "work", "opencode"), ctx())).toEqual({ provider: "t3-opencode-work", model: "m" });
    expect(keyToFav(key("m", "pool", "codex"), ctx())).toEqual({ provider: CODEX_POOL, model: "m" });
  });

  test("a key with no instance on this host has no T3 favourite", () => {
    expect(keyToFav(key("m", "other"), ctx())).toBeUndefined();
    expect(keyToFav(key("m", "work", "claude"), ctx({}, [CLAUDE_POOL]))).toBeUndefined();
  });

  test("the mapping is stable both ways for every instance of the host", () => {
    for (const id of INSTANCES) {
      const a = instanceToAis(id, names());
      if (!a) continue;
      const back = keyToFav({ ...a, model: "m" }, ctx());
      expect(back).toBeDefined();
      expect(instanceToAis(back!.provider, names())).toEqual(a);
    }
  });
});
