/**
 * Reset times for the limits page: Bangkok time (ICT) first, UK time (BST or GMT by date) alongside, with dates.
 * Same output as `formatLimitTimes` in `src/shared/limit-times.ts` (the web package cannot import from `src`).
 */

const ZONES = ["Asia/Bangkok", "Europe/London"];

function inZone(ms: number, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" }).formatToParts(new Date(ms));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const label = zone === "Asia/Bangkok" ? "ICT" : get("timeZoneName");
  return `${get("hour")}:${get("minute")} ${label} ${get("weekday")} ${get("day")} ${get("month")}`;
}

/** "01:35 ICT Fri 20 Nov, 18:35 GMT Thu 19 Nov". */
export function formatResetTimes(ms: number): string {
  const rounded = Math.ceil(ms / 60_000) * 60_000;
  return ZONES.map((z) => inZone(rounded, z)).join(", ");
}
