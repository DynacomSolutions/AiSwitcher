/**
 * Puts the AIS relay (src/acp/relay.ts) between T3 Code and its ACP registry agents, so a failed turn shows its reason
 * in the thread instead of an empty, completed turn.
 *
 * T3 Code starts a registry agent from its own install (`<t3Home>/tools/<agent>/<version>/...`). Each provider instance
 * of the `acpRegistry` driver has a `commandPath` setting ("Executable override"): T3 Code then starts that executable
 * with the registry's arguments and environment. This module writes one launcher per agent
 * (`~/.ais/t3/acp/<agentId>`) and sets it as `commandPath` on every instance of that agent in
 * `<t3Home>/userdata/settings.json`. T3 Code watches that file and takes the change for sessions started after it.
 *
 * The launcher starts `ais __acp_relay <agentId> --fallback=<executable> <args>`, which finds the agent's executable in
 * T3 Code's own install record (`<t3Home>/caches/acp-registry/package-installs/<agentId>-*.json`) at each start, and uses
 * the executable known at install time when there is no record. When `ais` is missing, or is a version without the relay
 * (the launcher asks it: `ais __acp_relay --supported`), the launcher starts that executable directly, so the agent
 * always runs.
 *
 * Only instances whose `commandPath` is empty or already this launcher are changed. T3 Code itself is never changed.
 * While the override is set T3 Code does not install a newer version of the agent; `--check` says when the registry
 * has one.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { t3Paths } from "./t3-anthropic-proxy.ts";

/** Registry agents the relay was measured with (docs/agents/gateway.md, "T3 Code ACP agents"). */
export const RELAY_AGENTS = ["kimi-code", "grok-build", "glm-acp-agent"] as const;
export type RelayAgentId = (typeof RELAY_AGENTS)[number];
export const isRelayAgent = (id: string): id is RelayAgentId => (RELAY_AGENTS as readonly string[]).includes(id);

export interface AcpRelayOptions {
  home?: string;
  env?: Record<string, string | undefined>;
  /** The `ais` executable the launchers start. Default: `<home>/.local/bin/ais`. */
  aisPath?: string;
  /** Whether the `ais` at a path has the relay. Default: asks it (`ais __acp_relay --supported`). */
  aisHasRelay?: (aisPath: string) => boolean;
  now?: () => number;
}

export interface AcpRelayPaths {
  settings: string;
  installs: string;
  registry: string;
  backupsDir: string;
  launchers: string;
  ais: string;
}

export function acpRelayPaths(opts: AcpRelayOptions = {}): AcpRelayPaths {
  const home = opts.home ?? homedir();
  const t3 = t3Paths({ home, ...(opts.env ? { env: opts.env } : {}) });
  // Launchers hold paths of one T3 Code folder, so a second folder (T3CODE_HOME) gets its own directory.
  const own = t3.t3Home === join(home, ".t3") ? "acp" : `acp-${createHash("sha256").update(t3.t3Home).digest("hex").slice(0, 8)}`;
  return {
    settings: join(t3.t3Home, "userdata", "settings.json"),
    installs: join(t3.t3Home, "caches", "acp-registry", "package-installs"),
    registry: join(t3.t3Home, "caches", "acp-registry", "registry.json"),
    backupsDir: t3.backupsDir,
    launchers: join(home, ".ais", "t3", own),
    ais: opts.aisPath ?? join(home, ".local", "bin", "ais"),
  };
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);

export interface AgentInstall {
  agentId: string;
  version: string;
  executable: string;
  binDirectory?: string;
}

function compareParts(pa: string[], pb: string[]): number {
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "0";
    const y = pb[i] ?? "0";
    const nx = /^\d+$/.test(x) ? Number(x) : undefined;
    const ny = /^\d+$/.test(y) ? Number(y) : undefined;
    const c = nx !== undefined && ny !== undefined ? nx - ny : x < y ? -1 : x > y ? 1 : 0;
    if (c !== 0) return c;
  }
  return 0;
}

/**
 * Orders versions as semver does: the dotted numbers first (`2.10.0` after `2.9.1`), then a release after its
 * pre-releases (`1.0.0` after `1.0.0-beta`). Build text after `+` is ignored.
 */
export function compareVersions(a: string, b: string): number {
  const split = (v: string): [string[], string[] | undefined] => {
    const [core = "", ...pre] = (v.split("+")[0] as string).split("-");
    return [core.split("."), pre.length > 0 ? pre.join("-").split(".") : undefined];
  };
  const [ca, prea] = split(a);
  const [cb, preb] = split(b);
  const core = compareParts(ca, cb);
  if (core !== 0) return core;
  if (!prea || !preb) return prea ? -1 : preb ? 1 : 0;
  return compareParts(prea, preb);
}

/** The newest install of `agentId` T3 Code recorded whose executable is still there. */
export async function resolveAgentInstall(agentId: string, opts: AcpRelayOptions = {}): Promise<AgentInstall | undefined> {
  const paths = acpRelayPaths(opts);
  let names: string[];
  try {
    names = await readdir(paths.installs);
  } catch {
    return undefined;
  }
  let best: AgentInstall | undefined;
  for (const name of names) {
    if (!name.startsWith(`${agentId}-`) || !name.endsWith(".json")) continue;
    let rec: Json | undefined;
    try {
      rec = obj(JSON.parse(await readFile(join(paths.installs, name), "utf8")));
    } catch {
      continue;
    }
    const executable = str(rec?.executablePath);
    if (!rec || rec.agentId !== agentId || !executable) continue;
    try {
      if (!(await stat(executable)).isFile()) continue;
    } catch {
      continue;
    }
    const binDirectory = str(rec.binDirectory);
    const found: AgentInstall = { agentId, version: str(rec.agentVersion) ?? str(rec.packageVersion) ?? "0", executable, ...(binDirectory ? { binDirectory } : {}) };
    if (!best || compareVersions(found.version, best.version) > 0) best = found;
  }
  return best;
}

/** The version of `agentId` in T3 Code's copy of the ACP registry. */
async function registryVersion(agentId: string, paths: AcpRelayPaths): Promise<string | undefined> {
  try {
    const reg = obj(JSON.parse(await readFile(paths.registry, "utf8")));
    const agents = Array.isArray(reg?.agents) ? reg.agents : [];
    for (const a of agents) if (obj(a)?.id === agentId) return str(obj(a)?.version);
  } catch {
    // no registry copy: nothing to compare with
  }
  return undefined;
}

/** True when the `ais` at `aisPath` answers `__acp_relay --supported` with exit 0, as the launcher asks at each start. */
export function aisHasRelay(aisPath: string): boolean {
  try {
    return spawnSync(aisPath, ["__acp_relay", "--supported"], { stdio: "ignore", timeout: 15_000 }).status === 0;
  } catch {
    return false;
  }
}

const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export function launcherSource(agentId: string, aisPath: string, fallbackExecutable: string): string {
  return [
    "#!/bin/sh",
    `# Written by \`ais gateway t3-acp\`; do not edit. Starts the ACP agent ${agentId} behind the AIS relay, which reports`,
    "# a failed turn to T3 Code as an error with its reason. Without ais, or with an ais that has no relay, the agent",
    "# starts directly.",
    `AIS=${shQuote(aisPath)}`,
    `AGENT=${shQuote(fallbackExecutable)}`,
    `if [ -x "$AIS" ] && "$AIS" __acp_relay --supported >/dev/null 2>&1; then exec "$AIS" __acp_relay ${agentId} "--fallback=$AGENT" "$@"; fi`,
    `exec "$AGENT" "$@"`,
    "",
  ].join("\n");
}

async function writeAtomic(path: string, content: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  await writeFile(temp, content, { mode });
  await chmod(temp, mode);
  await rename(temp, path);
}

interface Instance {
  id: string;
  agentId: RelayAgentId;
  commandPath: string;
  config: Json;
}

/** The `acpRegistry` instances of a relay agent that start from the registry (not a local command). */
function relayInstances(settings: Json): Instance[] {
  const out: Instance[] = [];
  for (const [id, raw] of Object.entries(obj(settings.providerInstances) ?? {})) {
    const inst = obj(raw);
    const config = obj(inst?.config);
    if (!inst || !config || inst.driver !== "acpRegistry" || config.source === "local") continue;
    const agentId = str(config.agentId);
    if (!agentId || !isRelayAgent(agentId)) continue;
    out.push({ id, agentId, commandPath: str(config.commandPath) ?? "", config });
  }
  return out;
}

async function readSettings(paths: AcpRelayPaths): Promise<{ text: string; settings: Json } | undefined> {
  let text: string;
  try {
    text = await readFile(paths.settings, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  const settings = obj(JSON.parse(text));
  if (!settings) throw new Error(`${paths.settings} is not a JSON object`);
  return { text, settings };
}

/** Thrown when T3 Code wrote its settings while this command worked on them; the command then starts again. */
class SettingsChanged extends Error {}

async function retryOnChange<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      if (!(err instanceof SettingsChanged) || attempt >= 5) throw err;
    }
  }
}

async function writeSettings(paths: AcpRelayPaths, before: string, settings: Json, now: number): Promise<string> {
  await mkdir(paths.backupsDir, { recursive: true });
  // A backup is never written over: a second one in the same second gets a suffix.
  const stem = join(paths.backupsDir, `settings.json.pre-acp-relay.${Math.floor(now / 1000)}`);
  let saved = stem;
  for (let n = 1; ; n++) {
    try {
      await writeFile(saved, before, { mode: 0o600, flag: "wx" });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || n > 100) throw err;
      saved = `${stem}.${n}`;
    }
  }
  // T3 Code writes this file too. When it changed since it was read, nothing is written and the caller starts again.
  if ((await readFile(paths.settings, "utf8")) !== before) {
    await rm(saved, { force: true });
    throw new SettingsChanged(`${paths.settings} changed while it was being updated`);
  }
  let mode = 0o600;
  try {
    mode = (await stat(paths.settings)).mode & 0o777;
  } catch {}
  // Keep the file's own layout: its indent and whether it ends with a newline.
  const indent = /^\{\r?\n([ \t]+)"/.exec(before)?.[1] ?? (before.includes("\n") ? 2 : 0);
  await writeAtomic(paths.settings, `${JSON.stringify(settings, null, indent)}${before.endsWith("\n") ? "\n" : ""}`, mode);
  return saved;
}

export interface InstanceResult {
  instance: string;
  agentId: string;
  status: "set" | "current" | "kept" | "no_install" | "removed";
  detail?: string;
}

export interface AcpRelayResult {
  instances: InstanceResult[];
  changed: boolean;
  backup?: string;
}

/** Writes the launchers and sets them as the executable of every relay-agent instance. Idempotent. */
export function installAcpRelay(opts: AcpRelayOptions = {}): Promise<AcpRelayResult> {
  return retryOnChange(() => installOnce(opts));
}

async function installOnce(opts: AcpRelayOptions): Promise<AcpRelayResult> {
  const paths = acpRelayPaths(opts);
  const read = await readSettings(paths);
  if (!read) return { instances: [], changed: false };
  const results: InstanceResult[] = [];
  let changed = false;
  const written = new Set<string>();
  for (const inst of relayInstances(read.settings)) {
    const launcher = join(paths.launchers, inst.agentId);
    if (inst.commandPath !== "" && inst.commandPath !== launcher) {
      results.push({ instance: inst.id, agentId: inst.agentId, status: "kept", detail: `has its own executable override (${inst.commandPath})` });
      continue;
    }
    const install = await resolveAgentInstall(inst.agentId, opts);
    if (!install) {
      results.push({ instance: inst.id, agentId: inst.agentId, status: "no_install", detail: "T3 Code has not installed this agent yet; start it once in T3 Code, then run this again" });
      continue;
    }
    if (!written.has(inst.agentId)) {
      const source = launcherSource(inst.agentId, paths.ais, install.executable);
      const current = await readFile(launcher, "utf8").catch(() => undefined);
      if (current !== source) await writeAtomic(launcher, source, 0o755);
      written.add(inst.agentId);
    }
    if (inst.commandPath === launcher) {
      results.push({ instance: inst.id, agentId: inst.agentId, status: "current" });
      continue;
    }
    inst.config.commandPath = launcher;
    changed = true;
    results.push({ instance: inst.id, agentId: inst.agentId, status: "set" });
  }
  const backup = changed ? await writeSettings(paths, read.text, read.settings, (opts.now ?? Date.now)()) : undefined;
  return { instances: results, changed, ...(backup ? { backup } : {}) };
}

/** Takes the launchers out of T3 Code's settings and deletes them. */
export function removeAcpRelay(opts: AcpRelayOptions = {}): Promise<AcpRelayResult> {
  return retryOnChange(() => removeOnce(opts));
}

async function removeOnce(opts: AcpRelayOptions): Promise<AcpRelayResult> {
  const paths = acpRelayPaths(opts);
  const read = await readSettings(paths);
  const results: InstanceResult[] = [];
  let changed = false;
  if (read) {
    for (const inst of relayInstances(read.settings)) {
      if (inst.commandPath !== join(paths.launchers, inst.agentId)) continue;
      delete inst.config.commandPath;
      changed = true;
      results.push({ instance: inst.id, agentId: inst.agentId, status: "removed" });
    }
  }
  const backup = read && changed ? await writeSettings(paths, read.text, read.settings, (opts.now ?? Date.now)()) : undefined;
  await rm(paths.launchers, { recursive: true, force: true });
  return { instances: results, changed, ...(backup ? { backup } : {}) };
}

/** What is not as `installAcpRelay` would leave it, one line each. Empty when all is in place. */
export async function checkAcpRelay(opts: AcpRelayOptions = {}): Promise<string[]> {
  const paths = acpRelayPaths(opts);
  const read = await readSettings(paths);
  if (!read) return [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const inst of relayInstances(read.settings)) {
    const launcher = join(paths.launchers, inst.agentId);
    if (inst.commandPath !== launcher) {
      problems.push(inst.commandPath === "" ? `${inst.id} (${inst.agentId}): the relay is not set` : `${inst.id} (${inst.agentId}): has its own executable override, the relay is not used`);
      continue;
    }
    if (seen.has(inst.agentId)) continue;
    seen.add(inst.agentId);
    const install = await resolveAgentInstall(inst.agentId, opts);
    if (!install) {
      problems.push(`${inst.agentId}: T3 Code's install of the agent is missing; the launcher cannot start it`);
      continue;
    }
    const source = await readFile(launcher, "utf8").catch(() => undefined);
    if (source !== launcherSource(inst.agentId, paths.ais, install.executable)) problems.push(`${inst.agentId}: the launcher ${launcher} is missing or out of date`);
    let aisThere = false;
    try {
      aisThere = (await stat(paths.ais)).isFile();
    } catch {}
    if (!aisThere) problems.push(`${inst.agentId}: ${paths.ais} is missing, so the agent starts without the relay`);
    else if (!(opts.aisHasRelay ?? aisHasRelay)(paths.ais)) problems.push(`${inst.agentId}: ${paths.ais} is a version without the relay, so the agent starts without it (ais update)`);
    const latest = await registryVersion(inst.agentId, paths);
    if (latest && compareVersions(latest, install.version) > 0) {
      problems.push(`${inst.agentId}: version ${install.version} is installed and the registry has ${latest}; T3 Code does not update an agent with an executable override (ais gateway t3-acp --remove, start the agent once in T3 Code, then ais gateway t3-acp)`);
    }
  }
  return problems;
}
