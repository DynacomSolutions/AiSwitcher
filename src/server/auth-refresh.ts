import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { TOOL_CONFIGS } from "../cli/identities/resolve-tool.ts";
import { loadIdentitiesFile } from "../identities/store.ts";
import { refreshAliAuthSession } from "../identities/auth-session.ts";
import type { Identity } from "../identities/types.ts";
import { consoleWebDir } from "./state.ts";

/** Daemon-side credential renewal. Today only Alibaba console cookies have a
 * real headless refresh flow (browser session harvest — the same code the
 * host systemd timers run); the registry below is where any future
 * refreshable credential plugs in. The scheduler runs the same work the
 * per-identity timers do, so it may run alongside them harmlessly: both
 * write the cookie file atomically. */

type Refresher = (identity: Identity) => Promise<string | undefined>;

const REFRESHERS: Record<string, Refresher> = {
  ali: (identity) => refreshAliAuthSession(identity),
};

export const DEFAULT_REFRESH_INTERVAL_MS = 10 * 60_000;

export interface RefreshStatusDto {
  tool: string;
  identity: string;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  running: boolean;
}

interface RefreshEntry {
  tool: string;
  identity: string;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
}

function statePath(home: string = homedir()): string {
  return join(consoleWebDir(home), "auth-refresh-state.json");
}

export class AuthRefreshScheduler {
  private readonly entries = new Map<string, RefreshEntry>();
  private readonly inFlight = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  constructor(
    private readonly intervalMs: number,
    private readonly refreshers: Record<string, Refresher> = REFRESHERS,
  ) {
    if (this.intervalMs > 0 && this.intervalMs < 60_000) this.intervalMs = 60_000;
  }

  get enabled(): boolean {
    return this.intervalMs > 0;
  }

  /** Best-effort restore of previous run state so a daemon restart does not
   * blank the dashboard. Missing or unparsable state is simply no state. */
  hydrate(): void {
    void (async () => {
      try {
        const parsed = (await Bun.file(statePath()).json()) as { entries?: RefreshEntry[] };
        for (const entry of parsed.entries ?? []) {
          this.entries.set(`${entry.tool}/${entry.identity}`, entry);
        }
      } catch {
        // No prior state; first tick will populate.
      }
    })();
  }

  private async persist(): Promise<void> {
    try {
      await mkdir(consoleWebDir(), { recursive: true });
      await Bun.write(statePath(), `${JSON.stringify({ entries: [...this.entries.values()] }, null, 2)}\n`);
    } catch {
      // Status persistence is best-effort; live status still works.
    }
  }

  /** Enumerates every identity that has a refresher registered. */
  async targets(): Promise<{ tool: string; identity: Identity; refresher: Refresher }[]> {
    const targets: { tool: string; identity: Identity; refresher: Refresher }[] = [];
    for (const [tool, refresher] of Object.entries(this.refreshers)) {
      const cfg = TOOL_CONFIGS[tool as keyof typeof TOOL_CONFIGS];
      if (!cfg) continue;
      try {
        const file = await loadIdentitiesFile(cfg.identitiesJsonPath);
        for (const identity of file.identities) targets.push({ tool, identity, refresher });
      } catch {
        // Registry unreadable (fresh machine): nothing to refresh yet.
      }
    }
    return targets;
  }

  private async runOne(tool: string, identity: Identity, refresher: Refresher): Promise<boolean> {
    const key = `${tool}/${identity.name}`;
    const existing = this.entries.get(key);
    const entry: RefreshEntry = existing ?? {
      tool,
      identity: identity.name,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastError: null,
    };
    this.entries.set(key, entry);
    entry.lastAttemptAt = new Date().toISOString();
    this.inFlight.add(key);
    try {
      const written = await refresher(identity);
      if (written) {
        entry.lastSuccessAt = entry.lastAttemptAt;
        entry.lastError = null;
      } else {
        entry.lastError = "refresh returned nothing (session not authenticated or browser unavailable)";
      }
      return Boolean(written);
    } catch (err) {
      entry.lastError = err instanceof Error ? err.message : String(err);
      return false;
    } finally {
      this.inFlight.delete(key);
      await this.persist();
    }
  }

  async refreshNow(tool: string, identityName: string): Promise<boolean> {
    const refresher = this.refreshers[tool];
    if (!refresher) throw new Error(`no refresh flow for tool "${tool}"`);
    const cfg = TOOL_CONFIGS[tool as keyof typeof TOOL_CONFIGS];
    const file = await loadIdentitiesFile(cfg.identitiesJsonPath);
    const identity = file.identities.find((candidate) => candidate.name === identityName);
    if (!identity) throw new Error(`no ${tool} identity named "${identityName}"`);
    return this.runOne(tool, identity, refresher);
  }

  async tick(): Promise<void> {
    if (this.stopped) return;
    const targets = await this.targets();
    for (const { tool, identity, refresher } of targets) {
      if (this.stopped) return;
      await this.runOne(tool, identity, refresher);
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
