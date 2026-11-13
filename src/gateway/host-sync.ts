import { readFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { defaultSecretsPath, readSecretsKey } from "../cli/gateway/secrets-file.ts";
import { aisStateDir } from "../shared/ais-home.ts";
import { STORE_DATABASE_URL_KEY } from "../sync/store-sync-supervisor.ts";
import { importHome, type ImportEntry, type ImportReport } from "./home-import.ts";
import { HomeMirror } from "./home-mirror.ts";
import { parseStoreKey, PgHomeStore, STORE_KEY_ENV } from "./home-store.ts";
import { PgRefreshBackend } from "./pg-refresh-backend.ts";
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
 * is configured: AIS_GATEWAY_STORE_DATABASE_URL and AIS_GATEWAY_STORE_KEY (or AIS_GATEWAY_STORE_KEY_FILE), from the
 * environment or ~/.secrets (`ais gateway store setup` writes them). A separate process because the import switches on
 * the member-store view for the whole process, which the profile sync must never see.
 */

export { STORE_DATABASE_URL_KEY };
export const STORE_KEY_FILE_KEY = "AIS_GATEWAY_STORE_KEY_FILE";
export const HOST_SYNC_IMPORT_MS = 5 * 60_000;
export const HOST_SYNC_POLL_MS = 5_000;

export interface HostStoreConfig {
  databaseUrl: string;
  key: Buffer;
}

/**
 * The host's store settings, environment first, then ~/.secrets. Undefined when no database URL is set (the store is not
 * used on this host). Throws when the URL is set but the key is missing or invalid; never includes a value in the error.
 */
export async function hostStoreConfig(env: Record<string, string | undefined> = process.env, secretsPath = defaultSecretsPath()): Promise<HostStoreConfig | undefined> {
  const pick = async (name: string): Promise<string | undefined> => env[name]?.trim() || (await readSecretsKey(name, secretsPath))?.trim() || undefined;
  const databaseUrl = await pick(STORE_DATABASE_URL_KEY);
  if (!databaseUrl) return undefined;
  let raw = await pick(STORE_KEY_ENV);
  if (!raw) {
    const file = await pick(STORE_KEY_FILE_KEY);
    if (file) raw = (await readFile(file.replace(/^~(?=\/)/, homedir()), "utf8").catch(() => undefined))?.trim();
  }
  return { databaseUrl, key: parseStoreKey(raw) };
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
  /** Tests: injected store and lock instead of connections from the config. */
  store?: PgHomeStore;
  lock?: RefreshGuardBackend;
  /** Tests: the files to import instead of the ones the host registries name. */
  importEntries?: () => Promise<ImportEntry[]>;
}

/** A file-store mirror on the host HOME that counts what each pass wrote and pushed. */
class CountingMirror extends HomeMirror {
  wrote = 0;
  pushed = 0;
}

function mirrorFor(store: PgHomeStore, home: string, warn?: (m: string) => void): CountingMirror {
  const counts = { m: undefined as CountingMirror | undefined };
  const m = new CountingMirror(store, {
    home,
    fileStore: true,
    ...(warn ? { warn } : {}),
    onOutcome: (_path, outcome) => {
      if (outcome === "wrote") counts.m!.wrote += 1;
      else if (outcome === "pushed") counts.m!.pushed += 1;
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
const runImport = async (store: PgHomeStore, lock: RefreshGuardBackend, home: string, opts: HostSyncOptions): Promise<ImportReport> =>
  importHome(store, { home, lock, ...(opts.importEntries ? { entries: await opts.importEntries() } : {}) });

async function pass(mirror: CountingMirror, store: PgHomeStore, lock: RefreshGuardBackend, home: string, opts: HostSyncOptions): Promise<HostSyncResult> {
  const imported = await runImport(store, lock, home, opts);
  mirror.wrote = 0;
  mirror.pushed = 0;
  await mirror.pullAll();
  await mirror.pushDirty();
  return { imported, wrote: mirror.wrote, pushed: mirror.pushed };
}

const open = (cfg: HostStoreConfig | undefined, opts: HostSyncOptions): { store: PgHomeStore; lock: RefreshGuardBackend; own: boolean } => {
  if (opts.store && opts.lock) return { store: opts.store, lock: opts.lock, own: false };
  if (!cfg) throw new Error("host store sync: no store configured");
  return { store: new PgHomeStore(cfg.databaseUrl, cfg.key, `host-sync:${hostname()}:${process.pid}`), lock: new PgRefreshBackend(cfg.databaseUrl), own: true };
};

/** `ais gateway store sync --once`: one pass, then closes its connections. */
export async function hostSyncOnce(cfg: HostStoreConfig | undefined, opts: HostSyncOptions = {}): Promise<HostSyncResult> {
  const home = opts.home ?? homedir();
  const { store, lock, own } = open(cfg, opts);
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
 * `ais gateway store sync`: a first pass, then follows the store (NOTIFY plus a 5 s poll; host edits are pushed on the same
 * pass) and re-runs the import every 5 minutes for new host files.
 */
export function startHostSync(cfg: HostStoreConfig | undefined, opts: HostSyncOptions & { pollMs?: number; importMs?: number } = {}): HostSync {
  const home = opts.home ?? homedir();
  const warn = opts.warn ?? ((m: string) => console.warn(`ais gateway store sync: ${m}`));
  const { store, lock, own } = open(cfg, opts);
  const mirror = mirrorFor(store, home, warn);
  let timer: ReturnType<typeof setInterval> | undefined;
  let importing: Promise<unknown> | undefined;
  let stopped = false;
  const ready = (async () => {
    const r = await pass(mirror, store, lock, home, opts);
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
      await mirror.stop();
      if (own) {
        await store.close().catch(() => undefined);
        await lock.close?.().catch(() => undefined);
      }
    },
  };
}

/** One line for logs and the CLI: counts only, never paths' contents or tokens. */
export function describeHostSync(r: HostSyncResult): string {
  return `host store sync: ${r.wrote} written from the store, ${r.pushed} pushed; import ${r.imported.added.length} added, ${r.imported.updated.length} updated, ${r.imported.unchanged.length} unchanged, ${r.imported.skipped.length} kept`;
}
