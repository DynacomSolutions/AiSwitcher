/**
 * Human reset times for limit answers. Owner rule: show Bangkok time (ICT, UTC+07:00) first and the UK time
 * (Europe/London, BST or GMT by date) alongside, with dates. A person never sees a bare UTC ISO time.
 */

export const DEFAULT_LIMIT_TIME_ZONES = ["Asia/Bangkok", "Europe/London"];

/** Zones whose short name Intl does not give as a word (Intl says "GMT+7" for Bangkok). */
const FIXED_LABELS: Record<string, string> = { "Asia/Bangkok": "ICT" };

function validZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Zones from `AIS_GATEWAY_LIMIT_TIME_ZONES` (comma-separated IANA names); invalid names are dropped; empty gives the default. */
export function limitTimeZonesFromEnv(env: Record<string, string | undefined> = process.env): string[] {
  const zones = (env.AIS_GATEWAY_LIMIT_TIME_ZONES ?? "").split(",").map((z) => z.trim()).filter((z) => z !== "" && validZone(z));
  return zones.length > 0 ? zones : DEFAULT_LIMIT_TIME_ZONES;
}

/** "01:35 ICT Fri 20 Nov": 24-hour clock, zone label from the real offset on that date, weekday and date. */
export function formatInZone(ms: number, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" }).formatToParts(new Date(ms));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const label = FIXED_LABELS[zone] ?? get("timeZoneName");
  return `${get("hour")}:${get("minute")} ${label} ${get("weekday")} ${get("day")} ${get("month")}`;
}

/** "01:35 ICT Fri 20 Nov, 18:35 GMT Thu 19 Nov" for the instant, one entry per zone. Seconds round up so the time is never before the reset. */
export function formatLimitTimes(ms: number, zones: string[] = limitTimeZonesFromEnv()): string {
  const rounded = Math.ceil(ms / 60_000) * 60_000;
  return zones.map((z) => formatInZone(rounded, z)).join(", ");
}
