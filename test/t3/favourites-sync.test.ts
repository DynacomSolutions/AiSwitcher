import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { FavSyncMetrics, readSnapshots, renderSnapshots } from "../../src/t3/favourites/metrics.ts";
import { homeKey, metricsPathOf, readState, runFavouritesSync, syncOnce, type FavSyncDeps } from "../../src/t3/favourites/sync.ts";
import { CLAUDE_POOL, fakeGateway, key, makeHome, names, scratch } from "./favourites-fixtures.ts";

const cleanups: string[] = [];
afterEach(() => {
  for (const p of cleanups.splice(0)) rmSync(p, { recursive: true, force: true });
});

function setup(opts: Parameters<typeof makeHome>[0] = {}) {
  const home = makeHome(opts);
  const stateDir = scratch();
  cleanups.push(home.home, stateDir);
  const gw = fakeGateway();
  const metrics = new FavSyncMetrics();
  const deps: FavSyncDeps = { t3Home: home.home, client: gw.api, names: async () => names(), stateDir, metrics, log: () => {} };
  const favs = () => home.read().favorites as Array<{ provider: string; model: string }>;
  return { home, stateDir, gw, metrics, deps, favs, round: () => syncOnce(deps) };
}

describe("one round", () => {
  test("a home with no settings does nothing", async () => {
    const e = setup();
    rmSync(e.home.settings);
    expect(await e.round()).toEqual({ status: "no-settings" });
  });

  test("T3 stars go up on the first run and the gateway stars come down", async () => {
    const e = setup({ favorites: [{ provider: "t3-claude-work", model: "from-t3" }, { provider: "claudeAgent", model: "builtin" }] });
    await e.gw.star(key("from-chrome", "pool"));
    const r = await e.round();
    expect(r).toMatchObject({ status: "ok", pushed: 1, wrote: true });
    expect((await e.gw.store.list()).items.map((i) => `${i.identity}/${i.model}`).sort()).toEqual(["pool/from-chrome", "work/from-t3"]);
    expect(e.favs()).toEqual([{ provider: "t3-claude-work", model: "from-t3" }, { provider: "claudeAgent", model: "builtin" }, { provider: CLAUDE_POOL, model: "from-chrome" }]);
    expect(e.metrics.s).toMatchObject({ pulls: 1, pushes: 1, writes: 1 });
  });

  test("a second round with no change sends nothing, writes nothing and leaves the file as it was", async () => {
    const e = setup({ favorites: [{ provider: "t3-claude-work", model: "a" }] });
    await e.round();
    const mtime = statSync(e.home.settings).mtimeMs;
    const text = e.home.text();
    const posts = e.gw.calls.posts;
    for (let i = 0; i < 3; i++) expect(await e.round()).toMatchObject({ status: "ok", pushed: 0, wrote: false });
    expect(e.gw.calls.posts).toBe(posts);
    expect(statSync(e.home.settings).mtimeMs).toBe(mtime);
    expect(e.home.text()).toBe(text);
  });

  test("a star in the panel reaches T3, and a removal in the panel removes it in T3", async () => {
    const e = setup();
    await e.round();
    await e.gw.star(key("m1"));
    await e.round();
    expect(e.favs()).toEqual([{ provider: "t3-claude-work", model: "m1" }]);
    await e.gw.star(key("m1"), "remove");
    await e.round();
    expect(e.favs()).toEqual([]);
  });

  test("a removal in T3 is found against the last sync and removes the star at the gateway", async () => {
    const e = setup({ favorites: [{ provider: "t3-claude-work", model: "a" }, { provider: "t3-claude-work", model: "b" }] });
    await e.round();
    expect((await e.gw.store.list()).items).toHaveLength(2);
    const raw = e.home.read();
    raw.favorites = [{ provider: "t3-claude-work", model: "a" }];
    writeFileSync(e.home.settings, `${JSON.stringify(raw, null, 2)}\n`);
    await e.round();
    expect((await e.gw.store.list()).items.map((i) => i.model)).toEqual(["a"]);
    expect(e.favs()).toEqual([{ provider: "t3-claude-work", model: "a" }]);
  });

  test("a star in T3 and a star in the panel at the same time both survive on both sides", async () => {
    const e = setup();
    await e.round();
    const raw = e.home.read();
    raw.favorites = [{ provider: "t3-claude-work", model: "from-t3" }];
    writeFileSync(e.home.settings, `${JSON.stringify(raw, null, 2)}\n`);
    await e.gw.star(key("from-panel"));
    await e.round();
    expect(e.favs().map((f) => f.model).sort()).toEqual(["from-panel", "from-t3"]);
    expect((await e.gw.store.list()).items.map((i) => i.model).sort()).toEqual(["from-panel", "from-t3"]);
  });

  test("a removal in the panel and an add of another star in T3 at the same time both apply", async () => {
    const e = setup({ favorites: [{ provider: "t3-claude-work", model: "old" }] });
    await e.round();
    await e.gw.star(key("old"), "remove");
    const raw = e.home.read();
    raw.favorites = [{ provider: "t3-claude-work", model: "old" }, { provider: "t3-claude-work", model: "new" }];
    writeFileSync(e.home.settings, `${JSON.stringify(raw, null, 2)}\n`);
    await e.round();
    expect(e.favs()).toEqual([{ provider: "t3-claude-work", model: "new" }]);
    expect((await e.gw.store.list()).items.map((i) => i.model)).toEqual(["new"]);
  });

  test("favourites of instances AIS does not manage are never touched, sent or counted", async () => {
    const e = setup({ favorites: [{ provider: "claudeAgent", model: "x" }, { provider: "t3-claude-kimi-work", model: "k" }] });
    await e.round();
    await e.round();
    expect((await e.gw.store.list()).items).toEqual([]);
    expect(e.favs()).toEqual([{ provider: "claudeAgent", model: "x" }, { provider: "t3-claude-kimi-work", model: "k" }]);
    // Even when every mapped star is removed at the gateway.
    await e.gw.star(key("m"));
    await e.round();
    await e.gw.star(key("m"), "remove");
    await e.round();
    expect(e.favs()).toEqual([{ provider: "claudeAgent", model: "x" }, { provider: "t3-claude-kimi-work", model: "k" }]);
  });

  test("a favourite with a name the gateway refuses stays untouched and stops nothing else", async () => {
    const odd = { provider: "t3-claude-work", model: "opus[1m]" };
    const e = setup({ favorites: [odd, { provider: "t3-claude-work", model: "ok" }] });
    await e.gw.star(key("from-panel"));
    expect(await e.round()).toMatchObject({ status: "ok", pushed: 1, wrote: true });
    expect(e.gw.calls.posted.flat().map((c) => c.model)).toEqual(["ok"]);
    expect(e.favs()).toEqual([odd, { provider: "t3-claude-work", model: "ok" }, { provider: "t3-claude-work", model: "from-panel" }]);
    await e.gw.star(key("ok"), "remove");
    await e.round();
    expect(e.favs()).toEqual([odd, { provider: "t3-claude-work", model: "from-panel" }]);
  });

  test("a bad entry in the state file is skipped, the rest is kept", async () => {
    const e = setup({ favorites: [{ provider: "t3-claude-work", model: "a" }] });
    await e.round();
    const file = join(e.stateDir, `${homeKey(e.home.home)}.json`);
    const s = JSON.parse(readFileSync(file, "utf8"));
    s.synced = [{ provider: "claude", identity: "work", model: "opus[1m]" }, ...s.synced, 7, null];
    writeFileSync(file, JSON.stringify(s));
    expect((await readState(e.deps))?.synced).toEqual([key("a")]);
  });

  test("a gateway star with no instance on this host is not written and does not come back as a removal", async () => {
    const e = setup();
    await e.gw.star(key("m", "stranger"));
    await e.round();
    expect(e.favs()).toEqual([]);
    await e.round();
    expect((await e.gw.store.list()).items).toHaveLength(1);
  });

  test("a gateway that lost its data gets the T3 stars again and T3 loses nothing", async () => {
    const e = setup({ favorites: [{ provider: "t3-claude-work", model: "a" }] });
    await e.round();
    await e.gw.star(key("b"));
    await e.round();
    expect(e.favs().map((f) => f.model)).toEqual(["a", "b"]);
    // A new gateway store: the version is below the remembered one.
    const fresh = fakeGateway();
    e.deps.client = fresh.api;
    await syncOnce(e.deps);
    expect(e.favs().map((f) => f.model)).toEqual(["a", "b"]);
    expect((await fresh.store.list()).items.map((i) => i.model).sort()).toEqual(["a", "b"]);
  });

  test("a gateway that was reset keeps the T3 stars even when its new version is past the old one", async () => {
    const e = setup({ favorites: [{ provider: "t3-claude-work", model: "a" }] });
    await e.round();
    await e.gw.star(key("b"));
    await e.round();
    expect((await readState(e.deps))?.seq).toBe(2);
    // A rebuilt store that has already gone past version 2 before the host reads it.
    const fresh = fakeGateway();
    for (const m of ["c", "d", "e"]) await fresh.star(key(m));
    expect((await fresh.store.list()).seq).toBeGreaterThanOrEqual(2);
    e.deps.client = fresh.api;
    await syncOnce(e.deps);
    expect(e.favs().map((f) => f.model).sort()).toEqual(["a", "b", "c", "d", "e"]);
    expect((await fresh.store.list()).items.map((i) => i.model).sort()).toEqual(["a", "b", "c", "d", "e"]);
    expect((await readState(e.deps))?.epoch).toBe((await fresh.store.list()).epoch);
  });

  test("a state file from before the epoch is still read, and the epoch is taken on the next round", async () => {
    const e = setup({ favorites: [{ provider: "t3-claude-work", model: "a" }] });
    await e.round();
    const file = join(e.stateDir, `${homeKey(e.home.home)}.json`);
    const s = JSON.parse(readFileSync(file, "utf8"));
    delete s.epoch;
    writeFileSync(file, JSON.stringify(s));
    expect((await readState(e.deps))?.epoch).toBeUndefined();
    await e.round();
    expect(e.favs()).toHaveLength(1);
    expect((await readState(e.deps))?.epoch).toBe((await e.gw.store.list()).epoch);
  });

  test("a gateway that is down fails the round and changes nothing", async () => {
    const e = setup({ favorites: [{ provider: "t3-claude-work", model: "a" }] });
    await e.round();
    e.gw.setDown(true);
    await expect(e.round()).rejects.toThrow(/down/);
    expect(e.favs()).toHaveLength(1);
    expect((await readState(e.deps))?.synced).toEqual([key("a")]);
  });

  test("when T3 writes its settings during the round, nothing is replaced and the round says retry", async () => {
    const e = setup();
    await e.gw.star(key("m"));
    let once = true;
    const real = e.gw.api.get;
    e.deps.client = { ...e.gw.api, get: async (...a) => {
      const r = await real(...a);
      if (once) {
        once = false;
        const raw = e.home.read();
        raw.defaultAutoPull = false;
        writeFileSync(e.home.settings, `${JSON.stringify(raw, null, 2)}\n`);
      }
      return r;
    } };
    expect(await syncOnce(e.deps)).toEqual({ status: "retry" });
    expect(e.home.read().defaultAutoPull).toBe(false);
    expect(e.favs()).toEqual([]);
    expect(await syncOnce(e.deps)).toMatchObject({ status: "ok", wrote: true });
    expect(e.home.read().defaultAutoPull).toBe(false);
    expect(e.favs()).toEqual([{ provider: "t3-claude-work", model: "m" }]);
  });

  test("the state file keeps no path of the home and is private", async () => {
    const e = setup({ favorites: [{ provider: "t3-claude-work", model: "a" }] });
    await e.round();
    const file = join(e.stateDir, `${homeKey(e.home.home)}.json`);
    expect(readFileSync(file, "utf8")).not.toContain(e.home.home);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

const until = async (fn: () => boolean | Promise<boolean>, ms = 4000): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await Bun.sleep(20);
  }
  throw new Error("timed out");
};

describe("the long-running mode", () => {
  test("follows the file and the gateway live, and its own write starts no loop", async () => {
    const e = setup({ favorites: [{ provider: "t3-claude-work", model: "a" }] });
    const ctl = new AbortController();
    const run = runFavouritesSync(e.deps, { signal: ctl.signal, fallbackMs: 60_000, waitMs: 300, settleMs: 30 });
    try {
      await until(async () => (await e.gw.store.list()).items.length === 1);
      // A star in the panel shows in the settings file.
      await e.gw.star(key("from-panel"));
      await until(() => e.favs().some((f) => f.model === "from-panel"));
      // A star in T3 reaches the gateway: T3 writes the file, the watch fires.
      const raw = e.home.read();
      raw.favorites = [...raw.favorites, { provider: "t3-codex-work", model: "from-t3" }];
      writeFileSync(e.home.settings, `${JSON.stringify(raw, null, 2)}\n`);
      await until(async () => (await e.gw.store.list()).items.some((i) => i.model === "from-t3"));
      // Quiet: after the writes of its own the loop sends and writes nothing more.
      await Bun.sleep(400);
      const posts = e.gw.calls.posts;
      const writes = e.metrics.s.writes;
      const mtime = statSync(e.home.settings).mtimeMs;
      await Bun.sleep(600);
      expect(e.gw.calls.posts).toBe(posts);
      expect(e.metrics.s.writes).toBe(writes);
      expect(statSync(e.home.settings).mtimeMs).toBe(mtime);
      expect(e.metrics.s.lastSuccess).toBeGreaterThan(0);
    } finally {
      ctl.abort();
      await run;
    }
  });

  test("a failing gateway is logged once, counted, and the loop recovers", async () => {
    const e = setup();
    const lines: string[] = [];
    e.deps.log = (m) => lines.push(m);
    e.gw.setDown(true);
    const ctl = new AbortController();
    const run = runFavouritesSync(e.deps, { signal: ctl.signal, fallbackMs: 60_000, waitMs: 100, backoffMs: 20, maxBackoffMs: 40, settleMs: 10 });
    try {
      await until(() => e.metrics.s.errors >= 3);
      expect(lines.filter((l) => l.includes("down"))).toHaveLength(1);
      e.gw.setDown(false);
      await e.gw.star(key("m"));
      await until(() => e.favs().length === 1);
      expect(lines.some((l) => l.includes("working again"))).toBe(true);
    } finally {
      ctl.abort();
      await run;
    }
  });
});

describe("metrics", () => {
  test("the snapshot file renders as Prometheus text without a path", () => {
    const dir = scratch();
    cleanups.push(dir);
    const m = new FavSyncMetrics(metricsPathOf("/some/t3/home", dir));
    m.s.pulls = 4;
    m.s.pushes = 2;
    m.s.writes = 1;
    m.s.errors = 3;
    m.persist();
    const text = renderSnapshots(readSnapshots(dir));
    for (const name of ["pulls_total", "pushes_total", "writes_total", "errors_total", "last_success_timestamp_seconds"]) expect(text).toContain(`ais_t3_favourites_sync_${name}{home="${homeKey("/some/t3/home")}"}`);
    expect(text).toContain(`ais_t3_favourites_sync_pulls_total{home="${homeKey("/some/t3/home")}"} 4`);
    expect(text).toContain(`ais_t3_favourites_sync_errors_total{home="${homeKey("/some/t3/home")}"} 3`);
    expect(text).not.toContain("/some/t3/home");
    expect(renderSnapshots([])).toBe("");
    expect(readSnapshots(join(dir, "missing"))).toEqual([]);
  });
});
