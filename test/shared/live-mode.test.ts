import { expect, test } from "bun:test";
import { isAisLive, isLiveImageUser } from "../../src/shared/live-mode.ts";
import { herdrTitleForLaunch } from "../../src/shared/run-wrapper.ts";
import { assertConsoleUserAllowed, shouldStartHerdrBridge, startHerdrBridgeIfAllowed } from "../../src/server/serve.ts";

test("live marker controls live mode and only blocks the effective live account console", () => {
  const missingMarker = () => false;
  const presentMarker = () => true;
  expect(isAisLive({}, missingMarker)).toBe(false);
  expect(isAisLive({}, presentMarker)).toBe(true);
  expect(isLiveImageUser({}, () => "live", missingMarker)).toBe(false);
  expect(isLiveImageUser({}, () => "agent", presentMarker)).toBe(false);
  expect(isLiveImageUser({}, () => "live", presentMarker)).toBe(true);
  expect(isLiveImageUser({ AIS_LIVE: "1" }, () => "live", missingMarker)).toBe(true);
  expect(() => assertConsoleUserAllowed({}, () => "live", presentMarker)).toThrow("disabled for the live image user");
  expect(() => assertConsoleUserAllowed({}, () => "agent", presentMarker)).not.toThrow();
});

test("live wrapper startup omits the title sidecar and emits one note without Herdr environment", () => {
  const notes: string[] = [];
  const exitCode = process.exitCode ?? 0;
  const title = herdrTitleForLaunch("claude", false, undefined, true, (line) => notes.push(line));
  expect(title).toBeUndefined();
  expect(notes).toEqual(["ais live: herdr tab titles disabled"]);
  expect(process.exitCode ?? 0).toBe(exitCode);
});

test("live console branch does not construct or start the Herdr bridge scheduler", async () => {
  expect(shouldStartHerdrBridge({ AIS_LIVE: "1" })).toBe(false);
  expect(shouldStartHerdrBridge({ AIS_HERDR_BRIDGE: "0" })).toBe(false);
  expect(shouldStartHerdrBridge({})).toBe(true);
  let calls = 0;
  const notes: string[] = [];
  const exitCode = process.exitCode ?? 0;
  const started = await startHerdrBridgeIfAllowed({ AIS_LIVE: "1" }, async () => {
    calls += 1;
    return { start: () => { calls += 1; } };
  }, (line) => notes.push(line));
  expect(started).toBe(false);
  expect(calls).toBe(0);
  expect(notes).toEqual(["ais live: herdr report-metadata bridge disabled"]);
  expect(process.exitCode ?? 0).toBe(exitCode);
});
