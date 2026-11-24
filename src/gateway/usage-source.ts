import { findIdentityByNameOrAlias, loadIdentitiesFile } from "../identities/store.ts";
import type { PoolUsage } from "../identities/pool/adapter.ts";
import { adapterFor as poolAdapterFor } from "../identities/pool/registry.ts";
import { TOOL_CONFIGS } from "../cli/identities/resolve-tool.ts";
import { fetchZaiLimits } from "../cli/limits/zai-limits.ts";
import { fetchOpencodeGoQuotaForKey } from "../cli/limits/opencode-limits.ts";
import { usageFromLimits } from "../identities/pool/grant-file-adapter.ts";
import type { GatewayProvider } from "./types.ts";
import { bounded } from "./refresh-guard.ts";
import type { SharedReading, UsageReadings } from "./usage-readings.ts";

export const USAGE_TTL_MS = 45_000;

/** `fresh`: read the source now, past any short-lived shared cache (claude's one-minute last-good file). */
export type FetchUsage = (provider: GatewayProvider, identity: string, opts?: { fresh?: boolean }) => Promise<PoolUsage | undefined>;

/** The zai reading with only the token windows (session, week). The monthly web tools count is not a token quota and must not make the pool refuse model traffic. */
export function zaiTokenUsage(result: Parameters<typeof usageFromLimits>[0][number]): PoolUsage {
  return usageFromLimits([{ ...result, windows: result.windows.filter((w) => w.category !== "other") }]);
}

/** The agent reserve's utilisation figure, from the same adapters `ais swap` uses (claude, codex, kimi) and, for zai, the same Z.ai quota read `ais limits` uses (zai has no swap pool adapter). Others have none. The poll never refreshes a token (`noRefresh`): rotating a grant is the proxy's job, where it is counted and alerted. */
export const fetchPoolUsage: FetchUsage = async (provider, identity, opts) => {
  if (provider !== "claude" && provider !== "codex" && provider !== "kimi" && provider !== "zai") return undefined;
  const adapter = provider === "zai" ? undefined : poolAdapterFor(provider);
  if (provider !== "zai" && !adapter) return undefined;
  const file = await loadIdentitiesFile(TOOL_CONFIGS[provider].identitiesJsonPath);
  const found = findIdentityByNameOrAlias(file.identities, identity);
  if (provider === "zai") return found ? zaiTokenUsage(await fetchZaiLimits(found)) : undefined;
  return found ? adapter!.fetchUsage(found, { noRefresh: true, ...(opts?.fresh ? { fresh: true } : {}) }) : undefined;
};

/**
 * The OpenCode Go plan reading for one member, from its own key (rolling 5-hour, weekly and monthly dollar windows, each
 * with its reset). A member with no Go plan, or a failed read, gives no figure, so it never blocks and never sets a reset.
 */
export async function fetchOpencodeUsage(apiKey: string): Promise<PoolUsage | undefined> {
  const outcome = await fetchOpencodeGoQuotaForKey(apiKey);
  if (outcome.noPlan) return { status: "unavailable", noPlan: true, capturedAt: new Date().toISOString() };
  if (outcome.error || !outcome.windows) return undefined; // a failed read keeps the last figure (stale)
  return usageFromLimits([{ status: "live", windows: outcome.windows }]);
}

/** The usage fetcher with the OpenCode Go branch: the opencode provider reads its Go plan with the member's own gateway credential, every other provider uses `base`. */
export function withOpencodeUsage(creds: { get(provider: GatewayProvider, identity: string): Promise<{ accessToken: string }> }, base: FetchUsage): FetchUsage {
  return (provider, identity, opts) => (provider === "opencode" ? creds.get(provider, identity).then((c) => fetchOpencodeUsage(c.accessToken)) : base(provider, identity, opts));
}

interface Entry {
  value: PoolUsage | undefined;
  at: number;
}

/**
 * Usage figures cached per provider and identity. A request never waits on the
 * usage API: a cold miss answers "no figure" and fills in the background, a
 * stale entry is served while one refresh (single-flight) runs. "unavailable"
 * counts as no figure; a failed fetch or a reading with no figure keeps the previous value, marked `stale`.
 * A stale figure is for display only: the reserve never refuses on it (an account reset upstream must not stay
 * blocked behind a figure that can no longer be refreshed).
 */
export function createUsageSource(opts: {
  fetchUsage: FetchUsage;
  ttlMs?: number;
  now?: () => number;
  /** Readings shared by the replicas: a young one saves an upstream call, and any one stands in when upstream has no figure. */
  shared?: UsageReadings;
  /** Counts a reading by where it came from. */
  onRead?: (provider: GatewayProvider, source: "upstream" | "shared") => void;
  /** Counts a failed shared store call. */
  onSharedError?: () => void;
  log?: (line: string) => void;
  /** Longest one shared store call may take (default 1500 ms). A slower call counts as an error. */
  sharedTimeoutMs?: number;
  /** How long a replica waits for the claim holder's reading before it polls itself (default 3000 ms). */
  claimWaitMs?: number;
  /** A claim lasts this long (default 15 s). */
  claimHoldMs?: number;
  /** 0 to 1, for the expiry jitter (tests). */
  random?: () => number;
}) {
  const ttl = opts.ttlMs ?? USAGE_TTL_MS;
  const now = opts.now ?? Date.now;
  const entries = new Map<string, Entry>();
  const inflight = new Map<string, Promise<void>>();
  /** Fresh reads in flight: one per member, so a burst of quota answers asks the source once. */
  const freshInflight = new Map<string, Promise<void>>();
  const keyOf = (p: string, i: string): string => `${p}\u0000${i}`;
  const staleOf = (v: PoolUsage | undefined): PoolUsage | undefined => (v ? { ...v, stale: true } : undefined);
  const hasFigure = (v: PoolUsage | undefined): boolean => !!v && (v.noPlan === true || (v.status !== "unavailable" && ((v.windows?.length ?? 0) > 0 || typeof v.maxUtilization === "number")));
  const log = opts.log ?? ((line: string) => console.warn(line));
  let sharedDown = false;
  /** The last upstream read outcome per member ("ok" or the error), so a change is logged once, not every poll. */
  const lastOutcome = new Map<string, string>();
  /** Logs when a member's upstream usage read starts or stops failing: a stale figure is otherwise silent. */
  const noteOutcome = (provider: GatewayProvider, identity: string, u: PoolUsage | undefined, backoff: boolean): void => {
    const failed = backoff || !hasFigure(u);
    const outcome = failed ? (u?.error ?? (u ? u.status : "no reading")) : "ok";
    const key = keyOf(provider, identity);
    const before = lastOutcome.get(key);
    if (before === outcome || (before === undefined && outcome === "ok")) return;
    lastOutcome.set(key, outcome);
    log(JSON.stringify({ event: "usage-read", provider, identity, outcome: failed ? "failed" : "recovered", ...(failed ? { error: outcome } : {}) }));
  };
  const sharedMs = opts.sharedTimeoutMs ?? 1500;
  const claimWaitMs = opts.claimWaitMs ?? 3000;
  const claimHoldMs = opts.claimHoldMs ?? 15_000;
  const random = opts.random ?? Math.random;
  /** Extra local life for an entry taken from the shared row, so the replicas do not all expire at the same moment. */
  const jitter = (): number => Math.floor(random() * (ttl / 3));
  const young = (s: SharedReading | undefined): s is SharedReading => !!s && hasFigure(s.reading) && s.ageMs >= 0 && s.ageMs < ttl;
  const capturedMs = (v: PoolUsage | undefined): number => Date.parse(v?.capturedAt ?? "") || 0;
  /** A shared store call never fails a read: it is bounded, logs once per outage and answers `fallback`. */
  const guarded = async <T>(call: (s: UsageReadings) => Promise<T>, fallback: T): Promise<T> => {
    if (!opts.shared) return fallback;
    try {
      const r = await bounded(call(opts.shared), sharedMs, "shared usage readings");
      if (sharedDown) log("gateway: shared usage readings reachable again");
      sharedDown = false;
      return r;
    } catch (err) {
      opts.onSharedError?.();
      if (!sharedDown) log(`gateway: shared usage readings unavailable (${err instanceof Error ? err.message : String(err)}); reading upstream only`);
      sharedDown = true;
      return fallback;
    }
  };
  const loadShared = (provider: GatewayProvider, identity: string): Promise<SharedReading | undefined> => guarded((s) => s.load(provider, identity), undefined);

  const refresh = (provider: GatewayProvider, identity: string, fresh = false): Promise<void> => {
    const key = keyOf(provider, identity);
    const running = inflight.get(key);
    if (running && !fresh) return running;
    const runningFresh = freshInflight.get(key);
    if (runningFresh) return runningFresh;
    const run = (async () => {
      // A plain read already in flight may answer from before the quota answer: let it land, then read again.
      if (running) await running;
      let shared: SharedReading | undefined;
      let loaded = false;
      let claimed = false;
      const useShared = (s: SharedReading): void => {
        opts.onRead?.(provider, "shared");
        entries.set(key, { value: s.reading, at: now() - s.ageMs + jitter() });
      };
      /** No figure upstream: the newer of the local figure and the shared one, always stale (display only). */
      const noFigure = async (prev: PoolUsage | undefined): Promise<PoolUsage | undefined> => {
        const local = hasFigure(prev) ? prev : undefined;
        if (opts.shared && !loaded) {
          shared = await loadShared(provider, identity);
          loaded = true;
        }
        const other = shared && hasFigure(shared.reading) ? shared.reading : undefined;
        if (local && other) return staleOf(capturedMs(other) > capturedMs(local) ? other : local);
        return staleOf(local ?? other ?? prev);
      };
      try {
        if (opts.shared) {
          shared = await loadShared(provider, identity);
          loaded = true;
          // A young shared reading answers a plain refresh: the fleet polls each identity about once per ttl.
          if (!fresh) {
            if (young(shared)) return useShared(shared);
            // One replica claims the poll. The others wait a little for its reading, then poll themselves.
            const won = await guarded((s) => s.claim(provider, identity, claimHoldMs), true); // a store error: poll
            claimed = won && !sharedDown;
            if (!won) {
              const end = Date.now() + claimWaitMs;
              while (Date.now() < end) {
                await new Promise((r) => setTimeout(r, Math.min(100, claimWaitMs)));
                shared = await loadShared(provider, identity);
                if (young(shared)) return useShared(shared);
              }
            }
          }
        }
        opts.onRead?.(provider, "upstream");
        const u = await opts.fetchUsage(provider, identity, fresh ? { fresh: true } : undefined);
        // A reading with no figure (the usage API answered 429, as Anthropic's does for an account at its limit, or was
        // unavailable) keeps the last figure: answering "no limits" for a full account is wrong (T3 showed "No limits reported").
        const prev = entries.get(key)?.value;
        // For claude, "rate-limited" with a figure is the usage endpoint's 429 backoff repeating the last good read: old
        // figures, so stale (shown, never refused on). Codex says "rate-limited" for a live reading at 100%: that one stands.
        const backoff = provider === "claude" && u?.status === "rate-limited";
        noteOutcome(provider, identity, u, backoff);
        const at = now();
        let value: PoolUsage | undefined;
        if (hasFigure(u)) {
          value = backoff ? staleOf(u) : u;
          if (opts.shared && !backoff) {
            // A last-good read (claude's one-minute file) is older than now: share it with its real age, up to one ttl.
            const age = Math.min(ttl, Math.max(0, at - (Date.parse(u!.capturedAt) || at)));
            await guarded((s) => s.save(provider, identity, u!, age), undefined);
          }
        } else {
          value = await noFigure(prev);
        }
        entries.set(key, { value, at });
      } catch (err) {
        noteOutcome(provider, identity, { status: "unavailable", error: err instanceof Error ? err.message : String(err), capturedAt: "" } as PoolUsage, false);
        // Keep the old figure; retry after the next ttl.
        entries.set(key, { value: await noFigure(entries.get(key)?.value), at: now() });
      } finally {
        // A poll that left no reading must not make the others wait for the hold to run out.
        if (claimed && !hasFigure(entries.get(key)?.value)) await guarded((s) => s.release(provider, identity), undefined);
        if (fresh) freshInflight.delete(key);
        else inflight.delete(key);
      }
    })();
    (fresh ? freshInflight : inflight).set(key, run);
    return run;
  };

  return {
    async get(provider: GatewayProvider, identity: string): Promise<PoolUsage | undefined> {
      const e = entries.get(keyOf(provider, identity));
      if (!e || now() - e.at >= ttl) void refresh(provider, identity);
      return e?.value;
    },
    /** Fills the cache from shared readings at start (warm-up). A reading older than the ttl is shown stale and read again. Never overwrites an entry. */
    seed(rows: Array<{ provider: GatewayProvider; identity: string; reading: PoolUsage; ageMs: number }>): void {
      for (const r of rows) {
        const key = keyOf(r.provider, r.identity);
        if (entries.has(key) || !hasFigure(r.reading)) continue;
        if (r.ageMs >= 0 && r.ageMs < ttl) entries.set(key, { value: r.reading, at: now() - r.ageMs + jitter() });
        else entries.set(key, { value: staleOf(r.reading), at: now() - ttl });
      }
    },
    /** Fetches now and waits; used at warm-up. */
    prefill: (provider: GatewayProvider, identity: string): Promise<void> => refresh(provider, identity),
    /** Reads the source now (past any shared short-lived cache) and waits; single-flight per member. Used after a quota answer. */
    refreshNow: (provider: GatewayProvider, identity: string): Promise<void> => refresh(provider, identity, true),
    /** Waits for fetches in flight (tests). */
    async idle(): Promise<void> {
      while (inflight.size > 0 || freshInflight.size > 0) await Promise.all([...inflight.values(), ...freshInflight.values()]);
    },
  };
}
