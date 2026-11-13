import { boolFlag, stringFlag, type ParsedArgs } from "../args.ts";
import { CliUsageError } from "../errors.ts";
import { resolveRemoteBase } from "./local-remote.ts";
import { runKubectl } from "./kube-secret.ts";
import { runAppCommand, runUsageCommand, type GatewayCliDeps } from "./apps.ts";
import { localGatewayTlsPort } from "../../gateway/local-tls.ts";
import { installDrainHandlers, LOCAL_GATEWAY_DEFAULT_PORT, startLocalGateway } from "../../gateway/local.ts";
import { parseStoreKey, STORE_KEY_ENV } from "../../gateway/home-store.ts";
import { DEFAULT_GATEWAY_ADMIN_PORT, DEFAULT_GATEWAY_CONNECT_PORT, DEFAULT_GATEWAY_PORT, startGateway } from "../../gateway/serve.ts";

function portOf(flag: string | undefined, env: string | undefined, fallback: number, name: string): number {
  const raw = flag ?? env;
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new CliUsageError(`${name} must be a port number, got "${raw}"`);
  return n;
}

export type { GatewayCliDeps };

const defaultDeps = (): GatewayCliDeps => ({ fetch, kubectl: runKubectl, out: (line) => console.info(line), now: () => Date.now() });

export async function runGatewayCommand(positionals: string[], flags: ParsedArgs["flags"], deps: Partial<GatewayCliDeps> = {}): Promise<void> {
  const [sub, ...rest] = positionals;
  const merged: GatewayCliDeps = { ...defaultDeps(), ...deps };
  if (sub === "app") return runAppCommand(rest[0], rest.slice(1), flags, merged);
  if (sub === "usage") return runUsageCommand(flags, merged);
  if (sub === "local") return runLocal(rest, merged, boolFlag(flags, "check"));
  if (sub === "claude-proxy") {
    const { runClaudeProxyCommand } = await import("./claude-proxy.ts");
    return runClaudeProxyCommand(rest, flags, merged);
  }
  if (sub === "t3-proxy") {
    const { runT3ProxyCommand } = await import("./t3-proxy.ts");
    return runT3ProxyCommand(rest, flags, merged);
  }
  if (sub === "t3-models") {
    const { runT3ModelsCommand } = await import("./t3-models.ts");
    return runT3ModelsCommand(rest, flags, merged);
  }
  if (sub === "store") return runStoreCommand(rest, flags, merged);
  if (sub === "codex-home") {
    const { runCodexHomeCommand } = await import("./codex-home.ts");
    return runCodexHomeCommand(rest, flags, merged);
  }
  if (sub !== "serve") throw new CliUsageError("Usage: ais gateway serve|local|app|usage|store|claude-proxy|t3-proxy|t3-models|codex-home ...  (ais gateway --help)");
  const databaseUrl = process.env.AIS_GATEWAY_DATABASE_URL;
  const adminToken = process.env.AIS_GATEWAY_ADMIN_TOKEN;
  if (!databaseUrl) throw new CliUsageError("AIS_GATEWAY_DATABASE_URL is required");
  if (!adminToken) throw new CliUsageError("AIS_GATEWAY_ADMIN_TOKEN is required");
  const port = portOf(stringFlag(flags, "port"), process.env.AIS_GATEWAY_PORT, DEFAULT_GATEWAY_PORT, "AIS_GATEWAY_PORT");
  const adminPort = portOf(stringFlag(flags, "admin-port"), process.env.AIS_GATEWAY_ADMIN_PORT, DEFAULT_GATEWAY_ADMIN_PORT, "AIS_GATEWAY_ADMIN_PORT");
  // The CONNECT proxy runs when the deployment mounts its certificate (AIS_GATEWAY_CONNECT_TLS_DIR).
  const tlsDir = process.env.AIS_GATEWAY_CONNECT_TLS_DIR;
  const connect = tlsDir
    ? { port: portOf(undefined, process.env.AIS_GATEWAY_CONNECT_PORT, DEFAULT_GATEWAY_CONNECT_PORT, "AIS_GATEWAY_CONNECT_PORT"), tlsDir, ...(process.env.AIS_GATEWAY_CONNECT_CA_PUBLISH ? { publishCaTo: process.env.AIS_GATEWAY_CONNECT_CA_PUBLISH } : {}) }
    : undefined;
  const credentialStore = credentialStoreFromEnv(process.env);
  const replicaUrl = replicaUrlFromEnv(process.env, adminPort);
  if (credentialStore) console.info(`gateway: logins from the PostgreSQL credential store${credentialStore.fileStore ? " (this replica's HOME is the host file store: write-back on)" : ""}`);
  const gateway = await startGateway({ port, adminPort, databaseUrl, adminToken, handleSignals: true, ...(connect ? { connect } : {}), ...(credentialStore ? { credentialStore } : {}), ...(replicaUrl ? { replicaUrl } : {}) });
  console.info(`gateway: proxy on :${gateway.port}, admin on :${gateway.adminPort}; warming up`);
  // Runs until SIGTERM or SIGINT, whose handler drains and exits the process.
  await new Promise<void>(() => {});
}

async function runLocal(args: string[], deps: GatewayCliDeps, check: boolean): Promise<void> {
  const port = portOf(undefined, process.env.AIS_GATEWAY_LOCAL_PORT, LOCAL_GATEWAY_DEFAULT_PORT, "AIS_GATEWAY_LOCAL_PORT");
  if (args[0] === "install") {
    const { installLocalGatewayService } = await import("./local-service.ts");
    const r = await installLocalGatewayService();
    deps.out(`gateway local: ${r.action}${r.slot ? ` (slot ${r.slot})` : ""}; unit at ${r.path}`);
    return;
  }
  if (args[0] === "status") {
    const { fetchLocalStatus } = await import("./local-service.ts");
    const st = await fetchLocalStatus(port);
    deps.out(st ? `gateway local: ${st.mode} mode since ${new Date(st.sinceMs).toISOString()} (remote ${st.remote}${st.tlsPort ? `, https port ${st.tlsPort}` : ""})` : `gateway local: not running on 127.0.0.1:${port}`);
    return;
  }
  if (args.length > 0) throw new CliUsageError("Usage: ais gateway local [install|status]");
  const remoteBase = await resolveRemoteBase();
  if (check) {
    // Preflight for the installer: the subcommand exists and its config loads. Binds nothing.
    deps.out("gateway local: ok");
    return;
  }
  const running = await startLocalGateway({ port, remoteBase, bindRetryMs: 30_000, tls: { port: localGatewayTlsPort(port) } });
  console.info(`gateway local: listening on 127.0.0.1:${running.port}${running.tlsPort ? ` (https ${running.tlsPort})` : ""}`);
  if (running.tlsPort) {
    // Codex homes written for the plain-HTTP gateway move to the HTTPS one (codex refuses an http ChatGPT backend).
    const { migrateRegisteredLocalCodexHomes } = await import("../../identities/codex-gateway-home.ts");
    await migrateRegisteredLocalCodexHomes(port, running.tlsPort).catch((e) => console.info(`gateway local: codex home migration skipped (${e instanceof Error ? e.message : String(e)})`));
  }
  installDrainHandlers(running);
  await new Promise<void>(() => {});
}

/** Env names of the PostgreSQL credential store (docs/agents/gateway.md, "Credential store and replicas"). */
export const CREDENTIAL_STORE_ENV = "AIS_GATEWAY_CREDENTIAL_STORE";
export const FILE_STORE_ENV = "AIS_GATEWAY_FILE_STORE";
export const STORE_IMPORT_ENV = "AIS_GATEWAY_STORE_IMPORT";
export const REPLICA_URL_ENV = "AIS_GATEWAY_REPLICA_URL";

const truthy = (v: string | undefined): boolean => v === "1" || v === "true";

/** `AIS_GATEWAY_CREDENTIAL_STORE=pg` turns the store on (default `files`: logins from the host files, as before). */
export function credentialStoreFromEnv(env: Record<string, string | undefined>): { key: Buffer; fileStore: boolean; importOnStart: boolean } | undefined {
  const mode = env[CREDENTIAL_STORE_ENV]?.trim() || "files";
  if (mode === "files") return undefined;
  if (mode !== "pg") throw new CliUsageError(`${CREDENTIAL_STORE_ENV} must be "pg" or "files", got "${mode}"`);
  return { key: parseStoreKey(env[STORE_KEY_ENV]), fileStore: truthy(env[FILE_STORE_ENV]), importOnStart: truthy(env[STORE_IMPORT_ENV]) };
}

/** This replica's admin address for the others: AIS_GATEWAY_REPLICA_URL, else http://$POD_IP:<admin port>; none on a single host. */
export function replicaUrlFromEnv(env: Record<string, string | undefined>, adminPort: number): string | undefined {
  const explicit = env[REPLICA_URL_ENV]?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const ip = env.POD_IP?.trim();
  if (!ip) return undefined;
  return `http://${ip.includes(":") ? `[${ip}]` : ip}:${adminPort}`;
}

const STORE_USAGE = "Usage: ais gateway store import [--dry-run] | sync [--once] | setup --key-file=<path>  (database URL on stdin)";

/**
 * `ais gateway store import [--dry-run]`: copies this host's gateway login files into the PostgreSQL store (idempotent).
 * `ais gateway store sync [--once]`: keeps this host's login files in step with the store (host-sync.ts).
 * `ais gateway store setup --key-file=<path>`: records the store's database URL (stdin) and key in ~/.secrets for the sync.
 */
async function runStoreCommand(args: string[], flags: ParsedArgs["flags"], deps: GatewayCliDeps): Promise<void> {
  const [action, ...extra] = args;
  if (extra.length > 0) throw new CliUsageError(STORE_USAGE);
  if (action === "sync") return runStoreSync(boolFlag(flags, "once"), deps);
  if (action === "setup") return runStoreSetup(stringFlag(flags, "key-file"), deps);
  if (action !== "import") throw new CliUsageError(STORE_USAGE);
  const databaseUrl = process.env.AIS_GATEWAY_DATABASE_URL;
  if (!databaseUrl) throw new CliUsageError("AIS_GATEWAY_DATABASE_URL is required");
  const key = parseStoreKey(process.env[STORE_KEY_ENV]);
  const dryRun = boolFlag(flags, "dry-run");
  const { migrate } = await import("../../gateway/pg-store.ts");
  const { PgHomeStore } = await import("../../gateway/home-store.ts");
  const { importHome } = await import("../../gateway/home-import.ts");
  const { PgRefreshBackend } = await import("../../gateway/pg-refresh-backend.ts");
  if (!dryRun) await migrate(databaseUrl);
  const store = new PgHomeStore(databaseUrl, key, `import:${process.env.HOSTNAME ?? "host"}:${process.pid}`);
  const lock = new PgRefreshBackend(databaseUrl);
  try {
    const r = await importHome(store, { dryRun, lock });
    const verb = dryRun ? "would add" : "added";
    deps.out(`gateway store import: ${r.added.length} ${verb}, ${r.updated.length} ${dryRun ? "would update" : "updated"}, ${r.unchanged.length} unchanged, ${r.skipped.length} kept`);
    for (const p of r.added) deps.out(`  + ${p}`);
    for (const p of r.updated) deps.out(`  ~ ${p}`);
    for (const k of r.skipped) deps.out(`  = ${k.path} (${k.why})`);
  } finally {
    await store.close().catch(() => undefined);
    await lock.close().catch(() => undefined);
  }
}

async function runStoreSync(once: boolean, deps: GatewayCliDeps): Promise<void> {
  const { describeHostSync, hostStoreConfig, hostSyncLockPath, hostSyncOnce, startHostSync } = await import("../../gateway/host-sync.ts");
  const cfg = await hostStoreConfig();
  if (!cfg) throw new CliUsageError("No credential store configured on this host: run `ais gateway store setup --key-file=<path>` with the database URL on stdin (or set AIS_GATEWAY_STORE_DATABASE_URL and AIS_GATEWAY_STORE_KEY)");
  if (once) {
    deps.out(describeHostSync(await hostSyncOnce(cfg)));
    return;
  }
  const { acquireDaemonLock, daemonLockState } = await import("../../sync/profile-sync-daemon.ts");
  const lockPath = hostSyncLockPath();
  if (!acquireDaemonLock(lockPath)) throw new CliUsageError("another `ais gateway store sync` is already running on this host");
  const parent = process.ppid;
  const sync = startHostSync(cfg);
  let stop!: () => void;
  const stopped = new Promise<void>((r) => (stop = r));
  process.once("SIGTERM", () => stop());
  process.once("SIGINT", () => stop());
  // Supervised by the profile-sync daemon: when that daemon goes (restart after an update), this child goes too.
  const watch = setInterval(() => {
    if (process.ppid !== parent || daemonLockState(lockPath) === "other") stop();
  }, 5_000);
  try {
    deps.out(describeHostSync(await Promise.race([sync.ready, stopped.then(() => sync.ready)])));
    await stopped;
  } finally {
    clearInterval(watch);
    await sync.stop();
    const { unlinkSync } = await import("node:fs");
    try {
      if (daemonLockState(lockPath) === "mine") unlinkSync(lockPath);
    } catch {
      // already gone
    }
  }
}

async function runStoreSetup(keyFile: string | undefined, deps: GatewayCliDeps): Promise<void> {
  if (!keyFile) throw new CliUsageError("Usage: ais gateway store setup --key-file=<path>  (the database URL is read from stdin, never argv)");
  const { readFile } = await import("node:fs/promises");
  const { homedir } = await import("node:os");
  const { appendSecretsFile, defaultSecretsPath } = await import("./secrets-file.ts");
  const { STORE_DATABASE_URL_KEY } = await import("../../gateway/host-sync.ts");
  const { PgHomeStore } = await import("../../gateway/home-store.ts");
  const databaseUrl = (await Bun.stdin.text()).trim();
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) throw new CliUsageError("stdin must hold the store's postgres:// URL");
  const key = parseStoreKey((await readFile(keyFile.replace(/^~(?=\/)/, homedir()), "utf8")).trim());
  // Prove both before writing anything: the database answers and the newest row decrypts with this key.
  const store = new PgHomeStore(databaseUrl, key, `host-setup:${process.pid}`);
  try {
    const metas = await store.list(0);
    const newest = [...metas].sort((a, b) => b.version - a.version)[0];
    if (newest && (await store.get([newest.path])).length === 0) throw new CliUsageError("the key does not decrypt the store's rows; check --key-file");
    deps.out(`gateway store setup: database reachable, ${metas.length} rows, key decrypts`);
  } finally {
    await store.close().catch(() => undefined);
  }
  await appendSecretsFile(STORE_DATABASE_URL_KEY, databaseUrl);
  await appendSecretsFile(STORE_KEY_ENV, key.toString("base64"));
  deps.out(`gateway store setup: ${STORE_DATABASE_URL_KEY} and ${STORE_KEY_ENV} written to ${defaultSecretsPath()} (backup kept)`);
  const { installProfileSyncService, describeProfileSyncServiceResult } = await import("../../sync/profile-sync-service.ts");
  const r = await installProfileSyncService({ restartIfActive: true });
  const line = describeProfileSyncServiceResult(r);
  if (line) deps.out(line.line);
}
