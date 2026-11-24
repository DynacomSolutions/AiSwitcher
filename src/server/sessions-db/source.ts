import { S3PartSource, type PartSource } from "../../gateway/sessions/part-reader.ts";
import { SessionStore } from "../../gateway/sessions/session-store.ts";
import { missingReaderSettings, sessionsReaderConfigFromEnv, sessionsSourceMode, SESSIONS_SOURCE_ENV, type SessionsReaderConfig, type SessionsSourceMode } from "./config.ts";
import { SessionsDbSource, type SessionsReadStore } from "./db-source.ts";
import { sessionsReaderMetrics, type SessionsReaderMetrics } from "./metrics.ts";
import { PartCache } from "./part-cache.ts";
import { PartLoader } from "./part-lines.ts";
import { markProbeFailedHere } from "./probe-cache.ts";

/** What a read uses: the files, or the database (the tools it holds) with the files for the rest. */
export interface SessionsSourceHandle {
  mode: SessionsSourceMode;
  /** The source in use. `auto` with no usable database gives `files`. */
  used: "files" | "db";
  /** Why `auto` chose the files. Names settings, never values. */
  reason?: string;
  db?: SessionsDbSource;
  /** True when a failed or missing database read may fall back to the files (`auto`). */
  fallback: boolean;
  close(): Promise<void>;
}

export interface OpenDeps {
  /** Test seams. */
  store?: SessionsReadStore & { close?: () => Promise<void> };
  parts?: PartSource;
  metrics?: SessionsReaderMetrics;
  cache?: PartCache;
  /** Milliseconds `auto` waits for the database to answer (default 3000). */
  pingTimeoutMs?: number;
  /** `auto` only: a recent probe failed (the console process knows), so use the files without probing. */
  skipProbe?: boolean;
}

export const PING_TIMEOUT_MS = 3000;
/** Connect limit of `db` mode, where no files can answer, so a slow database is better than an error. */
export const DB_CONNECT_TIMEOUT_MS = 10_000;

const filesHandle = (mode: SessionsSourceMode, reason?: string): SessionsSourceHandle => ({
  mode,
  used: "files",
  ...(reason !== undefined ? { reason } : {}),
  fallback: false,
  async close() {},
});

/** One cache per process: parts never change, so a later read of the same part skips the fetch. */
let sharedCache: { cap: number; cache: PartCache } | undefined;
function processCache(cap: number): PartCache {
  if (!sharedCache || sharedCache.cap !== cap) sharedCache = { cap, cache: new PartCache(cap) };
  return sharedCache.cache;
}

function buildDb(cfg: SessionsReaderConfig, deps: OpenDeps, mode: SessionsSourceMode): { db: SessionsDbSource; close: () => Promise<void> } {
  const metrics = deps.metrics ?? sessionsReaderMetrics;
  // The driver would wait about 30 s for a connection. A short connect timeout keeps a silent database from holding a read.
  const store = deps.store ?? new SessionStore(cfg.databaseUrl, { poolMax: 2, connectTimeoutS: Math.max(1, Math.ceil((mode === "auto" ? (deps.pingTimeoutMs ?? PING_TIMEOUT_MS) : DB_CONNECT_TIMEOUT_MS) / 1000)) });
  const loader = new PartLoader({
    source: deps.parts ?? new S3PartSource(cfg),
    identity: cfg.ageIdentity,
    cache: deps.cache ?? processCache(cfg.cacheBytes),
    metrics,
  });
  return { db: new SessionsDbSource({ store, loader, metrics, windowBytes: cfg.windowBytes }), close: async () => store.close?.() };
}

/**
 * Chooses the source for one read.
 *
 * - `files` (the default, also for an unknown value): no database is touched.
 * - `db`: the database is required. Missing settings throw, naming the settings.
 * - `auto`: the database when its settings are complete and it answers, else the files. A failed read later falls back to the
 *   files too (`fallback`).
 */
export async function openSessionsSource(env: Record<string, string | undefined>, deps: OpenDeps = {}): Promise<SessionsSourceHandle> {
  const mode = sessionsSourceMode(env);
  if (mode === "files") return filesHandle(mode);
  const missing = missingReaderSettings(env);
  const cfg = sessionsReaderConfigFromEnv(env);
  if (!cfg) {
    const reason = `settings missing: ${missing.join(", ")}`;
    if (mode === "db") throw new Error(`${SESSIONS_SOURCE_ENV}=db needs ${missing.join(", ")}`);
    return filesHandle(mode, reason);
  }
  if (mode === "auto" && deps.skipProbe) return filesHandle(mode, "the database did not answer a moment ago");
  const built = buildDb(cfg, deps, mode);
  if (mode === "auto") {
    try {
      await withTimeout(built.db.ping(), deps.pingTimeoutMs ?? PING_TIMEOUT_MS);
    } catch {
      // Close in the background: close() waits for the pending connect, which can take about 30 s on a silent database.
      void built.close().catch(() => undefined);
      markProbeFailedHere();
      return filesHandle(mode, "the database did not answer");
    }
  }
  return { mode, used: "db", db: built.db, fallback: mode === "auto", close: built.close };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

let announced = false;

/**
 * Called once when the console starts: resolves the source, logs which one the console uses (one line, no values), and
 * sets the `ais_console_sessions_source` gauge. A later call does nothing. The scan children resolve on their own and
 * stay quiet.
 */
export async function announceSessionsSource(
  env: Record<string, string | undefined> = process.env,
  log: (line: string) => void = (l) => console.log(l),
  deps: OpenDeps = {},
): Promise<"files" | "db"> {
  const metrics = deps.metrics ?? sessionsReaderMetrics;
  if (announced) return metrics.chosenSource() ?? "files";
  announced = true;
  let used: "files" | "db" = "files";
  let line: string;
  try {
    const h = await openSessionsSource(env, deps);
    await h.close();
    used = h.used;
    line = `sessions: reading ${h.used} (${SESSIONS_SOURCE_ENV}=${h.mode}${h.reason ? `, ${h.reason}` : ""})`;
  } catch (err) {
    used = "db";
    line = `sessions: ${(err as Error).message}; Claude and Codex session reads fail until it is fixed`;
  }
  metrics.source(used);
  log(line);
  return used;
}

/** Test seam: lets a test announce again. */
export function resetAnnouncedForTest(): void {
  announced = false;
}
