import { GROK_CONFIG, OPENCODE_CONFIG, ZAI_CONFIG } from "../tool-configs.ts";
import type { ToolConfig } from "../types.ts";
import { isAllowed, SwapPoolError } from "./swap-pool.ts";
import type { PoolAdapter, PoolUsage } from "./adapter.ts";

/**
 * Record-only pool adapters for tools with no per-identity credential swap: grok, opencode and zai.
 *
 * These tools keep a static key or login per identity and have no OAuth refresh, so there is no credential file to move
 * into a pool folder. A pool of such a tool is a registry record only: its members, `active` marker and `disallowed`
 * list. The gateway reads that record to choose which logins a pool app may use (`appPoolMemberNames`); without a record
 * it uses every login that is not retired. `active` is the recorded member and the first one the gateway tries. A swap
 * only changes the record and the ledger.
 *
 * They are deliberately NOT in the generic adapter registry (registry.ts): the launch picker, the `--pool` flag and the
 * auto-swap scheduler treat a registered tool as one that has a real pool folder, and these have none.
 */

const recordAdapter = (tool: ToolConfig["toolName"], config: ToolConfig): PoolAdapter => ({
  tool,
  config,
  liveSwap: true,
  hasCredentials: () => true,
  swapCredentials: async ({ pool, target }) => {
    // The record's active member must stay a usable one: never a member the pool disallows (force included).
    if (!isAllowed(pool, target.name)) throw new SwapPoolError(`Account "${target.name}" is not allowed in pool "${pool.name}"; allow it first.`);
    const from = pool.swapPool.active ?? null;
    return {
      pool: pool.name,
      from,
      to: target.name,
      noop: from === target.name,
      writeBack: "none-no-live-credentials",
      notes: ["records the active member only; the gateway holds each member's login and picks per request"],
    };
  },
  fetchUsage: async (): Promise<PoolUsage> => ({ status: "unavailable", error: "no usage source for a record-only pool", capturedAt: new Date().toISOString() }),
});

const adapters = new Map<string, PoolAdapter>([
  ["grok", recordAdapter("grok", GROK_CONFIG)],
  ["opencode", recordAdapter("opencode", OPENCODE_CONFIG)],
  ["zai", recordAdapter("zai", ZAI_CONFIG)],
]);

export const recordAdapterFor = (tool: string): PoolAdapter | undefined => adapters.get(tool);

/** Tools whose pool is a record only; their pool may hold one member (the gateway then routes every request to it). */
export const isRecordOnlyTool = (tool: string): boolean => adapters.has(tool);
