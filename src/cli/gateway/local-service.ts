import { homedir } from "node:os";
import { join } from "node:path";
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { LOCAL_GATEWAY_DEFAULT_PORT, LOCAL_STATUS_PATH, type LocalGatewayStatus } from "../../gateway/local.ts";

/** Two slots of one template unit. Exactly one is enabled and active; a release starts the other, waits until it listens, then drains the first. */
export const LOCAL_GATEWAY_TEMPLATE_NAME = "ais-gateway-local@.service";
export const LOCAL_GATEWAY_LEGACY_NAME = "ais-gateway-local.service";
export const LOCAL_GATEWAY_SLOTS = ["a", "b"] as const;
export type LocalSlot = (typeof LOCAL_GATEWAY_SLOTS)[number];
export const localSlotUnit = (slot: LocalSlot): string => `ais-gateway-local@${slot}.service`;

export const LOCAL_GATEWAY_UNIT = `[Unit]
Description=AiProfileSwitcher local AI gateway failover proxy (127.0.0.1), slot %i
# Herdr panes start agent sessions that point at this proxy: it must be up first.
Before=herdr-host.service herdr-session-restore.service

[Service]
Type=simple
Environment=AIS_GATEWAY_LOCAL_INSTANCE=%i
ExecStart=%h/.local/bin/ais gateway local
# Ready only once the port listens, so units ordered After= this one (Herdr) never race the proxy. $$ is systemd's escape for a literal $.
ExecStartPost=/usr/bin/env bash -c 'p=\$\${AIS_GATEWAY_LOCAL_PORT:-47140}; for i in $$(seq 1 150); do (exec 3<>/dev/tcp/127.0.0.1/$$p) 2>/dev/null && exit 0; sleep 0.1; done; exit 1'
TimeoutStartSec=30s
# The proxy drains on SIGTERM (in-flight streams finish) with no timer of its own; this is only the kill ceiling.
TimeoutStopSec=15min
Restart=always
RestartSec=2s

[Install]
WantedBy=default.target
`;

export interface Ctl {
  (args: string[]): Promise<{ code: number; out: string }>;
}

export const systemctlUser: Ctl = async (args) => {
  const child = Bun.spawn(["systemctl", "--user", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  return { code, out: out.trim() };
};

export interface InstallLocalOptions {
  unitDirectory?: string;
  platform?: NodeJS.Platform;
  ctl?: Ctl;
  /** Resolves once `slot` answers on the port (default: polls the status endpoint for its instance). */
  waitListening?: (slot: LocalSlot) => Promise<void>;
  /** The unit text or the ais binary changed: hand the running instance over to the other slot. */
  restartIfActive?: boolean;
  /** Release/host-update mode: enable and start only on a first install; never re-enable what the user disabled. */
  respectDisabled?: boolean;
}

const MIGRATE_WAIT_MS = 30_000;

async function defaultWaitListening(slot: LocalSlot): Promise<void> {
  const port = Number(process.env.AIS_GATEWAY_LOCAL_PORT) || LOCAL_GATEWAY_DEFAULT_PORT;
  const deadline = Date.now() + MIGRATE_WAIT_MS;
  while (Date.now() < deadline) {
    // Both slots share the port during a handoff, so keep asking (fresh connections) until the new one answers.
    for (let i = 0; i < 20; i++) {
      const st = await fetchLocalStatus(port, fetch, true);
      if (st?.instance === slot) return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${localSlotUnit(slot)} did not start listening`);
}

async function atomicWrite(dir: string, name: string, text: string): Promise<boolean> {
  const path = join(dir, name);
  const current = await readFile(path, "utf8").catch(() => undefined);
  const mode = await stat(path).then((s) => s.mode & 0o777, () => undefined);
  if (current === text && mode === 0o644) return false;
  const tmpDir = await mkdtemp(join(dir, ".ais-gateway-local-"));
  const tmp = join(tmpDir, name);
  try {
    await writeFile(tmp, text, { encoding: "utf8", mode: 0o644 });
    await chmod(tmp, 0o644);
    await rename(tmp, path);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
  return true;
}

/**
 * Installs the template unit and starts or hands over the proxy without ever closing the port:
 * - first install: enable and start slot a;
 * - upgrade with the proxy running: start the other slot, wait until it listens, enable it, then stop the old slot
 *   (non-blocking; it drains its in-flight streams) and disable it;
 * - migration from the single ais-gateway-local.service: only after the new slot listens, the old unit is disabled and
 *   removed together with its drop-ins (the old process is told to stop first because it does not share the port, so
 *   this one hop has a gap of the old process's exit; the new slot keeps retrying the bind meanwhile).
 */
export async function installLocalGatewayService(options: InstallLocalOptions = {}): Promise<{ path: string; changed: boolean; slot?: LocalSlot; action: string }> {
  if ((options.platform ?? process.platform) !== "linux") throw new Error("local gateway service installation is available on Linux only");
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const dir = options.unitDirectory ?? join(configHome, "systemd", "user");
  const ctl = options.ctl ?? systemctlUser;
  const wait = options.waitListening ?? defaultWaitListening;
  await mkdir(dir, { recursive: true });
  const path = join(dir, LOCAL_GATEWAY_TEMPLATE_NAME);
  const existedBefore = await stat(path).then(() => true, () => false);
  const changed = await atomicWrite(dir, LOCAL_GATEWAY_TEMPLATE_NAME, LOCAL_GATEWAY_UNIT);
  const reload = await ctl(["daemon-reload"]);
  if (reload.code !== 0) throw new Error("systemctl --user daemon-reload failed");

  const active = async (unit: string): Promise<boolean> => (await ctl(["is-active", unit])).out === "active";
  const enabled = async (unit: string): Promise<boolean> => (await ctl(["is-enabled", unit])).out === "enabled";
  const activeSlots: LocalSlot[] = [];
  const enabledSlots: LocalSlot[] = [];
  for (const slot of LOCAL_GATEWAY_SLOTS) {
    if (await active(localSlotUnit(slot))) activeSlots.push(slot);
    if (await enabled(localSlotUnit(slot))) enabledSlots.push(slot);
  }
  const legacyPath = join(dir, LOCAL_GATEWAY_LEGACY_NAME);
  const legacyExists = await stat(legacyPath).then(() => true, () => false);
  const legacyActive = legacyExists && (await active(LOCAL_GATEWAY_LEGACY_NAME));

  const start = async (slot: LocalSlot): Promise<void> => {
    const r = await ctl(["start", localSlotUnit(slot)]);
    if (r.code !== 0) throw new Error(`systemctl --user start ${localSlotUnit(slot)} failed`);
    await wait(slot);
  };
  const enable = async (slot: LocalSlot): Promise<void> => void (await ctl(["enable", localSlotUnit(slot)]));
  const retireLegacy = async (): Promise<void> => {
    await ctl(["disable", LOCAL_GATEWAY_LEGACY_NAME]);
    await rm(legacyPath, { force: true });
    const dropins = join(dir, `${LOCAL_GATEWAY_LEGACY_NAME}.d`);
    for (const f of await readdir(dropins).catch(() => [] as string[])) await rm(join(dropins, f), { force: true });
    await rmdir(dropins).catch(() => undefined);
    await ctl(["daemon-reload"]);
  };

  // Migration from the single unit.
  if (legacyExists) {
    const slot: LocalSlot = activeSlots[0] ?? "a";
    if (legacyActive) await ctl(["stop", "--no-block", LOCAL_GATEWAY_LEGACY_NAME]);
    if (!activeSlots.includes(slot)) await start(slot);
    await enable(slot);
    await retireLegacy();
    return { path, changed, slot, action: "migrated" };
  }

  if (activeSlots.length === 0) {
    // Nothing running. A release respects a unit the user disabled; an explicit install or a first install enables it.
    if (options.respectDisabled && existedBefore) return { path, changed, action: "left-alone" };
    const slot: LocalSlot = enabledSlots[0] ?? "a";
    await enable(slot);
    await start(slot);
    return { path, changed, slot, action: "started" };
  }

  const current = activeSlots[0] as LocalSlot;
  if (!(changed || (options.restartIfActive ?? false))) return { path, changed, slot: current, action: "unchanged" };
  // Handoff: the new instance listens (sharing the port) before the old one is told to drain.
  const next: LocalSlot = current === "a" ? "b" : "a";
  await start(next);
  await enable(next);
  await ctl(["stop", "--no-block", localSlotUnit(current)]);
  await ctl(["disable", localSlotUnit(current)]);
  return { path, changed, slot: next, action: "handed-over" };
}

/** The running proxy's state (whichever instance answers), or undefined when nothing answers on the port. */
export async function fetchLocalStatus(port = Number(process.env.AIS_GATEWAY_LOCAL_PORT) || LOCAL_GATEWAY_DEFAULT_PORT, doFetch: typeof fetch = fetch, fresh = false): Promise<LocalGatewayStatus | undefined> {
  try {
    const res = await doFetch(`http://127.0.0.1:${port}${LOCAL_STATUS_PATH}`, { signal: AbortSignal.timeout(1_500), ...(fresh ? { headers: { connection: "close" } } : {}) });
    if (!res.ok) return undefined;
    return (await res.json()) as LocalGatewayStatus;
  } catch {
    return undefined;
  }
}
