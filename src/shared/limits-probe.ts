/**
 * Marks a child process as a usage probe started by `ais limits`.
 *
 * The probe runs the real `claude`, which loads plugins. One plugin (the
 * ais-usage mod) runs `ais limits` again, which would start more probes.
 * Every code path that could start a probe checks this variable first and
 * does nothing when it is "1".
 */
export const AIS_LIMITS_PROBE_ENV = "AIS_LIMITS_PROBE";

/** True when this process was started as a usage probe. */
export function isLimitsProbe(env: Record<string, string | undefined> = process.env): boolean {
  return env[AIS_LIMITS_PROBE_ENV] === "1";
}
