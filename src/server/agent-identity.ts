import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { TOOL_CONFIGS, loadAll } from "../cli/identities/resolve-tool.ts";
import { loadGatewayRecentUsage } from "../gateway/usage-view.ts";
import type { ModelUsageRow } from "../gateway/types.ts";
import { expandPath, translateHostPath } from "../identities/match.ts";
import { isGatewayRoutedPool } from "../identities/pool/gateway-pool.ts";
import { isSwapPool, type PoolIdentity } from "../identities/pool/swap-pool.ts";
import { isRetired } from "../identities/retired.ts";
import { findIdentityByNameOrAlias } from "../identities/store.ts";
import type { IdentitiesFile, Identity } from "../identities/types.ts";
import { identityForConfigDir } from "../shared/browser-wiring.ts";
import { scanProcesses } from "./processes.ts";
import type { AgentIdentitySource, AgentInfoDto, ProcessInfoDto, ProcessesDto } from "./types.ts";

/**
 * Who runs each agent. The raw process scan (`processes.ts`) only knows the wrapper's session marker. That marker is a login
 * name for a direct launch, but for a pool it is the folder name (`<tool>-pool` for the T3 pool home), and a process that
 * the wrapper did not start has none. This module turns marker plus config folder into:
 *   - `pool`: the registered swap pool the agent runs through, or null;
 *   - `identity`: the real login now. A direct login is itself. A pool is its member in use now: for a pool routed
 *     through the gateway, the member the gateway served last for this tool (the gateway picks the member per request and
 *     keeps no session id, so this is the best the ledger can say); for a plain pool, the member the registry records
 *     as active (a swap copies that login into the pool folder, so it is the account the folder holds);
 *   - `identitySource`: which of those rules answered.
 */

/** A gateway ledger row counts as "in use now" when it is not older than this. */
export const LEDGER_WINDOW_MS = 15 * 60_000;
/** The ledger read is shared by every scan inside this time. */
const LEDGER_CACHE_MS = 10_000;

/** The gateway app name in a base URL such as `https://host/gateway/agents-claude`, or undefined. */
export function gatewayAppOfUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const m = /\/gateway\/([^/?#]+)/.exec(raw);
  return m ? decodeURIComponent(m[1]!) : undefined;
}

export interface AttributionDeps {
  /** Identity registries keyed by tool name. Default: every registry on disk. */
  files?: () => Promise<Map<string, IdentitiesFile>>;
  /** Gateway ledger rows (with `lastTs`) since the instant, or undefined when the gateway cannot be read. */
  ledger?: (since: Date) => Promise<ModelUsageRow[] | undefined>;
  /** The gateway app a tool folder routes to: a name, "" when routed but unnamed, undefined when not routed. */
  routedApp?: (tool: string, configDir: string, pool: PoolIdentity | undefined) => Promise<string | undefined>;
  now?: () => Date;
  /** Env holding `AIS_HOST_HOME` and the local home, for the host-path translation. Default: this process. */
  host?: { env: Record<string, string | undefined>; localHome?: string };
}

async function defaultFiles(): Promise<Map<string, IdentitiesFile>> {
  const loaded = await loadAll(Object.values(TOOL_CONFIGS));
  return new Map(loaded.map((l) => [l.cfg.toolName, l.file]));
}

async function defaultRoutedApp(tool: string, configDir: string, pool: PoolIdentity | undefined): Promise<string | undefined> {
  if (tool === "claude") {
    try {
      const settings = JSON.parse(await readFile(join(expandPath(configDir), "settings.json"), "utf8")) as { env?: Record<string, unknown> };
      const url = settings.env?.ANTHROPIC_BASE_URL;
      const app = gatewayAppOfUrl(typeof url === "string" ? url : undefined);
      if (app !== undefined) return app;
    } catch {
      // no readable settings: the pool folder check below can still say it is routed
    }
  }
  if (pool) {
    try {
      if (await isGatewayRoutedPool(tool, expandPath(pool.configDir))) return "";
    } catch {
      // unreadable folder: not routed as far as we can tell
    }
  }
  return undefined;
}

/** The tool whose registry an agent belongs to: the one whose config-dir env var the process holds, else its binary. */
function toolOf(p: ProcessInfoDto, hostEnv: Record<string, string | undefined> = process.env, localHome?: string): { tool: string; configDir: string | undefined } | undefined {
  const env = p.identityEnv ?? {};
  for (const [tool, cfg] of Object.entries(TOOL_CONFIGS)) {
    const dir = env[cfg.envVarName];
    // The process env holds a host path. The console pod mounts the host home elsewhere, so translate it before any compare.
    if (dir) return { tool, configDir: translateHostPath(dir, hostEnv, localHome) };
  }
  const tool = p.tool && p.tool in TOOL_CONFIGS ? p.tool : undefined;
  return tool ? { tool, configDir: undefined } : undefined;
}

interface Resolved {
  pool: string | null;
  identity: string | null;
  identitySource: AgentIdentitySource;
}

/** The member a gateway ledger served last for a pool, among the pool's own members, or undefined. */
function lastLedgerMember(rows: ModelUsageRow[], tool: string, pool: PoolIdentity, app: string | undefined, since: number): string | undefined {
  let best: { name: string; at: number } | undefined;
  for (const r of rows) {
    if (r.provider !== tool || !pool.swapPool.accounts.includes(r.identity)) continue;
    if (app && r.app !== app) continue;
    const at = r.lastTs ? Date.parse(r.lastTs) : Number.NaN;
    if (!Number.isFinite(at) || at < since) continue;
    if (!best || at > best.at) best = { name: r.identity, at };
  }
  return best?.name;
}

/** Builds a scanner: `/api/processes` and the agents panel call it. One ledger read is shared by all agents of a scan. */
export function createAgentScanner(deps: AttributionDeps & { scan?: () => Promise<ProcessesDto> } = {}): () => Promise<{ processes: AgentInfoDto[]; scannedAt: string }> {
  const now = deps.now ?? (() => new Date());
  const files = deps.files ?? defaultFiles;
  const routedApp = deps.routedApp ?? defaultRoutedApp;
  const ledger = deps.ledger ?? ((since: Date) => loadGatewayRecentUsage(since).then((v) => (v.configured && !v.error ? v.rows : undefined)));
  let ledgerCache: { at: number; rows: Promise<ModelUsageRow[] | undefined> } | undefined;
  const ledgerRows = (): Promise<ModelUsageRow[] | undefined> => {
    const t = now().getTime();
    if (!ledgerCache || t - ledgerCache.at > LEDGER_CACHE_MS) {
      const since = t - LEDGER_WINDOW_MS;
      ledgerCache = { at: t, rows: ledger(new Date(since)).catch(() => undefined) };
    }
    return ledgerCache.rows;
  };

  return async () => {
    const scanned = await (deps.scan ?? (() => scanProcesses(now())))();
    const registries = await files();
    const since = now().getTime() - LEDGER_WINDOW_MS;
    const processes: AgentInfoDto[] = [];
    for (const p of scanned.processes) {
      const r = await resolve(p, registries, routedApp, ledgerRows, since, deps.host);
      processes.push({ ...p, ...r, sessionIdentity: p.identity });
    }
    return { processes, scannedAt: scanned.scannedAt };
  };
}

async function resolve(
  p: ProcessInfoDto,
  registries: Map<string, IdentitiesFile>,
  routedApp: NonNullable<AttributionDeps["routedApp"]>,
  ledgerRows: () => Promise<ModelUsageRow[] | undefined>,
  since: number,
  host?: AttributionDeps["host"],
): Promise<Resolved> {
  const found = toolOf(p, host?.env, host?.localHome);
  const file = found ? registries.get(found.tool) : undefined;
  if (!found || !file) return p.identity ? { pool: null, identity: p.identity, identitySource: "session-marker" } : { pool: null, identity: null, identitySource: "unresolved" };

  const live = file.identities.filter((i) => !isRetired(i));
  // The marker wins when it names a registered login. A pool or T3 home name (`<tool>-pool`) is not one: the folder decides.
  let reg: Identity | undefined;
  let source: AgentIdentitySource = "config-dir";
  const marked = p.identity ? findIdentityByNameOrAlias(live, p.identity) : undefined;
  if (marked) {
    reg = marked;
    source = "session-marker";
  } else if (found.configDir) {
    reg = identityForConfigDir(file, found.configDir);
  }
  if (!reg) return p.identity ? { pool: null, identity: p.identity, identitySource: "session-marker" } : { pool: null, identity: null, identitySource: "unresolved" };
  if (!isSwapPool(reg)) return { pool: null, identity: reg.name, identitySource: source };

  const pool = reg;
  const app = await routedApp(found.tool, found.configDir ?? pool.configDir, pool);
  if (app !== undefined) {
    const rows = await ledgerRows();
    const member = rows ? lastLedgerMember(rows, found.tool, pool, app || undefined, since) : undefined;
    if (member) return { pool: pool.name, identity: member, identitySource: "gateway-ledger" };
  }
  const active = pool.swapPool.active;
  return active ? { pool: pool.name, identity: active, identitySource: "pool-active" } : { pool: pool.name, identity: null, identitySource: "unresolved" };
}
