import { S3PartSource, type PartSource } from "../../gateway/sessions/part-reader.ts";
import { SessionStore } from "../../gateway/sessions/session-store.ts";
import { missingReaderSettings, sessionsReaderConfigFromEnv, sessionsSourceMode, SESSIONS_SOURCE_ENV, type SessionsReaderConfig, type SessionsSourceMode } from "./config.ts";
import { SessionsDbSource, type SessionsReadStore } from "./db-source.ts";
import { sessionsReaderMetrics, type SessionsReaderMetrics } from "./metrics.ts";
import { PartCache } from "./part-cache.ts";
import { PartLoader } from "./part-lines.ts";

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
}

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

function buildDb(cfg: SessionsReaderConfig, deps: OpenDeps): { db: SessionsDbSource; close: () => Promise<void> } {
  const metrics = deps.metrics ?? sessionsReaderMetrics;
  const store = deps.store ?? new SessionStore(cfg.databaseUrl, { poolMax: 2 });
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
  const built = buildDb(cfg, deps);
  if (mode === "auto") {
    try {
      await withTimeout(built.db.ping(), deps.pingTimeoutMs ?? 3000);
    } catch {
      await built.close().catch(() => undefined);
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
