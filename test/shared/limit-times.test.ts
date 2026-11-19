import { describe, expect, test } from "bun:test";
import { formatLimitTimes, limitTimeZonesFromEnv } from "../../src/shared/limit-times.ts";
import { formatResetTimes } from "../../apps/web/src/lib/reset-time.ts";
import { limitMessage } from "../../src/gateway/native-limit.ts";

const cases: Array<[string, string]> = [
  // Winter: London is on GMT. The reset crosses midnight in Bangkok.
  ["2026-11-19T18:35:52.000Z", "01:36 ICT Fri 20 Nov, 18:36 GMT Thu 19 Nov"],
  // Summer: London is on BST.
  ["2026-07-15T18:30:00.000Z", "01:30 ICT Thu 16 Jul, 19:30 BST Wed 15 Jul"],
  // Last Sunday of October 2026 (25 Oct): the clocks go back at 01:00 UTC.
  ["2026-10-25T00:30:00.000Z", "07:30 ICT Sun 25 Oct, 01:30 BST Sun 25 Oct"],
  ["2026-10-25T01:30:00.000Z", "08:30 ICT Sun 25 Oct, 01:30 GMT Sun 25 Oct"],
  // Last Sunday of March 2026 (29 Mar): the clocks go forward at 01:00 UTC.
  ["2026-03-29T00:30:00.000Z", "07:30 ICT Sun 29 Mar, 00:30 GMT Sun 29 Mar"],
  ["2026-03-29T01:30:00.000Z", "08:30 ICT Sun 29 Mar, 02:30 BST Sun 29 Mar"],
];

describe("limit times", () => {
  for (const [iso, expected] of cases) {
    test(`${iso} -> ${expected}`, () => {
      expect(formatLimitTimes(Date.parse(iso))).toBe(expected);
      expect(formatResetTimes(Date.parse(iso))).toBe(expected);
    });
  }

  test("zones come from AIS_GATEWAY_LIMIT_TIME_ZONES, bad names are dropped, empty gives the default", () => {
    expect(limitTimeZonesFromEnv({})).toEqual(["Asia/Bangkok", "Europe/London"]);
    expect(limitTimeZonesFromEnv({ AIS_GATEWAY_LIMIT_TIME_ZONES: "Europe/London, Nope/Zone" })).toEqual(["Europe/London"]);
    expect(limitTimeZonesFromEnv({ AIS_GATEWAY_LIMIT_TIME_ZONES: "Nope/Zone" })).toEqual(["Asia/Bangkok", "Europe/London"]);
    expect(formatLimitTimes(Date.parse("2026-07-15T18:30:00.000Z"), ["Europe/London"])).toBe("19:30 BST Wed 15 Jul");
  });

  test("the limit message keeps the T3 contract with local times in the bracket", () => {
    const sec = Date.parse("2026-11-19T18:35:52.000Z") / 1000;
    const msg = limitMessage("5-hour", sec, "OpenCode Go usage limit reached (5-hour, resets in 1h 55m)");
    expect(msg).toBe("You've hit your 5-hour limit (OpenCode Go usage limit reached (5-hour, resets in 1h 55m); resets 01:36 ICT Fri 20 Nov, 18:36 GMT Thu 19 Nov). Resets at 2026-11-19T18:35:52.000Z.");
    expect(msg).toMatch(/^You've hit your .* limit/);
    expect(msg).toMatch(/\bResets at (\d{4}-\d\d-\d\dT[\d:.]+Z)\.?\s*$/);
  });
});
