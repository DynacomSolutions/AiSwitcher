/**
 * Settings of the enrichment loop, from the environment. The loop is off unless `AIS_SESSIONS_ENRICH` is `1` or `true`.
 * With the flag on, every other setting must be present: a missing one throws, and the caller leaves the loop off.
 */
export interface SessionsEnrichConfig {
  endpoint: string;
  bucket: string;
  /** Every part key must start with it (default none). A key outside it is refused, never fetched. */
  prefix: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** The private age identity (`AGE-SECRET-KEY-1...`). Never logged. */
  ageIdentity: string;
  /** Pause between passes while idle (ms). */
  intervalMs: number;
  /** Files read per pass. */
  batchFiles: number;
}

const INTERVAL_DEFAULT_MS = 5_000;
const BATCH_DEFAULT = 50;

const posInt = (v: string | undefined, fallback: number): number => {
  const n = v === undefined ? NaN : Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
};

export function sessionsEnrichEnabled(env: Record<string, string | undefined>): boolean {
  const v = env.AIS_SESSIONS_ENRICH?.trim().toLowerCase();
  return v === "1" || v === "true";
}

/** The settings, or undefined while the flag is off. Throws (naming the variable, never a value) when the flag is on and a setting is missing. */
export function sessionsEnrichConfigFromEnv(env: Record<string, string | undefined>): SessionsEnrichConfig | undefined {
  if (!sessionsEnrichEnabled(env)) return undefined;
  const need = (name: string): string => {
    const v = env[name]?.trim();
    if (!v) throw new Error(`${name} is not set`);
    return v;
  };
  return {
    endpoint: need("AIS_SESSIONS_S3_ENDPOINT"),
    bucket: need("AIS_SESSIONS_S3_BUCKET"),
    prefix: env.AIS_SESSIONS_S3_PREFIX?.trim() ?? "",
    region: env.AIS_SESSIONS_S3_REGION?.trim() || "auto",
    accessKeyId: need("AIS_SESSIONS_S3_ACCESS_KEY_ID"),
    secretAccessKey: need("AIS_SESSIONS_S3_SECRET_ACCESS_KEY"),
    ageIdentity: need("AIS_SESSIONS_AGE_IDENTITY"),
    intervalMs: posInt(env.AIS_SESSIONS_ENRICH_INTERVAL_MS, INTERVAL_DEFAULT_MS),
    batchFiles: posInt(env.AIS_SESSIONS_ENRICH_BATCH, BATCH_DEFAULT),
  };
}
