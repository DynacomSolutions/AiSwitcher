import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { readSecretsKey } from "../cli/gateway/secrets-file.ts";
import { BROWSER_TOOLS, type CallResult } from "./protocol.ts";
import { mcpTools } from "./tool-schemas.ts";

export const BROWSER_TOKEN_FILE = "ais-browser-token";
export const STOPPED_BY_USER_NOTE = "The user stopped browser control. Do not retry unless the user asks.";
const SUPPORTED_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"];
const LATEST_VERSION = "2025-06-18";
const FETCH_TIMEOUT_MS = 130_000;

export interface ShimContext {
  /** Gateway root URL, resolved on each call. */
  gatewayUrl(): Promise<string | undefined>;
  /** Agent token, resolved on each call. */
  token(): Promise<string | undefined>;
  session: { id: string; identity: string; label: string };
  fetch: typeof fetch;
  /** In-flight tools/call requests by JSON-RPC id, aborted by notifications/cancelled. */
  inflight?: Map<string | number, AbortController>;
}

type McpContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
interface RpcMessage { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }

const errorResult = (text: string): { isError: true; content: McpContent[] } => ({ isError: true, content: [{ type: "text", text }] });

export function mapCallResult(result: CallResult): { isError?: true; content: McpContent[] } {
  if (result.ok) {
    return { content: result.content.map((c): McpContent => (c.type === "image" ? { type: "image", data: c.data, mimeType: c.mimeType } : { type: "text", text: c.text })) };
  }
  const note = result.error === "stopped_by_user" ? ` ${STOPPED_BY_USER_NOTE}` : "";
  return errorResult(`${result.error}: ${result.message}${note}`);
}

async function callTool(ctx: ShimContext, name: string, rawArgs: unknown, signal?: AbortSignal): Promise<{ isError?: true; content: McpContent[] }> {
  if (!(BROWSER_TOOLS as readonly string[]).includes(name)) return errorResult(`bad_args: unknown tool ${name}`);
  const { browser, ...args } = (typeof rawArgs === "object" && rawArgs !== null ? rawArgs : {}) as Record<string, unknown>;
  const [url, token] = await Promise.all([ctx.gatewayUrl(), ctx.token()]);
  if (!url) return errorResult("internal: AIS_GATEWAY_PROXY_URL is not set (env or ~/.secrets)");
  if (!token) return errorResult("internal: no ais-browser-token found; run `ais browser agent-token <identity>`");
  let res: Response;
  try {
    res = await ctx.fetch(`${url.replace(/\/+$/, "")}/browser/call`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      signal: AbortSignal.any([AbortSignal.timeout(FETCH_TIMEOUT_MS), ...(signal ? [signal] : [])]),
      body: JSON.stringify({ ...(typeof browser === "string" ? { browser } : {}), session: ctx.session, tool: name, args }),
    });
  } catch (e) {
    if (signal?.aborted) return errorResult("internal: cancelled");
    return errorResult(`internal: gateway unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status !== 200) {
    const detail = await res.json().then((j) => (j as { error?: unknown }).error, () => undefined);
    return errorResult(`internal: gateway returned ${res.status}${typeof detail === "string" ? ` (${detail})` : ""}`);
  }
  let result: CallResult;
  try {
    result = (await res.json()) as CallResult;
  } catch {
    return errorResult("internal: gateway returned invalid JSON");
  }
  return mapCallResult(result);
}

/** Handles one JSON-RPC message; undefined for notifications. */
export async function handleRpc(msg: RpcMessage, ctx: ShimContext): Promise<object | undefined> {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id ?? null, result });
  if (typeof msg.method !== "string") return undefined;
  if (msg.method === "notifications/cancelled") {
    const rid = msg.params?.requestId;
    if (typeof rid === "string" || typeof rid === "number") ctx.inflight?.get(rid)?.abort();
    return undefined;
  }
  if (msg.id === undefined || msg.id === null) return undefined;
  switch (msg.method) {
    case "initialize":
      return reply({ protocolVersion: SUPPORTED_VERSIONS.includes(String(msg.params?.protocolVersion)) ? msg.params?.protocolVersion : LATEST_VERSION, capabilities: { tools: {} }, serverInfo: { name: "ais-browser", version: "1" } });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: mcpTools() });
    case "tools/call": {
      const p = msg.params ?? {};
      const ac = new AbortController();
      ctx.inflight?.set(msg.id, ac);
      try {
        return reply(await callTool(ctx, String(p.name ?? ""), p.arguments, ac.signal));
      } finally {
        ctx.inflight?.delete(msg.id);
      }
    }
    default:
      return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } };
  }
}

export interface ShimOptions { configDir?: string; identity?: string; gateway?: string }

/** Parses `--config-dir <d> --identity <n> --gateway <u>` (also `--flag=value`). Unknown args are ignored. */
export function parseShimArgs(argv: string[]): ShimOptions {
  const out: ShimOptions = {};
  const keys = { "--config-dir": "configDir", "--identity": "identity", "--gateway": "gateway" } as const;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const eq = a.indexOf("=");
    const flag = eq > 0 ? a.slice(0, eq) : a;
    if (!(flag in keys)) continue;
    const value = eq > 0 ? a.slice(eq + 1) : argv[++i];
    if (value) out[keys[flag as keyof typeof keys]] = value;
  }
  return out;
}

async function readToken(env: NodeJS.ProcessEnv, configDir?: string): Promise<string | undefined> {
  const dirs = [configDir, env.CLAUDE_CONFIG_DIR, env.CODEX_HOME];
  for (const dir of dirs) {
    if (!dir) continue;
    try {
      const t = (await readFile(join(dir, BROWSER_TOKEN_FILE), "utf8")).trim();
      if (t) return t;
    } catch {}
  }
  return undefined;
}

export function contextFromEnv(env: NodeJS.ProcessEnv = process.env, opts: ShimOptions = {}): ShimContext {
  const id = env.CLAUDE_SESSION_ID || env.CODEX_SESSION_ID || crypto.randomUUID();
  const identity = opts.identity || env.AI_PROFILE_SWITCHER_SESSION || "agent";
  return {
    gatewayUrl: async () => opts.gateway || env.AIS_GATEWAY_PROXY_URL || (await readSecretsKey("AIS_GATEWAY_PROXY_URL")),
    token: () => readToken(env, opts.configDir),
    session: { id, identity, label: `${identity} / ${id.slice(0, 6)}` },
    fetch,
    inflight: new Map(),
  };
}

/** Stdio MCP server: newline-delimited JSON-RPC on stdin/stdout; resolves when stdin closes. */
export async function runMcpShim(ctx: ShimContext = contextFromEnv(process.env, parseShimArgs(process.argv)), input: NodeJS.ReadableStream = process.stdin, write: (line: string) => void = (l) => process.stdout.write(l)): Promise<void> {
  const pending = new Set<Promise<void>>();
  for await (const line of createInterface({ input })) {
    if (!line.trim()) continue;
    const task = (async () => {
      let msg: RpcMessage;
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } })}\n`);
          return;
        }
        msg = parsed as RpcMessage;
      } catch {
        write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })}\n`);
        return;
      }
      const out = await handleRpc(msg, ctx).catch((e) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } }));
      if (out) write(`${JSON.stringify(out)}\n`);
    })().finally(() => pending.delete(task));
    pending.add(task);
  }
  await Promise.all(pending);
}
