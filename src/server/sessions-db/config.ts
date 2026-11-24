/**
 * Settings of the console's database session reader, from the environment.
 *
 * `AIS_SESSIONS_SOURCE` is `files` (default), `db` or `auto`. The reader shares the object store and age settings of
 * the enrichment loop (`enrich-config.ts`). The enrichment flag is not needed here. The database URL is
 * `AIS_SESSIONS_DATABASE_URL`, else `AIS_GATEWAY_DATABASE_URL`.
 */

export type SessionsSourceMode = "files" | "db" | "auto";

export const SESSIONS_SOURCE_ENV = "AIS_SESSIONS_SOURCE";

/** The mode. An unknown or empty value means `files`: a typo never moves the live page to the database. */
export function sessionsSourceMode(env: Record<string, string | undefined>): SessionsSourceMode {
  const v = env[SESSIONS_SOURCE_ENV]?.trim().toLowerCase();
  return v === "db" || v === "auto" ? v : "files";
}

export interface SessionsReaderConfig {
  databaseUrl: string;
  endpoint: string;
  bucket: string;
  prefix: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** The private age identity. Never logged. */
  ageIdentity: string;
  /** Plain bytes of the transcript tail the reader decodes (default 4 MiB, at most 16 MiB). */
  windowBytes: number;
  /** Size cap of the decrypted part cache in bytes (default 32 MiB, 0 turns it off). */
  cacheBytes: number;
}

export const WINDOW_DEFAULT_BYTES = 4 * 1024 * 1024;
export const WINDOW_MAX_BYTES = 16 * 1024 * 1024;
export const CACHE_DEFAULT_BYTES = 32 * 1024 * 1024;
export const CACHE_MAX_BYTES = 512 * 1024 * 1024;

const intIn = (v: string | undefined, fallback: number, min: number, max: number): number => {
  const n = v === undefined || !/^\s*\d+\s*$/.test(v) ? NaN : Number(v);
  return Number.isSafeInteger(n) ? Math.min(Math.max(n, min), max) : fallback;
};

/** Names (never values) of the settings that are missing. */
export function missingReaderSettings(env: Record<string, string | undefined>): string[] {
  const missing: string[] = [];
  if (!(env.AIS_SESSIONS_DATABASE_URL?.trim() || env.AIS_GATEWAY_DATABASE_URL?.trim())) missing.push("AIS_SESSIONS_DATABASE_URL");
  for (const name of ["AIS_SESSIONS_S3_ENDPOINT", "AIS_SESSIONS_S3_BUCKET", "AIS_SESSIONS_S3_ACCESS_KEY_ID", "AIS_SESSIONS_S3_SECRET_ACCESS_KEY", "AIS_SESSIONS_AGE_IDENTITY"]) {
    if (!env[name]?.trim()) missing.push(name);
  }
  return missing;
}

/** The settings, or undefined when any is missing (`missingReaderSettings` names them). */
export function sessionsReaderConfigFromEnv(env: Record<string, string | undefined>): SessionsReaderConfig | undefined {
  if (missingReaderSettings(env).length > 0) return undefined;
  const need = (name: string): string => env[name]!.trim();
  return {
    databaseUrl: (env.AIS_SESSIONS_DATABASE_URL?.trim() || env.AIS_GATEWAY_DATABASE_URL!.trim()),
    endpoint: need("AIS_SESSIONS_S3_ENDPOINT"),
    bucket: need("AIS_SESSIONS_S3_BUCKET"),
    prefix: env.AIS_SESSIONS_S3_PREFIX?.trim() ?? "",
    region: env.AIS_SESSIONS_S3_REGION?.trim() || "auto",
    accessKeyId: need("AIS_SESSIONS_S3_ACCESS_KEY_ID"),
    secretAccessKey: need("AIS_SESSIONS_S3_SECRET_ACCESS_KEY"),
    ageIdentity: need("AIS_SESSIONS_AGE_IDENTITY"),
    windowBytes: intIn(env.AIS_SESSIONS_READ_WINDOW_BYTES, WINDOW_DEFAULT_BYTES, 64 * 1024, WINDOW_MAX_BYTES),
    cacheBytes: intIn(env.AIS_SESSIONS_PART_CACHE_BYTES, CACHE_DEFAULT_BYTES, 0, CACHE_MAX_BYTES),
  };
}
