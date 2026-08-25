import { describe, expect, test } from "bun:test";
import { shouldTriggerProfileSync } from "../../src/sync/watch.ts";

describe("shouldTriggerProfileSync", () => {
  test("session and profile files trigger debounced reconciliation", () => {
    expect(shouldTriggerProfileSync("sessions/2026/07/22/rollout.jsonl")).toBe(true);
    expect(shouldTriggerProfileSync("settings.json")).toBe(true);
  });

  test("high-churn databases and transient process files wait for final reconciliation", () => {
    expect(shouldTriggerProfileSync("state_5.sqlite-wal")).toBe(false);
    expect(shouldTriggerProfileSync("crush.db")).toBe(false);
    expect(shouldTriggerProfileSync("daemon.lock")).toBe(false);
    expect(shouldTriggerProfileSync("plugins/cache/native-addon.node")).toBe(false);
    expect(shouldTriggerProfileSync("chrome-profile/Default/Cookies")).toBe(false);
  });
});
