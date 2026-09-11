import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The spend guard's machine-local config (~/.ais/config/spend-guard.json):
 * { intervalS, killGraceS, mode }. The CAP itself is never configured here
 * (it is AUTO from AWS Budgets); this file only tunes the guard's cadence
 * and its RESPONSE to a breach.
 *
 * `mode` decides what a breach DOES:
 *   - "warn" (the default, also when the key or the whole file is absent):
 *     breaches are surfaced loudly everywhere but nothing is refused and
 *     nobody is killed. The owner set this as the new default behaviour.
 *   - "enforce": the original hard-stop behaviour. New wrapped launches are
 *     refused at the gate (exit 1) and the daemon killer terminates active
 *     sessions on the transition into breach.
 *
 * The parse is tolerant: a typoed mode value falls to "warn" rather than
 * silently enforcing (a config mistake must never surprise-kill sessions),
 * matching the rule that out-of-range numeric fields fall to their defaults.
 */

export type SpendGuardMode = "warn" | "enforce";

export const DEFAULT_SPEND_GUARD_MODE: SpendGuardMode = "warn";
export const DEFAULT_SPEND_GUARD_INTERVAL_S = 300;
export const DEFAULT_KILL_GRACE_S = 10;
export const MIN_SPEND_GUARD_INTERVAL_S = 30;

export interface SpendGuardConfig {
  intervalS: number;
  killGraceS: number;
  mode: SpendGuardMode;
}

/** Tolerant config parse: missing/invalid fields fall to the defaults and
 * out-of-range values are clamped (a typoed config must never disable or
 * hammer enforcement). Exported pure for tests. */
export function parseSpendGuardConfig(raw: unknown): SpendGuardConfig {
  const source = (raw ?? {}) as { intervalS?: unknown; killGraceS?: unknown; mode?: unknown };
  const interval = Number(source.intervalS);
  const grace = Number(source.killGraceS);
  const mode: SpendGuardMode = source.mode === "enforce" ? "enforce" : source.mode === "warn" ? "warn" : DEFAULT_SPEND_GUARD_MODE;
  return {
    intervalS: Number.isFinite(interval) && interval > 0 ? Math.max(MIN_SPEND_GUARD_INTERVAL_S, Math.floor(interval)) : DEFAULT_SPEND_GUARD_INTERVAL_S,
    killGraceS: Number.isFinite(grace) && grace >= 0 ? Math.min(Math.floor(grace), 120) : DEFAULT_KILL_GRACE_S,
    mode,
  };
}

export function spendGuardConfigPath(home: string = homedir()): string {
  return join(home, ".ais", "config", "spend-guard.json");
}

export async function loadSpendGuardConfig(path: string = spendGuardConfigPath()): Promise<SpendGuardConfig> {
  try {
    return parseSpendGuardConfig(await Bun.file(path).json());
  } catch {
    // Absent (or corrupt) file: full defaults. mode=warn is the default
    // response to a breach, by owner decision.
    return parseSpendGuardConfig(undefined);
  }
}
