import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadIdentitiesFile } from "../../identities/store.ts";
import { t3Paths } from "../../identities/t3-anthropic-proxy.ts";
import { CLAUDE_CONFIG, CODEX_CONFIG } from "../../identities/tool-configs.ts";
import { browserLaunchWiring } from "../../shared/browser-wiring.ts";
import { resolveInstalledAisBinary } from "../../sync/background.ts";
import { boolFlag, type ParsedArgs } from "../args.ts";

export interface WiringRow {
  instance: string;
  tool: "claude" | "codex";
  folder: string;
  /** Identity name, or "pool:<name>" for a swap pool. */
  target: string | null;
  wired: boolean;
  reason?: string;
}

export interface WiringDeps {
  t3Home: string;
  aisBinary: string | undefined;
  registryPath: (tool: "claude" | "codex") => string;
  exists?: (p: string) => boolean;
  real?: (p: string) => string;
  out: (line: string) => void;
}

const DRIVER_TOOL: Record<string, "claude" | "codex"> = { claudeAgent: "claude", codex: "codex" };

const defaultDeps = (): WiringDeps => ({
  t3Home: t3Paths().t3Home,
  aisBinary: resolveInstalledAisBinary(),
  registryPath: (tool) => (tool === "claude" ? CLAUDE_CONFIG : CODEX_CONFIG).identitiesJsonPath,
  out: (line) => console.info(line),
});

async function readInstances(t3Home: string): Promise<Array<{ id: string; tool: "claude" | "codex"; folder: string }>> {
  let settings: unknown;
  try {
    settings = JSON.parse(await readFile(join(t3Home, "userdata", "settings.json"), "utf8"));
  } catch {
    return [];
  }
  const raw = (settings as { providerInstances?: unknown } | null)?.providerInstances;
  if (typeof raw !== "object" || raw === null) return [];
  const found: Array<{ id: string; tool: "claude" | "codex"; folder: string }> = [];
  for (const [id, value] of Object.entries(raw)) {
    const inst = value as { driver?: unknown; enabled?: unknown; config?: { homePath?: unknown } } | null;
    const tool = typeof inst?.driver === "string" ? DRIVER_TOOL[inst.driver] : undefined;
    const folder = inst?.config?.homePath;
    if (!tool || inst?.enabled === false || typeof folder !== "string" || folder === "") continue;
    found.push({ id, tool, folder });
  }
  return found;
}

/** Runs the same wiring steps a T3 launch runs (browserLaunchWiring) for every enabled claude/codex instance. Never prints tokens. */
export async function checkBrowserWiring(deps: WiringDeps = defaultDeps()): Promise<WiringRow[]> {
  const rows: WiringRow[] = [];
  for (const inst of await readInstances(deps.t3Home)) {
    const w = await browserLaunchWiring({
      toolName: inst.tool,
      configDirValue: inst.folder,
      fromEnv: true,
      aisBinary: deps.aisBinary,
      loadFile: () => loadIdentitiesFile(deps.registryPath(inst.tool)),
      ...(deps.exists ? { exists: deps.exists } : {}),
      ...(deps.real ? { real: deps.real } : {}),
      t3Gateway: join(deps.t3Home, "gateway"),
    });
    const target = w.identity ? (w.pool ? `pool:${w.pool.name}` : w.identity.name) : null;
    const wired = w.args.length > 0;
    const reason = wired ? undefined : !w.identity ? "no identity" : deps.aisBinary === undefined ? "ais binary not installed" : "no token";
    rows.push({ instance: inst.id, tool: inst.tool, folder: inst.folder, target, wired, ...(reason ? { reason } : {}) });
  }
  return rows;
}

export async function runBrowserWiring(flags: ParsedArgs["flags"], deps: Partial<WiringDeps> = {}): Promise<{ rows: WiringRow[]; ok: boolean }> {
  const d = { ...defaultDeps(), ...deps };
  const rows = await checkBrowserWiring(d);
  if (boolFlag(flags, "json")) d.out(JSON.stringify(rows, null, 2));
  else for (const r of rows) d.out(`${r.instance}  ${r.folder}  ${r.target ?? "-"}  ${r.wired ? "wired" : `NOT wired: ${r.reason}`}`);
  return { rows, ok: rows.every((r) => r.wired) };
}
