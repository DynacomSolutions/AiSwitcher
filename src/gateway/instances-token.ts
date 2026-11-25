import { createHmac } from "node:crypto";
import { tokenFromBytes } from "./tokens.ts";

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

/**
 * The app token that the scope hands to a T3 instance. It is derived from the admin token, the app and a generation, so the
 * same call gives the same token and the store holds one record per generation, not one per call. The gateway stores only the hash.
 */
export function instanceAppToken(adminToken: string, app: string, generation: number): { token: string; prefix: string; hash: string } {
  const part = (label: string): Buffer => createHmac("sha256", adminToken).update(`${APP_CONTEXT}\n${app}\n${generation}\n${label}`).digest();
  return tokenFromBytes(part("prefix"), part("secret"));
}
