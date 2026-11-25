import { readFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { defaultSecretsPath, readSecretsKey } from "../cli/gateway/secrets-file.ts";
import { readHeartbeat } from "../identities/gateway-heartbeat.ts";
import { ownedPath, recordOwned } from "../identities/gateway-owned.ts";
import { aisStateDir } from "../shared/ais-home.ts";
import { STORE_ADMIN_TOKEN_KEY, STORE_ADMIN_URL_KEY, STORE_DATABASE_URL_KEY, STORE_DIRECT_KEY } from "../sync/store-sync-supervisor.ts";
import { loadGatewayGuard, memberHere } from "../sync/gateway-guard.ts";
import { importHome, type ImportEntry, type ImportReport } from "./home-import.ts";
import { HomeMirror } from "./home-mirror.ts";
import { hostOwnsFolderLogin } from "./host-login-gate.ts";
import { HttpHomeStore, HttpRefreshBackend } from "./home-store-http.ts";
import { parseStoreKey, STORE_KEY_ENV, type HomeStoreClient } from "./home-store.ts";
import type { RefreshGuardBackend } from "./refresh-guard.ts";

/**
 * Host side of the PostgreSQL credential store: keeps a host's real login files (~/.claude, ~/.codex, ~/.ais, ...) in step
 * with the store now that no gateway replica mounts them (hostPath). It is the file-store mirror the hostPath replica ran
 * (HomeMirror with `fileStore`), plus the periodic import of new host logins:
 * - a gateway refresh (a row that moved) is written into the host file, so host tools that read their own files (grok,
 *   kimi, pi, zai, opencode, ...) never hold a refresh token the gateway already rotated;
 * - a host file that changed (a new login, a host tool's own refresh) is pushed when its grant is fresher; a login never
 *   replaces a fresher one either way (newest token wins), and the import never uploads a token the journal shows rotated out.
 *
 * Runs as `ais gateway store sync`, supervised by the host profile-sync daemon (profile-sync-daemon.ts) whenever the store
 * is configured: AIS_GATEWAY_STORE_KEY (or AIS_GATEWAY_STORE_KEY_FILE) plus the gateway admin address and token
 * (AIS_GATEWAY_ADMIN_URL, AIS_GATEWAY_ADMIN_TOKEN), from the environment or ~/.secrets. The host reads and writes the store
 * through the gateway's admin API (home-store-http.ts) and opens no database connection. The old direct path (a PostgreSQL
 * URL in AIS_GATEWAY_STORE_DATABASE_URL) only runs when AIS_GATEWAY_STORE_DIRECT=1 is set too; it stays for one release as
 * a fallback. A separate process because the import switches on the member-store view for the whole process, which the
 * profile sync must never see.
 */

export { STORE_DATABASE_URL_KEY };
export const STORE_KEY_FILE_KEY = "AIS_GATEWAY_STORE_KEY_FILE";
export const HOST_SYNC_IMPORT_MS = 5 * 60_000;
export const HOST_SYNC_POLL_MS = 5_000;

export interface HostStoreConfig {
  key: Buffer;
  /** The gateway's admin API: the way a host reaches the store. */
  admin?: { url: string; token: string };
  /** Direct database access, the fallback. Set only with AIS_GATEWAY_STORE_DIRECT=1. */
  databaseUrl?: string;
}

/**
 * The host's store settings, environment first, then ~/.secrets. Undefined when the store is not used on this host (no key).
 * Throws when a key is set but neither the admin address and token nor the opted-in direct database URL is; throws when
 * the key is invalid. Never includes a value in the error.
 */
export async function hostStoreConfig(env: Record<string, string | undefined> = process.env, secretsPath = defaultSecretsPath()): Promise<HostStoreConfig | undefined> {
  const pick = async (name: string): Promise<string | undefined> => env[name]?.trim() || (await readSecretsKey(name, secretsPath))?.trim() || undefined;
  let raw = await pick(STORE_KEY_ENV);
  const file = raw ? undefined : await pick(STORE_KEY_FILE_KEY);
  if (!raw) {
    if (file) raw = (await readFile(file.replace(/^~(?=\/)/, homedir()), "utf8").catch(() => undefined))?.trim();
  }
  const adminUrl = await pick(STORE_ADMIN_URL_KEY);
  const adminToken = await pick(STORE_ADMIN_TOKEN_KEY);
  const databaseUrl = await pick(STORE_DATABASE_URL_KEY);
  const direct = (await pick(STORE_DIRECT_KEY)) === "1";
  // A database URL without a key is the old setup gone wrong: say so, as before. No key and no URL means the store is not used here.
  if (!raw && !file && !databaseUrl) return undefined;
  const key = parseStoreKey(raw);
  const cfg: HostStoreConfig = { key };
  if (adminUrl && adminToken) cfg.admin = { url: adminUrl.replace(/\/+$/, ""), token: adminToken };
  if (direct && databaseUrl) cfg.databaseUrl = databaseUrl;
  if (!cfg.admin && !cfg.databaseUrl) throw new Error(`host store sync: ${STORE_ADMIN_URL_KEY} and ${STORE_ADMIN_TOKEN_KEY} are required (the host reaches the store through the gateway API; the direct database path needs ${STORE_DIRECT_KEY}=1)`);
  return cfg;
}

export const hostSyncLockPath = (): string => join(aisStateDir(), "gateway-store-sync.lock");

export interface HostSyncResult {
  imported: ImportReport;
  /** Host files written from the store (gateway refreshes, logins made elsewhere). */
  wrote: number;
  /** Host files pushed to the store. */
  pushed: number;
}

export interface HostSyncOptions {
  home?: string;
  warn?: (message: string) => void;
  /** Tests: injected store and lock instead of the ones made from the config. */
  store?: HomeStoreClient;
  lock?: RefreshGuardBackend;
  /** Tests: the files to import instead of the ones the host registries name. */
  importEntries?: () => Promise<ImportEntry[]>;
}

/** A file-store mirror on the host HOME that counts what each pass wrote and pushed. */
class CountingMirror extends HomeMirror {
  wrote = 0;
  pushed = 0;
  /** Records still running for a heartbeat row (see recordHeld). */
  recording: Promise<unknown>[] = [];
}

const HEARTBEAT_FILE = "gateway-heartbeat.json";

/**
 * Sticky ownership (gateway-owned.ts): every login the gateway's heartbeat names, as this host sees it, is written to the
 * host's ownership record. The record never shrinks here, so a heartbeat that goes stale later never hands a login back to a
 * host refresher. Reads the host file the mirror just wrote (or kept). Never throws.
 */
async function recordHeld(home: string, rel: string, warn?: (m: string) => void): Promise<void> {
  const file = join(home, ...rel.split("/"));
  try {
    const hb = await readHeartbeat(file);
    if (hb) await recordOwned(Object.keys(hb.held), hb.passAt, ownedPath(home));
  } catch (err) {
    warn?.(`could not record the logins the gateway owns (${(err as NodeJS.ErrnoException).code ?? (err as Error).name})`);
  }
}

function mirrorFor(store: HomeStoreClient, home: string, warn?: (m: string) => void): CountingMirror {
  const counts = { m: undefined as CountingMirror | undefined };
  const m = new CountingMirror(store, {
    home,
    fileStore: true,
    ...(warn ? { warn } : {}),
    // A row for a login the gateway owns (member copy here, or sticky ownership) never lands in its identity folder.
    keepHostLogin: async (rel) => {
      const guard = await loadGatewayGuard(home);
      const login = guard.native.get(rel);
      return login !== undefined && memberHere(guard, login);
    },
    // A folder login of an identity the gateway does not manage belongs to the host: it never goes to the store, and no row lands on it.
    hostOwnsLogin: (rel) => hostOwnsFolderLogin(home, rel),
    onOutcome: (path, outcome) => {
      if (outcome === "wrote") counts.m!.wrote += 1;
      else if (outcome === "pushed") counts.m!.pushed += 1;
      if (path.endsWith(HEARTBEAT_FILE) && outcome !== "conflict") {
        const task = recordHeld(home, path, warn).finally(() => {
          counts.m!.recording = counts.m!.recording.filter((t) => t !== task);
        });
        counts.m!.recording.push(task);
      }
    },
  });
  counts.m = m;
  return m;
}

/** A running host sync: `stop()` ends it after a final push. */
export interface HostSync {
  /** The first pass (import, pull, push). */
  ready: Promise<HostSyncResult>;
  stop(): Promise<void>;
}

/** One import + full pull + push of changed host files. Connections are the caller's. */
const runImport = async (store: HomeStoreClient, lock: RefreshGuardBackend, home: string, opts: HostSyncOptions): Promise<ImportReport> =>
  importHome(store, { home, lock, ...(opts.importEntries ? { entries: await opts.importEntries() } : {}) });

async function pass(mirror: CountingMirror, store: HomeStoreClient, lock: RefreshGuardBackend, home: string, opts: HostSyncOptions, warn?: (m: string) => void): Promise<HostSyncResult> {
  // A failed import never stops the pull and push, nor the mirror that follows the store afterwards.
  const imported = await runImport(store, lock, home, opts).catch((err: unknown): ImportReport => {
    (warn ?? opts.warn ?? ((m: string) => console.warn(`ais gateway store sync: ${m}`)))(`import failed (${(err as Error).name})`);
    return { added: [], updated: [], unchanged: [], skipped: [] };
  });
  mirror.wrote = 0;
  mirror.pushed = 0;
  await mirror.pullAll();
  await mirror.pushDirty();
  await Promise.allSettled(mirror.recording);
  return { imported, wrote: mirror.wrote, pushed: mirror.pushed };
}

const open = async (cfg: HostStoreConfig | undefined, opts: HostSyncOptions, warn?: (m: string) => void): Promise<{ store: HomeStoreClient; lock: RefreshGuardBackend; own: boolean }> => {
  if (opts.store && opts.lock) return { store: opts.store, lock: opts.lock, own: false };
  if (!cfg) throw new Error("host store sync: no store configured");
  // The direct database path is the fallback: only AIS_GATEWAY_STORE_DIRECT=1 puts a databaseUrl in the config (hostStoreConfig).
  if (cfg.databaseUrl) {
    const [{ PgHomeStore }, { PgRefreshBackend }] = await Promise.all([import("./home-store.ts"), import("./pg-refresh-backend.ts")]);
    return { store: new PgHomeStore(cfg.databaseUrl, cfg.key, `host-sync:${hostname()}:${process.pid}`), lock: new PgRefreshBackend(cfg.databaseUrl), own: true };
  }
  const api = { url: cfg.admin!.url, token: cfg.admin!.token };
  return { store: new HttpHomeStore({ ...api, key: cfg.key, ...(warn ? { warn } : {}) }), lock: new HttpRefreshBackend(api), own: true };
};

/** `ais gateway store sync --once`: one pass, then closes its connections. */
export async function hostSyncOnce(cfg: HostStoreConfig | undefined, opts: HostSyncOptions = {}): Promise<HostSyncResult> {
  const home = opts.home ?? homedir();
  const { store, lock, own } = await open(cfg, opts, opts.warn);
  const mirror = mirrorFor(store, home, opts.warn);
  try {
    return await pass(mirror, store, lock, home, opts);
  } finally {
    if (own) {
      await store.close().catch(() => undefined);
      await lock.close?.().catch(() => undefined);
    }
  }
}

/**
 * `ais gateway store sync`: a first pass, then follows the store (a long poll on the gateway, or NOTIFY on the direct path, plus a 5 s poll; host edits are pushed on the same
 * pass) and re-runs the import every 5 minutes for new host files.
 */
export function startHostSync(cfg: HostStoreConfig | undefined, opts: HostSyncOptions & { pollMs?: number; importMs?: number } = {}): HostSync {
  const home = opts.home ?? homedir();
  const warn = opts.warn ?? ((m: string) => console.warn(`ais gateway store sync: ${m}`));
  const opened = open(cfg, opts, warn).then((o) => ({ ...o, mirror: mirrorFor(o.store, home, warn) }));
  let timer: ReturnType<typeof setInterval> | undefined;
  let importing: Promise<unknown> | undefined;
  let stopped = false;
  const ready = (async () => {
    const { store, lock, mirror } = await opened;
    const r = await pass(mirror, store, lock, home, opts, warn);
    if (stopped) return r;
    await mirror.start(opts.pollMs ?? HOST_SYNC_POLL_MS);
    timer = setInterval(() => {
      if (stopped || importing) return;
      importing = runImport(store, lock, home, opts)
        .catch((err: unknown) => warn(`import failed (${(err as Error).name})`))
        .finally(() => {
          importing = undefined;
        });
    }, opts.importMs ?? HOST_SYNC_IMPORT_MS);
    timer.unref?.();
    return r;
  })();
  return {
    ready,
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      await ready.catch(() => undefined);
      await importing;
      const o = await opened.catch(() => undefined);
      if (!o) return;
      await o.mirror.stop();
      if (o.own) {
        await o.store.close().catch(() => undefined);
        await o.lock.close?.().catch(() => undefined);
      }
    },
  };
}

/** One line for logs and the CLI: counts only, never paths' contents or tokens. */
export function describeHostSync(r: HostSyncResult): string {
  return `host store sync: ${r.wrote} written from the store, ${r.pushed} pushed; import ${r.imported.added.length} added, ${r.imported.updated.length} updated, ${r.imported.unchanged.length} unchanged, ${r.imported.skipped.length} kept`;
}
