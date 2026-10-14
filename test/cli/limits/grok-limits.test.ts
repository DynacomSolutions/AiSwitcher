import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchGrokLimits, windowsFromBillingConfig } from "../../../src/cli/limits/grok-limits.ts";
import type { Identity } from "../../../src/identities/types.ts";

const CONFIG = {
  creditUsagePercent: 3,
  currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-10-12T11:54:18Z", end: "2026-10-19T11:54:18Z" },
};

function withIdentity(logLines: string[] | undefined, run: (identity: Identity) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "ais-grok-"));
  if (logLines) {
    mkdirSync(join(dir, "logs"));
    writeFileSync(join(dir, "logs", "unified.jsonl"), logLines.join("\n"));
  }
  return run({ name: "g", label: "g", configDir: dir }).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const failing = async () => {
  throw new Error("boom");
};

describe("windowsFromBillingConfig", () => {
  test("maps weekly usage to a week window with a reset time", () => {
    const [w] = windowsFromBillingConfig(CONFIG)!;
    expect(w).toMatchObject({ label: "week", category: "week", usedPercent: 3, resetsAtMs: Date.parse(CONFIG.currentPeriod.end) });
  });

  test("no percentage yields undefined", () => {
    expect(windowsFromBillingConfig({})).toBeUndefined();
  });
});

describe("fetchGrokLimits", () => {
  test("live success is status live", async () => {
    await withIdentity(undefined, async (identity) => {
      const r = await fetchGrokLimits(identity, false, async () => CONFIG);
      expect(r.status).toBe("live");
      expect(r.windows[0]!.usedPercent).toBe(3);
    });
  });

  test("live failure falls back to the log scrape", async () => {
    const line = JSON.stringify({ ts: "2026-10-01T00:00:00Z", msg: "billing: fetched credits config", ctx: { config: CONFIG } });
    await withIdentity([line], async (identity) => {
      const r = await fetchGrokLimits(identity, false, failing);
      expect(r.status).toBe("cached");
      expect(r.capturedAt).toBe("2026-10-01T00:00:00Z");
    });
  });

  test("live failure and empty log report the live error", async () => {
    await withIdentity(undefined, async (identity) => {
      const r = await fetchGrokLimits(identity, false, failing);
      expect(r.status).toBe("unavailable");
      expect(r.error).toBe("boom");
    });
  });

  test("cached mode never calls live", async () => {
    await withIdentity(undefined, async (identity) => {
      const r = await fetchGrokLimits(identity, true, async () => {
        throw new Error("should not run");
      });
      expect(r.status).toBe("unavailable");
      expect(r.error).not.toBe("should not run");
    });
  });
});
