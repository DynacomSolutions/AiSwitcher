import type { Identity, ToolConfig } from "../types.ts";
import type { LockOptions } from "../claude-swap-lock.ts";
import type { PoolIdentity } from "./swap-pool.ts";

/**
 * Provider-neutral swap pool contract. The core (ledger, chooseBest,
 * swapIfLimited, launcher hook, daemon loop) knows nothing about any
 * provider's credential layout; an adapter supplies the two provider-bound
 * halves: how to move credentials between a member and the pool folder, and
 * how to read a member's utilisation.
 */

export type SwapReason = "manual" | "auto" | "launch";

export interface SwapEvent {
  ts: string;
  pool: string;
  from: string | null;
  to: string;
  reason: SwapReason;
}

export type WriteBackOutcome =
  | "written"
  | "none-no-live-credentials"
  | "none-identical"
  | "none-member-newer"
  | "none-unknown-owner"
  | "none-account-mismatch";

export interface SwapResult {
  pool: string;
  from: string | null;
  to: string;
  reason: SwapReason;
  /** True when the target was already active and credentials were in place. */
  noop: boolean;
  writeBack: WriteBackOutcome;
  notes: string[];
  /** Running sessions that cannot follow the swap (set by `notifySwapped`
   * for `liveSwap: false` adapters). */
  runningSessions?: number;
}

/** Minimum a usage reading must carry for the core to decide on it. */
export interface PoolUsage {
  status: "live" | "rate-limited" | "unavailable";
  /** Highest utilisation percent over the provider's windows, when known. */
  maxUtilization?: number;
  /** Optional per-window detail for display; the core never reads it. */
  windows?: Array<{ label: string; utilization: number; resetsAt?: string }>;
  error?: string;
  retryAfterSeconds?: number;
  capturedAt: string;
}

export interface SwapCredentialsInput {
  pool: PoolIdentity;
  /** Live (non-retired) members of the pool. */
  members: Identity[];
  target: Identity;
  reason: SwapReason;
  lock?: LockOptions;
}

export interface PoolAdapter<U extends PoolUsage = PoolUsage> {
  tool: ToolConfig["toolName"];
  config: ToolConfig;
  /** True when a running session picks up swapped credentials on its next
   * turn (no restart needed). */
  liveSwap: boolean;
  /** Why an identity cannot be a pool member (e.g. not an OAuth login), or undefined. */
  memberProblem?(member: Identity): string | undefined;
  /** True when the pool folder already holds a credential store. */
  hasCredentials(configDir: string): boolean;
  /** Write back the pool's live grant to its owner, then atomically make the
   * pool folder carry the target's credentials. Does not touch the registry
   * or the ledger. */
  swapCredentials(input: SwapCredentialsInput): Promise<Omit<SwapResult, "reason">>;
  /** Utilisation of one member. `deps` is the caller's opaque dependency bag
   * (test hooks, fetch implementations). Never throws for provider errors. */
  fetchUsage(member: Identity, deps?: unknown): Promise<U>;
  /** Called by the core after the ledger append of a real swap. Best effort:
   * errors are swallowed. A `liveSwap: false` adapter uses it to tell running
   * sessions to relaunch; the returned count is surfaced on the result. */
  notifySwapped?(pool: PoolIdentity, from: string | null, to: string): Promise<{ sessions?: number } | void>;
  /** Repairs the pool folder if something outside the core damaged it (e.g. a
   * running session rewriting its own account). Called by the scheduler each
   * tick, under the pool lock, before the swap check. Optional. */
  heal?(pool: PoolIdentity, members: Identity[], lock?: LockOptions): Promise<string[]>;
}
