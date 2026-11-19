import { readFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { aisHome } from "../shared/ais-home.ts";
import { writeFileAtomic } from "./pool/fs.ts";

/**
 * Sticky gateway ownership. A login the gateway has ever named in its heartbeat stays the gateway's on every host until an
 * explicit release (`ais gateway release <tool>/<identity>`). The heartbeat alone is not enough: it goes stale when the
 * gateway restarts, a database moves or the push from the database to this host's files fails, and a host that sees a stale
 * heartbeat would then refresh the login. Refresh tokens are single use, so that refresh spends the token the gateway renews.
 *
 * The record holds only "tool/identity" keys and times. It is written by the host store sync from the heartbeat's held list (and by any
 * host process that sees a fresh heartbeat name a login), never shrinks by itself, and is read by isGatewayManagedHere
 * (gateway-managed.ts), the one check every host refresher goes through.
 */

export interface OwnedEntry {
  /** ISO time this host first saw the gateway hold the login. */
  since: string;
  /** ISO time of the newest heartbeat that named it. */
  lastHeldAt: string;
}

export interface OwnedRecord {
  version: 1;
  owned: Record<string, OwnedEntry>;
}

/** AIS_GATEWAY_OWNED overrides the location (tests, odd layouts). */
export const ownedPath = (home?: string): string => process.env.AIS_GATEWAY_OWNED ?? join(aisHome(home), "gateway-owned.json");

const ownedKey = (tool: string, identity: string): string => `${tool}/${identity}`;

function parse(text: string): OwnedRecord | undefined {
  try {
    const raw = JSON.parse(text) as Partial<OwnedRecord>;
    if (raw.version !== 1 || typeof raw.owned !== "object" || raw.owned === null || Array.isArray(raw.owned)) return undefined;
    const owned: Record<string, OwnedEntry> = {};
    for (const [key, value] of Object.entries(raw.owned)) {
      const v = value as Partial<OwnedEntry> | null;
      if (typeof v?.since === "string" && typeof v.lastHeldAt === "string") owned[key] = { since: v.since, lastHeldAt: v.lastHeldAt };
    }
    return { version: 1, owned };
  } catch {
    return undefined;
  }
}

/** The record, or an empty one when missing or malformed. */
export async function readOwned(path: string = ownedPath()): Promise<OwnedRecord> {
  return parse(await readFile(path, "utf8").catch(() => "")) ?? { version: 1, owned: {} };
}

/** Synchronous read for the callers that cannot await (gateway-pool.ts). */
export function readOwnedSync(path: string = ownedPath()): OwnedRecord {
  try {
    return parse(readFileSync(path, "utf8")) ?? { version: 1, owned: {} };
  } catch {
    return { version: 1, owned: {} };
  }
}

/** True when this host's record says the gateway owns the login. */
export const isStickyOwnedSync = (tool: string, identity: string, path?: string): boolean => Object.hasOwn(readOwnedSync(path).owned, ownedKey(tool, identity));

export async function isStickyOwned(tool: string, identity: string, path?: string): Promise<boolean> {
  return Object.hasOwn((await readOwned(path)).owned, ownedKey(tool, identity));
}

/**
 * Adds every login a heartbeat names to the record (never removes one). Returns the keys that were new. A write only
 * happens when something changed or an entry's time moved on.
 */
export async function recordOwned(held: Iterable<string>, heldAt: string, path: string = ownedPath()): Promise<string[]> {
  const keys = [...held].filter((k) => k.includes("/"));
  if (keys.length === 0) return [];
  const record = await readOwned(path);
  const added: string[] = [];
  let changed = false;
  for (const key of keys) {
    const entry = record.owned[key];
    if (!entry) {
      record.owned[key] = { since: heldAt, lastHeldAt: heldAt };
      added.push(key);
      changed = true;
    } else if (entry.lastHeldAt < heldAt) {
      entry.lastHeldAt = heldAt;
      changed = true;
    }
  }
  if (!changed) return added;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFileAtomic(path, `${JSON.stringify(record)}\n`);
  return added;
}

/** Removes one login from the record. False when it was not there. */
export async function releaseOwned(tool: string, identity: string, path: string = ownedPath()): Promise<boolean> {
  const record = await readOwned(path);
  const key = ownedKey(tool, identity);
  if (!Object.hasOwn(record.owned, key)) return false;
  delete record.owned[key];
  await writeFileAtomic(path, `${JSON.stringify(record)}\n`);
  return true;
}
