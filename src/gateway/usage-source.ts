import { findIdentityByNameOrAlias, loadIdentitiesFile } from "../identities/store.ts";
import type { PoolUsage } from "../identities/pool/adapter.ts";
import type { ManualResetInfo } from "../cli/limits/types.ts";
import type { ProviderCredential } from "./providers/shared.ts";
import { codexAdapter } from "./providers/codex.ts";
import { adapterFor as poolAdapterFor } from "../identities/pool/registry.ts";
import type { AutoResetUsage } from "./auto-reset.ts";
import { categorizeByMinutes } from "../cli/limits/bucket.ts";
import { CODEX_WHAM_USAGE_URL, codexPlanLabel, extraUsageFromCredits, snapshotFromWham } from "../cli/limits/codex-limits.ts";
import { TOOL_CONFIGS } from "../cli/identities/resolve-tool.ts";
import { fetchZaiLimits } from "../cli/limits/zai-limits.ts";
import { fetchOpencodeGoQuotaForKey } from "../cli/limits/opencode-limits.ts";
import { usageFromLimits } from "../identities/pool/grant-file-adapter.ts";
import type { GatewayProvider } from "./types.ts";
import { bounded } from "./refresh-guard.ts";
import type { SharedReading, UsageReadings } from "./usage-readings.ts";
import { redactText } from "./upstream-error.ts";

export const USAGE_TTL_MS = 45_000;
/** A manual refresh keeps the reading of an upstream read younger than this. */
export const MANUAL_REFRESH_MIN_AGE_MS = 15_000;

export interface CodexResetSource {
  (identity: string): Promise<ManualResetInfo | undefined>;
  /** A spend: drops the cached credits here and on every replica, so no old count shows. */
  invalidate(identity: string): Promise<void>;
  /** A manual refresh: the next read asks OpenAI again, and a failed read keeps the last known credits (marked stale). No shared write. */
  expire(identity: string): void;
  /** The cached credits now, marked stale, with no read. Undefined when none are cached. */
  peek(identity: string): ManualResetInfo | undefined;
}

export const CODEX_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";

/** Reads the provider's inventory with the same account-scoped headers as Codex traffic. */
export async function fetchCodexResetCredits(
  credential: ProviderCredential,
  doFetch: (input: string | URL, init?: RequestInit) => Promise<Response> = fetch,
  signal?: AbortSignal,
  now: () => number = Date.now,
  purpose: "manual" | "automatic" = "manual",
): Promise<ManualResetInfo | undefined> {
  const response = await doFetch(CODEX_CREDITS_URL, {
    headers: { ...codexAdapter.authHeaders(credential, new Headers()), accept: "application/json" },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    redirect: "manual",
  });
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  return codexResetInventory(await response.json().catch(() => undefined), now(), purpose);
}

export function codexResetInventory(raw: unknown, now: number, purpose: "manual" | "automatic" = "manual"): ManualResetInfo | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const body = raw as { available_count?: unknown; credits?: unknown };
  const credits = Array.isArray(body.credits) ? body.credits as Array<{ id?: unknown; title?: unknown; status?: unknown; expires_at?: unknown; reset_type?: unknown }> : undefined;
  const available = credits?.filter((credit) => credit?.status === "available") ?? [];
  const count = body.available_count;
  // The upstream details contract requires available_count. Missing or malformed data is unknown, never zero.
  if (!(typeof count === "number" && Number.isSafeInteger(count) && count >= 0)) return undefined;
  const availableCount = count;
  const otherTypes = purpose === "automatic"
    ? new Set(available.filter((credit) => credit.reset_type !== "codex_rate_limits").map((credit) => credit.id))
    : undefined;
  const creditExpiries = available.flatMap((credit) => {
    if (otherTypes?.has(credit.id)) return [];
    const expiry = typeof credit.expires_at === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(credit.expires_at)
      ? Date.parse(credit.expires_at) : Number.NaN;
    return Number.isFinite(expiry) && typeof credit.id === "string"
      ? [{ id: credit.id, ...(typeof credit.title === "string" ? { label: credit.title } : {}), endsAt: new Date(expiry).toISOString() }]
      : [];
  });
  return {
    availableCount,
    readAt: new Date(now).toISOString(),
    ...(typeof available[0]?.title === "string" ? { label: available[0].title } : {}),
    ...(creditExpiries[0] ? { expiresAt: new Date(creditExpiries[0].endsAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) } : {}),
    ...(creditExpiries.length ? { creditExpiries } : {}),
  };
}

interface WhamProofLimit {
  allowed?: unknown;
  limit_reached?: unknown;
  primary_window?: WhamProofWindow | null;
  secondary_window?: WhamProofWindow | null;
}

interface WhamProofWindow {
  used_percent?: unknown;
  limit_window_seconds?: unknown;
  reset_at?: unknown;
}

function additionalCodexWindows(raw: unknown, now: number): NonNullable<PoolUsage["windows"]> | undefined {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return undefined;
  const windows: NonNullable<PoolUsage["windows"]> = [];
  for (const entry of raw as Array<{ normal_model_slug?: unknown; metered_feature?: unknown; rate_limit?: WhamProofLimit | null } | null>) {
    const model = entry?.normal_model_slug ?? entry?.metered_feature;
    const limit = entry?.rate_limit;
    if (typeof model !== "string" || !/[a-z0-9]/i.test(model) || !limit ||
      typeof limit.allowed !== "boolean" || typeof limit.limit_reached !== "boolean") return undefined;
    const scoped = [limit.primary_window, limit.secondary_window].filter((window) => window != null);
    if (!scoped.length && limit.allowed && !limit.limit_reached) return undefined;
    for (const { used_percent: utilization, limit_window_seconds: seconds, reset_at: reset } of scoped) {
      if (typeof utilization !== "number" || !Number.isFinite(utilization) || utilization < 0 ||
        typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds <= 0 ||
        typeof reset !== "number" || !Number.isSafeInteger(reset) || reset * 1000 <= now || reset * 1000 > 8.64e15) return undefined;
      const label = categorizeByMinutes(seconds / 60);
      windows.push({ label, utilization, resetsAt: new Date(reset * 1000).toISOString(), model });
    }
    if (!limit.allowed || limit.limit_reached) windows.push({ label: "provider limit", utilization: 100, model });
  }
  return windows;
}

/** Reads usage with the gateway credential. Strict reads supply evidence for a spend or replay. */
export async function fetchGatewayCodexUsage(
  credential: ProviderCredential,
  doFetch: typeof fetch,
  now: () => number,
  signal: AbortSignal,
): Promise<AutoResetUsage | undefined> {
  const response = await doFetch(CODEX_WHAM_USAGE_URL, {
    headers: { ...codexAdapter.authHeaders(credential, new Headers()), accept: "application/json" },
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    redirect: "manual",
  });
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    return { status: "unavailable", capturedAt: new Date(now()).toISOString(), error: `usage endpoint answered HTTP ${response.status}` };
  }
  const body = await response.json() as { rate_limit?: WhamProofLimit | null; additional_rate_limits?: unknown } | null;
  signal.throwIfAborted();
  const capturedAt = now();
  const snapshot = snapshotFromWham(body, capturedAt);
  if (!snapshot) return undefined;
  const limit = body?.rate_limit;
  const raw = [limit?.primary_window, limit?.secondary_window];
  const windows = [snapshot.primary, snapshot.secondary].flatMap((window) => {
    if (!window) return [];
    const mins = window.windowDurationMins;
    const category = mins === undefined ? "other" : categorizeByMinutes(mins);
    const label = category !== "other" ? category : mins === undefined ? "usage" : mins >= 1440 ? `~${Math.round(mins / 1440)}d` : `~${Math.round(mins / 60)}h`;
    const reset = new Date((window.resetsAt ?? Number.NaN) * 1000);
    return [{ label, utilization: window.usedPercent, ...(Number.isFinite(reset.getTime()) ? { resetsAt: reset.toISOString() } : {}) }];
  });
  const maxUtilization = Math.max(...windows.map((window) => window.utilization));
  const weekly = raw.filter((window) => window?.limit_window_seconds === 604_800);
  const reset = weekly[0]?.reset_at;
  const weeklyProof = weekly.length === 1 && windows.filter((window) => window.label === "week").length === 1 &&
    typeof reset === "number" && Number.isSafeInteger(reset) && reset * 1000 > capturedAt && reset * 1000 <= 8.64e15 &&
    raw.every((window) => window == null || (typeof window.used_percent === "number" && Number.isFinite(window.used_percent) && window.used_percent >= 0)) &&
    (limit?.allowed === undefined || limit.allowed === (maxUtilization < 100)) &&
    (limit?.limit_reached === undefined || limit.limit_reached === (maxUtilization >= 100));
  const modelWindows = additionalCodexWindows(body?.additional_rate_limits, capturedAt);
  if (!weeklyProof || !modelWindows) return undefined;
  const extraUsage = extraUsageFromCredits(snapshot);
  const planLabel = codexPlanLabel(snapshot.planType);
  return {
    status: maxUtilization >= 100 ? "rate-limited" : "live",
    maxUtilization,
    windows: [...windows, ...modelWindows],
    capturedAt: new Date(capturedAt).toISOString(),
    ...(typeof limit?.allowed === "boolean" ? { codexRateLimitAllowed: limit.allowed } : {}),
    ...(extraUsage ? { extraUsage } : {}),
    ...(planLabel ? { planLabel } : {}),
  };
}

/** Cache Codex reset credits per identity so repeated Console polls do not hit the provider. */
export function createCodexResetSource(opts: {
  fetchCredits(identity: string): Promise<ManualResetInfo | undefined>;
  invalidations?: import("./reset-credit-cache.ts").ResetCreditInvalidations;
  ttlMs?: number;
  now?: () => number;
}): CodexResetSource {
  const ttl = opts.ttlMs ?? USAGE_TTL_MS;
  const now = opts.now ?? Date.now;
  const entries = new Map<string, { value: ManualResetInfo; at: number; version: string }>();
  const inflight = new Map<string, { version: string | undefined; promise: Promise<ManualResetInfo | undefined> }>();
  const source = async (identity: string): Promise<ManualResetInfo | undefined> => {
    let version: string | undefined = opts.invalidations ? undefined : "unshared";
    try { if (opts.invalidations) version = await opts.invalidations.version(identity); } catch { /* The cache cannot be trusted when shared state is unavailable. */ }
    let entry = entries.get(identity);
    if (entry && (version === undefined || entry.version !== version)) {
      entries.delete(identity);
      entry = undefined;
    }
    if (entry && now() - entry.at < ttl) return entry.value;
    let running = inflight.get(identity);
    if (!running || running.version !== version) {
      const promise = (async (): Promise<ManualResetInfo | undefined> => {
        let value = await opts.fetchCredits(identity).catch(() => undefined);
        let currentVersion = version;
        if (opts.invalidations) {
          try {
            currentVersion = await opts.invalidations.version(identity);
            if (version === undefined || currentVersion !== version) {
              // The first generation was unknown or changed during this read. Fetch against the current generation.
              value = await opts.fetchCredits(identity).catch(() => undefined);
              const confirmedVersion = await opts.invalidations.version(identity);
              if (confirmedVersion !== currentVersion) value = undefined;
              currentVersion = confirmedVersion;
            }
          } catch {
            // If generation state is unavailable, use a live read and do not cache it.
            value = await opts.fetchCredits(identity).catch(() => undefined);
            currentVersion = undefined;
          }
        }
        if (!value && entry && entry.version === currentVersion) value = { ...entry.value, stale: true };
        if (value && currentVersion !== undefined) entries.set(identity, { value, at: now(), version: currentVersion });
        return value;
      })().finally(() => {
        if (inflight.get(identity)?.promise === promise) inflight.delete(identity);
      });
      running = { version, promise };
      inflight.set(identity, running);
    }
    return running.promise;
  };
  return Object.assign(source, {
    async invalidate(identity: string): Promise<void> {
      entries.delete(identity);
      await opts.invalidations?.invalidate(identity);
    },
    peek(identity: string): ManualResetInfo | undefined {
      const entry = entries.get(identity);
      return entry ? { ...entry.value, stale: true } : undefined;
    },
    expire(identity: string): void {
      const entry = entries.get(identity);
      if (entry) entries.set(identity, { ...entry, at: Number.NEGATIVE_INFINITY });
    },
  });
}

/** The providers with a usage reader: `fetchPoolUsage` (claude, codex, kimi, zai) and the OpenCode Go read. Others (grok, ali) have no source. */
export const USAGE_READER_PROVIDERS: ReadonlySet<GatewayProvider> = new Set(["claude", "codex", "kimi", "zai", "opencode"]);

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
  publishedAt?: number;
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
  /** The last upstream read state per member (`ok` or `failed`), so a change is logged once, not every poll. */
  const lastState = new Map<string, "ok" | "failed">();
  /** The newest failed read per member, until a read works again. */
  const lastFailure = new Map<string, { error: string; at: string }>();
  /** When the newest upstream read of each member ended (a shared reading is not one). */
  const lastUpstream = new Map<string, number>();
  /** Logs when a member's usage read starts or stops failing: a stale figure is otherwise silent. The error text goes in the log line only. */
  const setState = (provider: GatewayProvider, identity: string, state: "ok" | "failed", error?: string): void => {
    const key = keyOf(provider, identity);
    // The text is redacted before it is stored or logged: a parse error can repeat part of the input (a token header, for example).
    if (error !== undefined) error = redactText(error);
    // The newest failure text stays for the Limits page, which shows why a card is cached. A good read clears it.
    if (state === "failed") lastFailure.set(key, { error: error ?? "no reading", at: new Date(now()).toISOString() });
    else lastFailure.delete(key);
    const before = lastState.get(key);
    if (before === state || (before === undefined && state === "ok")) return;
    lastState.set(key, state);
    log(JSON.stringify({ event: "usage-read", provider, identity, outcome: state === "failed" ? "failed" : "recovered", ...(state === "failed" ? { error } : {}) }));
  };
  /** Notes one upstream read. A provider with no usage reader has no source, so it never counts as a failure. */
  const noteOutcome = (provider: GatewayProvider, identity: string, u: PoolUsage | undefined, backoff: boolean): void => {
    if (!USAGE_READER_PROVIDERS.has(provider)) return;
    const failed = backoff || !hasFigure(u);
    if (failed) setState(provider, identity, "failed", u?.error ?? (u ? u.status : "no reading"));
    else setState(provider, identity, "ok");
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
    const started = performance.now();
    const write = (value: PoolUsage | undefined, at: number) => {
      const publishedAt = entries.get(key)?.publishedAt;
      entries.set(key, { value, at, publishedAt });
    };
    const newerPublication = () => (entries.get(key)?.publishedAt ?? -Infinity) >= started;
    const outdated = (reading: PoolUsage | undefined) => {
      const current = entries.get(key);
      return newerPublication() || (current?.publishedAt !== undefined && capturedMs(reading) < capturedMs(current.value));
    };
    const run = (async () => {
      // A plain read already in flight may answer from before the quota answer: let it land, then read again.
      if (running) await running;
      let shared: SharedReading | undefined;
      let loaded = false;
      let claimed = false;
      const useShared = (s: SharedReading): void => {
        if (outdated(s.reading)) return;
        opts.onRead?.(provider, "shared");
        if (USAGE_READER_PROVIDERS.has(provider)) setState(provider, identity, "ok");
        write(s.reading, now() - s.ageMs + jitter());
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
        if (newerPublication()) return;
        opts.onRead?.(provider, "upstream");
        let u: PoolUsage | undefined;
        try {
          u = await opts.fetchUsage(provider, identity, fresh ? { fresh: true } : undefined);
        } finally {
          if (!newerPublication()) lastUpstream.set(key, now());
        }
        if (outdated(u ?? entries.get(key)?.value)) return;
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
        if (!outdated(value)) write(value, at);
      } catch (err) {
        if (newerPublication()) return;
        noteOutcome(provider, identity, { status: "unavailable", error: err instanceof Error ? err.message : String(err), capturedAt: "" } as PoolUsage, false);
        // Keep the old figure; retry after the next ttl.
        const value = await noFigure(entries.get(key)?.value);
        if (!outdated(value)) write(value, now());
      } finally {
        // A poll that left no reading must not make the others wait for the hold to run out.
        if (claimed && (newerPublication() || !hasFigure(entries.get(key)?.value))) await guarded((s) => s.release(provider, identity), undefined);
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
    /** Publishes a confirmed direct reading locally and to the shared cache. */
    async publish(provider: GatewayProvider, identity: string, reading: PoolUsage): Promise<void> {
      const key = keyOf(provider, identity);
      const current = entries.get(key)?.value;
      if (!hasFigure(reading) || reading.stale || (current && !current.stale && capturedMs(current) > capturedMs(reading))) return;
      const age = now() - capturedMs(reading);
      if (age < 0 || age >= ttl) return;
      entries.set(key, { value: reading, at: now() - age, publishedAt: performance.now() });
      lastUpstream.set(key, now() - age);
      opts.onRead?.(provider, "upstream");
      noteOutcome(provider, identity, reading, false);
      await guarded((s) => s.save(provider, identity, reading, age), undefined);
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
    /** Waits for an older fresh read, then starts a distinct read for a post-action reconciliation. */
    refreshNowAfterInflight: (provider: GatewayProvider, identity: string): Promise<void> => {
      const running = freshInflight.get(keyOf(provider, identity));
      return running ? running.then(() => refresh(provider, identity, true)) : refresh(provider, identity, true);
    },
    /**
     * A manual refresh. Many clicks must not become many upstream reads: a read in flight is joined, and a member whose last
     * upstream read is younger than `minAgeMs` keeps that reading. Answers true when it started a new read.
     */
    async refreshManual(provider: GatewayProvider, identity: string, minAgeMs = MANUAL_REFRESH_MIN_AGE_MS): Promise<boolean> {
      const key = keyOf(provider, identity);
      const runningFresh = freshInflight.get(key);
      if (runningFresh) {
        await runningFresh;
        return false;
      }
      const runningPlain = inflight.get(key);
      if (runningPlain) {
        await runningPlain;
        // A plain read may have answered from a shared reading up to one ttl old: a refresh needs one under `minAgeMs`.
        if (now() - capturedMs(entries.get(key)?.value) < minAgeMs) return false;
      }
      const last = lastUpstream.get(key);
      if (last !== undefined && now() - last < minAgeMs) return false;
      await refresh(provider, identity, true);
      return true;
    },
    /** A new sign-in landed for this member: its old read no longer counts, so the next manual refresh reads again. */
    forgetUpstream(provider: GatewayProvider, identity: string): void {
      lastUpstream.delete(keyOf(provider, identity));
    },
    /** Why the newest upstream read of this member failed, or undefined when the last read worked. The text carries no token. */
    lastFailure(provider: GatewayProvider, identity: string): { error: string; at: string } | undefined {
      return lastFailure.get(keyOf(provider, identity));
    },
    /** Waits for fetches in flight (tests). */
    async idle(): Promise<void> {
      while (inflight.size > 0 || freshInflight.size > 0) await Promise.all([...inflight.values(), ...freshInflight.values()]);
    },
  };
}
