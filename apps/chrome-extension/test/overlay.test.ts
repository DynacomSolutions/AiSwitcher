import { describe, expect, test } from "bun:test";
import type { PanelStatus } from "../src/shared/panel.ts";
import { viewFor } from "../src/sidepanel/sidepanel.ts";
import { hexForIdentity, OverlayUi } from "../src/background/ui.ts";
import type { Scripting } from "../src/background/ui.ts";

function fakeScripting(opts: { missing?: boolean; slowMs?: number; fail?: boolean } = {}) {
  const calls: Array<{ tabId: number; method: string; arg: unknown }> = [];
  let injected = 0;
  let present = !opts.missing;
  const s: Scripting = {
    async call(tabId, method, arg) {
      if (opts.fail) throw new Error("Cannot access chrome:// pages");
      if (!present) return "missing";
      calls.push({ tabId, method, arg });
      if (opts.slowMs) await new Promise(r => setTimeout(r, opts.slowMs));
      return "ok";
    },
    async inject() { injected++; present = true; },
  };
  return { s, calls, injected: () => injected, navigate: () => { present = false; } };
}
const session = { id: "s", identity: "dyn", label: "dyn / s" };

describe("OverlayUi", () => {
  test("injects once when the page has no overlay, then marks with the identity colour", async () => {
    const f = fakeScripting({ missing: true });
    const ui = new OverlayUi(f.s);
    await ui.markControlled(4, session);
    await ui.markControlled(4, session);
    expect(f.injected()).toBe(1);
    expect(f.calls[0]).toMatchObject({ tabId: 4, method: "mark", arg: { identity: "dyn", color: hexForIdentity("dyn") } });
  });

  test("beforeAction is capped at 350 ms and honours the abort signal", async () => {
    const f = fakeScripting({ slowMs: 2000 });
    const ui = new OverlayUi(f.s);
    await ui.markControlled(4, session);
    const t0 = Date.now();
    await ui.beforeAction(4, { x: 1, y: 2, kind: "click" });
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(300);
    expect(took).toBeLessThan(700);
    const ac = new AbortController();
    const t1 = Date.now();
    const p = ui.beforeAction(4, { x: 1, y: 2, kind: "click" }, ac.signal);
    setTimeout(() => ac.abort(), 20);
    await p;
    expect(Date.now() - t1).toBeLessThan(200);
    const pre = new AbortController();
    pre.abort();
    const n = f.calls.length;
    await ui.beforeAction(4, { x: 1, y: 2, kind: "click" }, pre.signal);
    expect(f.calls.length).toBe(n);
  });

  test("unmark and unmarkAll clear only marked tabs and never inject", async () => {
    const f = fakeScripting({ missing: true });
    const ui = new OverlayUi(f.s);
    await ui.unmark(9);
    expect(f.calls).toHaveLength(0);
    await ui.markControlled(1, session);
    await ui.markControlled(2, session);
    await ui.unmarkAll();
    expect(f.calls.filter(c => c.method === "unmark").map(c => c.tabId).sort()).toEqual([1, 2]);
    expect(ui.has(1)).toBe(false);
    expect(f.injected()).toBe(1);
  });

  test("scripting failures (chrome:// pages) are swallowed", async () => {
    const ui = new OverlayUi(fakeScripting({ fail: true }).s);
    await ui.markControlled(1, session);
    await ui.beforeAction(1, { x: 0, y: 0, kind: "hover" });
    await ui.unmarkAll();
  });
});

describe("side panel view", () => {
  const base: PanelStatus = { status: "connected", paused: false, inflight: 0, signedIn: true, sessions: [] };
  test("paused shows Resume as the primary action", () => {
    const v = viewFor({ ...base, paused: true });
    expect(v.title).toBe("Paused");
    expect(v.actions).toEqual([{ label: "Resume", send: "ais-resume", kind: "primary" }]);
  });
  test("connected offers Pause all and Stop; signed out offers sign in", () => {
    expect(viewFor(base).actions.map(a => a.label)).toEqual(["Pause all", "Stop"]);
    expect(viewFor({ ...base, signedIn: false, status: "idle" }).actions[0]).toMatchObject({ label: "Sign in", open: true });
  });
  test("pause beats reconnecting so a stopped profile never looks usable", () => {
    expect(viewFor({ ...base, status: "reconnecting", paused: true }).chip).toBe("Paused");
  });
});

describe("OverlayUi session end and races", () => {
  test("refresh after the idle window neither redraws nor keeps the entry; activity extends it", async () => {
    const f = fakeScripting();
    let t = 0;
    const ui = new OverlayUi(f.s, () => t);
    await ui.markControlled(3, session);
    t = 80_000;
    await ui.refresh(3);
    expect(f.calls.filter(c => c.method === "mark")).toHaveLength(2);
    await ui.beforeAction(3, { x: 1, y: 1, kind: "click" });
    t = 80_000 + 89_000;
    await ui.refresh(3);
    expect(f.calls.filter(c => c.method === "mark")).toHaveLength(3);
    t += 91_000;
    await ui.refresh(3);
    expect(f.calls.filter(c => c.method === "mark")).toHaveLength(3);
    expect(ui.has(3)).toBe(false);
  });

  test("an unmark that lands during injection wins: no second mark or action call", async () => {
    const f = fakeScripting({ missing: true });
    const ui = new OverlayUi(f.s);
    const inject = f.s.inject;
    f.s.inject = async tabId => { await inject(tabId); await ui.unmark(tabId); };
    await ui.markControlled(5, session);
    expect(f.calls.filter(c => c.method === "mark")).toHaveLength(0);
    const f2 = fakeScripting({ missing: true });
    const ui2 = new OverlayUi(f2.s);
    await ui2.markControlled(6, session);
    f2.navigate(); // the page navigated: overlay gone, next call must re-inject
    f2.s.inject = async () => { await ui2.unmark(6); };
    await ui2.beforeAction(6, { x: 1, y: 1, kind: "click" });
    expect(f2.calls.filter(c => c.method === "action")).toHaveLength(0);
  });

  test("suspend and restore reach only marked tabs and are capped at 150 ms", async () => {
    const f = fakeScripting({ slowMs: 2000 });
    const ui = new OverlayUi(f.s);
    await ui.suspend(1);
    expect(f.calls).toHaveLength(0);
    await ui.markControlled(1, session);
    const t0 = Date.now();
    await ui.suspend(1);
    await ui.restore(1);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(f.calls.map(c => c.method)).toEqual(["mark", "suspend", "restore"]);
  });
});
