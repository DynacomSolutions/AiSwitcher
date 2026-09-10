import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { ToolConfig } from "../identities/types.ts";

type Table = Record<string, unknown>;

function isTable(value: unknown): value is Table {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
}

async function readConfig(path: string): Promise<Table> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Cannot read shared Codex configuration: ${path}`);
  }
  // Parser diagnostics can contain source lines with credentials.
  let config: Table;
  try {
    config = parseToml(source);
  } catch {
    throw new Error(`Invalid TOML in shared Codex configuration: ${path}`);
  }
  if (config.mcp_servers !== undefined && !isTable(config.mcp_servers)) {
    throw new Error(`Expected an mcp_servers table in Codex configuration: ${path}`);
  }
  return config;
}

function missingDefaults(defaults: Table, overrides: Table): Table {
  const entries: Array<[string, unknown]> = [];
  for (const [key, shared] of Object.entries(defaults)) {
    if (!Object.hasOwn(overrides, key)) {
      entries.push([key, shared]);
    } else if (isTable(shared) && isTable(overrides[key])) {
      const missing = missingDefaults(shared, overrides[key]);
      if (Object.keys(missing).length > 0) entries.push([key, missing]);
    }
  }
  return Object.fromEntries(entries);
}

const STDIO_FIELDS = new Set(["command", "args", "env", "env_vars", "cwd"]);
const HTTP_FIELDS = new Set([
  "url", "bearer_token", "bearer_token_env_var", "http_headers",
  "env_http_headers", "http_headers_helper", "oauth", "oauth_resource", "auth",
]);

function missingServers(shared: Table, local: Table): Table {
  const entries: Array<[string, unknown]> = [];
  for (const [name, defaults] of Object.entries(shared)) {
    if (!isTable(defaults)) throw new Error("Expected a Codex MCP server table");
    const overrides = Object.hasOwn(local, name) ? local[name] : {};
    // Invalid local server shapes belong to Codex's own validation.
    if (!isTable(overrides)) continue;
    // Switching transport must not inherit fields that Codex rejects for the
    // explicitly selected transport. Common settings still act as defaults.
    const excluded = Object.hasOwn(overrides, "url") ? STDIO_FIELDS
      : Object.hasOwn(overrides, "command") ? HTTP_FIELDS : new Set<string>();
    const compatible = Object.fromEntries(Object.entries(defaults).filter(([key]) => !excluded.has(key)));
    const missing = missingDefaults(compatible, overrides);
    if (Object.keys(missing).length > 0) entries.push([name, missing]);
  }
  return Object.fromEntries(entries);
}

const SANDBOX_KEYS = ["sandbox_mode", "default_permissions", "sandbox_workspace_write"];
const RUNTIME_SCALARS = [
  "model", "model_reasoning_effort", "service_tier",
  "model_auto_compact_token_limit", "tool_output_token_limit",
];

function sharedRuntimeProjection(shared: Table, local: Table): Table {
  const defaults: Table = {};
  const nonOpenAiProvider = Object.hasOwn(local, "model_provider") && local.model_provider !== "openai";
  for (const key of RUNTIME_SCALARS) {
    if (nonOpenAiProvider && (key === "model" || key === "service_tier")) continue;
    if (Object.hasOwn(shared, key)) defaults[key] = shared[key];
  }
  for (const key of ["agents", "features"]) {
    if (Object.hasOwn(shared, key)) {
      const value = key === "agents" && nonOpenAiProvider && isTable(shared[key])
        ? Object.fromEntries(Object.entries(shared[key]).filter(([name]) => name !== "default_subagent_model"))
        : shared[key];
      defaults[key] = value;
    }
  }
  return defaults;
}

function hasCliSandboxSelection(argv: string[]): boolean {
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--") break;
    if (["--sandbox", "-s", "--approve-for-me", "--full-auto",
      "--dangerously-bypass-approvals-and-sandbox"].includes(arg)
      || arg.startsWith("--sandbox=") || arg.startsWith("-s")) return true;
    const override = arg === "-c" || arg === "--config" ? argv[++index]
      : arg.startsWith("--config=") ? arg.slice("--config=".length)
      : arg.startsWith("-c") ? arg.slice(2) : undefined;
    const key = override?.split("=", 1)[0]?.trim();
    if (key && SANDBOX_KEYS.some((name) => key === name || key.startsWith(`${name}.`))) return true;
  }
  return false;
}

function sharedPermissionsProjection(shared: Table, local: Table, argv: string[]): Table {
  const defaults: Table = {};
  for (const key of ["approval_policy", "approvals_reviewer"]) {
    // The shared policy is authoritative even if Codex rewrites identity files.
    if (Object.hasOwn(shared, key)) defaults[key] = shared[key];
  }
  // Invocation choices win. Preserve incompatible named/legacy representations
  // rather than trying to erase a native permission profile through CLI TOML.
  if (hasCliSandboxSelection(argv)) return defaults;
  if (Object.hasOwn(local, "default_permissions")
    || (Object.hasOwn(shared, "default_permissions")
      && (Object.hasOwn(local, "sandbox_mode") || Object.hasOwn(local, "sandbox_workspace_write")))) return defaults;
  if (Object.hasOwn(shared, "default_permissions")) {
    defaults.default_permissions = shared.default_permissions;
  } else {
    for (const key of ["sandbox_mode", "sandbox_workspace_write"]) {
      if (Object.hasOwn(shared, key)) defaults[key] = shared[key];
    }
  }
  return defaults;
}

function tomlString(value: string): string {
  // JSON basic strings share TOML's escapes, but TOML also forbids literal DEL.
  return JSON.stringify(value).replace(/\x7f/g, "\\u007f");
}

function tomlValue(value: unknown): string {
  if (typeof value === "string") return tomlString(value);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "nan";
    if (value === Infinity) return "inf";
    if (value === -Infinity) return "-inf";
    return Object.is(value, -0) ? "-0.0" : String(value);
  }
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  if (isTable(value)) {
    return `{${Object.entries(value).map(([key, item]) => `${tomlString(key)} = ${tomlValue(item)}`).join(", ")}}`;
  }
  throw new Error("Unsupported value in shared Codex configuration");
}

/**
 * Read per-user MCP and whitelisted runtime/permission defaults on every launch;
 * shared runtime policy is authoritative and identity values are never forwarded.
 * Codex recursively merges the overlay, retaining identity-only fields. MCP
 * transport entries still fill only missing identity fields.
 * A single inline table keeps quoted keys out of Codex's dotted CLI-key parser.
 * Caller overrides follow the projection and retain precedence.
 */
export async function projectSharedCodexConfigForLaunch(
  cfg: Pick<ToolConfig, "toolName">,
  configDir: string,
  argv: string[],
  home: string = homedir(),
): Promise<string[]> {
  if (cfg.toolName !== "codex") return argv;
  const globalPath = join(home, ".codex", "config.toml");
  const localPath = join(configDir, "config.toml");
  if (resolve(globalPath) === resolve(localPath)) return argv;
  // Also recognise aliases of the same config file without creating anything.
  const [globalRealPath, localRealPath] = await Promise.all(
    [globalPath, localPath].map(async (path) => {
      try {
        return await realpath(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw new Error(`Cannot resolve shared Codex configuration: ${path}`);
      }
    }),
  );
  if (globalRealPath && globalRealPath === localRealPath) return argv;

  const shared = await readConfig(globalPath);
  if (Object.keys(shared).length === 0) return argv;
  const local = await readConfig(localPath);
  const missing = missingServers(
    (shared.mcp_servers ?? {}) as Table,
    (local.mcp_servers ?? {}) as Table,
  );
  const projection: Table = Object.keys(missing).length > 0 ? { mcp_servers: missing } : {};
  Object.assign(projection, sharedRuntimeProjection(shared, local));
  Object.assign(projection, sharedPermissionsProjection(shared, local, argv));
  if (Object.keys(projection).length === 0) return argv;
  return [...Object.entries(projection).flatMap(([key, value]) => ["-c", `${key}=${tomlValue(value)}`]), ...argv];
}
