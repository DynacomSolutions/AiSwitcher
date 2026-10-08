import { resolve } from "node:path";
import type { Identity } from "./types.ts";

/** True only when the identity is explicitly retired; absent means active. */
export function isRetired(identity: Pick<Identity, "retired">): boolean {
  return identity.retired === true;
}

/** The identities that are not retired, preserving order. */
export function activeIdentities<T extends Pick<Identity, "retired">>(list: T[]): T[] {
  return list.filter((identity) => !isRetired(identity));
}

/** Mark an identity retired in place. Clears any earlier unretire marker. */
export function retireIdentityFields(identity: Identity, now: Date): void {
  identity.retired = true;
  identity.retiredAt = now.toISOString();
  delete identity.unretiredAt;
}

/** Restore an identity in place. Records when, so sync can order events. */
export function unretireIdentityFields(identity: Identity, now: Date): void {
  delete identity.retired;
  delete identity.retiredAt;
  identity.unretiredAt = now.toISOString();
}

/** Epoch milliseconds of the newest retire/unretire event, if any. */
export function lastRetirementEventMs(
  identity: Pick<Identity, "retiredAt" | "unretiredAt">,
): number | undefined {
  const times = [identity.retiredAt, identity.unretiredAt]
    .filter((value): value is string => typeof value === "string")
    .map((value) => Date.parse(value))
    .filter((ms) => !Number.isNaN(ms));
  return times.length ? Math.max(...times) : undefined;
}

function normaliseDir(dir: string): string {
  const resolved = resolve(dir);
  return resolved.length > 1 ? resolved.replace(/\/+$/, "") : resolved;
}

/** Find a retired identity whose configDir matches, comparing normalised paths. */
export function findRetiredByConfigDir(identities: Identity[], configDir: string): Identity | undefined {
  const target = normaliseDir(configDir);
  return identities.find((identity) => isRetired(identity) && normaliseDir(identity.configDir) === target);
}
