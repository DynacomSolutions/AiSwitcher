// The options that let the favourites sync run as a sidecar in a pod: pool names, usage-only instances, an origin label, the favourites token.
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { runT3Command } from "../../src/cli/t3/dispatch.ts";
import { instanceToAis, keyToFav, mappedKeys, poolProviders, type MapContext } from "../../src/t3/favourites/mapping.ts";
import { gatewayAdmin } from "../../src/t3/favourites/config.ts";
import { hostNames, homeKey, metricsPathOf, parsePoolNames, readState, syncOnce, type FavSyncDeps, type HostNames } from "../../src/t3/favourites/sync.ts";
import { CLAUDE_POOL, fakeGateway, INSTANCES, key, makeHome, names, scratch } from "./favourites-fixtures.ts";

const cleanups: string[] = [];
afterEach(() => {
  for (const p of cleanups.splice(0)) rmSync(p, { recursive: true, force: true });
});
const home = (opts: Parameters<typeof makeHome>[0] = {}) => {
  const h = makeHome(opts);
  const stateDir = scratch();
  cleanups.push(h.home, stateDir);
  return { ...h, stateDir };
};
const noPool = (): HostNames => ({ poolName: () => undefined, canonical: (_p, n) => n });

describe("pool names", () => {
  test("the flag format is <tool>=<name> pairs", () => {
    expect(parsePoolNames("claude=x,codex=y, kimi = z ")).toEqual({ claude: "x", codex: "y", kimi: "z" });
    expect(parsePoolNames("")).toEqual({});
    expect(parsePoolNames(undefined)).toEqual({});
  });

  test.each(["claude", "claude=", "=x", "claude=x=y", "nope=x", "claude=has space", "claude=x,,codex=y"])("%s is refused", (raw) => {
    expect(() => parsePoolNames(raw)).toThrow();
  });

  test("the option, then the environment, give the pool name; no source gives none", async () => {
    const env = { AIS_T3_POOL_NAMES: "claude=from-env,codex=from-env" };
    const n = await hostNames({ env, poolNames: { claude: "from-flag" } });
    expect(n.poolName("claude")).toBe("from-flag");
    expect(n.poolName("codex")).toBe("from-env");
  });

  test("a provider with no pool name never maps to a guessed name", () => {
    const ctx: MapContext = { ...noPool(), instances: new Set(INSTANCES) };
    expect(instanceToAis(CLAUDE_POOL, ctx)).toBeUndefined();
    expect(instanceToAis("t3-kimi-pool-acp", ctx)).toBeUndefined();
    expect(instanceToAis("t3-claude-work", ctx)).toEqual({ provider: "claude", identity: "work" });
    expect(mappedKeys([{ provider: CLAUDE_POOL, model: "m" }, { provider: "t3-claude-work", model: "m" }], ctx)).toEqual([key("m")]);
    // A gateway star on a pool identity finds no instance.
    expect(keyToFav(key("m", "shared-pool"), ctx)).toBeUndefined();
    expect(poolProviders(INSTANCES).sort()).toEqual(["claude", "codex", "grok", "kimi", "opencode"]);
  });

  test("pool favourites are left alone, not synced, and the reason is logged once per provider", async () => {
    const h = home({ favorites: [{ provider: CLAUDE_POOL, model: "pool-star" }, { provider: "t3-claude-work", model: "a" }] });
    const gw = fakeGateway();
    await gw.star(key("chrome-star", "shared-pool"));
    const logs: string[] = [];
    const deps: FavSyncDeps = { t3Home: h.home, client: gw.api, names: async () => noPool(), stateDir: h.stateDir, log: (m) => logs.push(m) };
    await syncOnce(deps);
    await syncOnce(deps);
    expect((await gw.store.list()).items.map((i) => `${i.identity}/${i.model}`).sort()).toEqual(["shared-pool/chrome-star", "work/a"]);
    expect(h.read().favorites).toEqual([{ provider: CLAUDE_POOL, model: "pool-star" }, { provider: "t3-claude-work", model: "a" }]);
    expect(logs.filter((l) => l.includes("no pool name for claude"))).toHaveLength(1);
    expect(logs.every((l) => l.includes("--pool-names"))).toBe(true);
  });

  test("with a pool name given, the pool favourites sync", async () => {
    const h = home({ favorites: [{ provider: CLAUDE_POOL, model: "pool-star" }] });
    const gw = fakeGateway();
    await syncOnce({ t3Home: h.home, client: gw.api, names: async () => ({ ...noPool(), poolName: (p) => (p === "claude" ? "shared-pool" : undefined) }), stateDir: h.stateDir, log: () => {} });
    expect((await gw.store.list()).items).toMatchObject([{ provider: "claude", identity: "shared-pool", model: "pool-star" }]);
  });

  test("the command reads --pool-names and AIS_T3_POOL_NAMES, the flag winning, and refuses a bad value", async () => {
    const h = home({ favorites: [{ provider: CLAUDE_POOL, model: "m" }] });
    const gw = fakeGateway();
    const run = (flags: Record<string, string | boolean>, env: Record<string, string>) =>
      runT3Command(["favourites", "sync"], { once: true, "t3-home": h.home, ...flags }, { out: () => {}, client: gw.api, stateDir: h.stateDir, env });
    await run({}, { AIS_T3_POOL_NAMES: "claude=from-env" });
    expect((await gw.store.list()).items.map((i) => i.identity)).toEqual(["from-env"]);
    await gw.star(key("m2", "from-flag"));
    await run({ "pool-names": "claude=from-flag" }, { AIS_T3_POOL_NAMES: "claude=from-env" });
    expect(h.read().favorites.some((f: { provider: string; model: string }) => f.provider === CLAUDE_POOL && f.model === "m2")).toBe(true);
    await expect(run({ "pool-names": "claude" }, {})).rejects.toThrow(/pool names/);
    await expect(run({}, { AIS_T3_POOL_NAMES: "nope=x" })).rejects.toThrow(/not a tool/);
  });
});

describe("usage-only instances", () => {
  test.each(["t3-opencode-work-usage", "t3-opencode-work-acp-usage", "t3-claude-work-usage", "t3-grok-work-usage", "t3-kimi-work-acp-usage", "t3-opencode-pool-usage"])("%s is not synced", (id) => {
    expect(instanceToAis(id, names())).toBeUndefined();
  });

  test("a favourite of a usage instance stays in T3 and is never sent; a gateway star does not map to it", async () => {
    const usage = "t3-opencode-work-usage";
    const h = home({ favorites: [{ provider: usage, model: "m" }], instances: [...INSTANCES, usage, "t3-opencode-keep-usage"] });
    const gw = fakeGateway();
    await gw.star(key("g", "keep", "opencode"));
    await syncOnce({ t3Home: h.home, client: gw.api, names: async () => names(), stateDir: h.stateDir, log: () => {} });
    expect(gw.calls.posts).toBe(0);
    expect(h.read().favorites).toEqual([{ provider: usage, model: "m" }]);
  });
});

describe("origin label", () => {
  test("the home key takes the label as a suffix", () => {
    expect(homeKey("/a", "pod-1")).toBe(`${homeKey("/a")}-pod-1`);
    expect(homeKey("/a")).toMatch(/^[0-9a-f]{8}$/);
    expect(metricsPathOf("/a", "/s", "cli", 7, "pod-1")).toBe(`/s/${homeKey("/a")}-pod-1.cli-7.metrics.json`);
  });

  test("the label goes in the origin, the state file and the metrics label", async () => {
    const h = home({ favorites: [{ provider: "t3-claude-work", model: "a" }] });
    const other = home({ favorites: [{ provider: "t3-claude-work", model: "b" }] });
    const gw = fakeGateway();
    const out: string[] = [];
    await runT3Command(["favourites", "sync"], { once: true, "t3-home": h.home, origin: "pod-1" }, { out: (l) => out.push(l), client: gw.api, names: async () => names(), stateDir: h.stateDir, env: {} });
    expect(gw.calls.origins).toEqual([`t3:${homeKey(h.home, "pod-1")}`]);
    expect((await readState({ t3Home: h.home, stateDir: h.stateDir, label: "pod-1" }))?.synced).toHaveLength(1);
    expect(await readState({ t3Home: h.home, stateDir: h.stateDir })).toBeUndefined();
    // The environment gives the label too, and the flag wins.
    await runT3Command(["favourites", "sync"], { once: true, "t3-home": other.home }, { out: () => {}, client: gw.api, names: async () => names(), stateDir: other.stateDir, env: { AIS_T3_FAVOURITES_ORIGIN: "pod-2" } });
    await runT3Command(["favourites", "sync"], { once: true, "t3-home": other.home, origin: "pod-3" }, { out: () => {}, client: gw.api, names: async () => names(), stateDir: other.stateDir, env: { AIS_T3_FAVOURITES_ORIGIN: "pod-2" } });
    expect(gw.calls.origins[1]).toBe(`t3:${homeKey(other.home, "pod-2")}`);
    expect((await readState({ t3Home: other.home, stateDir: other.stateDir, label: "pod-3" }))).toBeDefined();
  });

  test.each(["", "a b", "-x", "a/b", "x".repeat(41), "a:b", "é"])("the label %p is refused", async (label) => {
    const h = home();
    await expect(runT3Command(["favourites", "sync"], { once: true, "t3-home": h.home, origin: label }, { out: () => {}, client: fakeGateway().api, stateDir: h.stateDir, env: {} })).rejects.toThrow(/--origin/);
  });
});

describe("the token the command sends", () => {
  const secrets = "/nonexistent-favsync-secrets";
  test("the favourites token is preferred to the admin token", async () => {
    const env = { AIS_GATEWAY_ADMIN_URL: "http://gw.test", AIS_GATEWAY_ADMIN_TOKEN: "admin-value", AIS_GATEWAY_FAVOURITES_TOKEN: "fav-value" };
    expect(await gatewayAdmin(env, secrets)).toEqual({ url: "http://gw.test", token: "fav-value" });
  });
  test("the admin token is used when there is no favourites token", async () => {
    expect(await gatewayAdmin({ AIS_GATEWAY_ADMIN_URL: "http://gw.test", AIS_GATEWAY_ADMIN_TOKEN: "admin-value" }, secrets)).toEqual({ url: "http://gw.test", token: "admin-value" });
  });
  test("the favourites token alone is enough", async () => {
    expect(await gatewayAdmin({ AIS_GATEWAY_ADMIN_URL: "http://gw.test", AIS_GATEWAY_FAVOURITES_TOKEN: "fav-value" }, secrets)).toEqual({ url: "http://gw.test", token: "fav-value" });
  });
  test("nothing without an address or a token", async () => {
    expect(await gatewayAdmin({ AIS_GATEWAY_FAVOURITES_TOKEN: "fav-value" }, secrets)).toBeUndefined();
    expect(await gatewayAdmin({ AIS_GATEWAY_ADMIN_URL: "http://gw.test" }, secrets)).toBeUndefined();
  });
});
