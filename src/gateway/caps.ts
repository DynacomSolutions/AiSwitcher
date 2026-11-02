import type { GatewayApp } from "./types.ts";

const ICT_OFFSET_MS = 7 * 3_600_000;
const DAY_MS = 86_400_000;

/** 00:00 in Asia/Bangkok (UTC+7, no DST) at or before `now`. */
export function dayStartIct(now: Date): Date {
  const shifted = now.getTime() + ICT_OFFSET_MS;
  return new Date(Math.floor(shifted / DAY_MS) * DAY_MS - ICT_OFFSET_MS);
}

export function checkCaps(
  app: GatewayApp,
  model: string | undefined,
  usedToday: number,
): { ok: true } | { status: 403 | 429; reason: string } {
  if (app.models && app.models.length > 0 && (model === undefined || !app.models.includes(model))) {
    return { status: 403, reason: "model not allowed for this app" };
  }
  if (app.dailyTokens !== undefined && usedToday >= app.dailyTokens) {
    return { status: 429, reason: "daily token cap reached" };
  }
  return { ok: true };
}
