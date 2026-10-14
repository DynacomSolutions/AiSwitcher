import type { LimitedOutcome, OpsDeps } from "../identities/claude-swap-ops.ts";
import { claudeAdapter } from "../identities/pool/claude-adapter.ts";
import { PoolSwapScheduler, type PoolSwapStatusDto } from "../identities/pool/scheduler.ts";

/** Claude-only binding of the generic daemon loop (identities/pool/scheduler.ts).
 * The daemon itself (serve.ts) runs the generic scheduler over every adapter;
 * AIS_CLAUDE_SWAP=0 drops claude from it. */

export { MIN_POLL_MS, MAX_POLL_MS, MAX_BACKOFF_MS, jitteredDelayMs } from "../identities/pool/scheduler.ts";

export interface ClaudeSwapStatusDto {
  ok: true;
  enabled: boolean;
  pools: Array<{ pool: string; auto: boolean; lastCheckAt: string | null; lastOutcome: string | null; backoffMs: number }>;
}

export interface ClaudeSwapSchedulerDeps extends OpsDeps {
  check?: (pool: string) => Promise<LimitedOutcome>;
  log?: (message: string) => void;
  random?: () => number;
}

/** The claude-only view of a status DTO (tool field dropped, other tools hidden). */
export function claudeStatusOf(dto: ClaudeSwapStatusDto | PoolSwapStatusDto): ClaudeSwapStatusDto {
  const pools = (dto.pools as Array<{ tool?: string; pool: string; auto: boolean; lastCheckAt: string | null; lastOutcome: string | null; backoffMs: number }>)
    .filter((p) => p.tool === undefined || p.tool === "claude")
    .map(({ tool: _tool, ...p }) => p);
  return { ...dto, pools };
}

/** What `/api/claude-swap` reports as `scheduler`: null when the claude
 * adapter is not served by the daemon (AIS_CLAUDE_SWAP=0). */
export function claudeSchedulerView(dto: ClaudeSwapStatusDto | PoolSwapStatusDto): ClaudeSwapStatusDto | null {
  return "tools" in dto && !dto.tools.includes("claude") ? null : claudeStatusOf(dto);
}

export class ClaudeSwapScheduler {
  private readonly inner: PoolSwapScheduler;
  constructor(deps: ClaudeSwapSchedulerDeps = {}) {
    const { check, log, random, ...rest } = deps;
    this.inner = new PoolSwapScheduler({ ...(log ? { log } : {}), ...(random ? { random } : {}), perTool: { claude: rest }, adapters: () => [claudeAdapter], ...(check ? { check: (_a, pool) => check(pool) } : {}) });
  }
  tick(nowMs?: number): Promise<void> { return this.inner.tick(nowMs); }
  start(): void { this.inner.start(); }
  stop(): void { this.inner.stop(); }
  async status(): Promise<ClaudeSwapStatusDto> { return claudeStatusOf(await this.inner.status()); }
}
