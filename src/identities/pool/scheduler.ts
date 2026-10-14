import { isRetired } from "../retired.ts";
import { loadIdentitiesFile } from "../store.ts";
import type { PoolAdapter } from "./adapter.ts";
import { swapIfLimited, type LimitedOutcome, type PoolOpsDeps } from "./ops.ts";
import { withPoolLock } from "./lock.ts";
import { allAdapters } from "./registry.ts";
import { poolsOf, requirePool, type PoolIdentity } from "./swap-pool.ts";
import type { Identity } from "../types.ts";

/**
 * Daemon loop: for every swap pool with `auto` on, in the registry of every
 * adapter, poll the active member's utilisation every ~60-120s (jittered)
 * and swap to the allowed member with the most headroom when the threshold
 * is reached. Hysteresis: swapIfLimited honours a ledger-based cooldown,
 * and a pool with no qualifying member backs off exponentially (up to 10
 * min) instead of hammering the usage endpoint.
 */

export const MIN_POLL_MS = 60_000;
export const MAX_POLL_MS = 120_000;
export const MAX_BACKOFF_MS = 10 * 60_000;

export function jitteredDelayMs(random: () => number = Math.random): number {
  return Math.round(MIN_POLL_MS + random() * (MAX_POLL_MS - MIN_POLL_MS));
}

export interface PoolSwapStatusDto {
  ok: true;
  enabled: boolean;
  /** Tools whose adapter this scheduler serves. */
  tools: string[];
  pools: Array<{ tool: string; pool: string; auto: boolean; lastCheckAt: string | null; lastOutcome: string | null; backoffMs: number }>;
}

export interface PoolSwapSchedulerDeps {
  /** Per-tool ops deps (registry path, ledger path, usage fetch, test hooks).
   * Never shared across tools: each adapter reads its own registry and ledger. */
  perTool?: Partial<Record<PoolAdapter["tool"], PoolOpsDeps<any>>>;
  /** Adapters to serve; defaults to every registered adapter. */
  adapters?: () => PoolAdapter<any>[];
  check?: (adapter: PoolAdapter<any>, pool: string) => Promise<LimitedOutcome>;
  log?: (message: string) => void;
  random?: () => number;
}

interface PoolState {
  lastCheckAt: number;
  nextAt: number;
  backoffMs: number;
  lastOutcome: string | null;
}

export class PoolSwapScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private readonly state = new Map<string, PoolState>();
  constructor(protected readonly deps: PoolSwapSchedulerDeps = {}) {}

  private adapters(): PoolAdapter<any>[] {
    return (this.deps.adapters ?? allAdapters)();
  }

  private log(tool: string, message: string): void {
    (this.deps.log ?? ((m: string) => console.error(m)))(`${tool}-swap: ${message}`);
  }

  private async poolsOfAdapter(adapter: PoolAdapter<any>) {
    return poolsOf(await this.fileOf(adapter));
  }

  private fileOf(adapter: PoolAdapter<any>) {
    return loadIdentitiesFile(this.deps.perTool?.[adapter.tool]?.registryPath ?? adapter.config.identitiesJsonPath);
  }

  /** Heal pass for `liveSwap: false` adapters: a running session can rewrite
   * the pool credentials after a swap, so repair them every tick, under the pool lock. */
  private async healPool(adapter: PoolAdapter<any>, pool: PoolIdentity): Promise<void> {
    if (adapter.liveSwap || !adapter.heal) return;
    try {
      const lock = { timeoutMs: 1_500 };
      const notes = await withPoolLock(pool.configDir, async () => {
        // Reload under the lock: a swap that landed while we waited must not be undone.
        const file = await this.fileOf(adapter);
        const fresh = requirePool(file, pool.name, adapter.tool);
        const members = fresh.swapPool.accounts
          .map((name) => file.identities.find((i) => i.name === name))
          .filter((i): i is Identity => i !== undefined && !isRetired(i));
        return adapter.heal!(fresh, members, lock);
      }, lock);
      for (const note of notes) this.log(adapter.tool, note);
    } catch (err) {
      this.log(adapter.tool, `pool ${pool.name}: heal failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** One pass over the pools whose next poll is due. Exported for tests. */
  async tick(nowMs: number = Date.now()): Promise<void> {
    for (const adapter of this.adapters()) {
      let pools;
      try {
        pools = await this.poolsOfAdapter(adapter);
      } catch {
        continue;
      }
      for (const pool of pools) {
        if (this.stopped) return;
        await this.healPool(adapter, pool);
        if (pool.swapPool.auto !== true) continue;
        const key = `${adapter.tool}:${pool.name}`;
        const st = this.state.get(key) ?? { lastCheckAt: 0, nextAt: 0, backoffMs: 0, lastOutcome: null };
        if (nowMs < st.nextAt) continue;
        let outcome: LimitedOutcome;
        try {
          outcome = await (this.deps.check ?? ((a, name) => swapIfLimited(a, { ...this.deps.perTool?.[a.tool], now: () => nowMs }, name, "auto")))(adapter, pool.name);
        } catch (err) {
          outcome = { action: "skipped", why: err instanceof Error ? err.message : String(err) };
        }
        st.lastCheckAt = nowMs;
        st.lastOutcome = outcome.action === "skipped" ? `skipped: ${outcome.why}` : outcome.action;
        const base = jitteredDelayMs(this.deps.random);
        if (outcome.action === "no-candidate") {
          st.backoffMs = Math.min(MAX_BACKOFF_MS, Math.max(base, st.backoffMs * 2));
          this.log(adapter.tool, `pool ${pool.name}: active account is limited and no allowed account has headroom; backing off ${Math.round(st.backoffMs / 1000)}s`);
        } else {
          st.backoffMs = 0;
          if (outcome.action === "swapped") {
            const { from: previous, to: target } = outcome.result;
            this.log(adapter.tool, `pool ${pool.name}: ${previous} -> ${target} (auto)`);
          }
        }
        st.nextAt = nowMs + Math.max(base, st.backoffMs, outcome.action === "cooldown" ? outcome.retryAfterMs : 0);
        this.state.set(key, st);
      }
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

  async status(): Promise<PoolSwapStatusDto> {
    const out: PoolSwapStatusDto["pools"] = [];
    for (const adapter of this.adapters()) {
      try {
        for (const p of await this.poolsOfAdapter(adapter)) {
          const st = this.state.get(`${adapter.tool}:${p.name}`);
          out.push({ tool: adapter.tool, pool: p.name, auto: p.swapPool.auto === true, lastCheckAt: st?.lastCheckAt ? new Date(st.lastCheckAt).toISOString() : null, lastOutcome: st?.lastOutcome ?? null, backoffMs: st?.backoffMs ?? 0 });
        }
      } catch {
        // no registry yet
      }
    }
    return { ok: true, enabled: true, tools: this.adapters().map((a) => a.tool), pools: out };
  }
}
