import { defaultSecretsPath, readSecretsKey } from "../cli/gateway/secrets-file.ts";
import { resolveInstalledAisBinary } from "./background.ts";

/**
 * Keeps one `ais gateway store sync` child running under the host profile-sync daemon while the gateway's PostgreSQL
 * credential store is configured on this host (the store key plus the gateway admin address and token, or the opted-in direct database path, in the environment or ~/.secrets), so the
 * host's login files follow the store without a service of their own (src/gateway/host-sync.ts). Unconfigured hosts
 * (every host but the one whose files the gateway was imported from) start nothing.
 *
 * The child exits by itself when this daemon goes (it watches its parent), so the unit's KillMode=process never leaves an
 * old child running beside a new one. A child that exits is restarted with a backoff (10 s doubling to 5 minutes; reset
 * after it ran 10 minutes).
 */

export const STORE_DATABASE_URL_KEY = "AIS_GATEWAY_STORE_DATABASE_URL";
export const STORE_ADMIN_URL_KEY = "AIS_GATEWAY_ADMIN_URL";
export const STORE_ADMIN_TOKEN_KEY = "AIS_GATEWAY_ADMIN_TOKEN";
/** Set to 1 to let the host sync open its own database connections (the old path, kept for one release). */
export const STORE_DIRECT_KEY = "AIS_GATEWAY_STORE_DIRECT";
const CONFIG_RECHECK_MS = 60_000;
const BACKOFF_MIN_MS = 10_000;
const BACKOFF_MAX_MS = 5 * 60_000;
const HEALTHY_RUN_MS = 10 * 60_000;

export interface SupervisedChild {
  readonly exited: Promise<unknown>;
  kill(signal?: NodeJS.Signals): void;
}

export interface StoreSyncSupervisorDeps {
  configured?: () => Promise<boolean>;
  /** Replaces `configured` when the caller can tell "blocked" from "off" (default: storeSyncState). */
  state?: () => Promise<StoreSyncState>;
  spawn?: () => SupervisedChild | undefined;
  now?: () => number;
  log?: (message: string) => void;
}

export interface StoreSyncSupervisor {
  tick(): Promise<void>;
  stop(): void;
  /** Tests and status. */
  running(): boolean;
}

/**
 * Whether the host sync may run here.
 * - off: no key and no database URL. The store is not used on this host.
 * - ready: the key is set and one transport is: the gateway admin address and token, or AIS_GATEWAY_STORE_DIRECT=1 with a database URL.
 * - blocked: something is set but the sync cannot work. `reason` is one clear line, and the supervisor starts nothing (a child would only crash and restart).
 */
export type StoreSyncState = { state: "off" } | { state: "ready" } | { state: "blocked"; reason: string };

export async function storeSyncState(env: Record<string, string | undefined> = process.env, secretsPath = defaultSecretsPath()): Promise<StoreSyncState> {
  const has = async (name: string): Promise<boolean> => Boolean(env[name]?.trim() || (await readSecretsKey(name, secretsPath))?.trim());
  const key = (await has("AIS_GATEWAY_STORE_KEY")) || (await has("AIS_GATEWAY_STORE_KEY_FILE"));
  const database = await has(STORE_DATABASE_URL_KEY);
  const api = (await has(STORE_ADMIN_URL_KEY)) && (await has(STORE_ADMIN_TOKEN_KEY));
  const direct = database && (env[STORE_DIRECT_KEY]?.trim() || (await readSecretsKey(STORE_DIRECT_KEY, secretsPath))?.trim()) === "1";
  if (!key) {
    return database ? { state: "blocked", reason: "AIS_GATEWAY_STORE_KEY (or AIS_GATEWAY_STORE_KEY_FILE) is required for the PostgreSQL credential store (32 random bytes, base64)" } : { state: "off" };
  }
  if (api || direct) return { state: "ready" };
  return {
    state: "blocked",
    reason: `${STORE_ADMIN_URL_KEY} and ${STORE_ADMIN_TOKEN_KEY} are missing: the host reaches the store through the gateway API now${database ? ` (the database URL is ignored unless ${STORE_DIRECT_KEY}=1)` : ""}`,
  };
}

export async function storeSyncConfigured(env: Record<string, string | undefined> = process.env, secretsPath = defaultSecretsPath()): Promise<boolean> {
  return (await storeSyncState(env, secretsPath)).state === "ready";
}

function spawnStoreSync(): SupervisedChild | undefined {
  const binary = resolveInstalledAisBinary();
  if (!binary) return undefined;
  const child = Bun.spawn([binary, "gateway", "store", "sync"], { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  return { exited: child.exited, kill: (signal) => child.kill(signal) };
}

export function createStoreSyncSupervisor(deps: StoreSyncSupervisorDeps = {}): StoreSyncSupervisor {
  const state: () => Promise<StoreSyncState> = deps.state ?? (deps.configured ? async () => ((await deps.configured!()) ? { state: "ready" } : { state: "off" }) : () => storeSyncState());
  const spawn = deps.spawn ?? spawnStoreSync;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((m: string) => console.error(`ais: ${m}`));
  let child: SupervisedChild | undefined;
  let startedAt = 0;
  let backoff = BACKOFF_MIN_MS;
  let nextStartAt = 0;
  let checkedAt = -Infinity;
  let wanted = false;
  let blockedWarned: string | undefined;
  let stopped = false;

  return {
    running: () => child !== undefined,
    async tick() {
      if (stopped) return;
      if (now() - checkedAt >= CONFIG_RECHECK_MS) {
        checkedAt = now();
        const s = await state().catch(() => undefined);
        if (s) {
          wanted = s.state === "ready";
          // One line per reason, never one per check.
          if (s.state === "blocked" && s.reason !== blockedWarned) log(`host store sync not started: ${s.reason}`);
          blockedWarned = s.state === "blocked" ? s.reason : undefined;
        }
      }
      if (!wanted) {
        if (child) {
          log("credential store no longer configured; stopping the host store sync");
          child.kill("SIGTERM");
        }
        return;
      }
      if (child || now() < nextStartAt) return;
      const c = spawn();
      if (!c) {
        nextStartAt = now() + BACKOFF_MAX_MS;
        log("host store sync: could not find the installed ais binary");
        return;
      }
      child = c;
      startedAt = now();
      void c.exited.then((code) => {
        if (child !== c) return;
        child = undefined;
        if (stopped) return;
        backoff = now() - startedAt >= HEALTHY_RUN_MS ? BACKOFF_MIN_MS : Math.min(backoff * 2, BACKOFF_MAX_MS);
        nextStartAt = now() + backoff;
        if (wanted) log(`host store sync exited (${String(code)}); restarting in ${Math.round(backoff / 1000)} s`);
      });
    },
    stop() {
      stopped = true;
      child?.kill("SIGTERM");
    },
  };
}
