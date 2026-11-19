import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { memberDir, memberStoreRoot } from "../identities/gateway-members.ts";
import { writeFileDurable } from "../identities/pool/fs.ts";
import { REPLACED_MARKER_FILE, refreshFingerprints } from "./home-mirror.ts";

/**
 * A record that the owner replaced an account's member-store login with a login of another account (a sign-in they made).
 * It lists non-secret fingerprints of the refresh tokens the replaced login held. A sync or import that still carries
 * one of those tokens must never put the old login back, however fresh its grant looks.
 */

export { REPLACED_MARKER_FILE };

export interface ReplacedMarker {
  at: string;
  /** grantFingerprint of each refresh token of the replaced login. */
  fingerprints: string[];
}

export const replacedMarkerPath = (tool: string, name: string, root: string = memberStoreRoot()): string => join(memberDir(tool, name, root), REPLACED_MARKER_FILE);

/** Writes the marker next to the store copy, merging fingerprints already recorded. Nothing in it is secret. */
export async function recordLoginReplaced(tool: string, name: string, oldLoginText: string, root: string, now: () => number = Date.now): Promise<void> {
  const path = replacedMarkerPath(tool, name, root);
  const earlier = (await Bun.file(path).json().catch(() => undefined)) as Partial<ReplacedMarker> | undefined;
  const fingerprints = [...new Set([...(Array.isArray(earlier?.fingerprints) ? earlier.fingerprints.filter((f): f is string => typeof f === "string") : []), ...refreshFingerprints(oldLoginText)])];
  await mkdir(memberDir(tool, name, root), { recursive: true, mode: 0o700 });
  await chmod(memberDir(tool, name, root), 0o700).catch(() => undefined);
  const marker: ReplacedMarker = { at: new Date(now()).toISOString(), fingerprints };
  await writeFileDurable(path, `${JSON.stringify(marker)}\n`);
}

