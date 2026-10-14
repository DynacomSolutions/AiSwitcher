import type { OpsDeps } from "./claude-swap-ops.ts";
import { claudeAdapter } from "./pool/claude-adapter.ts";
import { poolLaunchCheck, LAUNCH_CHECK_TIMEOUT_MS } from "./pool/launch.ts";
import type { Identity } from "./types.ts";

export { LAUNCH_CHECK_TIMEOUT_MS };

/** Claude binding of the generic pre-launch check (pool/launch.ts). */
export const claudeSwapLaunchCheck = (identity: Identity, deps: OpsDeps & { timeoutMs?: number } = {}): Promise<string | undefined> =>
  poolLaunchCheck(claudeAdapter, identity, deps);
