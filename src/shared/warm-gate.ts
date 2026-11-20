/** Readiness gate that waits, for a bounded time, until a set of caches is warm. Used by the gateway and the console. */
export type WarmState = "cold" | "warm" | "timeout" | "draining";

export const WARM_STATES: readonly WarmState[] = ["cold", "warm", "timeout", "draining"];

/** The longest delay a timer accepts. A larger value would fire at once. */
export const MAX_TIMER_MS = 2_147_483_647;

/** The cold entry reported when the warm set itself could not be read before the timeout. */
export const UNREADABLE_WARM_SET = "<warm set unreadable>";

export interface WarmResult {
  /** `draining`: the gate was drained while the run was pending. */
  outcome: "warm" | "timeout" | "draining";
  durationMs: number;
  /** Keys still running when the run ended early (empty when warm). */
  cold: string[];
}

/** The keys to warm: a list, a promise of one, or a function that reads it (retried on failure). */
export type WarmKeys = string[] | Promise<string[]> | (() => Promise<string[]>);

export interface WarmGate {
  /**
   * Runs every warmOne in parallel. A rejection counts as finished. The timeout covers the whole run,
   * including reading the keys. Unreadable keys are retried every `retryMs` until the timeout.
   */
  run(keys: WarmKeys, warmOne: (key: string) => Promise<unknown>): Promise<WarmResult>;
  state(): WarmState;
  /** True for warm and timeout. */
  isReady(): boolean;
  /** Moves to draining from any state, clears the timers and settles a pending run. It is sticky. */
  drain(): void;
  /** The result of the last finished run (undefined until then). */
  result(): WarmResult | undefined;
}

export interface WarmGateOptions {
  timeoutMs: number;
  /** Wait before the keys are read again after a failure (default 1000 ms). */
  retryMs?: number;
  now?(): number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

export function createWarmGate(opts: WarmGateOptions): WarmGate {
  const now = opts.now ?? (() => Date.now());
  const setTimer =
    opts.setTimer ??
    ((fn, ms) => {
      const handle = setTimeout(fn, ms);
      // A pending warm-up must not keep the process alive.
      (handle as { unref?: () => void }).unref?.();
      return handle;
    });
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const timeoutMs = Math.min(Math.max(1, opts.timeoutMs), MAX_TIMER_MS);
  const retryMs = Math.min(Math.max(1, opts.retryMs ?? 1000), MAX_TIMER_MS);
  let current: WarmState = "cold";
  let last: WarmResult | undefined;
  const active = new Set<() => void>();

  const finish = (outcome: WarmResult["outcome"], startedAt: number, cold: string[]): WarmResult => {
    const result: WarmResult = { outcome, durationMs: Math.max(0, now() - startedAt), cold };
    last = result;
    if (current !== "draining" && outcome !== "draining") current = outcome;
    return result;
  };

  return {
    run(keysIn, warmOne) {
      const startedAt = now();
      if (current === "draining") return Promise.resolve(finish("draining", startedAt, []));
      if (Array.isArray(keysIn) && keysIn.length === 0) return Promise.resolve(finish("warm", startedAt, []));
      return new Promise<WarmResult>((resolve) => {
        let done = false;
        let pending = new Set<string>(Array.isArray(keysIn) ? keysIn : [UNREADABLE_WARM_SET]);
        let timer: unknown;
        let retryTimer: unknown;
        const settle = (outcome: WarmResult["outcome"]): void => {
          if (done) return;
          done = true;
          clearTimer(timer);
          if (retryTimer !== undefined) clearTimer(retryTimer);
          active.delete(abort);
          resolve(finish(outcome, startedAt, outcome === "warm" ? [] : [...pending]));
        };
        const abort = (): void => settle("draining");
        active.add(abort);
        timer = setTimer(() => settle("timeout"), timeoutMs);

        const start = (keys: string[]): void => {
          if (done) return;
          pending = new Set(keys);
          if (pending.size === 0) return settle("warm");
          for (const key of keys) {
            const end = (): void => {
              pending.delete(key);
              if (pending.size === 0) settle("warm");
            };
            let p: Promise<unknown>;
            try {
              p = warmOne(key);
            } catch {
              p = Promise.reject(new Error("warm failed"));
            }
            p.then(end, end);
          }
        };
        const read = typeof keysIn === "function" ? keysIn : () => Promise.resolve(keysIn);
        const attempt = (): void => {
          if (done) return;
          let p: Promise<string[]>;
          try {
            p = read();
          } catch (e) {
            p = Promise.reject(e);
          }
          p.then(start, () => {
            if (!done) retryTimer = setTimer(attempt, retryMs);
          });
        };
        attempt();
      });
    },
    state: () => current,
    isReady: () => current === "warm" || current === "timeout",
    drain() {
      current = "draining";
      for (const abort of [...active]) abort();
    },
    result: () => last,
  };
}

/** Reads a positive integer from the environment, else the default. Values above the timer limit are clamped. */
export function positiveIntEnv(name: string, fallback: number, env: Record<string, string | undefined> = process.env): number {
  const raw = env[name]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, MAX_TIMER_MS);
}
