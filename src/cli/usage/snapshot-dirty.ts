import { createHash, randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { aisCacheDir } from "../../shared/ais-home.ts";
import { requestKnownUsageBreakdownsRefresh } from "./breakdown-snapshot.ts";

const dirtyDir = join(aisCacheDir(), "usage", "dirty");
const EXT = ".json";

export function usageSnapshotTargetKey(tool: string, identity: string): string {
  return `target:${tool}:${identity}`;
}

export function usageSnapshotDirtyId(partitionKey: string): string {
  return createHash("sha256").update(`ais-usage-dirty-v1\0${partitionKey}`).digest("hex");
}

export interface UsageSnapshotDirtyMarker {
  id: string;
  token: string;
}

/** Writes one coalescing marker per source partition. No identity names or
 * paths leave the process; repeated writes replace the same tiny file. */
export function markUsageSnapshotDirty(partitionKey: string, path = dirtyDir): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const id = usageSnapshotDirtyId(partitionKey);
  const file = join(path, `${id}${EXT}`);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ token: randomUUID() }), { mode: 0o600 });
    renameSync(temporary, file);
    // Keep already-requested breakdown windows warm from the same source
    // change signal. This only writes coalesced request markers; the bounded
    // collector remains the sole owner of source scans.
    if (path === dirtyDir) {
      try { requestKnownUsageBreakdownsRefresh(); } catch { /* usage dirty state remains authoritative */ }
    }
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* no temporary file remains */ }
    throw error;
  }
}

/** Coalesce repeated stale-read requests without invalidating an in-flight
 * scan's acknowledgement token. Source change hooks use mark... instead so
 * a change during a scan always leaves a newer token behind. */
export function ensureUsageSnapshotDirty(partitionKey: string, path = dirtyDir): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const id = usageSnapshotDirtyId(partitionKey);
  const file = join(path, `${id}${EXT}`);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ token: randomUUID() }), { mode: 0o600 });
    try { linkSync(temporary, file); } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
    }
  } finally {
    try { unlinkSync(temporary); } catch { /* no temporary file remains */ }
  }
}

export function readUsageSnapshotDirtyMarkers(path = dirtyDir): UsageSnapshotDirtyMarker[] {
  let names: string[];
  try { names = readdirSync(path).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)); }
  catch { return []; }
  return names.map((name) => {
    try {
      const value = JSON.parse(readFileSync(join(path, name), "utf8")) as { token?: unknown };
      if (typeof value.token !== "string") return undefined;
      return { id: name.slice(0, -EXT.length), token: value.token };
    } catch { return undefined; }
  }).filter((marker): marker is UsageSnapshotDirtyMarker => marker !== undefined);
}

export function acknowledgeUsageSnapshotDirty(markers: UsageSnapshotDirtyMarker[], path = dirtyDir): void {
  for (const marker of markers) {
    const file = join(path, `${marker.id}${EXT}`);
    const claim = `${file}.${process.pid}.${randomUUID()}.claim`;
    try {
      // Claim by rename, then compare the claimed version. A concurrent
      // writer can now recreate `file`; deleting the claim cannot erase it.
      renameSync(file, claim);
      const current = JSON.parse(readFileSync(claim, "utf8")) as { token?: unknown };
      if (current.token === marker.token) {
        unlinkSync(claim);
      } else {
        // The claim was already newer than the scan. Restore only when no
        // still-newer marker has appeared since the rename.
        try {
          linkSync(claim, file);
          unlinkSync(claim);
        } catch { unlinkSync(claim); }
      }
    } catch { /* a newer event or a removed marker needs no acknowledgement */ }
  }
}

export const usageSnapshotDirtyDirectory = dirtyDir;
