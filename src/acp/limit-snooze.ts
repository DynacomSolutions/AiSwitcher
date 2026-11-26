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
/** A reset later than this is not trusted (a wrong clock or text): no snooze. */
export const MAX_RESET_MS = 8 * 24 * 3600_000;
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
  return Number.isNaN(at.getTime()) || at.getTime() <= nowMs || at.getTime() > nowMs + MAX_RESET_MS ? undefined : at;
}

export interface LimitFailure {
  /** The text the client would show. */
  text: string;
  status?: number;
  /** Agent error code (`provider.rate_limit`) or the JSON-RPC error code as text. */
  code?: string;
}

const USAGE_LIMIT_TEXT = /(?:you['’]ve hit your (?:\d+(?:\.\d+)?[- ]hour|weekly|usage) limit|usage limit (?:reached|exhausted)|subscription (?:usage )?limit (?:reached|exhausted))/i;
/** T3 Code maps this ACP error code to a usage limit. */
export const USAGE_LIMIT_RPC_CODE = "-32003";

/** Whether a failure is a usage or rate limit (not any other provider error). */
export function isLimitFailure(f: LimitFailure): boolean {
  return f.code === USAGE_LIMIT_RPC_CODE || USAGE_LIMIT_TEXT.test(f.text);
}

export type McpFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<Response>;

export interface McpCaller {
  /** Calls one tool and gives its data (structured content, or the JSON text of the first text part). */
  call(endpoint: McpEndpoint, tool: string, args: Json): Promise<Json>;
}

/** The data object of a `tools/call` result. */
export function toolData(result: Json | undefined): Json {
  const structured = obj(result?.structuredContent);
  if (structured) return structured;
  const parts = Array.isArray(result?.content) ? result.content : [];
  for (const part of parts) {
    const text = str(obj(part)?.text);
    if (text === undefined) continue;
    try {
      const o = obj(JSON.parse(text));
      if (o) return o;
    } catch {
      // not JSON
    }
  }
  return {};
}

/** The first string stored under `key` in `data` or in one object nested directly in it. */
function findString(data: Json, key: string): string | undefined {
  const direct = str(data[key]);
  if (direct !== undefined) return direct;
  for (const v of Object.values(data)) {
    const nested = str(obj(v)?.[key]);
    if (nested !== undefined) return nested;
  }
  return undefined;
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
      return toolData(result);
    },
  };
}

export interface LimitSnoozerOptions {
  caller?: McpCaller;
  now?: () => number;
  log?: (line: string) => void;
}

interface Scheduled {
  taskId: string;
  runAtMs: number;
  endpoint: McpEndpoint;
  key: string;
}

/** Keeps the MCP endpoint of each session and snoozes plus schedules a resume once per failure. */
export class LimitSnoozer {
  private readonly endpoints = new Map<string, McpEndpoint>();
  private readonly done = new Set<string>();
  /** The resume task of each session, until it runs or a prompt succeeds first. */
  private readonly scheduled = new Map<string, Scheduled>();
  private readonly caller: McpCaller;

  constructor(private readonly opts: LimitSnoozerOptions = {}) {
    this.caller = opts.caller ?? mcpCaller();
  }

  private nowMs(): number {
    return this.opts.now?.() ?? Date.now();
  }

  setEndpoint(sessionId: string, endpoint: McpEndpoint): void {
    this.endpoints.set(sessionId, endpoint);
  }

  /** Never throws and never waits for the MCP calls: the caller's answer to the client must not be delayed. */
  onFailure(sessionId: string, failure: LimitFailure): void {
    try {
      if (!isLimitFailure(failure)) return;
      const reset = resetFromText(failure.text, this.nowMs());
      if (!reset) return;
      const endpoint = this.endpoints.get(sessionId);
      if (!endpoint) {
        this.opts.log?.("acp-relay: usage limit with a reset time, but no T3 MCP server known for this session");
        return;
      }
      const key = `${sessionId}|${reset.toISOString()}`;
      if (this.done.has(key)) return;
      this.done.add(key);
      void this.run(sessionId, endpoint, reset, key, true);
    } catch {
      // never changes the answer
    }
  }

  /**
   * A long usage-limit retry inside an open prompt. The agent sleeps until the reset, so the turn never ends on its own.
   * Snooze the thread and schedule the resume. The resume is not registered for `onSuccess` deletion: the cancelled turn
   * ends "ok" and must not delete it. Returns true only for the first snooze of this session and reset. Never throws.
   */
  onInTurnLimit(sessionId: string, failure: LimitFailure): boolean {
    try {
      if (!isLimitFailure(failure)) return false;
      const reset = resetFromText(failure.text, this.nowMs());
      if (!reset) return false;
      const endpoint = this.endpoints.get(sessionId);
      if (!endpoint) {
        this.opts.log?.("acp-relay: in-turn usage limit with a reset time, but no T3 MCP server known for this session");
        return false;
      }
      const key = `${sessionId}|${reset.toISOString()}`;
      if (this.done.has(key)) return false;
      this.done.add(key);
      void this.run(sessionId, endpoint, reset, key, false);
      return true;
    } catch {
      // never changes the answer
      return false;
    }
  }

  /**
   * A prompt of the session ended well. When it did so before the resume task ran, the task would start a second turn,
   * so it is deleted. Never throws and never waits.
   */
  onSuccess(sessionId: string): void {
    try {
      const task = this.scheduled.get(sessionId);
      if (!task) return;
      this.scheduled.delete(sessionId);
      this.done.delete(task.key);
      if (this.nowMs() >= task.runAtMs) return;
      void this.caller
        .call(task.endpoint, "delete_scheduled_task", { scheduledTaskId: task.taskId })
        .then(() => this.opts.log?.("acp-relay: a prompt ended well before the reset, resume task deleted"))
        .catch((err) => this.opts.log?.(`acp-relay: resume task not deleted: ${ownMessage(err)}`));
    } catch {
      // never changes the answer
    }
  }

  /** `registerResume` false keeps the resume task out of the map `onSuccess` deletes from (an in-turn limit). */
  private async run(sessionId: string, endpoint: McpEndpoint, reset: Date, key: string, registerResume: boolean): Promise<void> {
    try {
      await this.caller.call(endpoint, "t3_thread_organize", { action: "snooze", snoozedUntil: reset.toISOString() });
      const runAtMs = reset.getTime() + RESUME_DELAY_MS;
      const data = await this.caller.call(endpoint, "schedule_task", { prompt: RESUME_PROMPT, schedule: { type: "once", runAt: new Date(runAtMs).toISOString() }, bindToCurrentThread: true, title: "Resume after usage limit" });
      const taskId = findString(data, "scheduledTaskId");
      // T3's own recovery never resumes a subagent (it would wake the parent): the snooze stays, the resume goes.
      const threadId = findString(data, "boundThreadId") ?? findString(data, "threadId");
      if (taskId !== undefined && threadId !== undefined && (await this.isSubagent(endpoint, threadId).catch(() => false))) {
        await this.caller.call(endpoint, "delete_scheduled_task", { scheduledTaskId: taskId });
        this.opts.log?.(`acp-relay: thread snoozed until ${reset.toISOString()}; no resume for a subagent thread`);
        return;
      }
      if (taskId !== undefined && registerResume) this.scheduled.set(sessionId, { taskId, runAtMs, endpoint, key });
      this.opts.log?.(`acp-relay: thread snoozed until ${reset.toISOString()}, resume scheduled`);
    } catch (err) {
      this.opts.log?.(`acp-relay: snooze or resume failed: ${ownMessage(err)}`);
    }
  }

  private async isSubagent(endpoint: McpEndpoint, threadId: string): Promise<boolean> {
    const data = await this.caller.call(endpoint, "t3_thread_read", { threadId, limit: 1, runLimit: 1, maxCharsPerItem: 1 });
    return findString(data, "relationshipToParent") === "subagent";
  }
}

/** Only our own messages are logged: a network error text can name the endpoint. */
function ownMessage(err: unknown): string {
  return err instanceof Error && /^(MCP|tool )/.test(err.message) ? err.message.slice(0, 120) : "request failed";
}
