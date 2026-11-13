import { defaultSecretsPath, readSecretsKey } from "../cli/gateway/secrets-file.ts";
import { resolveInstalledAisBinary } from "./background.ts";

/**
 * Keeps one `ais gateway store sync` child running under the host profile-sync daemon while the gateway's PostgreSQL
 * credential store is configured on this host (AIS_GATEWAY_STORE_DATABASE_URL in the environment or ~/.secrets), so the
 * host's login files follow the store without a service of their own (src/gateway/host-sync.ts). Unconfigured hosts
 * (every host but the one whose files the gateway was imported from) start nothing.
 *
 * The child exits by itself when this daemon goes (it watches its parent), so the unit's KillMode=process never leaves an
 * old child running beside a new one. A child that exits is restarted with a backoff (10 s doubling to 5 minutes; reset
 * after it ran 10 minutes).
 */

export const STORE_DATABASE_URL_KEY = "AIS_GATEWAY_STORE_DATABASE_URL";
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

export async function storeSyncConfigured(env: Record<string, string | undefined> = process.env, secretsPath = defaultSecretsPath()): Promise<boolean> {
  return Boolean(env[STORE_DATABASE_URL_KEY]?.trim() || (await readSecretsKey(STORE_DATABASE_URL_KEY, secretsPath))?.trim());
}

function spawnStoreSync(): SupervisedChild | undefined {
  const binary = resolveInstalledAisBinary();
  if (!binary) return undefined;
  const child = Bun.spawn([binary, "gateway", "store", "sync"], { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  return { exited: child.exited, kill: (signal) => child.kill(signal) };
}

export function createStoreSyncSupervisor(deps: StoreSyncSupervisorDeps = {}): StoreSyncSupervisor {
  const configured = deps.configured ?? (() => storeSyncConfigured());
  const spawn = deps.spawn ?? spawnStoreSync;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((m: string) => console.error(`ais: ${m}`));
  let child: SupervisedChild | undefined;
  let startedAt = 0;
  let backoff = BACKOFF_MIN_MS;
  let nextStartAt = 0;
  let checkedAt = -Infinity;
  let wanted = false;
  let stopped = false;

  return {
    running: () => child !== undefined,
    async tick() {
      if (stopped) return;
      if (now() - checkedAt >= CONFIG_RECHECK_MS) {
        checkedAt = now();
        wanted = await configured().catch(() => wanted);
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
