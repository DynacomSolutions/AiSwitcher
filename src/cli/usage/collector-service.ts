import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";

export const USAGE_COLLECTOR_SERVICE_NAME = "ais-usage-snapshot.service";

export const USAGE_COLLECTOR_UNIT = `[Unit]
Description=AiProfileSwitcher usage snapshot collector

[Service]
Type=simple
ExecStart=%h/.local/bin/ais __usage_snapshot_daemon
Environment=AIS_USAGE_COLLECTOR_MODE=external
Restart=on-failure
RestartSec=5s
MemoryHigh=8G
MemoryMax=12G
MemorySwapMax=512M
CPUQuota=400%
# Backstop: blk-throttle caps the disk holding the cache, so a regression cannot starve other services.
IOReadBandwidthMax=%h 20M
IOWriteBandwidthMax=%h 20M

[Install]
WantedBy=default.target
`;

export interface UsageCollectorServiceOptions {
  /** Unit directory override for isolated tests. */
  unitDirectory?: string;
  /** Installed AIS executable override for isolated tests. */
  aisPath?: string;
  /** Non-starting check for the hidden daemon entrypoint. */
  checkEntrypoint?: (aisPath: string) => Promise<boolean>;
  /** Reload and check the user manager after installing the unit. */
  reloadAndVerify?: (serviceName: string) => Promise<void>;
  /** Enable/start the unit and check its operational state. */
  enableStartAndVerify?: (serviceName: string, restartIfActive: boolean) => Promise<void>;
  /** Restart an active daemon after a full install replaces the ais binary. */
  restartIfActive?: boolean;
  /** Platform override for isolated tests. */
  platform?: NodeJS.Platform;
}

export interface FullInstallServiceOptions {
  platform?: NodeJS.Platform;
  aisPath?: string;
  aisBinaryChanged?: boolean;
  checkEntrypoint?: (aisPath: string) => Promise<boolean>;
  hasManager?: () => Promise<boolean>;
  install?: (aisPath: string, aisBinaryChanged: boolean) => Promise<{ path: string; changed: boolean }>;
}

export type FullInstallServiceResult =
  | { status: "not-linux" | "unsupported-entrypoint" | "no-user-manager" }
  | { status: "installed" | "verified"; path: string; changed: boolean };

async function checkInstalledEntrypoint(aisPath: string): Promise<boolean> {
  try {
    const child = Bun.spawn([aisPath, "__usage_snapshot_daemon", "--check"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await child.exited) === 0;
  } catch {
    return false;
  }
}

export async function installedUsageCollectorSupported(
  aisPath = join(homedir(), ".local", "bin", "ais"),
): Promise<boolean> {
  return checkInstalledEntrypoint(aisPath);
}

async function reloadAndVerifyUserUnit(serviceName: string): Promise<void> {
  const reload = Bun.spawn(["systemctl", "--user", "daemon-reload"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const [reloadCode, reloadError] = await Promise.all([
    reload.exited,
    new Response(reload.stderr).text(),
  ]);
  if (reloadCode !== 0) {
    throw new Error(`systemctl --user daemon-reload failed: ${reloadError.trim() || `exit ${reloadCode}`}`);
  }

  const verify = Bun.spawn(["systemctl", "--user", "show", "--property=LoadState", "--value", serviceName], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [verifyCode, state, verifyError] = await Promise.all([
    verify.exited,
    new Response(verify.stdout).text(),
    new Response(verify.stderr).text(),
  ]);
  if (verifyCode !== 0 || state.trim() !== "loaded") {
    throw new Error(`systemd did not load ${serviceName}: ${verifyError.trim() || state.trim() || `exit ${verifyCode}`}`);
  }
}

async function enableStartAndVerifyUserUnit(serviceName: string, restartIfActive: boolean): Promise<void> {
  const enable = Bun.spawn(["systemctl", "--user", "enable", serviceName], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const [enableCode, enableError] = await Promise.all([
    enable.exited,
    new Response(enable.stderr).text(),
  ]);
  if (enableCode !== 0) {
    throw new Error(`systemctl --user enable ${serviceName} failed: ${enableError.trim() || `exit ${enableCode}`}`);
  }

  const active = Bun.spawn(["systemctl", "--user", "show", "--property=ActiveState", "--value", serviceName], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [activeCode, activeState, activeError] = await Promise.all([
    active.exited,
    new Response(active.stdout).text(),
    new Response(active.stderr).text(),
  ]);
  if (activeCode !== 0) {
    throw new Error(`could not inspect ${serviceName} state: ${activeError.trim() || `exit ${activeCode}`}`);
  }

  const isActive = activeState.trim() === "active";
  const action = isActive ? (restartIfActive ? "restart" : undefined) : "start";
  if (action) {
    const start = Bun.spawn(["systemctl", "--user", action, serviceName], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    const [startCode, startError] = await Promise.all([
      start.exited,
      new Response(start.stderr).text(),
    ]);
    if (startCode !== 0) {
      throw new Error(`systemctl --user ${action} ${serviceName} failed: ${startError.trim() || `exit ${startCode}`}`);
    }
  }

  for (const [property, expected] of [["UnitFileState", "enabled"], ["ActiveState", "active"]] as const) {
    const check = Bun.spawn(["systemctl", "--user", "show", `--property=${property}`, "--value", serviceName], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, state, error] = await Promise.all([
      check.exited,
      new Response(check.stdout).text(),
      new Response(check.stderr).text(),
    ]);
    if (code !== 0 || state.trim() !== expected) {
      throw new Error(`usage collector service ${property} is ${state.trim() || error.trim() || `exit ${code}`}, expected ${expected}`);
    }
  }
}

/** True when the collector service is installed on this host: its unit file exists (Linux), or a running
 * collector has marked itself as the refresh owner. Hosts without one fall back to live scans. */
export function usageCollectorInstalled(options: { unitDirectory?: string; platform?: NodeJS.Platform; ownsRefreshes?: () => boolean } = {}): boolean {
  if (options.ownsRefreshes?.()) return true;
  if ((options.platform ?? process.platform) !== "linux") return false;
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return existsSync(join(options.unitDirectory ?? join(configHome, "systemd", "user"), USAGE_COLLECTOR_SERVICE_NAME));
}

/** True when this login has a reachable user systemd manager. */
export async function hasUserSystemdManager(): Promise<boolean> {
  try {
    const child = Bun.spawn(["systemctl", "--user", "show-environment"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await child.exited) === 0;
  } catch {
    return false;
  }
}

/** Configure the durable service when a full install has a supported entrypoint
 * and a reachable user manager. Unsupported hosts receive an explicit fallback. */
export async function configureUsageCollectorServiceForFullInstall(
  options: FullInstallServiceOptions = {},
): Promise<FullInstallServiceResult> {
  if ((options.platform ?? process.platform) !== "linux") return { status: "not-linux" };

  const aisPath = options.aisPath ?? join(homedir(), ".local", "bin", "ais");
  if (!(await (options.checkEntrypoint ?? checkInstalledEntrypoint)(aisPath))) {
    return { status: "unsupported-entrypoint" };
  }
  if (!(await (options.hasManager ?? hasUserSystemdManager)())) return { status: "no-user-manager" };

  const result = await (options.install ?? ((path, aisBinaryChanged) => installUsageCollectorService({
    aisPath: path,
    restartIfActive: aisBinaryChanged,
  })))(aisPath, options.aisBinaryChanged ?? false);
  return { status: result.changed ? "installed" : "verified", ...result };
}

/** Atomically installs, verifies, enables, and starts the per-user service. */
export async function installUsageCollectorService(
  options: UsageCollectorServiceOptions = {},
): Promise<{ path: string; changed: boolean }> {
  if ((options.platform ?? process.platform) !== "linux") {
    throw new Error("usage collector service installation is available on Linux only");
  }

  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const unitDirectory = options.unitDirectory ?? join(configHome, "systemd", "user");
  const aisPath = options.aisPath ?? join(homedir(), ".local", "bin", "ais");
  const supported = await (options.checkEntrypoint ?? checkInstalledEntrypoint)(aisPath);
  if (!supported) {
    throw new Error(`installed AIS at ${aisPath} does not support the usage snapshot daemon`);
  }

  await mkdir(unitDirectory, { recursive: true });
  const path = join(unitDirectory, USAGE_COLLECTOR_SERVICE_NAME);
  const current = await readFile(path, "utf8").catch(() => undefined);
  const currentMode = await stat(path).then((info) => info.mode & 0o777, () => undefined);
  const changed = current !== USAGE_COLLECTOR_UNIT || currentMode !== 0o644;

  if (changed) {
    const temporaryDirectory = await mkdtemp(join(unitDirectory, ".ais-usage-service-"));
    const temporaryPath = join(temporaryDirectory, USAGE_COLLECTOR_SERVICE_NAME);
    try {
      await writeFile(temporaryPath, USAGE_COLLECTOR_UNIT, { encoding: "utf8", mode: 0o644 });
      await chmod(temporaryPath, 0o644);
      await rename(temporaryPath, path);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  const verified = await readFile(path, "utf8");
  if (verified !== USAGE_COLLECTOR_UNIT) {
    throw new Error(`installed usage collector unit did not verify at ${path}`);
  }
  await (options.reloadAndVerify ?? reloadAndVerifyUserUnit)(USAGE_COLLECTOR_SERVICE_NAME);
  await (options.enableStartAndVerify ?? enableStartAndVerifyUserUnit)(
    USAGE_COLLECTOR_SERVICE_NAME,
    changed || (options.restartIfActive ?? false),
  );
  return { path, changed };
}
