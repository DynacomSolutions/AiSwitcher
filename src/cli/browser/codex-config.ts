import { chmod, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isOtherProviderName } from "../../browser/headers.ts";
import { expandPath } from "../../identities/match.ts";
import { loadIdentitiesFile } from "../../identities/store.ts";
import { t3Paths } from "../../identities/t3-anthropic-proxy.ts";
import { CODEX_CONFIG } from "../../identities/tool-configs.ts";
import { resolveInstalledAisBinary } from "../../sync/background.ts";
import { readSecretsKey } from "../gateway/secrets-file.ts";
import { boolFlag, type ParsedArgs } from "../args.ts";
import { CliUsageError } from "../errors.ts";

const BEGIN = "# >>> ais-browser (managed by ais browser codex-config) >>>";
const END = "# <<< ais-browser <<<";
/** Longest relay call (wait: 120 s) plus margin. */
const TOOL_TIMEOUT_SEC = 135;

export interface CodexConfigDeps {
  gatewayUrl: () => Promise<string | undefined>;
  aisBinary: () => string | undefined;
  /** Codex folders to manage when none are named. */
  defaultHomes: () => Promise<string[]>;
  out: (line: string) => void;
}

const toml = (s: string): string => JSON.stringify(s);
/** POSIX shell quoting: Codex runs the helper through `sh -c`. */
const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** The managed block of one Codex folder. The command carries the folder, because Codex starts the helper with a bare environment (no CODEX_HOME). */
export function codexBlock(gateway: string, ais: string, home: string): string {
  const url = `${gateway.replace(/\/+$/, "")}/browser/mcp`;
  return [
    BEGIN,
    "[mcp_servers.ais-browser]",
    `url = ${toml(url)}`,
    `http_headers_helper = ${toml(`${shq(ais)} browser headers --tool=codex --config-dir=${shq(home)}`)}`,
    `tool_timeout_sec = ${TOOL_TIMEOUT_SEC}`,
    END,
    "",
  ].join("\n");
}

/** `text` without the managed block. */
export function stripBlock(text: string): string {
  const a = text.indexOf(BEGIN);
  if (a < 0) return text;
  const e = text.indexOf(END, a);
  if (e < 0) return text;
  return `${text.slice(0, a)}${text.slice(e + END.length).replace(/^\n/, "")}`.replace(/\n{3,}/g, "\n\n");
}

/**
 * True when the config has its own `ais-browser` server outside the managed block: a table header in any quoting
 * (`[mcp_servers.ais-browser]`, `['ais-browser']`, `["ais-browser"]`, also sub-tables), an inline entry under `[mcp_servers]`,
 * or a dotted key (`mcp_servers.ais-browser.url = ...`, `mcp_servers."ais-browser" = {...}`).
 */
export function hasForeignEntry(text: string): boolean {
  const name = `(?:ais-browser|"ais-browser"|'ais-browser')`;
  const header = new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*${name}\\s*[\\].]`, "m");
  const dotted = new RegExp(`^\\s*mcp_servers\\s*\\.\\s*${name}\\s*[.=]`, "m");
  const rest = stripBlock(text);
  if (header.test(rest) || dotted.test(rest)) return true;
  // An inline entry inside a `[mcp_servers]` table.
  let inServers = false;
  for (const line of rest.split("\n")) {
    const t = line.trim();
    const h = /^\[\s*([^\]]*?)\s*\]\s*(?:#.*)?$/.exec(t);
    if (h && !t.startsWith("[[")) inServers = h[1] === "mcp_servers";
    else if (inServers && new RegExp(`^${name}\\s*(?:[.=])`).test(t)) return true;
  }
  return false;
}

export function applyBlock(text: string, block: string | undefined): string {
  const base = stripBlock(text).replace(/\n*$/, "\n");
  return block ? `${base === "\n" ? "" : `${base}\n`}${block}` : base === "\n" ? "" : base;
}

/** A Codex folder exists and holds a Codex file or folder. Never create config.toml elsewhere. */
async function isCodexFolder(home: string): Promise<boolean> {
  for (const f of ["config.toml", "auth.json", "sessions"]) if (await stat(join(home, f)).then(() => true, () => false)) return true;
  return false;
}

async function defaultHomes(): Promise<string[]> {
  const homes: string[] = [];
  try {
    for (const i of (await loadIdentitiesFile(CODEX_CONFIG.identitiesJsonPath)).identities) if (!i.retired) homes.push(expandPath(i.configDir));
  } catch { /* no registry */ }
  try {
    const dir = join(t3Paths().t3Home, "gateway");
    for (const name of await readdir(dir)) if (name.startsWith("t3-codex-")) homes.push(join(dir, name));
  } catch { /* no T3 */ }
  return [...new Set(homes)];
}

const defaults = (): CodexConfigDeps => ({
  gatewayUrl: async () => process.env.AIS_GATEWAY_PROXY_URL || (await readSecretsKey("AIS_GATEWAY_PROXY_URL")),
  aisBinary: resolveInstalledAisBinary,
  defaultHomes,
  out: (l) => console.info(l),
});

/**
 * `ais browser codex-config [<codex home>...] [--check] [--remove]`: writes (or removes) the `ais-browser` MCP server in the config.toml of Codex folders.
 * Kimi and Z.ai folders are skipped. Without folder names it manages every Codex identity folder and every `t3-codex-*` folder in the T3 gateway folder.
 * Returns false when `--check` finds a folder that is not set up, or a folder has an entry the command does not own.
 */
export async function runCodexConfig(homesArg: string[], flags: ParsedArgs["flags"], deps: Partial<CodexConfigDeps> = {}): Promise<boolean> {
  const d = { ...defaults(), ...deps };
  const check = boolFlag(flags, "check");
  const remove = boolFlag(flags, "remove");
  const homes = (homesArg.length > 0 ? homesArg.map(expandPath) : await d.defaultHomes()).filter((h) => !isOtherProviderName(h.replace(/\/+$/, "").split("/").pop() ?? ""));
  if (homes.length === 0) throw new CliUsageError("No Codex folders found. Pass the folders: ais browser codex-config <codex home>...");
  const gateway = remove ? "" : await d.gatewayUrl();
  if (!remove && !gateway) throw new CliUsageError("AIS_GATEWAY_PROXY_URL is not set (env or ~/.secrets)");
  const ais = d.aisBinary() ?? "ais";
  let ok = true;
  for (const home of homes) {
    if (!(await isCodexFolder(home))) { d.out(`${home}  skipped: not a Codex folder (missing, or no config.toml, auth.json or sessions)`); ok = false; continue; }
    const path = join(home, "config.toml");
    let text = "";
    let mode = 0o600;
    try {
      text = await readFile(path, "utf8");
      mode = (await stat(path)).mode & 0o777;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") { d.out(`${home}  skipped: cannot read config.toml`); ok = false; continue; }
    }
    if (hasForeignEntry(text)) { d.out(`${home}  skipped: config.toml has its own ais-browser entry`); ok = false; continue; }
    const next = applyBlock(text, remove ? undefined : codexBlock(gateway!, ais, home));
    const same = next === text;
    if (check || same) {
      d.out(`${home}  ${remove ? (stripBlock(text) === text ? "not set up" : "set up") : same ? "set up" : "NOT set up"}`);
      if (check && !same) ok = false;
      continue;
    }
    try {
      const tmp = `${path}.tmp.${process.pid}`;
      await writeFile(tmp, next, { mode });
      await chmod(tmp, mode);
      await rename(tmp, path);
      d.out(`${home}  ${remove ? "removed" : "written"}`);
    } catch {
      d.out(`${home}  skipped: cannot write config.toml`);
      ok = false;
    }
  }
  return ok;
}
