import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolLimitResult } from "../../src/cli/limits/types.ts";
import { expiringResets, messageFor, ResetExpiryNotifier, stageFor } from "../../src/server/reset-expiry-push.ts";
import type { PushMessage } from "../../src/server/web-push.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const statePath = () => {
  const d = mkdtempSync(join(tmpdir(), "ais-reset-push-"));
  dirs.push(d);
  return join(d, "reset-expiry-push.json");
};

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const T0 = Date.parse("2026-11-17T00:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

function claude(name: string, grants: { id: string; resetsLeft: number; endsAt?: string; label?: string }[], extra: Partial<ToolLimitResult["identity"]> = {}): ToolLimitResult {
  return {
    toolName: "claude",
    provider: "anthropic",
    identity: { name, configDir: "/tmp/x", ...extra } as ToolLimitResult["identity"],
    windows: [],
    status: "live",
    manualReset: {
      availableCount: 0,
      grants: grants.map((g) => ({ ...g, kind: "full" as const, usableNow: g.resetsLeft > 0, paused: false })),
    },
  };
}

function codex(name: string, endsAt: string): ToolLimitResult {
  return {
    toolName: "codex",
    provider: "openai",
    identity: { name, configDir: "/tmp/y" } as ToolLimitResult["identity"],
    windows: [],
    status: "live",
    manualReset: { availableCount: 1, creditExpiries: [{ id: "RateLimitResetCredit_SYNTHETIC_FIXTURE", label: "Full reset (Weekly + 5 hr)", endsAt }] },
  };
}

describe("stageFor", () => {
  test("7 days, 3 days, 24 hours and nothing outside", () => {
    const at = (ms: number) => stageFor(iso(T0 + ms), T0);
    expect(at(8 * DAY)).toBeUndefined();
    expect(at(7 * DAY)).toBe("7d");
    expect(at(4 * DAY)).toBe("7d");
    expect(at(3 * DAY)).toBe("3d");
    expect(at(25 * HOUR)).toBe("3d");
    expect(at(24 * HOUR)).toBe("24h");
    expect(at(HOUR)).toBe("24h");
    expect(at(-HOUR)).toBeUndefined();
  });
});

describe("expiringResets", () => {
  test("unspent Claude grants and Codex credits with a future end; pools, retired, spent and ended skipped", () => {
    const items = expiringResets(
      [
        claude("alpha", [
          { id: "full-reset-SYNTHETIC_FIXTURE", resetsLeft: 2, endsAt: iso(T0 + 5 * DAY), label: "Full reset" },
          { id: "spent-SYNTHETIC_FIXTURE", resetsLeft: 0, endsAt: iso(T0 + 5 * DAY) },
          { id: "ended-SYNTHETIC_FIXTURE", resetsLeft: 1, endsAt: iso(T0 - DAY) },
          { id: "no-end-SYNTHETIC_FIXTURE", resetsLeft: 1 },
        ]),
        claude("pool", [{ id: "full-reset-SYNTHETIC_FIXTURE", resetsLeft: 2, endsAt: iso(T0 + 5 * DAY) }], { swapPool: { members: [] } } as never),
        claude("old", [{ id: "full-reset-SYNTHETIC_FIXTURE", resetsLeft: 1, endsAt: iso(T0 + 5 * DAY) }], { retired: true }),
        codex("beta", iso(T0 + 2 * DAY)),
      ],
      T0,
    );
    expect(items.map((i) => [i.provider, i.identity, i.label, i.resetsLeft])).toEqual([
      ["Claude", "alpha", "Full reset", 2],
      ["Codex", "beta", "Full reset (Weekly + 5 hr)", undefined],
    ]);
  });

  test("the message names the provider, time left, account and deadline", () => {
    const [item] = expiringResets([claude("alpha", [{ id: "g-SYNTHETIC_FIXTURE", resetsLeft: 2, endsAt: iso(T0 + 3 * DAY), label: "Full reset" }])], T0);
    const msg = messageFor(item!, T0, "UTC");
    expect(msg.title).toBe("Claude reset expires in 3 days");
    expect(msg.body).toBe("alpha: Full reset (2 left). Use it before Fri 20 Nov, 00:00.");
    expect(msg.url).toBe("/limits");
    expect(messageFor(item!, T0 + 3 * DAY - 5 * HOUR, "UTC").title).toBe("Claude reset expires in 5 hours");
  });
});

describe("ResetExpiryNotifier", () => {
  const endsAt = iso(T0 + 8 * DAY);
  const results = [claude("alpha", [{ id: "g-SYNTHETIC_FIXTURE", resetsLeft: 1, endsAt, label: "Full reset" }])];

  function harness(sentPer = 1) {
    let now = T0;
    const sent: PushMessage[] = [];
    const path = statePath();
    const notifier = new ResetExpiryNotifier({
      scanLimits: async () => ({ ok: true, payload: { results } }),
      send: async (m) => {
        sent.push(m);
        return { sent: sentPer, removed: 0, failed: sentPer > 0 ? 0 : 1 };
      },
      hasSubscribers: async () => true,
      statePath: path,
      now: () => now,
      log: () => {},
      timeZone: "UTC",
    });
    return { notifier, sent, path, setNow: (ms: number) => (now = ms) };
  }

  test("one reminder at 7 days, one at 3 days, one at 24 hours, never repeated", async () => {
    const h = harness();
    expect(await h.notifier.tick()).toBe(0); // 8 days left
    h.setNow(T0 + DAY); // 7 days left
    expect(await h.notifier.tick()).toBe(1);
    h.setNow(T0 + DAY + HOUR);
    expect(await h.notifier.tick()).toBe(0);
    h.setNow(T0 + 5 * DAY); // 3 days left
    expect(await h.notifier.tick()).toBe(1);
    h.setNow(T0 + 6 * DAY); // 2 days left, still the 3-day stage
    expect(await h.notifier.tick()).toBe(0);
    h.setNow(T0 + 7 * DAY + HOUR); // 23 hours left
    expect(await h.notifier.tick()).toBe(1);
    h.setNow(T0 + 7 * DAY + 10 * HOUR);
    expect(await h.notifier.tick()).toBe(0);
    expect(h.sent.map((m) => m.title)).toEqual(["Claude reset expires in 7 days", "Claude reset expires in 3 days", "Claude reset expires in 23 hours"]);
  });

  test("a reset first seen inside a later stage gets only that reminder", async () => {
    const h = harness();
    h.setNow(T0 + 6 * DAY); // 2 days left
    expect(await h.notifier.tick()).toBe(1);
    h.setNow(T0 + 6 * DAY + HOUR);
    expect(await h.notifier.tick()).toBe(0);
    expect(h.sent).toHaveLength(1);
  });

  test("a push no device took is retried on the next check", async () => {
    const h = harness(0);
    h.setNow(T0 + DAY);
    expect(await h.notifier.tick()).toBe(0);
    expect(await h.notifier.tick()).toBe(0);
    expect(h.sent).toHaveLength(2);
  });

  test("sent stages survive a restart and ended resets are forgotten", async () => {
    const h = harness();
    h.setNow(T0 + DAY);
    await h.notifier.tick();
    const again = new ResetExpiryNotifier({
      scanLimits: async () => ({ ok: true, payload: { results } }),
      send: async () => ({ sent: 1, removed: 0, failed: 0 }),
      hasSubscribers: async () => true,
      statePath: h.path,
      now: () => T0 + DAY + HOUR,
      log: () => {},
    });
    expect(await again.tick()).toBe(0);
    const ended = new ResetExpiryNotifier({
      scanLimits: async () => ({ ok: true, payload: { results: [] } }),
      hasSubscribers: async () => true,
      statePath: h.path,
      now: () => T0 + 9 * DAY,
      log: () => {},
    });
    await ended.tick();
    expect(JSON.parse(readFileSync(h.path, "utf8"))).toEqual({ sent: {} });
  });

  test("no subscribers: no limits scan at all", async () => {
    let scanned = false;
    const n = new ResetExpiryNotifier({
      scanLimits: async () => {
        scanned = true;
        return { ok: true, payload: { results } };
      },
      hasSubscribers: async () => false,
      log: () => {},
    });
    expect(await n.tick()).toBe(0);
    expect(scanned).toBe(false);
  });

  test("a failed scan is reported in status, not thrown", async () => {
    const n = new ResetExpiryNotifier({ scanLimits: async () => ({ ok: false, error: "boom" }), hasSubscribers: async () => true, statePath: statePath(), log: () => {} });
    expect(await n.tick()).toBe(0);
    expect(n.status().lastError).toBe("boom");
  });
});
