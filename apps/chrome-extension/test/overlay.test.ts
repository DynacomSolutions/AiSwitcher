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
  return { s, calls, injected: () => injected };
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
  const base: PanelStatus = { status: "connected", paused: false, signedIn: true, sessions: [] };
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
