import { claudeAdapter } from "./pool/claude-adapter.ts";
import * as core from "./pool/ops.ts";
import type { SwapReason, SwapResult } from "./pool/adapter.ts";
import type { FetchUsageDeps, MemberUsage } from "./claude-usage-api.ts";
import type { PoolIdentity } from "./pool/swap-pool.ts";

/** Claude binding of the generic pool ops (pool/ops.ts). */

export { SWAP_COOLDOWN_MS, chooseBest, type LimitedOutcome } from "./pool/ops.ts";

export type MemberRow = core.MemberRow<MemberUsage>;

export interface OpsDeps extends FetchUsageDeps, core.PoolOpsDeps<MemberUsage> {}

export const poolStatus = (deps: OpsDeps, poolKey: string | undefined, options: { usage?: boolean } = {}): Promise<{ pool: PoolIdentity; thresholdPercent: number; rows: MemberRow[] }> =>
  core.poolStatus(claudeAdapter, deps, poolKey, options);

export const swapToNext = (deps: OpsDeps, poolKey: string | undefined, reason: SwapReason, options: { requireBelowThreshold?: boolean } = {}): Promise<SwapResult | undefined> =>
  core.swapToNext(claudeAdapter, deps, poolKey, reason, options);

export const swapIfLimited = (deps: OpsDeps, poolKey: string | undefined, reason: SwapReason, options: { assumeLimited?: boolean; cooldownMs?: number } = {}): Promise<core.LimitedOutcome> =>
  core.swapIfLimited(claudeAdapter, deps, poolKey, reason, options);
