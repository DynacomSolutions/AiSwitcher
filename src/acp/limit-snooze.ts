/**
 * Snooze and resume for ACP threads that hit a usage limit (board 5.246).
 *
 * T3 Code snoozes a Claude thread until the reset time of a limit and resumes it. Its generic ACP driver (Kimi) and its
 * Grok driver never read a reset time from a failure, so the relay does it through T3's own MCP tools:
 * - `t3_thread_organize` with `{ action: "snooze", snoozedUntil }` (the thread of the session; no thread id needed);
 * - `schedule_task` once at the reset time plus a short delay, bound to the same thread, which posts a short prompt.
 *
 * T3 gives each ACP session a `t3-code` MCP server in `session/new` (and `session/load`, `session/resume`): either a
 * stdio server (command `t3 acp-mcp-bridge`) whose `env` holds `T3_ACP_MCP_ENDPOINT` and `T3_ACP_MCP_AUTHORIZATION`, or,
 * when the agent supports it, an `http` server with `url` and an `Authorization` header. Both reach the same endpoint:
 * streamable HTTP MCP, one JSON-RPC message per POST, answered as JSON or as an event stream. The endpoint and its
 * authorization are kept in memory only and never logged.
 */

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);

export const MCP_SERVER_NAME = "t3-code";
export const RESUME_DELAY_MS = 30_000;
export const RESUME_PROMPT = "The usage limit has reset. Continue the task from where you stopped.";
const MCP_PROTOCOL_VERSION = "2025-06-18";
const MCP_TIMEOUT_MS = 20_000;

export interface McpEndpoint {
  url: string;
  authorization: string;
}

/** Name and value pairs from an ACP `env` or `headers` list. */
function pairs(list: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (Array.isArray(list)) for (const item of list) {
    const name = str(obj(item)?.name);
    const value = str(obj(item)?.value);
    if (name !== undefined && value !== undefined) out.set(name.toLowerCase(), value);
  }
  return out;
}

/** The T3 MCP endpoint in the `mcpServers` of a `session/new`, `session/load` or `session/resume` request. */
export function endpointFromServers(mcpServers: unknown): McpEndpoint | undefined {
  if (!Array.isArray(mcpServers)) return undefined;
  for (const raw of mcpServers) {
    const s = obj(raw);
    if (!s || s.name !== MCP_SERVER_NAME) continue;
    const url = str(s.url);
    if (url !== undefined) {
      const authorization = pairs(s.headers).get("authorization");
      if (authorization !== undefined) return { url, authorization };
    }
    const env = pairs(s.env);
    const endpoint = env.get("t3_acp_mcp_endpoint");
    const authorization = env.get("t3_acp_mcp_authorization");
    if (endpoint !== undefined && authorization !== undefined) return { url: endpoint, authorization };
  }
  return undefined;
}

/** The reset time in a limit text (`Resets at 2026-11-21T03:00:00Z.`) when it is later than `nowMs`. */
export function resetFromText(text: string, nowMs: number): Date | undefined {
  const m = /Resets at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z)/.exec(text);
  if (!m) return undefined;
  const at = new Date(m[1] as string);
  return Number.isNaN(at.getTime()) || at.getTime() <= nowMs ? undefined : at;
}

export interface LimitFailure {
  /** The text the client would show. */
  text: string;
  status?: number;
  /** Agent error code (`provider.rate_limit`) or the JSON-RPC error code as text. */
  code?: string;
}

const LIMIT_CODE = /rate[_.-]?limit|usage|quota|limit/i;
/** T3 Code maps this ACP error code to a usage limit. */
export const USAGE_LIMIT_RPC_CODE = "-32003";

/** Whether a failure is a usage or rate limit (not any other provider error). */
export function isLimitFailure(f: LimitFailure): boolean {
  return f.status === 429 || (f.code !== undefined && (f.code === USAGE_LIMIT_RPC_CODE || LIMIT_CODE.test(f.code))) || /usage limit|rate limit/i.test(f.text);
}

export type McpFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<Response>;

export interface McpCaller {
  call(endpoint: McpEndpoint, tool: string, args: Json): Promise<void>;
}

/** The JSON-RPC answer in a response that is JSON or an event stream (`data:` lines). */
async function readAnswer(res: Response, id: number): Promise<Json | undefined> {
  const text = await res.text();
  const candidates = (res.headers.get("content-type") ?? "").includes("text/event-stream")
    ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim())
    : [text];
  for (const c of candidates) {
    try {
      const o = obj(JSON.parse(c));
      if (o && o.id === id) return o;
    } catch {
      // not a JSON line
    }
  }
  return undefined;
}

/** A small MCP client over streamable HTTP: initialize, initialized, one tool call. Throws on any failure. */
export function mcpCaller(fetchImpl: McpFetch = fetch as unknown as McpFetch): McpCaller {
  return {
    async call(endpoint, tool, args) {
      let sessionId: string | undefined;
      let nextId = 0;
      const post = async (message: Json, id?: number): Promise<Json | undefined> => {
        const res = await fetchImpl(endpoint.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: endpoint.authorization,
            ...(sessionId ? { "mcp-session-id": sessionId } : {}),
            ...(sessionId ? { "mcp-protocol-version": MCP_PROTOCOL_VERSION } : {}),
          },
          body: JSON.stringify(message),
          signal: AbortSignal.timeout(MCP_TIMEOUT_MS),
        });
        sessionId = res.headers.get("mcp-session-id") ?? sessionId;
        if (!res.ok) {
          await res.text().catch(() => "");
          throw new Error(`MCP endpoint answered HTTP ${res.status}`);
        }
        if (id === undefined) {
          await res.text().catch(() => "");
          return undefined;
        }
        const answer = await readAnswer(res, id);
        if (!answer) throw new Error("MCP endpoint gave no answer");
        const error = obj(answer.error);
        if (error) throw new Error(`MCP error ${String(error.code)}`);
        return answer;
      };
      const request = (method: string, params: Json) => {
        const id = nextId++;
        return post({ jsonrpc: "2.0", id, method, params }, id);
      };
      await request("initialize", { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "ais-acp-relay", version: "1" } });
      await post({ jsonrpc: "2.0", method: "notifications/initialized" });
      const result = obj((await request("tools/call", { name: tool, arguments: args }))?.result);
      if (result?.isError === true) throw new Error(`tool ${tool} reported an error`);
    },
  };
}

export interface LimitSnoozerOptions {
  caller?: McpCaller;
  now?: () => number;
  log?: (line: string) => void;
}

/** Keeps the MCP endpoint of each session and snoozes plus schedules a resume once per failure. */
export class LimitSnoozer {
  private readonly endpoints = new Map<string, McpEndpoint>();
  private readonly done = new Set<string>();
  private readonly caller: McpCaller;

  constructor(private readonly opts: LimitSnoozerOptions = {}) {
    this.caller = opts.caller ?? mcpCaller();
  }

  setEndpoint(sessionId: string, endpoint: McpEndpoint): void {
    this.endpoints.set(sessionId, endpoint);
  }

  /** Never throws and never waits for the MCP calls: the caller's answer to the client must not be delayed. */
  onFailure(sessionId: string, failure: LimitFailure): void {
    try {
      if (!isLimitFailure(failure)) return;
      const nowMs = this.opts.now?.() ?? Date.now();
      const reset = resetFromText(failure.text, nowMs);
      if (!reset) return;
      const endpoint = this.endpoints.get(sessionId);
      if (!endpoint) {
        this.opts.log?.("acp-relay: usage limit with a reset time, but no T3 MCP server known for this session");
        return;
      }
      const key = `${sessionId}|${reset.toISOString()}`;
      if (this.done.has(key)) return;
      this.done.add(key);
      void this.run(endpoint, reset);
    } catch {
      // never changes the answer
    }
  }

  private async run(endpoint: McpEndpoint, reset: Date): Promise<void> {
    try {
      await this.caller.call(endpoint, "t3_thread_organize", { action: "snooze", snoozedUntil: reset.toISOString() });
      const runAt = new Date(reset.getTime() + RESUME_DELAY_MS).toISOString();
      await this.caller.call(endpoint, "schedule_task", { prompt: RESUME_PROMPT, schedule: { type: "once", runAt }, bindToCurrentThread: true, title: "Resume after usage limit" });
      this.opts.log?.(`acp-relay: thread snoozed until ${reset.toISOString()}, resume scheduled`);
    } catch (err) {
      // Only our own messages are logged: a network error text can name the endpoint.
      const own = err instanceof Error && /^(MCP|tool )/.test(err.message) ? err.message.slice(0, 120) : "request failed";
      this.opts.log?.(`acp-relay: snooze or resume failed: ${own}`);
    }
  }
}
