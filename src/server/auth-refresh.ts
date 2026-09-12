import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { TOOL_CONFIGS } from "../cli/identities/resolve-tool.ts";
import { loadIdentitiesFile } from "../identities/store.ts";
import { refreshAliAuthSession } from "../identities/auth-session.ts";
import {
  DEFAULT_EXPIRY_WINDOW_HOURS,
  OAuthRefreshError,
  refreshIdentityOAuthGrant,
  type RefreshableTool,
} from "../identities/oauth-refresh.ts";
import type { Identity } from "../identities/types.ts";
import { consoleWebDir } from "./state.ts";

async function listIdentitiesFromRegistry(tool: string): Promise<Identity[]> {
  const cfg = TOOL_CONFIGS[tool as keyof typeof TOOL_CONFIGS];
  if (!cfg) return [];
  const file = await loadIdentitiesFile(cfg.identitiesJsonPath);
  return file.identities;
}

/** Daemon-side credential renewal. Two kinds of refresher live here:
 * - ali: the Alibaba console-cookie harvest (browser session — the same
 *   code the host systemd timers run, hardened 2026-09-10).
 * - the OAuth refreshers (codex/claude/grok/kimi): proactive access-token
 *   renewal at each provider's token endpoint, written through to every
 *   store of the account per the one-credential law
 *   (src/identities/oauth-refresh.ts). These run on a cadence — inside the
 *   expiry window (default 24h) or at least once a day — and short-circuit
 *   without another endpoint call once a grant has been diagnosed revoked
 *   (re-login is the only fix; retrying would just loop).
 *
 * The scheduler runs the same work the per-identity timers do, so it may
 * run alongside them harmlessly: both write their outputs atomically.
 *
 * Failures are LOUD: every failed attempt is logged to stderr (visible in
 * the daemon's journal) and consecutive failures past ESCALATION_THRESHOLD
 * are marked escalated in the status DTO the WebUI and `ais doctor`
 * surface. Skips (nothing to do within cadence) are recorded with their
 * reason but are never failures. */

/** What a refresher tells the scheduler about one attempt. A plain string
 * is a completed refresh (the summary); `undefined` is a failure; the
 * outcome object reports a deliberate skip (nothing to do) with its
 * reason, or a completed refresh with extra detail. */
export interface RefreshOutcome {
  skipped: boolean;
  detail: string;
}

export type Refresher = (
  identity: Identity,
  context: RefresherContext,
) => Promise<string | RefreshOutcome | undefined>;

export interface RefresherContext {
  /** Manual run (CLI `ais auth refresh` / POST /api/auth/refresh): ignore
   * the cadence window and refresh regardless of remaining validity. */
  force: boolean;
  /** This target's last successful refresh (null when never). */
  lastSuccessAt: string | null;
  /** When set, the grant whose fingerprint matches was already diagnosed
   * revoked — refreshers must skip instead of hammering the endpoint. */
  revokedFingerprint?: string;
  /** Proactive window: refresh when the access token expires within this
   * many hours (AIS_AUTH_REFRESH_EXPIRY_HOURS, default 24). */
  expiryWindowHours: number;
}

function oauthRefresherFor(tool: RefreshableTool): Refresher {
  return async (identity, context) => {
    const result = await refreshIdentityOAuthGrant(tool, identity, {
      force: context.force,
      expiryWindowHours: context.expiryWindowHours,
      lastSuccessAt: context.lastSuccessAt,
      revokedFingerprint: context.revokedFingerprint,
    });
    if (result.outcome === "failed") return undefined;
    if (result.outcome === "refreshed") return result.detail;
    return { skipped: true, detail: result.detail };
  };
}

const REFRESHERS: Record<string, Refresher> = {
  ali: (identity) => refreshAliAuthSession(identity),
  codex: oauthRefresherFor("codex"),
  claude: oauthRefresherFor("claude"),
  grok: oauthRefresherFor("grok"),
  kimi: oauthRefresherFor("kimi"),
};

export const DEFAULT_REFRESH_INTERVAL_MS = 10 * 60_000;

export function parseRefreshExpiryWindowHours(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_EXPIRY_WINDOW_HOURS;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_EXPIRY_WINDOW_HOURS;
  return value;
}

/** After this many consecutive failures a target is flagged escalated in the
 * status DTO (and the failure summary the CLI surfaces), so "the harvester
 * has been broken for a while" is visible instead of silent. */
export const ESCALATION_THRESHOLD = 3;

export interface RefreshStatusDto {
  tool: string;
  identity: string;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  /** Why the last attempt deliberately did nothing (cadence skip, revoked
   * grant awaiting re-login, API-key identity). Never a failure. */
  lastDetail: string | null;
  /** True while the pinned diagnosis for this target is "refresh token
   * revoked - re-login required"; cleared by a successful refresh or a
   * re-login (which mints a different refresh token). */
  revoked: boolean;
  consecutiveFailures: number;
  running: boolean;
}

interface RefreshEntry {
  tool: string;
  identity: string;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastDetail: string | null;
  /** Fingerprint of the refresh token a revoked diagnosis was pinned to
   * (null when there is no such diagnosis). A re-login mints a different
   * token, so the fingerprint no longer matches and refreshes resume. */
  revokedFingerprint: string | null;
  consecutiveFailures: number;
}

/** The actionable residue of one refresh target's state: present only while
 * the LAST attempt failed (a success clears both fields). Never carries
 * secret material: the state file stores timestamps and error text only. */
export interface RefreshFailureSummary {
  lastAttemptAt: string;
  lastError: string;
  consecutiveFailures: number;
}

function statePath(home: string = homedir()): string {
  return join(consoleWebDir(home), "auth-refresh-state.json");
}

/** Reads the persisted refresh state for one target straight from disk, for
 * CLI consumers (`ais limits --tool=ali`, `ais doctor`) that run outside the
 * daemon process. Undefined when there is no record, the file is unreadable,
 * or the last attempt SUCCEEDED: a failure summary exists only to explain
 * an active problem. */
export async function lastRefreshFailure(
  tool: string,
  identity: string,
  home: string = homedir(),
): Promise<RefreshFailureSummary | undefined> {
  const entry = await persistedRefreshEntry(tool, identity, home);
  if (!entry?.lastError || !entry.lastAttemptAt) return undefined;
  // Defensive: a well-formed state file never carries a stale error past a
  // newer success, but hydrating an old or hand-edited file must not invent
  // a failure either.
  if (entry.lastSuccessAt && entry.lastSuccessAt > entry.lastAttemptAt) return undefined;
  return {
    lastAttemptAt: entry.lastAttemptAt,
    lastError: entry.lastError,
    consecutiveFailures: entry.consecutiveFailures ?? 0,
  };
}

/** The full persisted refresh-state entry for one target, including the
 * pinned revoked diagnosis (fingerprint only, never a token). Unlike
 * lastRefreshFailure this survives a success — the doctor needs the revoked
 * flag even while the last error has been cleared by a re-login. */
export async function lastRefreshState(
  tool: string,
  identity: string,
  home: string = homedir(),
): Promise<{ revokedFingerprint: string | null; lastError: string | null; lastSuccessAt: string | null } | undefined> {
  const entry = await persistedRefreshEntry(tool, identity, home);
  if (!entry) return undefined;
  return {
    revokedFingerprint: entry.revokedFingerprint ?? null,
    lastError: entry.lastError ?? null,
    lastSuccessAt: entry.lastSuccessAt ?? null,
  };
}

async function persistedRefreshEntry(
  tool: string,
  identity: string,
  home: string,
): Promise<(Partial<RefreshEntry> & { tool?: string; identity?: string }) | undefined> {
  let parsed: { entries?: (Partial<RefreshEntry> & { tool?: string; identity?: string })[] };
  try {
    parsed = await Bun.file(statePath(home)).json();
  } catch {
    return undefined;
  }
  return (parsed.entries ?? []).find((candidate) => candidate.tool === tool && candidate.identity === identity);
}

export class AuthRefreshScheduler {
  private readonly entries = new Map<string, RefreshEntry>();
  private readonly inFlight = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  constructor(
    private readonly intervalMs: number,
    private readonly refreshers: Record<string, Refresher> = REFRESHERS,
    /** Injectable so tests never depend on a real on-disk registry. */
    private readonly listIdentities: (tool: string) => Promise<Identity[]> = listIdentitiesFromRegistry,
    /** Injectable so tests never read/write the real ~/.ais/web state file.
     * os.homedir() is cached from the spawn environment, so an env-var HOME
     * change at runtime does NOT isolate these writes: tests must pass an
     * explicit temp dir here (observed live: tests silently wrote the real
     * daemon's state file before this parameter existed). */
    private readonly stateHome: string = homedir(),
    /** Proactive-refresh window for the OAuth refreshers (hours before
     * access-token expiry at which a refresh runs). */
    private readonly expiryWindowHours: number = parseRefreshExpiryWindowHours(process.env.AIS_AUTH_REFRESH_EXPIRY_HOURS),
  ) {
    if (this.intervalMs > 0 && this.intervalMs < 60_000) this.intervalMs = 60_000;
  }

  get enabled(): boolean {
    return this.intervalMs > 0;
  }

  /** Best-effort restore of previous run state so a daemon restart does not
   * blank the dashboard. Missing or unparsable state is simply no state.
   * Entries written before consecutive-failure tracking default to 0. */
  hydrate(): void {
    void (async () => {
      try {
        const parsed = (await Bun.file(statePath(this.stateHome)).json()) as { entries?: Partial<RefreshEntry>[] };
        for (const entry of parsed.entries ?? []) {
          if (!entry.tool || !entry.identity) continue;
          this.entries.set(`${entry.tool}/${entry.identity}`, {
            tool: entry.tool,
            identity: entry.identity,
            lastAttemptAt: entry.lastAttemptAt ?? null,
            lastSuccessAt: entry.lastSuccessAt ?? null,
            lastError: entry.lastError ?? null,
            lastDetail: entry.lastDetail ?? null,
            revokedFingerprint: entry.revokedFingerprint ?? null,
            consecutiveFailures: entry.consecutiveFailures ?? 0,
          });
        }
      } catch {
        // No prior state; first tick will populate.
      }
    })();
  }

  private async persist(): Promise<void> {
    try {
      await mkdir(consoleWebDir(), { recursive: true });
      await Bun.write(statePath(this.stateHome), `${JSON.stringify({ entries: [...this.entries.values()] }, null, 2)}\n`);
    } catch {
      // Status persistence is best-effort; live status still works.
    }
  }

  /** Enumerates every identity that has a refresher registered. */
  async targets(): Promise<{ tool: string; identity: Identity; refresher: Refresher }[]> {
    const targets: { tool: string; identity: Identity; refresher: Refresher }[] = [];
    for (const [tool, refresher] of Object.entries(this.refreshers)) {
      try {
        for (const identity of await this.listIdentities(tool)) targets.push({ tool, identity, refresher });
      } catch {
        // Registry unreadable (fresh machine): nothing to refresh yet.
      }
    }
    return targets;
  }

  private async runOne(tool: string, identity: Identity, refresher: Refresher, context: RefresherContext): Promise<boolean> {
    const key = `${tool}/${identity.name}`;
    const existing = this.entries.get(key);
    const entry: RefreshEntry = existing ?? {
      tool,
      identity: identity.name,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastError: null,
      lastDetail: null,
      revokedFingerprint: null,
      consecutiveFailures: 0,
    };
    this.entries.set(key, entry);
    entry.lastAttemptAt = new Date().toISOString();
    this.inFlight.add(key);
    let failed = false;
    try {
      const outcome = await refresher(identity, { ...context, lastSuccessAt: entry.lastSuccessAt, revokedFingerprint: entry.revokedFingerprint ?? undefined });
      if (outcome === undefined) {
        failed = true;
        entry.consecutiveFailures += 1;
        entry.lastError = "refresh returned nothing (session not authenticated or browser unavailable)";
        entry.lastDetail = null;
      } else if (typeof outcome === "string") {
        entry.lastSuccessAt = entry.lastAttemptAt;
        entry.lastError = null;
        entry.lastDetail = outcome;
        entry.revokedFingerprint = null;
        entry.consecutiveFailures = 0;
      } else if (outcome.skipped) {
        // A deliberate skip is not a failure and must not refresh the
        // last-success stamp (the daily keep-alive floor depends on it).
        entry.lastError = null;
        entry.lastDetail = outcome.detail;
      } else {
        entry.lastSuccessAt = entry.lastAttemptAt;
        entry.lastError = null;
        entry.lastDetail = outcome.detail;
        entry.revokedFingerprint = null;
        entry.consecutiveFailures = 0;
      }
      return !failed && typeof outcome !== "undefined";
    } catch (err) {
      failed = true;
      entry.consecutiveFailures += 1;
      entry.lastError = err instanceof Error ? err.message : String(err);
      entry.lastDetail = null;
      // Pin a revoked diagnosis to the exact grant it was made against, so
      // the refresher can skip (never loop) while that token is still in
      // the store, and resume automatically once a re-login rotates it.
      if (err instanceof OAuthRefreshError && err.revoked && err.refreshFingerprint) {
        entry.revokedFingerprint = err.refreshFingerprint;
      }
      return false;
    } finally {
      this.inFlight.delete(key);
      await this.persist();
      if (failed) this.reportFailure(entry);
    }
  }

  /** Failure is LOUD: one stderr line per failed attempt (the daemon's
   * journal keeps the history), with the consecutive count and, past the
   * escalation threshold, an explicit flag. Remediation lives in the error
   * message itself (AliAuthRefreshError.hint is folded in by the refresher).
   * Never throws: logging must not break the scheduler loop. */
  private reportFailure(entry: RefreshEntry): void {
    try {
      const escalated = entry.consecutiveFailures >= ESCALATION_THRESHOLD;
      console.error(
        `[ais auth-refresh] ${entry.tool}/${entry.identity} refresh failed ` +
          `(${entry.consecutiveFailures} consecutive${escalated ? ", ESCALATED - action needed" : ""}): ${entry.lastError}`,
      );
    } catch {
      // console.error cannot realistically throw; guard anyway.
    }
  }

  async refreshNow(tool: string, identityName: string): Promise<boolean> {
    const refresher = this.refreshers[tool];
    if (!refresher) throw new Error(`no refresh flow for tool "${tool}"`);
    const identities = await this.listIdentities(tool);
    const identity = identities.find((candidate) => candidate.name === identityName);
    if (!identity) throw new Error(`no ${tool} identity named "${identityName}"`);
    // Manual runs force the underlying flow past its cadence skip.
    return this.runOne(tool, identity, refresher, {
      force: true,
      lastSuccessAt: null,
      expiryWindowHours: this.expiryWindowHours,
    });
  }

  async tick(): Promise<void> {
    if (this.stopped) return;
    const targets = await this.targets();
    for (const { tool, identity, refresher } of targets) {
      if (this.stopped) return;
      await this.runOne(tool, identity, refresher, {
        force: false,
        lastSuccessAt: null,
        expiryWindowHours: this.expiryWindowHours,
      });
    }
  }

  start(): void {
    if (!this.enabled || this.timer) return;
    // First pass shortly after boot so a fresh daemon converges without
    // waiting a full interval; cookies only need renewing every ~10m.
    const boot = setTimeout(() => {
      void this.tick();
    }, 15_000);
    boot.unref?.();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  status(): RefreshStatusDto[] {
    return [...this.entries.values()]
      .map((entry) => ({
        tool: entry.tool,
        identity: entry.identity,
        lastAttemptAt: entry.lastAttemptAt,
        lastSuccessAt: entry.lastSuccessAt,
        lastError: entry.lastError,
        lastDetail: entry.lastDetail,
        revoked: entry.revokedFingerprint !== null,
        consecutiveFailures: entry.consecutiveFailures,
        running: this.inFlight.has(`${entry.tool}/${entry.identity}`),
      }))
      .sort((a, b) => a.tool.localeCompare(b.tool) || a.identity.localeCompare(b.identity));
  }
}

export function parseRefreshIntervalMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_REFRESH_INTERVAL_MS;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_REFRESH_INTERVAL_MS;
  return value; // 0 disables auto-refresh
}
