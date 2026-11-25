import { createHmac } from "node:crypto";
import { INSTANCE_PREFIX_MARK, tokenFromBytes } from "./tokens.ts";

/** What the t3-instances scope token is derived from. A new version string makes every old one invalid. */
const SCOPE_CONTEXT = "ais-t3-instances-v1";
const APP_CONTEXT = "ais-t3-instances-app-v1";

/**
 * The t3-instances bearer token: HMAC-SHA256 of the admin token, as hex.
 * The gateway accepts it on GET /apps (a reduced view) and POST /apps/:name/instance-token only.
 * It cannot change an app, mint a token of its own choice, read the credential store or touch favourites.
 * It changes when the admin token changes.
 */
export function instancesToken(adminToken: string): string {
  return createHmac("sha256", adminToken).update(SCOPE_CONTEXT).digest("hex");
}

/** A scope-minted app token lives one window (7 days) plus an overlap, so a sync that runs every few minutes always holds a fresh one. */
export const INSTANCE_TOKEN_WINDOW_MS = 7 * 24 * 3600 * 1000;
export const INSTANCE_TOKEN_OVERLAP_MS = 24 * 3600 * 1000;

export const instanceTokenWindow = (nowMs: number): number => Math.floor(nowMs / INSTANCE_TOKEN_WINDOW_MS);
/** When the token of a window stops working (ISO). A record with any other expiry was ended by a rotation of the app. */
export const instanceTokenExpiry = (window: number): string => new Date((window + 1) * INSTANCE_TOKEN_WINDOW_MS + INSTANCE_TOKEN_OVERLAP_MS).toISOString();

/**
 * The app token that the scope hands to a T3 instance. It is derived from the admin token, the app, a generation (app rotations)
 * and a time window, so the same call in the same window gives the same token and the store holds one record per window, not one
 * per call. The gateway stores only the hash. The generation is the number of the app's own tokens: an app rotation adds one, so the
 * next mint gives a new token, and the rotation ends the older minted tokens at its overlap. After a leak, rotate the app (or the admin token).
 */
export function instanceAppToken(adminToken: string, app: string, generation: number, window: number): { token: string; prefix: string; hash: string } {
  const part = (label: string): Buffer => createHmac("sha256", adminToken).update(`${APP_CONTEXT}\n${app}\n${generation}\n${window}\n${label}`).digest();
  return tokenFromBytes(part("prefix"), part("secret"), INSTANCE_PREFIX_MARK);
}
