import type { GatewayMetrics } from "../metrics.ts";
import type { GatewayStore } from "../store.ts";

export interface BrowserDeps {
  store: GatewayStore;
  now(): Date;
  metrics?: GatewayMetrics;
  /** Member accounts of a swap pool; undefined when no such pool exists. */
  browserPoolMembers?(pool: string): Promise<string[] | undefined>;
  /** The canonical name of an identity (alias resolved), or undefined when it does not exist. When absent, names are used as given. */
  browserIdentityExists?(identity: string): Promise<string | undefined>;
  /** Closes the live extension socket of a revoked binding. */
  hub?: { revoke(binding: string): void; extensionVersion?(binding: string): string | undefined };
}

/** A DNS-1123 label, as for app names. */
export const BINDING_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
