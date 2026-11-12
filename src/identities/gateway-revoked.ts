import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { withOauthRefreshLock } from "./claude-swap-lock.ts";
import { hasMemberCopy, isMemberStoreTool, localWritten, memberDir, memberLoginFile, memberStoreRoot } from "./gateway-members.ts";
import { refreshFingerprint, refreshOf } from "./gateway-routed.ts";
import { writeFileAtomic } from "./pool/fs.ts";

/**
 * A durable record that the gateway found an account's member-store login dead (the token endpoint answered with a dead-grant
 * code such as invalid_grant, refresh_token_reused or token_revoked). The gateway process writes it next to the store copy;
 * the portal (a different process) reads it for the Identities tab. Nothing in it is secret: the code, the time and the
 * first 16 hex digits of the refresh token's sha256.
 *
 * The record names the refresh token it was written for, so it applies to that login only: a new login (a different refresh
 * token) in the store makes the record stale at once, even before anything deletes it.
 */

export interface RevokedMarker {
  /** ISO time the gateway diagnosed the login dead. */
  at: string;
  /** The OAuth error code, or "revoked" when only an earlier diagnosis is known. */
  code: string;
  /** refreshFingerprint of the store copy's refresh token the diagnosis was for. */
  fingerprint: string;
}

export const REVOKED_MARKER_FILE = "login-revoked.json";

export const revokedMarkerPath = (tool: string, name: string, root: string = memberStoreRoot()): string => join(memberDir(tool, name, root), REVOKED_MARKER_FILE);

function readStoreRefresh(tool: string, name: string, root: string): string | undefined {
  if (!isMemberStoreTool(tool)) return undefined;
  try {
    return refreshOf(tool, readFileSync(join(memberDir(tool, name, root), memberLoginFile(tool)), "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Records that the login with refresh-token fingerprint `rejected` is dead (the fingerprint of the grant the token endpoint
 * rejected: OAuthRefreshError.refreshFingerprint / RefreshResult.beforeFingerprint, the first 8 hex digits of the refresh
 * token's sha256). Written under the member dir's refresh lock and only while the store copy still holds that very login: a
 * newer login that landed after the rejection (a portal sign-in) is never marked. Best effort: false when nothing was written.
 */
export async function recordLoginRevoked(tool: string, name: string, code: string, rejected: string | undefined, root: string = memberStoreRoot(), now: () => Date = () => new Date()): Promise<boolean> {
  if (!isMemberStoreTool(tool) || !rejected || !hasMemberCopy(tool, name, root)) return false;
  try {
    return await withOauthRefreshLock(memberDir(tool, name, root), async () => {
      const refresh = readStoreRefresh(tool, name, root);
      if (refresh === undefined) return false;
      const fingerprint = refreshFingerprint(refresh);
      if (!fingerprint.startsWith(rejected)) return false;
      const marker: RevokedMarker = { at: now().toISOString(), code, fingerprint };
      await writeFileAtomic(revokedMarkerPath(tool, name, root), `${JSON.stringify(marker)}\n`);
      await localWritten(revokedMarkerPath(tool, name, root), "marker", `${tool}/${name}`);
      return true;
    });
  } catch {
    return false;
  }
}

/** The marker when it applies to the store copy's current login; undefined when none, unreadable or stale (a new login landed). */
export function readLoginRevoked(tool: string, name: string, root: string = memberStoreRoot()): RevokedMarker | undefined {
  try {
    const parsed = JSON.parse(readFileSync(revokedMarkerPath(tool, name, root), "utf8")) as Partial<RevokedMarker>;
    if (typeof parsed.at !== "string" || typeof parsed.code !== "string" || typeof parsed.fingerprint !== "string") return undefined;
    const refresh = readStoreRefresh(tool, name, root);
    if (refresh === undefined || refreshFingerprint(refresh) !== parsed.fingerprint) return undefined;
    return { at: parsed.at, code: parsed.code, fingerprint: parsed.fingerprint };
  } catch {
    return undefined;
  }
}

/** Removes the marker (a new login landed in the store). */
export async function clearLoginRevoked(tool: string, name: string, root: string = memberStoreRoot()): Promise<void> {
  await rm(revokedMarkerPath(tool, name, root), { force: true }).catch(() => undefined);
}
