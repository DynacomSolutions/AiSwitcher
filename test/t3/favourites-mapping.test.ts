import { describe, expect, test } from "bun:test";
import { favToKey, instanceToAis, keyToFav, mappedKeys, type MapContext } from "../../src/t3/favourites/mapping.ts";
import { POOL_IDENTITY } from "../../src/browser/chat-protocol.ts";
import { CLAUDE_POOL, CODEX_POOL, INSTANCES, key, names, poolKey } from "./favourites-fixtures.ts";

const ctx = (instances: string[] = INSTANCES): MapContext => ({ ...names(), instances: new Set(instances) });

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

  test("the pool instance of every provider is the fixed pool identity, with no configuration", () => {
    for (const [id, provider] of [[CLAUDE_POOL, "claude"], [CODEX_POOL, "codex"], ["t3-kimi-pool-acp", "kimi"], ["t3-grok-pool", "grok"], ["t3-grok-pool-acp", "grok"], ["t3-zai-pool-acp", "zai"], ["t3-opencode-pool", "opencode"]] as const) {
      expect(instanceToAis(id)).toEqual({ provider, identity: POOL_IDENTITY });
      expect(instanceToAis(id, names())).toEqual({ provider, identity: POOL_IDENTITY });
    }
  });

  test("the pool identity cannot be the name of a real identity", () => {
    expect(instanceToAis("t3-claude-@pool")).toBeUndefined();
    expect(favToKey({ provider: "t3-claude-@pool", model: "m" })).toBeUndefined();
    // An instance id never has an `@`, so no real instance of AIS gets there.
    expect(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test("t3-claude-@pool")).toBe(false);
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
    expect(keyToFav(poolKey("m"), ctx())).toEqual({ provider: CLAUDE_POOL, model: "m" });
    expect(keyToFav(key("m", "work", "grok"), ctx())).toEqual({ provider: "t3-grok-work", model: "m" });
    // Without the driver instance the ACP twin holds it.
    expect(keyToFav(key("m", "work", "grok"), ctx(["t3-grok-work-acp"]))).toEqual({ provider: "t3-grok-work-acp", model: "m" });
    expect(keyToFav(key("m", "work", "kimi"), ctx())).toEqual({ provider: "t3-kimi-work-acp", model: "m" });
    expect(keyToFav(key("m", "work", "zai"), ctx())).toEqual({ provider: "t3-zai-work-acp", model: "m" });
    expect(keyToFav(key("m", "work", "opencode"), ctx())).toEqual({ provider: "t3-opencode-work", model: "m" });
    expect(keyToFav(poolKey("m", "codex"), ctx())).toEqual({ provider: CODEX_POOL, model: "m" });
  });

  test("a key with no instance on this host has no T3 favourite", () => {
    expect(keyToFav(key("m", "other"), ctx())).toBeUndefined();
    expect(keyToFav(key("m", "work", "claude"), ctx([CLAUDE_POOL]))).toBeUndefined();
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

describe("every instance form of all six providers", () => {
  const providers: Array<"claude" | "codex" | "kimi" | "grok" | "zai" | "opencode"> = ["claude", "codex", "kimi", "grok", "zai", "opencode"];
  /** The instance ids AIS makes for an identity and for the pool of a provider. */
  const forms = (p: (typeof providers)[number], who: string): string[] => {
    switch (p) {
      case "claude": return [`t3-claude-${who}`];
      case "codex": return [`t3-codex-${who}`];
      case "kimi": return [`t3-kimi-${who}-acp`];
      case "zai": return [`t3-zai-${who}-acp`];
      case "grok": return [`t3-grok-${who}`, `t3-grok-${who}-acp`];
      case "opencode": return [`t3-opencode-${who}`];
    }
  };
  const poolForms = (p: (typeof providers)[number]): string[] => (p === "claude" ? [CLAUDE_POOL] : p === "codex" ? [CODEX_POOL] : forms(p, "pool"));

  test.each(providers)("%s: every identity form maps to the identity and back", (p) => {
    for (const id of forms(p, "work")) {
      expect(favToKey({ provider: id, model: "m" })).toEqual({ provider: p, identity: "work", model: "m" });
      expect(keyToFav({ provider: p, identity: "work", model: "m" }, { instances: new Set([id]) })).toEqual({ provider: id, model: "m" });
    }
  });

  test.each(providers)("%s: every pool form maps to the pool key and back, with no pool name", (p) => {
    for (const id of poolForms(p)) {
      expect(favToKey({ provider: id, model: "m" })).toEqual(poolKey("m", p));
      expect(keyToFav(poolKey("m", p), { instances: new Set([id]) })).toEqual({ provider: id, model: "m" });
    }
  });

  test("a hand-made t3-<claude|codex>-pool instance also reads as the pool", () => {
    expect(favToKey({ provider: ["t3", "claude", "pool"].join("-"), model: "m" })).toEqual(poolKey("m", "claude"));
    expect(favToKey({ provider: ["t3", "codex", "pool"].join("-"), model: "m" })).toEqual(poolKey("m", "codex"));
  });

  test("a grok pool favourite on both of its instances is one key", () => {
    expect(mappedKeys([{ provider: "t3-grok-pool", model: "g" }, { provider: "t3-grok-pool-acp", model: "g" }])).toEqual([poolKey("g", "grok")]);
  });
});
