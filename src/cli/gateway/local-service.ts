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
  /** Resolves once `slot` answers on the port (default: polls the status endpoint for its instance); rejects on timeout. */
  waitListening?: (slot: LocalSlot, port?: number) => Promise<void>;
  /** Which slot currently answers on the port (default: the status endpoint's instance); used when both slots are active. */
  answeringInstance?: () => Promise<string | undefined>;
  /** Proves the installed binary can serve (default: `<ais> gateway local --check`). Rejects or returns false when it cannot. */
  preflight?: () => Promise<boolean>;
  /** The unit text or the ais binary changed: hand the running instance over to the other slot. */
  restartIfActive?: boolean;
  /** Release/host-update mode: enable and start only on a first install; never re-enable what the user disabled. */
  respectDisabled?: boolean;
  log?: (line: string) => void;
  /** Unit name base (default ais-gateway-local); for proofs on throwaway names. */
  unitBase?: string;
  /** Unit text override (default LOCAL_GATEWAY_UNIT); for proofs. */
  unitText?: string;
}

const MIGRATE_WAIT_MS = 30_000;

/** Runs `<ais> gateway local --check` (port 0, bounded): exit 0 means the subcommand exists and its config loads. An older binary without --check would start serving, so the bound kills it and counts as a failure. */
async function defaultPreflight(): Promise<boolean> {
  const aisPath = join(homedir(), ".local", "bin", "ais");
  try {
    const child = Bun.spawn([aisPath, "gateway", "local", "--check"], { stdin: "ignore", stdout: "ignore", stderr: "ignore", env: { ...process.env, AIS_GATEWAY_LOCAL_PORT: "0" } });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    const code = await child.exited;
    clearTimeout(timer);
    return code === 0;
  } catch {
    return false;
  }
}

async function defaultWaitListening(slot: LocalSlot, unitPort?: number): Promise<void> {
  // The port the unit will actually use (a carried override), else the installer's own setting, else the default.
  const port = unitPort ?? (Number(process.env.AIS_GATEWAY_LOCAL_PORT) || LOCAL_GATEWAY_DEFAULT_PORT);
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

export interface UnitNames {
  template: string;
  legacy: string;
  slot(slot: LocalSlot): string;
}

/** Unit names for a base ("ais-gateway-local" in production; a throwaway base lets a proof run beside the real unit). */
export function unitNames(base = "ais-gateway-local"): UnitNames {
  return { template: `${base}@.service`, legacy: `${base}.service`, slot: (slot) => `${base}@${slot}.service` };
}

/** Directives that move to the template drop-in unchanged and in order (a bare `Environment=` resets and is kept in place). */
const CARRIED = new Set(["Environment", "EnvironmentFile", "UnsetEnvironment"]);

/**
 * Carries Environment=, EnvironmentFile= and UnsetEnvironment= from the legacy unit's drop-ins into the template drop-in, in order,
 * with backslash continuations joined and no dedupe. ExecStart is dropped (the template owns the command) with one log line, and every
 * other directive is dropped with one log line naming it. Returns the AIS_GATEWAY_LOCAL_PORT the carried lines set, if any.
 */
async function carryLegacyDropins(dir: string, names: UnitNames, log: (line: string) => void): Promise<{ port?: number }> {
  const dropins = join(dir, `${names.legacy}.d`);
  const carried: string[] = [];
  const dropped = new Set<string>();
  let port: number | undefined;
  for (const f of (await readdir(dropins).catch(() => [] as string[])).sort()) {
    const text = (await readFile(join(dropins, f), "utf8").catch(() => "")).replace(/\s*\\\r?\n\s*/g, " ");
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (line === "" || line.startsWith("#") || line.startsWith(";") || line.startsWith("[")) continue;
      const name = line.split("=")[0]?.trim() ?? "";
      if (CARRIED.has(name)) {
        carried.push(line);
        if (name === "Environment") {
          if (/^Environment=\s*$/.test(line)) port = undefined;
          else {
            const m = /AIS_GATEWAY_LOCAL_PORT=(\d+)/.exec(line);
            if (m) port = Number(m[1]);
          }
        }
      } else dropped.add(name);
    }
  }
  if (dropped.delete("ExecStart")) log("gateway local: an ExecStart override in the old unit's drop-ins was dropped (the template owns the command)");
  for (const name of [...dropped].sort()) log(`gateway local: the old unit's drop-in directive ${name}= was not carried over`);
  if (carried.length > 0) {
    const target = join(dir, `${names.template}.d`);
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "legacy-migrated.conf"), `[Service]\n${carried.join("\n")}\n`, { mode: 0o644 });
  }
  return port === undefined ? {} : { port };
}

/**
 * Installs the template unit and starts or hands over the proxy without closing the port:
 * - first install: enable and start slot a;
 * - upgrade with the proxy running: start the other slot, wait until it answers, enable it, then stop the old slot
 *   (non-blocking; it drains its in-flight streams) and disable it. A slot still draining is never the target: the
 *   handoff is skipped and the next install converges;
 * - every install ends by converging: exactly one slot enabled, and it is the active one;
 * - migration from the single ais-gateway-local.service: preflight the binary, start the new slot, stop the legacy unit
 *   only once the slot answers, and on any failure start the legacy unit again and stop and disable the slot. The legacy
 *   unit and its drop-ins are removed last (Environment= lines move to a template drop-in).
 */
export async function installLocalGatewayService(options: InstallLocalOptions = {}): Promise<{ path: string; changed: boolean; slot?: LocalSlot; action: string }> {
  if ((options.platform ?? process.platform) !== "linux") throw new Error("local gateway service installation is available on Linux only");
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const dir = options.unitDirectory ?? join(configHome, "systemd", "user");
  const ctl = options.ctl ?? systemctlUser;
  const wait = options.waitListening ?? defaultWaitListening;
  const names = unitNames(options.unitBase);
  const unitText = options.unitText ?? LOCAL_GATEWAY_UNIT;
  const log = options.log ?? ((line: string) => console.error(line));
  await mkdir(dir, { recursive: true });
  const path = join(dir, names.template);
  const existedBefore = await stat(path).then(() => true, () => false);
  const changed = await atomicWrite(dir, names.template, unitText);
  const must = async (args: string[]): Promise<void> => {
    const r = await ctl(args);
    if (r.code !== 0) throw new Error(`systemctl --user ${args.join(" ")} failed`);
  };
  const soft = async (args: string[]): Promise<void> => {
    const r = await ctl(args);
    if (r.code !== 0) log(`gateway local: systemctl --user ${args.join(" ")} failed (exit ${r.code})`);
  };
  await must(["daemon-reload"]);

  type State = "active" | "deactivating" | "idle";
  const stateOf = async (unit: string): Promise<State> => {
    const out = (await ctl(["is-active", unit])).out;
    return out === "active" ? "active" : out === "deactivating" ? "deactivating" : "idle";
  };
  const isEnabled = async (unit: string): Promise<boolean> => (await ctl(["is-enabled", unit])).out === "enabled";
  const states = {} as Record<LocalSlot, State>;
  for (const slot of LOCAL_GATEWAY_SLOTS) states[slot] = await stateOf(names.slot(slot));
  const activeSlots = LOCAL_GATEWAY_SLOTS.filter((s) => states[s] === "active");
  const freeSlots = LOCAL_GATEWAY_SLOTS.filter((s) => states[s] === "idle");

  /**
   * Leaves exactly one slot enabled, the active one. With respectDisabled a slot the user disabled is never re-enabled.
   * With both slots active, the one that answers on the port is kept and the other drains and is disabled; if neither answers, nothing is touched.
   */
  const converge = async (): Promise<void> => {
    const active: LocalSlot[] = [];
    for (const slot of LOCAL_GATEWAY_SLOTS) if ((await stateOf(names.slot(slot))) === "active") active.push(slot);
    let keep: LocalSlot | undefined = active.length === 1 ? active[0] : undefined;
    if (active.length === 2) {
      const answering = await (options.answeringInstance ?? (async () => (await fetchLocalStatus(undefined, fetch, true))?.instance))().catch(() => undefined);
      keep = active.find((s) => s === answering);
      if (!keep) {
        log("gateway local: both slots are active and neither answers on the port; nothing was changed");
        return;
      }
      const other = active.find((s) => s !== keep) as LocalSlot;
      await soft(["stop", "--no-block", names.slot(other)]);
    }
    if (!keep) return;
    for (const slot of LOCAL_GATEWAY_SLOTS) {
      const enabled = await isEnabled(names.slot(slot));
      if (slot === keep && !enabled && !options.respectDisabled) await soft(["enable", names.slot(slot)]);
      if (slot !== keep && enabled) await soft(["disable", names.slot(slot)]);
    }
  };
  /** Stops and disables a slot that did not come up; best effort, never throws. */
  const abandon = async (slot: LocalSlot): Promise<void> => {
    if (activeSlots.includes(slot)) return; // it was running before this install: never stop it
    await ctl(["stop", names.slot(slot)]).catch(() => undefined);
    await ctl(["disable", names.slot(slot)]).catch(() => undefined);
  };
  const startAndWait = async (slot: LocalSlot, port?: number): Promise<void> => {
    await must(["start", names.slot(slot)]);
    await wait(slot, port);
  };

  const legacyPath = join(dir, names.legacy);
  const legacyExists = await stat(legacyPath).then(() => true, () => false);
  if (legacyExists) {
    const legacyActive = (await stateOf(names.legacy)) === "active";
    const legacyEnabled = await isEnabled(names.legacy);
    let carried = false;
    let unitPort: number | undefined;
    const carry = async (): Promise<void> => {
      if (carried) return;
      carried = true;
      unitPort = (await carryLegacyDropins(dir, names, log)).port;
    };
    const retireLegacy = async (): Promise<void> => {
      await carry();
      await ctl(["disable", names.legacy]);
      await rm(legacyPath, { force: true });
      const dropins = join(dir, `${names.legacy}.d`);
      for (const f of await readdir(dropins).catch(() => [] as string[])) await rm(join(dropins, f), { force: true });
      await rmdir(dropins).catch(() => undefined);
      await must(["daemon-reload"]);
    };
    // A legacy unit the user disabled or stopped is retired without starting anything.
    if (options.respectDisabled && (!legacyActive || !legacyEnabled)) {
      await retireLegacy();
      return { path, changed, action: "retired-legacy" };
    }
    // (a) The installed binary must be able to serve before the legacy unit is touched.
    const ok = await (options.preflight ?? defaultPreflight)().catch(() => false);
    if (!ok) throw new Error("the installed ais cannot serve the local gateway (preflight `gateway local --check` failed); the existing unit was left running");
    const slot: LocalSlot = activeSlots[0] ?? freeSlots[0] ?? "a";
    await carry();
    await must(["daemon-reload"]); // the slot must start with the carried Environment= lines
    let legacyStopped = false;
    const restoreLegacy = async (): Promise<void> => {
      await abandon(slot);
      if (legacyActive && legacyStopped) await ctl(["start", names.legacy]);
      else if (legacyActive && (await stateOf(names.legacy)) !== "active") await ctl(["start", names.legacy]);
    };
    try {
      // (b) Start the slot on the shared port. (c) The legacy unit stays up until the slot answers.
      if (!activeSlots.includes(slot)) await must(["start", names.slot(slot)]);
      try {
        await wait(slot, unitPort);
      } catch (err) {
        if (!legacyActive) throw err;
        // An old legacy process does not share the port (no reusePort): the slot is alive but retrying its bind. Stopping the legacy
        // unit is then the one unavoidable hop; the slot must answer within the wait, or the legacy unit is started again.
        legacyStopped = true;
        await must(["stop", names.legacy]);
        await wait(slot, unitPort);
      }
      await must(["enable", names.slot(slot)]);
    } catch (err) {
      await restoreLegacy();
      throw err;
    }
    if (legacyActive && !legacyStopped) await soft(["stop", "--no-block", names.legacy]);
    await retireLegacy();
    await converge();
    return { path, changed, slot, action: "migrated" };
  }

  if (activeSlots.length === 0) {
    // Nothing running. A release respects a unit the user disabled or stopped; a first or explicit install enables it.
    if (options.respectDisabled && existedBefore) return { path, changed, action: "left-alone" };
    const slot: LocalSlot = freeSlots[0] ?? "a";
    try {
      await must(["enable", names.slot(slot)]);
      await startAndWait(slot);
    } catch (err) {
      await abandon(slot);
      throw err;
    }
    await converge();
    return { path, changed, slot, action: "started" };
  }

  const current = activeSlots[0] as LocalSlot;
  if (!(changed || (options.restartIfActive ?? false))) {
    await converge();
    return { path, changed, slot: current, action: "unchanged" };
  }
  const next: LocalSlot = current === "a" ? "b" : "a";
  if (states[next] !== "idle") {
    // The other slot is still draining an earlier instance: leave the running one alone, the next install converges.
    log(`gateway local: handoff skipped, ${names.slot(next)} is still draining; the running instance stays`);
    await converge();
    return { path, changed, slot: current, action: "handoff-deferred" };
  }
  // Handoff: the new instance answers (sharing the port) before the old one is told to drain.
  const currentEnabled = await isEnabled(names.slot(current));
  try {
    await startAndWait(next);
    if (!options.respectDisabled || currentEnabled) await must(["enable", names.slot(next)]);
  } catch (err) {
    await abandon(next);
    await soft(["enable", names.slot(current)]);
    throw err;
  }
  await soft(["stop", "--no-block", names.slot(current)]);
  await soft(["disable", names.slot(current)]);
  await converge();
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
