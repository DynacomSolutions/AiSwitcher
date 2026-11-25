import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, rmSync } from "node:fs";
import { runT3Command } from "../../src/cli/t3/dispatch.ts";
import { HELP, helpText } from "../../src/cli/help.ts";
import { createT3FavouritesTicker } from "../../src/sync/t3-favourites-ticker.ts";
import { fakeGateway, key, makeHome, names, scratch } from "./favourites-fixtures.ts";

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
const until = async (fn: () => boolean, ms = 4000): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await Bun.sleep(20);
  }
  throw new Error("timed out");
};

describe("ais t3 favourites sync", () => {
  test("--once runs one round for the given home and says what it did", async () => {
    const h = home({ favorites: [{ provider: "t3-claude-work", model: "a" }] });
    const gw = fakeGateway();
    await gw.star(key("b"));
    const out: string[] = [];
    await runT3Command(["favourites", "sync"], { once: true, "t3-home": h.home }, { out: (l) => out.push(l), client: gw.api, names: async () => names(), stateDir: h.stateDir, env: {} });
    expect(out).toEqual(["t3 favourites sync: 1 sent to the gateway, T3 settings updated (list version 2)"]);
    expect(h.read().favorites).toEqual([{ provider: "t3-claude-work", model: "a" }, { provider: "t3-claude-work", model: "b" }]);
    out.length = 0;
    await runT3Command(["favourites", "sync"], { once: true, "t3-home": h.home }, { out: (l) => out.push(l), client: gw.api, names: async () => names(), stateDir: h.stateDir, env: {} });
    expect(out).toEqual(["t3 favourites sync: 0 sent to the gateway, T3 settings unchanged (list version 2)"]);
  });

  test("T3CODE_HOME picks the home when --t3-home is absent", async () => {
    const h = home();
    const gw = fakeGateway();
    await gw.star(key("m"));
    await runT3Command(["favourites", "sync"], { once: true }, { out: () => {}, client: gw.api, names: async () => names(), stateDir: h.stateDir, env: { T3CODE_HOME: h.home } });
    expect(h.read().favorites).toEqual([{ provider: "t3-claude-work", model: "m" }]);
  });

  test("a home with no settings is said, not an error", async () => {
    const dir = scratch();
    cleanups.push(dir);
    const out: string[] = [];
    await runT3Command(["favourites", "sync"], { once: true, "t3-home": dir }, { out: (l) => out.push(l), client: fakeGateway().api, names: async () => names(), stateDir: dir, env: {} });
    expect(out[0]).toContain("no settings.json");
  });

  test("a failing gateway makes the command fail", async () => {
    const h = home();
    const gw = fakeGateway();
    gw.setDown(true);
    await expect(runT3Command(["favourites", "sync"], { once: true, "t3-home": h.home }, { out: () => {}, client: gw.api, names: async () => names(), stateDir: h.stateDir, env: {} })).rejects.toThrow(/down/);
  });

  test("usage errors: wrong words, a bad interval, a bad listen address, no credentials", async () => {
    const deps = { out: () => {}, env: { AIS_SECRETS_FILE: "/nonexistent-favsync-secrets" } };
    await expect(runT3Command([], {}, deps)).rejects.toThrow(/Usage: ais t3 favourites sync/);
    await expect(runT3Command(["favourites"], {}, deps)).rejects.toThrow(/Usage/);
    await expect(runT3Command(["favourites", "sync", "x"], {}, deps)).rejects.toThrow(/Usage/);
    await expect(runT3Command(["favourites", "sync"], { interval: "0" }, deps)).rejects.toThrow(/--interval/);
    await expect(runT3Command(["favourites", "sync"], { "metrics-listen": "nope" }, deps)).rejects.toThrow(/--metrics-listen/);
    const prev = process.env.AIS_SECRETS_FILE;
    process.env.AIS_SECRETS_FILE = "/nonexistent-favsync-secrets";
    try {
      await expect(runT3Command(["favourites", "sync"], { once: true }, { out: () => {}, env: {} })).rejects.toThrow(/AIS_GATEWAY_ADMIN_URL and AIS_GATEWAY_FAVOURITES_TOKEN \(or AIS_GATEWAY_ADMIN_TOKEN\)/);
    } finally {
      if (prev === undefined) delete process.env.AIS_SECRETS_FILE;
      else process.env.AIS_SECRETS_FILE = prev;
    }
  });

  test("the long-running mode serves its counters and stops on the signal", async () => {
    const h = home();
    const gw = fakeGateway();
    const ctl = new AbortController();
    const out: string[] = [];
    const probe = Bun.serve({ port: 0, fetch: () => new Response("") }); // the system picks a free port, so parallel runs never meet
    const port = probe.port;
    await probe.stop(true);
    const run = runT3Command(["favourites", "sync"], { "t3-home": h.home, "metrics-listen": `127.0.0.1:${port}` }, { out: (l) => out.push(l), client: gw.api, names: async () => names(), stateDir: h.stateDir, env: {}, signal: ctl.signal });
    try {
      await until(() => gw.calls.gets > 0);
      let text = "";
      await until(() => {
        void fetch(`http://127.0.0.1:${port}/metrics`).then((r) => r.text()).then((t) => { text = t; }).catch(() => {});
        return text.includes("ais_t3_favourites_sync_pulls_total");
      });
      expect(text).toContain("ais_t3_favourites_sync_errors_total");
      expect(text).not.toContain(h.home);
      expect((await fetch(`http://127.0.0.1:${port}/other`)).status).toBe(404);
    } finally {
      ctl.abort();
      await run;
    }
    expect(out[0]).toContain("following");
    // A clean stop removes the counters file of this process.
    expect(readdirSync(h.stateDir).filter((n) => n.endsWith(".metrics.json"))).toEqual([]);
  });

  test("help lists the command", () => {
    expect(Object.keys(HELP)).toContain("t3");
    expect(helpText(["t3", "favourites"])).toContain("ais t3 favourites sync");
  });
});

describe("the daemon ticker", () => {
  const admin = async () => ({ url: "http://admin.test", token: "tok" });
  test("starts one loop for a home with a settings file, and none for one without", async () => {
    const h = home();
    const empty = scratch();
    cleanups.push(empty);
    const started: string[] = [];
    const t = createT3FavouritesTicker({ homes: () => [h.home, empty], admin, client: () => fakeGateway().api, run: async (d, o) => { started.push(d.t3Home); await new Promise<void>((r) => o.signal?.addEventListener("abort", () => r())); }, log: () => {} });
    await t.tick();
    expect(started).toEqual([h.home]);
    expect(t.running()).toEqual([h.home]);
    await t.tick();
    expect(started).toHaveLength(1);
    t.stop();
    await until(() => t.running().length === 0);
  });

  test("the loop of a home writes a daemon metrics file and removes it when the loop ends", async () => {
    const h = home();
    const t = createT3FavouritesTicker({ homes: () => [h.home], admin, client: () => fakeGateway().api, stateDir: h.stateDir, run: async (d, o) => { d.metrics?.persist(); await new Promise<void>((r) => o.signal?.addEventListener("abort", () => r())); }, log: () => {} });
    await t.tick();
    const files = () => readdirSync(h.stateDir).filter((n) => n.endsWith(".metrics.json"));
    await until(() => files().length === 1);
    expect(files()[0]).toContain(`.daemon-${process.pid}.`);
    t.stop();
    await until(() => files().length === 0);
  });

  test("starts nothing without the gateway admin address and token", async () => {
    const h = home();
    const t = createT3FavouritesTicker({ homes: () => [h.home], admin: async () => undefined, run: async () => { throw new Error("must not run"); }, log: () => {} });
    await t.tick();
    expect(t.running()).toEqual([]);
    t.stop();
  });

  test("a loop that ends is started again after a pause, and stop() ends it for good", async () => {
    const h = home();
    let clock = 1_000_000;
    let runs = 0;
    const t = createT3FavouritesTicker({ homes: () => [h.home], admin, client: () => fakeGateway().api, now: () => clock, run: async () => { runs += 1; throw new Error("boom"); }, log: () => {} });
    await t.tick();
    await until(() => t.running().length === 0);
    expect(runs).toBe(1);
    // The next check is a minute later, past the 10 s pause: the loop starts again.
    clock += 61_000;
    await t.tick();
    expect(runs).toBe(2);
    t.stop();
    await until(() => t.running().length === 0);
    clock += 61_000;
    await t.tick();
    expect(runs).toBe(2);
  });
});
