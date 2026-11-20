/**
 * The rules of the AIS relay between an ACP client (T3 Code) and an ACP agent. It changes one thing only: how the end of
 * a `session/prompt` reaches the client when the turn failed.
 *
 * Measured 18 Nov 2026 against a stub provider (board 4.215):
 * - kimi-code answers a failed turn (provider 400, 429 or 5xx after its retries) with `stopReason: "end_turn"` and no
 *   text, so the client shows an empty, completed turn. The reason is only in the agent's own session log.
 * - grok-build and glm-acp-agent answer with a JSON-RPC error whose message is `Internal error`; the reason is in `data`.
 *   T3 Code shows the message, so the reason is lost.
 *
 * A JSON-RPC error on `session/prompt` is what the client shows as a failed turn, so:
 * - an answer `end_turn` for a turn the agent's own records say failed becomes a JSON-RPC error with the reason;
 * - an error whose message is generic gets the detail from its `data`;
 * - an `end_turn` after a turn with no output at all, when nothing is known about how the turn ended, is kept, preceded
 *   by a notice the user can see. A turn the agent's records say ended well is never given a notice. When the agent sent
 *   output while no prompt of the session was open (a turn it started itself), the notice says the agent is busy.
 *
 * Permission requests while no prompt of the session is open (measured 18 Nov 2026, kimi-code 2.5.2): an agent can
 * start a turn by itself (a finished background task wakes it). T3 Code has no run for that turn and answers its
 * `session/request_permission` by selecting the agent's reject option, so the agent tells the model "the user rejected
 * the approval request" although nobody was asked. Such a request never goes to the client. The relay answers it:
 * - with the client's own answer inside runs, when the client answered this session's last permission request with an
 *   allow option within `AUTO_ANSWER_MS` (no person answers that fast: the thread's mode approves by itself);
 * - otherwise `cancelled`, which agents report as a cancelled request, never as a user's rejection.
 *
 * Every other line passes unchanged, byte for byte. A line this code cannot read passes unchanged too.
 */
import { redactText } from "../gateway/upstream-error.ts";
import { endpointFromServers, type LimitSnoozer, type McpEndpoint } from "./limit-snooze.ts";

/** Why a turn failed, from the agent's own records. */
export interface TurnFailure {
  message: string;
  /** The agent's error code (`provider.api_error`). */
  code?: string;
  /** The provider's HTTP status. */
  status?: number;
  retryable?: boolean;
}

/** How a turn ended by the agent's own records: its failure, "ok" (ended without one), or undefined when nothing is known. */
export type TurnOutcome = TurnFailure | "ok" | undefined;

/** What the relay knows about one agent beyond the protocol. */
export interface RelayAdapter {
  /**
   * Called for a prompt before it is passed to the agent. What it returns (a place in the agent's records) is given back
   * to `turnOutcome`, so the end of this turn is told apart from the end of an earlier one. Must be quick: it runs in
   * the path of the prompt.
   */
  promptStarting?(sessionId: string): unknown;
  /** The outcome of the turn in `sessionId` whose prompt gave `mark`. */
  turnOutcome?(sessionId: string, mark: unknown): Promise<TurnOutcome>;
}

export interface RelayOptions {
  adapter?: RelayAdapter;
  /** One line per changed answer, for the agent's stderr log. Never carries prompt or reply text. */
  log?: (line: string) => void;
  /** Sends a line to the agent (the relay's own answer to a request the client does not get). */
  toAgent?: (line: string) => void;
  /** The clock, for the time the client took to answer a permission request. */
  now?: () => number;
  /** Snoozes and resumes a thread whose turn failed on a usage limit (limit-snooze.ts). */
  limit?: LimitSnoozer;
}

/** JSON-RPC "internal error": the code agents use for a failed provider call. */
export const TURN_FAILED_CODE = -32603;
export const ERROR_SOURCE = "ais-acp-relay";
export const EMPTY_TURN_NOTICE = "[No reply: the agent ended this turn without any output and gave no reason.]";
export const BUSY_TURN_NOTICE =
  "[No reply: the agent is busy with a turn it started by itself (for example when background work ended). That turn's output does not reach this thread. Wait until it is done, then send the message again.]";
/** A permission answer quicker than this came from the client's mode, not from a person. */
export const AUTO_ANSWER_MS = 250;
const MESSAGE_MAX = 500;

/** Session updates that are output of the turn (text, thinking, tools, a plan). */
const OUTPUT_UPDATES = new Set(["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "plan"]);
const GENERIC_MESSAGE = /^(internal error|unknown error|error|request failed)\.?$/i;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);

interface Prompt {
  sessionId: string;
  /** What the adapter returned before the prompt went to the agent. */
  mark: unknown;
  /** The session's output count when the prompt was sent. */
  outputAtStart: number;
}

/** The detail an agent put in a JSON-RPC error's `data`: a string, or an object's message, details, detail or error text. */
function errorDetail(data: unknown): string | undefined {
  const s = str(data);
  if (s) return s;
  const d = obj(data);
  if (!d) return undefined;
  return str(d.message) ?? str(d.details) ?? str(d.detail) ?? str(d.error) ?? str(obj(d.error)?.message);
}

/**
 * A JSON-RPC error with the reason in its message: the detail from `data` replaces a generic message and is added to
 * any other message that does not already hold it. Undefined when there is nothing to add.
 */
export function describeError(error: unknown): Json | undefined {
  const e = obj(error);
  if (!e) return undefined;
  const detail = errorDetail(e.data);
  if (!detail) return undefined;
  const message = str(e.message) ?? "";
  if (message.includes(detail)) return undefined;
  const next = redactText(message === "" || GENERIC_MESSAGE.test(message) ? detail : `${message}: ${detail}`, MESSAGE_MAX);
  return next === "" || next === message ? undefined : { ...e, message: next };
}

/** The text the client shows for a failed turn. */
export function failureMessage(f: TurnFailure): string {
  const facts = [f.status !== undefined ? `HTTP ${f.status}` : undefined, f.code, f.retryable === true ? "the agent's retries ran out" : undefined].filter((x): x is string => x !== undefined);
  return redactText(`Turn failed: ${f.message}${facts.length > 0 ? ` (${facts.join(", ")})` : ""}`, MESSAGE_MAX);
}

const idKey = (id: unknown): string | undefined => (typeof id === "number" || typeof id === "string" ? `${typeof id}:${id}` : undefined);

interface PermissionAsked {
  sessionId: string;
  /** Option id -> kind (`allow_once`, `allow_always`, `reject_once`, ...). */
  kinds: Map<string, string>;
  at: number;
}

/** The options of a `session/request_permission` request, id -> kind. */
function optionKinds(params: Json | undefined): Map<string, string> {
  const kinds = new Map<string, string>();
  const options = Array.isArray(params?.options) ? params.options : [];
  for (const o of options) {
    const id = str(obj(o)?.optionId);
    if (id !== undefined) kinds.set(id, str(obj(o)?.kind) ?? "");
  }
  return kinds;
}

export class AcpRelay {
  private readonly prompts = new Map<string, Prompt>();
  /** Output updates seen per session. A prompt had output when the count grew after it was sent. */
  private readonly output = new Map<string, number>();
  /** Permission requests the client got and has not answered, by request id. */
  private readonly asked = new Map<string, PermissionAsked>();
  /** Per session: the option kind the client chose at once for its last permission request, or null when it did not. */
  private readonly autoAnswer = new Map<string, string | null>();
  /** Sessions that sent output while none of their prompts was open, and have not had a prompt with output since. */
  private readonly busyAlone = new Set<string>();
  /** The T3 MCP endpoint of a `session/new` request, until its answer gives the session id. */
  private readonly newSessions = new Map<string, McpEndpoint>();

  constructor(private readonly opts: RelayOptions = {}) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private promptOpen(sessionId: string): boolean {
    for (const p of this.prompts.values()) if (p.sessionId === sessionId) return true;
    return false;
  }

  /**
   * A line the client sends to the agent, seen before the agent gets it. It is never changed; a `session/prompt`
   * request is remembered, and the client's answer to a permission request is noted.
   */
  fromClient(line: string): void {
    if (this.asked.size > 0 && line.includes('"outcome"')) this.notePermissionAnswer(line);
    if (this.opts.limit && /"session\/(new|load|resume)"/.test(line)) this.noteSessionSetup(line);
    if (!line.includes('"session/prompt"')) return;
    let msg: Json | undefined;
    try {
      msg = obj(JSON.parse(line));
    } catch {
      return;
    }
    if (!msg || msg.method !== "session/prompt") return;
    const key = idKey(msg.id);
    const sessionId = str(obj(msg.params)?.sessionId);
    if (key === undefined || sessionId === undefined) return;
    let mark: unknown;
    try {
      mark = this.opts.adapter?.promptStarting?.(sessionId);
    } catch {
      mark = undefined;
    }
    this.prompts.set(key, { sessionId, mark, outputAtStart: this.output.get(sessionId) ?? 0 });
  }

  /** The T3 MCP server of a session setup request, kept in memory for the limit snooze. */
  private noteSessionSetup(line: string): void {
    let msg: Json | undefined;
    try {
      msg = obj(JSON.parse(line));
    } catch {
      return;
    }
    const params = obj(msg?.params);
    const endpoint = endpointFromServers(params?.mcpServers);
    if (!msg || !endpoint) return;
    if (msg.method === "session/new") {
      const key = idKey(msg.id);
      if (key !== undefined) this.newSessions.set(key, endpoint);
    } else if (msg.method === "session/load" || msg.method === "session/resume") {
      const sessionId = str(params?.sessionId);
      if (sessionId !== undefined) this.opts.limit?.setEndpoint(sessionId, endpoint);
    }
  }

  /** A failed prompt: a usage limit with a reset time snoozes the thread. Fire and forget. */
  private limitFailure(sessionId: string, text: string, status?: number, code?: string): void {
    this.opts.limit?.onFailure(sessionId, { text, ...(status !== undefined ? { status } : {}), ...(code !== undefined ? { code } : {}) });
  }

  /** A line the agent sent. Returns the lines the client gets: the same line, or the changed answer to a prompt. */
  async fromAgent(line: string): Promise<string[]> {
    if (this.prompts.size === 0 && this.newSessions.size === 0 && !line.includes('"session/')) return [line];
    let msg: Json | undefined;
    try {
      msg = obj(JSON.parse(line));
    } catch {
      return [line];
    }
    if (!msg) return [line];
    if (msg.method === "session/update") {
      const params = obj(msg.params);
      const kind = obj(params?.update)?.sessionUpdate;
      const sessionId = str(params?.sessionId);
      if (sessionId !== undefined && typeof kind === "string" && OUTPUT_UPDATES.has(kind)) {
        if (this.promptOpen(sessionId)) this.output.set(sessionId, (this.output.get(sessionId) ?? 0) + 1);
        else if (!this.busyAlone.has(sessionId)) {
          this.busyAlone.add(sessionId);
          this.opts.log?.("acp-relay: the agent sent output with no prompt open (a turn it started itself)");
        }
      }
      return [line];
    }
    if (msg.method === "session/request_permission") return this.permissionRequest(msg, line);
    if (msg.method !== undefined) return [line];
    const key = idKey(msg.id);
    const setup = key !== undefined ? this.newSessions.get(key) : undefined;
    if (key !== undefined && setup) {
      this.newSessions.delete(key);
      const sessionId = str(obj(msg.result)?.sessionId);
      if (sessionId !== undefined) this.opts.limit?.setEndpoint(sessionId, setup);
      return [line];
    }
    const prompt = key !== undefined ? this.prompts.get(key) : undefined;
    if (key === undefined || !prompt) return [line];
    this.prompts.delete(key);
    const hadOutput = (this.output.get(prompt.sessionId) ?? 0) > prompt.outputAtStart;
    if (!this.promptOpen(prompt.sessionId)) this.output.delete(prompt.sessionId);
    if (hadOutput) this.busyAlone.delete(prompt.sessionId);

    if (msg.error !== undefined) {
      const described = describeError(msg.error);
      const err = obj(msg.error);
      const errText = `${str(described?.message) ?? str(err?.message) ?? ""} ${errorDetail(err?.data) ?? ""}`.trim();
      this.limitFailure(prompt.sessionId, errText, undefined, err?.code !== undefined ? String(err.code) : undefined);
      if (!described) return [line];
      this.opts.log?.(`acp-relay: prompt error given its reason (code ${String(described.code)})`);
      return [JSON.stringify({ ...msg, error: described })];
    }
    if (obj(msg.result)?.stopReason !== "end_turn") return [line];

    let outcome: TurnOutcome;
    try {
      outcome = await this.opts.adapter?.turnOutcome?.(prompt.sessionId, prompt.mark);
    } catch {
      outcome = undefined;
    }
    if (outcome === "ok") return [line];
    const failure = outcome;
    if (failure) {
      this.limitFailure(prompt.sessionId, failure.message, failure.status, failure.code);
      this.opts.log?.(`acp-relay: failed turn reported as an error (${failure.code ?? "no code"}${failure.status !== undefined ? `, HTTP ${failure.status}` : ""})`);
      const data = { source: ERROR_SOURCE, ...(failure.code !== undefined ? { code: failure.code } : {}), ...(failure.status !== undefined ? { status: failure.status } : {}), ...(failure.retryable !== undefined ? { retryable: failure.retryable } : {}) };
      return [JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: TURN_FAILED_CODE, message: failureMessage(failure), data } })];
    }
    if (!hadOutput) {
      const busy = this.busyAlone.has(prompt.sessionId);
      this.opts.log?.(busy ? "acp-relay: empty turn while the agent is busy on its own, notice added" : "acp-relay: empty turn, notice added");
      const text = busy ? BUSY_TURN_NOTICE : EMPTY_TURN_NOTICE;
      const notice = { jsonrpc: "2.0", method: "session/update", params: { sessionId: prompt.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } };
      return [JSON.stringify(notice), line];
    }
    return [line];
  }

  /** A permission request from the agent: to the client inside a prompt, answered here outside one. */
  private permissionRequest(msg: Json, line: string): string[] {
    const params = obj(msg.params);
    const sessionId = str(params?.sessionId);
    const key = idKey(msg.id);
    if (sessionId === undefined || key === undefined) return [line];
    const kinds = optionKinds(params);
    if (this.promptOpen(sessionId) || !this.opts.toAgent) {
      this.asked.set(key, { sessionId, kinds, at: this.now() });
      return [line];
    }
    const want = this.autoAnswer.get(sessionId);
    const optionId = want ? [...kinds].find(([, k]) => k === want)?.[0] ?? [...kinds].find(([, k]) => k.startsWith("allow"))?.[0] : undefined;
    const outcome = optionId !== undefined ? { outcome: "selected", optionId } : { outcome: "cancelled" };
    this.opts.log?.(
      optionId !== undefined
        ? `acp-relay: permission asked with no prompt open, approved as the client approves this session (${want})`
        : "acp-relay: permission asked with no prompt open, nobody can answer: cancelled",
    );
    this.opts.toAgent(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { outcome } }));
    return [];
  }

  /** The client's answer to a permission request: notes whether this session's mode approves by itself. */
  private notePermissionAnswer(line: string): void {
    let msg: Json | undefined;
    try {
      msg = obj(JSON.parse(line));
    } catch {
      return;
    }
    if (!msg || msg.method !== undefined) return;
    const key = idKey(msg.id);
    const asked = key !== undefined ? this.asked.get(key) : undefined;
    if (key === undefined || !asked) return;
    this.asked.delete(key);
    const outcome = obj(obj(msg.result)?.outcome);
    const optionId = str(outcome?.optionId);
    const kind = outcome?.outcome === "selected" && optionId !== undefined ? asked.kinds.get(optionId) : undefined;
    const quick = this.now() - asked.at <= AUTO_ANSWER_MS;
    this.autoAnswer.set(asked.sessionId, kind !== undefined && kind.startsWith("allow") && quick ? kind : null);
  }
}
