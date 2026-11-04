import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { readSecretsKey } from "../cli/gateway/secrets-file.ts";
import { BROWSER_TOOLS, type CallResult } from "./protocol.ts";
import { mcpTools } from "./tool-schemas.ts";

export const BROWSER_TOKEN_FILE = "ais-browser-token";
export const STOPPED_BY_USER_NOTE = "The user stopped browser control. Do not retry unless the user asks.";
const PROTOCOL_VERSION = "2024-11-05";

export interface ShimContext {
  /** Gateway root URL, resolved on each call. */
  gatewayUrl(): Promise<string | undefined>;
  /** Agent token, resolved on each call. */
  token(): Promise<string | undefined>;
  session: { id: string; identity: string; label: string };
  fetch: typeof fetch;
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

async function callTool(ctx: ShimContext, name: string, rawArgs: unknown): Promise<{ isError?: true; content: McpContent[] }> {
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
      body: JSON.stringify({ ...(typeof browser === "string" ? { browser } : {}), session: ctx.session, tool: name, args }),
    });
  } catch (e) {
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
  if (msg.id === undefined || msg.id === null) return undefined;
  switch (msg.method) {
    case "initialize":
      return reply({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "ais-browser", version: "1" } });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: mcpTools() });
    case "tools/call": {
      const p = msg.params ?? {};
      return reply(await callTool(ctx, String(p.name ?? ""), p.arguments));
    }
    default:
      return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } };
  }
}

async function readToken(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  for (const key of ["CLAUDE_CONFIG_DIR", "CODEX_HOME"]) {
    const dir = env[key];
    if (!dir) continue;
    try {
      const t = (await readFile(join(dir, BROWSER_TOKEN_FILE), "utf8")).trim();
      if (t) return t;
    } catch {}
  }
  return undefined;
}

export function contextFromEnv(env: NodeJS.ProcessEnv = process.env): ShimContext {
  const id = env.CLAUDE_SESSION_ID || env.CODEX_SESSION_ID || crypto.randomUUID();
  const identity = env.AI_PROFILE_SWITCHER_SESSION || "agent";
  return {
    gatewayUrl: async () => env.AIS_GATEWAY_PROXY_URL || (await readSecretsKey("AIS_GATEWAY_PROXY_URL")),
    token: () => readToken(env),
    session: { id, identity, label: `${identity} / ${id.slice(0, 6)}` },
    fetch,
  };
}

/** Stdio MCP server: newline-delimited JSON-RPC on stdin/stdout; resolves when stdin closes. */
export async function runMcpShim(ctx: ShimContext = contextFromEnv(), input: NodeJS.ReadableStream = process.stdin, write: (line: string) => void = (l) => process.stdout.write(l)): Promise<void> {
  const pending = new Set<Promise<void>>();
  for await (const line of createInterface({ input })) {
    if (!line.trim()) continue;
    const task = (async () => {
      let msg: RpcMessage;
      try {
        msg = JSON.parse(line) as RpcMessage;
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
