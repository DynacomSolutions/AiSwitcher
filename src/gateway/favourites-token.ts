import { createHmac } from "node:crypto";

/** What the favourites token is derived from. A new version string makes every old token invalid. */
const FAVOURITES_TOKEN_CONTEXT = "ais-favourites-v1";

/**
 * The favourites-only bearer token: HMAC-SHA256 of the admin token, as hex.
 * The gateway accepts it on GET and POST /favourites only. It cannot mint app tokens or touch the credential store.
 * It changes when the admin token changes.
 */
export function favouritesToken(adminToken: string): string {
  return createHmac("sha256", adminToken).update(FAVOURITES_TOKEN_CONTEXT).digest("hex");
}
