// The options that let the favourites sync run as a sidecar in a pod: pools with no configuration, usage-only instances, an origin label, the favourites token.
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { runT3Command } from "../../src/cli/t3/dispatch.ts";
import { instanceToAis } from "../../src/t3/favourites/mapping.ts";
import { gatewayAdmin } from "../../src/t3/favourites/config.ts";
import { homeKey, metricsPathOf, readState, syncOnce, type HostNames } from "../../src/t3/favourites/sync.ts";
import { CLAUDE_POOL, CODEX_POOL, fakeGateway, INSTANCES, key, makeHome, names, poolKey, scratch } from "./favourites-fixtures.ts";

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
/** A pod: no identity files, so no registry and no pool name. Names are used as they are. */
const pod = (): HostNames => ({ canonical: (_p, n) => n });

describe("pools in a pod, with no pool name", () => {
  const POOL_FORMS = [[CLAUDE_POOL, "claude"], [CODEX_POOL, "codex"], ["t3-kimi-pool-acp", "kimi"], ["t3-grok-pool", "grok"], ["t3-opencode-pool", "opencode"]] as const;

  test("the pool favourites of every provider in the home go up under the pool key and come down again", async () => {
    const h = home({ favorites: POOL_FORMS.map(([id, p]) => ({ provider: id, model: `t3-${p}` })) });
    const gw = fakeGateway();
    const deps = { t3Home: h.home, client: gw.api, names: async () => pod(), stateDir: h.stateDir, log: () => {} };
    await syncOnce(deps);
    expect((await gw.store.list()).items.map((i) => favLine(i)).sort()).toEqual(POOL_FORMS.map(([, p]) => `${p}/@pool/t3-${p}`).sort());
    // A star made in the side panel on the pool row of a provider reaches the pool instance of the pod.
    await gw.star(poolKey("from-panel", "grok"));
    await gw.star(poolKey("from-panel", "opencode"));
    await syncOnce(deps);
    const favs = h.read().favorites as Array<{ provider: string; model: string }>;
    expect(favs.filter((f) => f.model === "from-panel").map((f) => f.provider).sort()).toEqual(["t3-grok-pool", "t3-opencode-pool"]);
  });

  test("a star removed in T3 on a pool instance is removed at the gateway, and the other way round", async () => {
    const h = home({ favorites: [{ provider: "t3-grok-pool", model: "g" }, { provider: "t3-opencode-pool", model: "o" }] });
    const gw = fakeGateway();
    const deps = { t3Home: h.home, client: gw.api, names: async () => pod(), stateDir: h.stateDir, log: () => {} };
    await syncOnce(deps);
    await gw.star(poolKey("g", "grok"), "remove", Date.now() + 1000);
    await syncOnce(deps);
    expect((h.read().favorites as Array<{ model: string }>).map((f) => f.model)).toEqual(["o"]);
    const text = h.text().replace('"model": "o"', '"model": "o2"');
    (await import("node:fs")).writeFileSync(h.settings, text);
    await syncOnce(deps);
    expect((await gw.store.list()).items.map((i) => favLine(i)).sort()).toEqual(["opencode/@pool/o2"]);
  });

  test("no log line says that a pool is skipped", async () => {
    const h = home({ favorites: [{ provider: CLAUDE_POOL, model: "m" }] });
    const logs: string[] = [];
    await syncOnce({ t3Home: h.home, client: fakeGateway().api, names: async () => pod(), stateDir: h.stateDir, log: (m) => logs.push(m) });
    expect(logs).toEqual([]);
  });

  test("the old pool-name flag and variable are accepted and ignored", async () => {
    const h = home({ favorites: [{ provider: CLAUDE_POOL, model: "m" }] });
    const gw = fakeGateway();
    await runT3Command(["favourites", "sync"], { once: true, "t3-home": h.home, "pool-names": "claude=named,codex=named,kimi=named" }, { out: () => {}, client: gw.api, names: async () => pod(), stateDir: h.stateDir, env: { AIS_T3_POOL_NAMES: "nope=x" } });
    expect((await gw.store.list()).items.map((i) => favLine(i))).toEqual(["claude/@pool/m"]);
  });
});

const favLine = (i: { provider: string; identity: string; model: string }): string => `${i.provider}/${i.identity}/${i.model}`;

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
