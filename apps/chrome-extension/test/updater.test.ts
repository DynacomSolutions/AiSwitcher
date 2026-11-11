import { describe, expect, test } from "bun:test";
import { isNewer, Updater, CHECK_EVERY_MS } from "../src/background/updater.ts";

function make(opts: { version?: string; replies?: Record<string, unknown>; fail?: string; idle?: () => boolean } = {}) {
  const store: Record<string, unknown> = {};
  const calls: string[] = [];
  let reloads = 0;
  let t = 1_000_000;
  const pending: Array<() => void> = [];
  const u = new Updater({
    sendNative: async msg => { calls.push(msg.type); if (opts.fail) throw new Error(opts.fail); return opts.replies?.[msg.type]; },
    reload: async () => { reloads++; },
    version: opts.version ?? "0.5.45",
    isIdle: opts.idle ?? (() => true),
    storage: { get: async keys => Object.fromEntries(keys.filter(k => k in store).map(k => [k, store[k]])), set: async v => { Object.assign(store, v); } },
    now: () => t,
    later: fn => { pending.push(fn); },
  });
  return { u, store, calls, reloads: () => reloads, advance: (ms: number) => { t += ms; }, runLater: () => pending.splice(0).forEach(f => f()) };
}

describe("extension self-update", () => {
  test("version compare", () => {
    expect(isNewer("0.5.46", "0.5.45")).toBe(true);
    expect(isNewer("v0.6.0", "0.5.99")).toBe(true);
    expect(isNewer("0.5.45", "0.5.45")).toBe(false);
    expect(isNewer("0.5.44", "0.5.45")).toBe(false);
    expect(isNewer("garbage", "0.5.45")).toBe(false);
    expect(isNewer(undefined, "0.5.45")).toBe(false);
  });

  test("auto: a newer release is installed and the extension reloads", async () => {
    const m = make({ replies: { check: { ok: true, latest: "0.5.46", installed: "0.5.45" }, update: { ok: true, latest: "0.5.46", installed: "0.5.46", updated: true } } });
    await m.u.load();
    await m.u.tick();
    expect(m.calls).toEqual(["check", "update"]);
    expect(m.reloads()).toBe(1);
  });

  test("auto off: only checks; Update now installs", async () => {
    const m = make({ replies: { check: { ok: true, latest: "0.5.46" }, update: { ok: true, latest: "0.5.46", installed: "0.5.46", updated: true } } });
    await m.u.load();
    await m.u.setAuto(false);
    await m.u.tick(true);
    expect(m.calls).toEqual(["check"]);
    expect(m.u.info()).toMatchObject({ running: "0.5.45", latest: "0.5.46", auto: false });
    await m.u.update();
    expect(m.reloads()).toBe(1);
  });

  test("checks at most every 6 h; the result survives a worker restart", async () => {
    const m = make({ replies: { check: { ok: true, latest: "0.5.45" } } });
    await m.u.load();
    await m.u.tick();
    await m.u.tick();
    expect(m.calls).toEqual(["check"]);
    m.advance(CHECK_EVERY_MS + 1);
    await m.u.tick();
    expect(m.calls).toEqual(["check", "check"]);
    expect(m.reloads()).toBe(0);
  });

  test("the reload waits until no agent call runs", async () => {
    let idle = false;
    const m = make({ idle: () => idle, replies: { update: { ok: true, latest: "0.5.46", installed: "0.5.46", updated: true } } });
    await m.u.load();
    await m.u.update();
    expect(m.reloads()).toBe(0);
    expect(m.u.info().waitingForIdle).toBe(true);
    m.runLater();
    expect(m.reloads()).toBe(0);
    idle = true;
    m.runLater();
    expect(m.reloads()).toBe(1);
  });

  test("files already newer on disk (CLI update): a check reloads without downloading", async () => {
    const m = make({ replies: { check: { ok: true, latest: "0.5.46", installed: "0.5.46" } } });
    await m.u.load();
    await m.u.setAuto(false);
    await m.u.check();
    expect(m.calls).toEqual(["check"]);
    expect(m.reloads()).toBe(1);
  });

  test("helper not registered: the panel is told, nothing reloads", async () => {
    const m = make({ fail: "Specified native messaging host not found." });
    await m.u.load();
    await m.u.tick();
    expect(m.u.info()).toMatchObject({ hostMissing: true });
    expect(m.u.info().error).toBeUndefined();
    expect(m.reloads()).toBe(0);
  });

  test("a helper error is shown and does not reload", async () => {
    const m = make({ replies: { check: { ok: true, latest: "0.5.46" }, update: { ok: false, error: "download failed: HTTP 503" } } });
    await m.u.load();
    await m.u.tick();
    expect(m.u.info()).toMatchObject({ error: "download failed: HTTP 503" });
    expect(m.reloads()).toBe(0);
  });
});
