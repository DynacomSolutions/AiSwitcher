import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { favId } from "../../src/browser/chat-protocol.ts";
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

  test("a change found in T3 is sent with the time the settings file was written, not the time of the push", async () => {
    const e = setup({ favorites: [{ provider: "t3-claude-work", model: "a" }, { provider: "t3-claude-work", model: "b" }] });
    const when = new Date(Date.now() - 3 * 3600_000);
    utimesSync(e.home.settings, when, when);
    const mtime = Math.floor(statSync(e.home.settings).mtimeMs);
    expect(Math.abs(mtime - when.getTime())).toBeLessThan(2);
    await e.round();
    expect(e.gw.calls.posted.flat().map((c) => c.at)).toEqual([mtime, mtime]);
    // The removal of one of them, made 2 hours ago, goes with that time.
    const raw = e.home.read();
    raw.favorites = [{ provider: "t3-claude-work", model: "a" }];
    writeFileSync(e.home.settings, `${JSON.stringify(raw, null, 2)}\n`);
    const later = new Date(Date.now() - 2 * 3600_000);
    utimesSync(e.home.settings, later, later);
    const laterMs = Math.floor(statSync(e.home.settings).mtimeMs);
    await e.round();
    expect(e.gw.calls.posted.at(-1)).toEqual([expect.objectContaining({ model: "b", op: "remove", at: laterMs })]);
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

  test("a star the gateway refuses (full list, `cap`) stays in T3, is not recorded as synced and goes up again later", async () => {
    const e = setup();
    for (let i = 0; i < 200; i++) await e.gw.star(key(`g${i}`), "add", Date.now() - 100_000 + i);
    await e.round();
    expect(e.favs()).toHaveLength(200);
    const raw = e.home.read();
    raw.favorites = [...raw.favorites, { provider: "t3-claude-work", model: "fresh" }];
    writeFileSync(e.home.settings, `${JSON.stringify(raw, null, 2)}\n`);
    expect(await e.round()).toMatchObject({ status: "ok", pushed: 1 });
    // Not deleted from T3, not at the gateway, not in the state.
    expect(e.favs().some((f) => f.model === "fresh")).toBe(true);
    expect((await e.gw.store.list()).items.some((i) => i.model === "fresh")).toBe(false);
    expect((await readState(e.deps))?.synced.some((k) => k.model === "fresh")).toBe(false);
    expect(e.metrics.s.refused).toBe(1);
    // It is sent again, and refused again, while the list stays full.
    expect(await e.round()).toMatchObject({ status: "ok", pushed: 1 });
    expect(e.favs().some((f) => f.model === "fresh")).toBe(true);
    // Room appears: the next round sends it again and it is accepted.
    await e.gw.star(key("g0"), "remove");
    await e.round();
    expect((await e.gw.store.list()).items.some((i) => i.model === "fresh")).toBe(true);
    expect(e.favs().some((f) => f.model === "fresh")).toBe(true);
    expect((await readState(e.deps))?.synced.some((k) => k.model === "fresh")).toBe(true);
    expect(e.favs().some((f) => f.model === "g0")).toBe(false);
  });

  test("an add that lost to a newer removal (stale) is dropped from T3, not recorded as synced and not sent again", async () => {
    const e = setup({ favorites: [{ provider: "t3-claude-work", model: "lost" }, { provider: "t3-claude-work", model: "ok" }] });
    const when = new Date(Date.now() - 3 * 3600_000);
    utimesSync(e.home.settings, when, when);
    // The gateway holds a removal of "lost" that is newer than the T3 change.
    await e.gw.star(key("lost"), "add", Date.now() - 5 * 3600_000);
    await e.gw.star(key("lost"), "remove", Date.now() - 3600_000);
    expect(await e.round()).toMatchObject({ status: "ok", pushed: 2, wrote: true });
    expect(e.metrics.s.refused).toBe(1);
    expect(e.favs()).toEqual([{ provider: "t3-claude-work", model: "ok" }]);
    expect((await e.gw.store.list()).items.map((i) => i.model)).toEqual(["ok"]);
    expect((await readState(e.deps))?.synced).toEqual([key("ok")]);
    // The next rounds send nothing: the dead add is not re-sent.
    const posts = e.gw.calls.posts;
    expect(await e.round()).toMatchObject({ status: "ok", pushed: 0 });
    expect(e.gw.calls.posts).toBe(posts);
    expect(e.favs()).toEqual([{ provider: "t3-claude-work", model: "ok" }]);
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

  test("an unrelated T3 save does not re-date a change that waits: the old removal stays older than a newer panel add", async () => {
    const X = { provider: "t3-claude-work", model: "x" };
    const e = setup({ favorites: [X, { provider: "t3-claude-work", model: "y" }] });
    const ago = (h: number) => { const t = new Date(Date.now() - h * 3600_000); return t; };
    const stamp = (h: number) => utimesSync(e.home.settings, ago(h), ago(h));
    const rewrite = (fn: (raw: Record<string, any>) => void, h: number) => { const raw = e.home.read(); fn(raw); writeFileSync(e.home.settings, `${JSON.stringify(raw, null, 2)}\n`); stamp(h); };
    stamp(6);
    await e.round();
    expect((await e.gw.store.list()).items.map((i) => i.model).sort()).toEqual(["x", "y"]);
    // t1: T3 removes X while the gateway is down. The rounds fail.
    e.gw.setDown(true);
    rewrite((raw) => { raw.favorites = raw.favorites.filter((f: { model: string }) => f.model !== "x"); }, 4);
    await expect(e.round()).rejects.toThrow(/down/);
    // t2: the panel adds X (the store is reached by another route). t3: T3 saves an unrelated key.
    await e.gw.star(key("x"), "add", Date.now() - 3 * 3600_000);
    rewrite((raw) => { raw.defaultAutoPull = false; }, 2);
    await expect(e.round()).rejects.toThrow(/down/);
    e.gw.setDown(false);
    await e.round();
    // The removal is dated t1 < t2, so it lost: X stays starred at the gateway and in T3.
    expect((await e.gw.store.list()).items.map((i) => i.model).sort()).toEqual(["x", "y"]);
    expect(e.favs().map((f) => f.model).sort()).toEqual(["x", "y"]);
    expect((await readState(e.deps))?.synced.map((k) => k.model).sort()).toEqual(["x", "y"]);
    expect((await readState(e.deps))?.pending).toBeUndefined();
    expect(e.metrics.s.refused).toBe(1);
  });

  test("a pending change keeps its first time across rounds, a different op for the same star gets a new time, a state file with no pending map is read", async () => {
    const A = { provider: "t3-claude-work", model: "a" };
    const e = setup({ favorites: [A] });
    utimesSync(e.home.settings, new Date(Date.now() - 5 * 3600_000), new Date(Date.now() - 5 * 3600_000));
    await e.round();
    const stateFile = join(e.stateDir, `${homeKey(e.home.home)}.json`);
    const old = JSON.parse(readFileSync(stateFile, "utf8"));
    expect(old.pending).toBeUndefined();
    expect((await readState(e.deps))?.pending).toBeUndefined();
    const edit = (favorites: unknown[], h: number) => { const raw = e.home.read(); raw.favorites = favorites; writeFileSync(e.home.settings, `${JSON.stringify(raw, null, 2)}\n`); const t = new Date(Date.now() - h * 3600_000); utimesSync(e.home.settings, t, t); return Math.floor(statSync(e.home.settings).mtimeMs); };
    e.gw.setDown(true);
    const t1 = edit([], 4);
    await expect(e.round()).rejects.toThrow(/down/);
    expect((await readState(e.deps))?.pending).toEqual({ [favId(key("a"))]: { op: "remove", at: t1 } });
    edit([], 1);
    await expect(e.round()).rejects.toThrow(/down/);
    expect(Object.values((await readState(e.deps))?.pending ?? {})).toEqual([{ op: "remove", at: t1 }]);
    // T3 stars it again: the difference is gone, then a new removal is a new change with a new time.
    edit([A], 3);
    await expect(e.round()).rejects.toThrow(/down/);
    expect((await readState(e.deps))?.pending).toBeUndefined();
    const t4 = edit([], 0.5);
    await expect(e.round()).rejects.toThrow(/down/);
    expect(Object.values((await readState(e.deps))?.pending ?? {})).toEqual([{ op: "remove", at: t4 }]);
  });

  test("a cap-refused add keeps its entry and its first time", async () => {
    const e = setup();
    for (let i = 0; i < 200; i++) await e.gw.star(key(`g${i}`), "add", Date.now() - 100_000 + i);
    await e.round();
    const raw = e.home.read();
    raw.favorites = [...raw.favorites, { provider: "t3-claude-work", model: "fresh" }];
    writeFileSync(e.home.settings, `${JSON.stringify(raw, null, 2)}\n`);
    const t = new Date(Date.now() - 2 * 3600_000);
    utimesSync(e.home.settings, t, t);
    const t1 = Math.floor(statSync(e.home.settings).mtimeMs);
    await e.round();
    expect(Object.values((await readState(e.deps))?.pending ?? {})).toEqual([{ op: "add", at: t1 }]);
    // An unrelated save moves the mtime: the add is still sent with t1.
    const raw2 = e.home.read();
    raw2.defaultAutoPull = false;
    writeFileSync(e.home.settings, `${JSON.stringify(raw2, null, 2)}\n`);
    await e.round();
    expect(e.gw.calls.posted.at(-1)).toEqual([expect.objectContaining({ model: "fresh", op: "add", at: t1 })]);
    // Room appears: it is accepted and the entry goes.
    await e.gw.star(key("g0"), "remove");
    await e.round();
    expect((await e.gw.store.list()).items.some((i) => i.model === "fresh")).toBe(true);
    expect((await readState(e.deps))?.pending).toBeUndefined();
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
  const hk = homeKey("/some/t3/home");
  test("the snapshot file renders as Prometheus text without a path, labelled with the role and the process", () => {
    const dir = scratch();
    cleanups.push(dir);
    const m = new FavSyncMetrics(metricsPathOf("/some/t3/home", dir));
    m.s.pulls = 4;
    m.s.pushes = 2;
    m.s.writes = 1;
    m.s.errors = 3;
    m.s.refused = 2;
    m.persist();
    const text = renderSnapshots(readSnapshots(dir));
    const labels = `{home="${hk}",role="cli",pid="${process.pid}"}`;
    for (const name of ["pulls_total", "pushes_total", "writes_total", "errors_total", "last_success_timestamp_seconds"]) expect(text).toContain(`ais_t3_favourites_sync_${name}${labels}`);
    expect(text).toContain(`ais_t3_favourites_sync_pulls_total${labels} 4`);
    expect(text).toContain(`ais_t3_favourites_sync_errors_total${labels} 3`);
    expect(text).toContain(`ais_t3_favourites_sync_refused_total${labels} 2`);
    expect(text).not.toContain("/some/t3/home");
    expect(renderSnapshots([])).toBe("");
    expect(readSnapshots(join(dir, "missing"))).toEqual([]);
  });

  test("two processes for one home write two files and keep two series", () => {
    const dir = scratch();
    cleanups.push(dir);
    expect(metricsPathOf("/h", dir, "daemon", 11)).not.toBe(metricsPathOf("/h", dir, "cli", 11));
    expect(metricsPathOf("/h", dir, "cli", 11)).not.toBe(metricsPathOf("/h", dir, "cli", 12));
    const daemon = new FavSyncMetrics(metricsPathOf("/some/t3/home", dir, "daemon"), Date.now, "daemon");
    const cli = new FavSyncMetrics(metricsPathOf("/some/t3/home", dir, "cli"), Date.now, "cli");
    daemon.s.pulls = 40;
    cli.s.pulls = 3;
    daemon.persist();
    cli.persist();
    cli.s.pulls = 4;
    cli.persist();
    const text = renderSnapshots(readSnapshots(dir));
    expect(text).toContain(`ais_t3_favourites_sync_pulls_total{home="${hk}",role="daemon",pid="${process.pid}"} 40`);
    expect(text).toContain(`ais_t3_favourites_sync_pulls_total{home="${hk}",role="cli",pid="${process.pid}"} 4`);
  });

  test("a process that exits cleanly removes its file, and a file of a dead process is not served", () => {
    const dir = scratch();
    cleanups.push(dir);
    const m = new FavSyncMetrics(metricsPathOf("/some/t3/home", dir));
    m.persist();
    expect(readSnapshots(dir)).toHaveLength(1);
    m.remove();
    expect(readSnapshots(dir)).toEqual([]);
    m.persist();
    expect(readSnapshots(dir)).toEqual([]);
    // A crashed process leaves its file. Its pid is gone, so the console does not serve its counters.
    const dead = new FavSyncMetrics(metricsPathOf("/some/t3/home", dir, "cli", 4_194_303), Date.now, "cli", 4_194_303);
    dead.persist();
    expect(readSnapshots(dir)).toEqual([]);
  });
});
