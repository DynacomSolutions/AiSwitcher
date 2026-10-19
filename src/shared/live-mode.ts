import { existsSync } from "node:fs";
import { userInfo } from "node:os";

/** The image installs this root-owned marker so an agent cannot opt out of
 * live-image protections by changing its environment. */
export const AIS_LIVE_MARKER = "/etc/ais-live";

export function isAisLive(env: NodeJS.ProcessEnv = process.env, markerExists: (path: string) => boolean = existsSync): boolean {
  return env.AIS_LIVE === "1" || markerExists(AIS_LIVE_MARKER);
}

/** The interactive live account cannot start the local console. Agent users
 * may start it, but the live marker still makes its API token-only. */
export function isLiveImageUser(
  env: NodeJS.ProcessEnv = process.env,
  username: () => string = () => userInfo().username,
  markerExists: (path: string) => boolean = existsSync,
): boolean {
  if (!isAisLive(env, markerExists)) return false;
  try { return username() === "live"; } catch { return false; }
}

export function noteLiveFeatureDisabled(feature: string, write: (line: string) => void = console.error): void {
  write(`ais live: ${feature} disabled`);
}
