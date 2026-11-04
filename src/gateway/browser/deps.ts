import type { GatewayMetrics } from "../metrics.ts";
import type { GatewayStore } from "../store.ts";

export interface BrowserDeps {
  store: GatewayStore;
  now(): Date;
  metrics?: GatewayMetrics;
  /** Member accounts of a swap pool; undefined when no such pool exists. */
  browserPoolMembers?(pool: string): Promise<string[] | undefined>;
  /** Whether an identity exists. When absent, identity targets are not checked. */
  browserIdentityExists?(identity: string): Promise<boolean>;
}

/** A DNS-1123 label, as for app names. */
export const BINDING_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
