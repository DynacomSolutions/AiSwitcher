import { swapIfLimited, type LimitedOutcome, type OpsDeps } from "../identities/claude-swap-ops.ts";
import { loadIdentitiesFile } from "../identities/store.ts";
import { poolsOf } from "../identities/swap-pool.ts";
import { CLAUDE_CONFIG } from "../identities/tool-configs.ts";

/**
 * Daemon job: for every claude swap pool with `auto` on, poll the active
 * member's utilisation every ~60-120s (jittered) and swap to the allowed
 * member with the most headroom when the threshold is reached. Hysteresis:
 * swapIfLimited honours a ledger-based cooldown, and a pool with no
 * qualifying member backs off exponentially (up to 10 min) instead of
 * hammering the usage endpoint. AIS_CLAUDE_SWAP=0 opts out (serve.ts).
 */

export const MIN_POLL_MS = 60_000;
export const MAX_POLL_MS = 120_000;
export const MAX_BACKOFF_MS = 10 * 60_000;

export function jitteredDelayMs(random: () => number = Math.random): number {
  return Math.round(MIN_POLL_MS + random() * (MAX_POLL_MS - MIN_POLL_MS));
}

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

interface PoolState {
  lastCheckAt: number;
  nextAt: number;
  backoffMs: number;
  lastOutcome: string | null;
}

export class ClaudeSwapScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private readonly state = new Map<string, PoolState>();
  constructor(private readonly deps: ClaudeSwapSchedulerDeps = {}) {}

  private log(message: string): void {
    (this.deps.log ?? ((m: string) => console.error(m)))(`claude-swap: ${message}`);
  }

  /** One pass over the pools whose next poll is due. Exported for tests. */
  async tick(nowMs: number = Date.now()): Promise<void> {
    let pools;
    try {
      pools = poolsOf(await loadIdentitiesFile(this.deps.registryPath ?? CLAUDE_CONFIG.identitiesJsonPath));
    } catch {
      return;
    }
    for (const pool of pools) {
      if (this.stopped) return;
      if (pool.swapPool.auto !== true) continue;
      const st = this.state.get(pool.name) ?? { lastCheckAt: 0, nextAt: 0, backoffMs: 0, lastOutcome: null };
      if (nowMs < st.nextAt) continue;
      let outcome: LimitedOutcome;
      try {
        outcome = await (this.deps.check ?? ((name) => swapIfLimited({ ...this.deps, now: () => nowMs }, name, "auto")))(pool.name);
      } catch (err) {
        outcome = { action: "skipped", why: err instanceof Error ? err.message : String(err) };
      }
      st.lastCheckAt = nowMs;
      st.lastOutcome = outcome.action === "skipped" ? `skipped: ${outcome.why}` : outcome.action;
      const base = jitteredDelayMs(this.deps.random);
      if (outcome.action === "no-candidate") {
        st.backoffMs = Math.min(MAX_BACKOFF_MS, Math.max(base, st.backoffMs * 2));
        this.log(`pool ${pool.name}: active account is limited and no allowed account has headroom; backing off ${Math.round(st.backoffMs / 1000)}s`);
      } else {
        st.backoffMs = 0;
        if (outcome.action === "swapped") {
          const { from: previous, to: target } = outcome.result;
          this.log(`pool ${pool.name}: ${previous} -> ${target} (auto)`);
        }
      }
      st.nextAt = nowMs + Math.max(base, st.backoffMs, outcome.action === "cooldown" ? outcome.retryAfterMs : 0);
      this.state.set(pool.name, st);
    }
  }

  start(): void {
    if (this.timer) return;
    const loop = () => {
      this.timer = setTimeout(async () => {
        await this.tick().catch(() => undefined);
        if (!this.stopped) loop();
      }, MIN_POLL_MS / 2);
      this.timer.unref?.();
    };
    // First pass soon after boot; afterwards a 30s heartbeat only dispatches
    // pools whose own jittered nextAt is due.
    const boot = setTimeout(() => void this.tick().catch(() => undefined), 20_000);
    boot.unref?.();
    loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  async status(): Promise<ClaudeSwapStatusDto> {
    let pools: ReturnType<typeof poolsOf> = [];
    try {
      pools = poolsOf(await loadIdentitiesFile(this.deps.registryPath ?? CLAUDE_CONFIG.identitiesJsonPath));
    } catch {
      // no registry yet
    }
    return {
      ok: true,
      enabled: true,
      pools: pools.map((p) => {
        const st = this.state.get(p.name);
        return { pool: p.name, auto: p.swapPool.auto === true, lastCheckAt: st?.lastCheckAt ? new Date(st.lastCheckAt).toISOString() : null, lastOutcome: st?.lastOutcome ?? null, backoffMs: st?.backoffMs ?? 0 };
      }),
    };
  }
}
