import { homedir } from "node:os";
import { join } from "node:path";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { LOCAL_GATEWAY_DEFAULT_PORT, LOCAL_STATUS_PATH, type LocalGatewayStatus } from "../../gateway/local.ts";
import { enableStartAndVerifyUserUnit, reloadAndVerifyUserUnit } from "../usage/collector-service.ts";

export const LOCAL_GATEWAY_SERVICE_NAME = "ais-gateway-local.service";

export const LOCAL_GATEWAY_UNIT = `[Unit]
Description=AiProfileSwitcher local AI gateway failover proxy (127.0.0.1)
# Herdr panes start agent sessions that point at this proxy: it must be up first.
Before=herdr-host.service herdr-session-restore.service

[Service]
Type=simple
ExecStart=%h/.local/bin/ais gateway local
# Ready only once the port listens, so units ordered After= this one (Herdr) never race the proxy. $$ is systemd's escape for a literal $.
ExecStartPost=/usr/bin/env bash -c 'p=\$\${AIS_GATEWAY_LOCAL_PORT:-47140}; for i in $$(seq 1 50); do (exec 3<>/dev/tcp/127.0.0.1/$$p) 2>/dev/null && exit 0; sleep 0.1; done; exit 1'
TimeoutStartSec=15s
# The proxy drains on SIGTERM (in-flight streams finish) with no timer of its own; this is only the kill ceiling.
TimeoutStopSec=15min
Restart=always
RestartSec=2s

[Install]
WantedBy=default.target
`;

export interface InstallLocalOptions {
  unitDirectory?: string;
  platform?: NodeJS.Platform;
  reloadAndVerify?: (serviceName: string) => Promise<void>;
  enableStartAndVerify?: (serviceName: string, restartIfActive: boolean) => Promise<void>;
  /** Restart an active proxy even when the unit text is unchanged (the ais binary was replaced). */
  restartIfActive?: boolean;
  /** Release/host-update mode: enable and start only on first install; afterwards never re-enable, restart only an active unit. */
  respectDisabled?: boolean;
  isActive?: (serviceName: string) => Promise<boolean>;
  restart?: (serviceName: string) => Promise<void>;
}

async function systemctlUser(args: string[]): Promise<{ code: number; out: string }> {
  const child = Bun.spawn(["systemctl", "--user", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  return { code, out: out.trim() };
}
const unitActive = async (name: string): Promise<boolean> => (await systemctlUser(["is-active", name])).out === "active";
const unitRestart = async (name: string): Promise<void> => {
  const r = await systemctlUser(["restart", name]);
  if (r.code !== 0) throw new Error(`systemctl --user restart ${name} failed`);
};

/** Atomically writes, enables and starts the per-user unit (same flow as the usage collector unit). */
export async function installLocalGatewayService(options: InstallLocalOptions = {}): Promise<{ path: string; changed: boolean }> {
  if ((options.platform ?? process.platform) !== "linux") throw new Error("local gateway service installation is available on Linux only");
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const dir = options.unitDirectory ?? join(configHome, "systemd", "user");
  await mkdir(dir, { recursive: true });
  const path = join(dir, LOCAL_GATEWAY_SERVICE_NAME);
  const current = await readFile(path, "utf8").catch(() => undefined);
  const existed = current !== undefined;
  const mode = await stat(path).then((s) => s.mode & 0o777, () => undefined);
  const changed = current !== LOCAL_GATEWAY_UNIT || mode !== 0o644;
  if (changed) {
    const tmpDir = await mkdtemp(join(dir, ".ais-gateway-local-"));
    const tmp = join(tmpDir, LOCAL_GATEWAY_SERVICE_NAME);
    try {
      await writeFile(tmp, LOCAL_GATEWAY_UNIT, { encoding: "utf8", mode: 0o644 });
      await chmod(tmp, 0o644);
      await rename(tmp, path);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }
  await (options.reloadAndVerify ?? reloadAndVerifyUserUnit)(LOCAL_GATEWAY_SERVICE_NAME);
  if (options.respectDisabled && existed) {
    // A unit the user disabled or stopped stays that way; an active one picks up a new binary or unit text.
    if ((changed || (options.restartIfActive ?? false)) && (await (options.isActive ?? unitActive)(LOCAL_GATEWAY_SERVICE_NAME))) await (options.restart ?? unitRestart)(LOCAL_GATEWAY_SERVICE_NAME);
    return { path, changed };
  }
  await (options.enableStartAndVerify ?? enableStartAndVerifyUserUnit)(LOCAL_GATEWAY_SERVICE_NAME, changed || (options.restartIfActive ?? false));
  return { path, changed };
}

/** The running proxy's state, or undefined when nothing answers on the port. */
export async function fetchLocalStatus(port = Number(process.env.AIS_GATEWAY_LOCAL_PORT) || LOCAL_GATEWAY_DEFAULT_PORT, doFetch: typeof fetch = fetch): Promise<LocalGatewayStatus | undefined> {
  try {
    const res = await doFetch(`http://127.0.0.1:${port}${LOCAL_STATUS_PATH}`, { signal: AbortSignal.timeout(1_500) });
    if (!res.ok) return undefined;
    return (await res.json()) as LocalGatewayStatus;
  } catch {
    return undefined;
  }
}
