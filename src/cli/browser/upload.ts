import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readUploadFiles } from "../../browser/upload.ts";
import { resolvePoolAuth } from "../../browser/mcp-shim.ts";
import { expandPath } from "../../identities/match.ts";
import { isSwapPool } from "../../identities/pool/swap-pool.ts";
import { findIdentityByNameOrAlias, loadIdentitiesFile } from "../../identities/store.ts";
import { CLAUDE_CONFIG, CODEX_CONFIG } from "../../identities/tool-configs.ts";
import { identityForConfigDir } from "../../shared/browser-wiring.ts";
import { foldValuedFlags, parseArgs, stringFlag } from "../args.ts";
import { CliUsageError } from "../errors.ts";
import { readSecretsKey } from "../gateway/secrets-file.ts";

const TOKEN_FILE = "ais-browser-token";
const VALUED = ["session", "tab", "ref", "coordinate", "label", "browser", "tool", "identity", "pool", "gateway"] as const;
/** The gateway allows an upload 120 s to reach the extension. */
const UPLOAD_TIMEOUT_MS = 130_000;

export interface UploadDeps {
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  out: (line: string) => void;
  registryPath: (tool: "claude" | "codex") => string;
  gatewayUrl: () => Promise<string | undefined>;
  readFile: (path: string) => Promise<string>;
}

const defaultDeps = (): UploadDeps => ({
  env: process.env,
  fetch,
  out: (line) => console.info(line),
  registryPath: (tool) => (tool === "claude" ? CLAUDE_CONFIG : CODEX_CONFIG).identitiesJsonPath,
  gatewayUrl: async () => process.env.AIS_GATEWAY_PROXY_URL || (await readSecretsKey("AIS_GATEWAY_PROXY_URL")),
  readFile: (p) => readFile(p, "utf8"),
});

async function tokenIn(deps: UploadDeps, dir: string): Promise<string | undefined> {
  try {
    return (await deps.readFile(join(dir, TOKEN_FILE))).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The caller: identity or pool. Resolved from the flags, else from the tool's config folder in the env (as a launch does). */
async function resolveAuth(deps: UploadDeps, tool: "claude" | "codex", flags: Record<string, string | true>): Promise<{ identity: string; token: string }> {
  const registry = deps.registryPath(tool);
  const poolName = stringFlag(flags, "pool");
  const identityName = stringFlag(flags, "identity");
  const file = await loadIdentitiesFile(registry);
  let id = identityName ? findIdentityByNameOrAlias(file.identities, identityName) : undefined;
  if (identityName && !id) throw new CliUsageError(`unknown identity ${identityName}`);
  if (poolName) {
    const auth = await resolvePoolAuth(poolName, tool, registry);
    if (auth.error || !auth.token || !auth.identity) throw new Error(auth.error ?? "no token for the pool's active member");
    return { identity: auth.identity, token: auth.token };
  }
  if (!id) {
    const dir = tool === "codex" ? deps.env.CODEX_HOME : deps.env.CLAUDE_CONFIG_DIR;
    if (!dir) throw new CliUsageError(`cannot tell which identity this is: pass --identity=<name> or --pool=<name>, or run it where ${tool === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"} is set`);
    id = identityForConfigDir(file, dir);
    if (!id) throw new CliUsageError(`no registered identity for ${dir}: pass --identity=<name> or --pool=<name>`);
  }
  if (isSwapPool(id)) {
    const auth = await resolvePoolAuth(id.name, tool, registry);
    if (auth.error || !auth.token || !auth.identity) throw new Error(auth.error ?? "no token for the pool's active member");
    return { identity: auth.identity, token: auth.token };
  }
  const token = await tokenIn(deps, expandPath(id.configDir));
  if (!token) throw new Error(`no AIS Browser agent token for identity ${id.name}; run ais browser agent-token ${id.name}`);
  return { identity: id.name, token };
}

/**
 * `ais browser upload --session <id> --tab <tabId> (--ref <ref> | --coordinate <x,y>) [--browser <name>] <paths...>`.
 * Reads the files on this machine and posts one `upload_file` call, with their content, to `<gateway>/browser/call`.
 * Used when the MCP server is the gateway: the gateway cannot read the agent's files.
 */
export async function runBrowserUpload(argv: string[], overrides: Partial<UploadDeps> = {}): Promise<boolean> {
  const deps = { ...defaultDeps(), ...overrides };
  const { positionals, flags } = parseArgs(foldValuedFlags(argv, VALUED));
  const session = stringFlag(flags, "session");
  if (!session || session.length > 128) throw new CliUsageError("--session=<session id> is required (the tool error names it)");
  const tabText = stringFlag(flags, "tab");
  const tabId = Number(tabText);
  if (!tabText || !Number.isInteger(tabId) || tabId < 0) throw new CliUsageError("--tab=<tabId> is required");
  const ref = stringFlag(flags, "ref");
  const coordText = stringFlag(flags, "coordinate");
  if ((ref === undefined) === (coordText === undefined)) throw new CliUsageError("give exactly one of --ref=<ref> and --coordinate=<x,y>");
  let coordinate: [number, number] | undefined;
  if (coordText !== undefined) {
    const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(coordText);
    if (!m) throw new CliUsageError("--coordinate must be <x,y>");
    coordinate = [Number(m[1]), Number(m[2])];
  }
  if (positionals.length === 0) throw new CliUsageError("give at least one file path");
  const tool: "claude" | "codex" = stringFlag(flags, "tool") === "codex" || (stringFlag(flags, "tool") === undefined && !deps.env.CLAUDE_CONFIG_DIR && !!deps.env.CODEX_HOME) ? "codex" : "claude";
  const gateway = stringFlag(flags, "gateway") || (await deps.gatewayUrl());
  if (!gateway) throw new Error("AIS_GATEWAY_PROXY_URL is not set (env or ~/.secrets)");

  const files = await readUploadFiles(positionals);
  const { identity, token } = await resolveAuth(deps, tool, flags);
  const browser = stringFlag(flags, "browser");
  const res = await deps.fetch(`${gateway.replace(/\/+$/, "")}/browser/call`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    body: JSON.stringify({
      ...(browser ? { browser } : {}),
      // The label keeps the tab group name. Without it the label is empty and the extension keeps the current name.
      session: { id: session, identity, label: (stringFlag(flags, "label") ?? "").slice(0, 80) },
      tool: "upload_file",
      args: { tabId, ...(ref !== undefined ? { ref } : { coordinate }), files },
    }),
  });
  if (res.status !== 200) {
    const detail = await res.json().then((j) => (j as { error?: unknown }).error, () => undefined);
    throw new Error(`gateway returned ${res.status}${typeof detail === "string" ? ` (${detail})` : ""}`);
  }
  const result = (await res.json()) as { ok?: boolean; error?: string; message?: string; content?: Array<{ type: string; text?: string }> };
  if (!result.ok) {
    deps.out(`${result.error ?? "internal"}: ${result.message ?? "upload failed"}`);
    return false;
  }
  for (const c of result.content ?? []) if (c.type === "text" && c.text) deps.out(c.text);
  return true;
}
