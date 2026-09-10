import { homedir } from "node:os";
import { join } from "node:path";
import { enteredBreach, type AccountSpendState } from "../spend/state.ts";
import { runSpendGuardCycle, type SpendGuardCycleResult } from "../spend/compute.ts";
import { loadSpendGuardCache, spendGuardCachePath, writeSpendGuardCache, type SpendKillRecord, type SpendGuardCache } from "../spend/cache.ts";
import { scanProcesses } from "./processes.ts";
import type { ProcessInfoDto } from "./types.ts";

/**
 * The daemon-side spend guard: the half that can ACT. On a fixed interval
 * (default 5 min, machine-local override via ~/.ais/config/spend-guard.json
 * — { intervalS, killGraceS }, the only config that exists because the cap
 * itself is AUTO from AWS Budgets) it runs one spend-guard cycle and:
 *
 *   - persists the fresh per-account states to the cache the launch gate
 *     reads (the gate is a pure consumer of this file);
 *   - on an account's TRANSITION INTO breached+enforced (including this
 *     guard's first observation of an already-blown account), finds every
 *     ACTIVE wrapped session whose identity maps to that account and
 *     terminates it: SIGTERM, killGraceS grace (default 10s), then SIGKILL.
 *
 * Kill targeting is deliberately narrow, on a shared production machine:
 * candidates come exclusively from the /proc scanner's AGENT_BINARIES set
 * AND carry the wrapper's IDENTITY_SESSION_MARKER env var (the same
 * environ-matching shape the herdr detection uses). herdr processes, this
 * daemon, chrome-mcp instances, aistui, and any process without the marker
 * can never appear as candidates, independent of what is running. Every
 * kill is logged loudly (what/why/pid/identity/account) and kept in the
 * recent-kills ring the /api/spend-guard endpoint exposes.
 */

export const DEFAULT_SPEND_GUARD_INTERVAL_S = 300;
export const DEFAULT_KILL_GRACE_S = 10;
export const MIN_SPEND_GUARD_INTERVAL_S = 30;
export const FIRST_TICK_DELAY_MS = 10_000;

export interface SpendGuardConfig {
  intervalS: number;
  killGraceS: number;
}

/** Tolerant config parse: missing/invalid fields fall to the defaults and
 * out-of-range values are clamped (a typoed config must never disable or
 * hammer enforcement). Exported pure for tests. */
export function parseSpendGuardConfig(raw: unknown): SpendGuardConfig {
  const source = (raw ?? {}) as { intervalS?: unknown; killGraceS?: unknown };
  const interval = Number(source.intervalS);
  const grace = Number(source.killGraceS);
  return {
    intervalS: Number.isFinite(interval) && interval > 0 ? Math.max(MIN_SPEND_GUARD_INTERVAL_S, Math.floor(interval)) : DEFAULT_SPEND_GUARD_INTERVAL_S,
    killGraceS: Number.isFinite(grace) && grace >= 0 ? Math.min(Math.floor(grace), 120) : DEFAULT_KILL_GRACE_S,
  };
}

export async function loadSpendGuardConfig(path: string = join(homedir(), ".ais", "config", "spend-guard.json")): Promise<SpendGuardConfig> {
  try {
    return parseSpendGuardConfig(await Bun.file(path).json());
  } catch {
    return parseSpendGuardConfig(undefined);
  }
}

export interface SpendGuardStatusDto {
  ok: true;
  running: boolean;
  config: SpendGuardConfig;
  lastCycleAt: string | null;
  lastError: string | null;
  accounts: AccountSpendState[];
  recentKills: SpendKillRecord[];
}

export interface SpendGuardSchedulerDeps {
  config: SpendGuardConfig;
  cycle?: () => Promise<SpendGuardCycleResult>;
  scan?: () => Promise<{ processes: ProcessInfoDto[] }>;
  signal?: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  alive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  cachePath?: string;
  log?: (message: string) => void;
  now?: () => Date;
}

function defaultSignal(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  process.kill(pid, signal);
}

function defaultAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class SpendGuardScheduler {
  private readonly config: SpendGuardConfig;
  private readonly deps: SpendGuardSchedulerDeps;
  private timer: ReturnType<typeof setInterval> | undefined;
  private bootTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private ticking = false;
  private lastStates: Record<string, AccountSpendState> = {};
  private lastCycleAt: string | null = null;
  private lastError: string | null = null;
  private recentKills: SpendKillRecord[] = [];
  private cache: SpendGuardCache = { version: 1, updatedAt: new Date(0).toISOString(), accounts: {}, recentKills: [] };

  constructor(deps: SpendGuardSchedulerDeps) {
    this.config = deps.config;
    this.deps = deps;
  }

  /** Restores the previous cycle's states + kill ring so a daemon restart
   * neither forgets an ongoing breach (no spurious re-kills) nor its kill
   * history. Missing cache is simply no history. */
  async hydrate(): Promise<void> {
    const cache = await loadSpendGuardCache(this.deps.cachePath ?? spendGuardCachePath());
    if (!cache) return;
    this.cache = cache;
    this.lastStates = cache.accounts;
    this.recentKills = cache.recentKills;
  }

  get enabled(): boolean {
    return this.config.intervalS > 0;
  }

  start(): void {
    if (!this.enabled || this.timer) return;
    // First pass shortly after boot so a fresh daemon converges fast; kills
    // never wait a full interval to act on an already-breached account.
    this.bootTimer = setTimeout(() => void this.tick(), FIRST_TICK_DELAY_MS);
    this.bootTimer.unref?.();
    this.timer = setInterval(() => void this.tick(), this.config.intervalS * 1000);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.bootTimer) clearTimeout(this.bootTimer);
    this.timer = undefined;
    this.bootTimer = undefined;
  }

  status(): SpendGuardStatusDto {
    return {
      ok: true,
      running: !this.stopped && this.timer !== undefined,
      config: { ...this.config },
      lastCycleAt: this.lastCycleAt,
      lastError: this.lastError,
      accounts: Object.values(this.lastStates).sort((a, b) => a.accountId.localeCompare(b.accountId)),
      recentKills: [...this.recentKills],
    };
  }

  /** One enforcement pass. Overlapping ticks are collapsed (a slow cycle
   * must not stack AWS fetches); errors are recorded, never thrown. */
  async tick(): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      const cycle = await (this.deps.cycle ?? (() => runSpendGuardCycle()))();
      this.lastCycleAt = cycle.computedAt;
      this.lastError = cycle.errors.length > 0 ? cycle.errors.join("; ") : null;

      for (const [accountId, current] of Object.entries(cycle.states)) {
        if (!enteredBreach(this.lastStates[accountId], current)) continue;
        await this.killAccountSessions(accountId, current);
      }

      this.lastStates = cycle.states;
      await this.persist(cycle);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.log(`cycle failed: ${this.lastError}`);
    } finally {
      this.ticking = false;
    }
  }

  private async persist(cycle: SpendGuardCycleResult): Promise<void> {
    this.cache = {
      version: 1,
      updatedAt: cycle.computedAt,
      accounts: cycle.states,
      recentKills: this.recentKills.slice(-20),
    };
    try {
      await writeSpendGuardCache(this.cache, this.deps.cachePath ?? spendGuardCachePath());
    } catch {
      // Cache persistence is best-effort; the in-memory state still serves
      // /api/spend-guard and the next cycle rewrites the file.
    }
  }

  /** Finds the ACTIVE wrapped sessions of one account's identities and
   * terminates them. A candidate must (a) come from the scanner's agent
   * set, (b) carry the wrapper's session marker, (c) carry an identity name
   * that maps to THIS account, and (d) not be this daemon. Anything else on
   * this machine is structurally unreachable here. */
  private async killAccountSessions(accountId: string, state: AccountSpendState): Promise<void> {
    const identityNames = new Set(state.identities);
    const scan = this.deps.scan ?? (() => scanProcesses());
    const { processes } = await scan();
    const candidates = processes.filter(
      (p) => p.wrapped === true && p.identity !== null && identityNames.has(p.identity) && p.pid !== process.pid,
    );
    if (candidates.length === 0) {
      this.log(`account ...${accountId.slice(-4)} entered breach: no active wrapped sessions to terminate`);
      return;
    }
    for (const candidate of candidates) {
      await this.terminate(candidate, accountId, state);
    }
  }

  private async terminate(candidate: ProcessInfoDto, accountId: string, state: AccountSpendState): Promise<void> {
    const signal = this.deps.signal ?? defaultSignal;
    const alive = this.deps.alive ?? defaultAlive;
    const sleep = this.deps.sleep ?? ((ms: number) => Bun.sleep(ms));
    const log = (message: string): void => this.log(message);
    const reason = state.reason ?? `account ...${accountId.slice(-4)} is over its spend cap`;
    const base = {
      pid: candidate.pid,
      tool: candidate.tool ?? "unknown",
      identity: candidate.identity ?? "unknown",
      accountId,
      command: candidate.command,
      reason,
      at: (this.deps.now?.() ?? new Date()).toISOString(),
    };
    log(
      `KILLING pid ${candidate.pid} (${base.tool}, identity ${base.identity}, account ...${accountId.slice(-4)}): ${reason} — sending SIGTERM`,
    );
    let terminated: SpendKillRecord["signal"] = "ALREADY-GONE";
    try {
      signal(candidate.pid, "SIGTERM");
      const graceMs = this.config.killGraceS * 1000;
      for (let waited = 0; waited < graceMs; waited += 500) {
        await sleep(Math.min(500, graceMs - waited));
        if (!alive(candidate.pid)) {
          terminated = "SIGTERM";
          break;
        }
      }
      if (terminated === "ALREADY-GONE" && alive(candidate.pid)) {
        signal(candidate.pid, "SIGKILL");
        terminated = "SIGKILL";
        log(`pid ${candidate.pid} survived SIGTERM grace (${this.config.killGraceS}s) — sent SIGKILL`);
      }
    } catch (err) {
      log(`pid ${candidate.pid} vanished before termination completed: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.recentKills.push({ ...base, signal: terminated });
    log(
      `KILLED pid ${candidate.pid} (${base.tool}, identity ${base.identity}, account ...${accountId.slice(-4)}): terminated via ${terminated}`,
    );
  }

  private log(message: string): void {
    (this.deps.log ?? ((msg: string) => console.error(`[spend-guard] ${msg}`)))(message);
  }
}
