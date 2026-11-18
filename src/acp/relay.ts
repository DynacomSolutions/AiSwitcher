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
 * - an `end_turn` after a turn with no output at all, and no known failure, is kept, preceded by a notice the user can see.
 *
 * Every other line passes unchanged, byte for byte. A line this code cannot read passes unchanged too.
 */
import { redactText } from "../gateway/upstream-error.ts";

/** Why a turn failed, from the agent's own records. */
export interface TurnFailure {
  message: string;
  /** The agent's error code (`provider.api_error`). */
  code?: string;
  /** The provider's HTTP status. */
  status?: number;
  retryable?: boolean;
}

/** What the relay knows about one agent beyond the protocol. */
export interface RelayAdapter {
  /** The failure of the turn that started at `startedAtMs` in `sessionId`, when the agent recorded one. */
  turnFailure?(sessionId: string, startedAtMs: number): Promise<TurnFailure | undefined>;
}

export interface RelayOptions {
  adapter?: RelayAdapter;
  now?: () => number;
  /** One line per changed answer, for the agent's stderr log. Never carries prompt or reply text. */
  log?: (line: string) => void;
}

/** JSON-RPC "internal error": the code agents use for a failed provider call. */
export const TURN_FAILED_CODE = -32603;
export const ERROR_SOURCE = "ais-acp-relay";
export const EMPTY_TURN_NOTICE = "[No reply: the agent ended this turn without any output and gave no reason.]";
const MESSAGE_MAX = 500;

/** Session updates that are output of the turn (text, thinking, tools, a plan). */
const OUTPUT_UPDATES = new Set(["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "plan"]);
const GENERIC_MESSAGE = /^(internal error|unknown error|error|request failed)\.?$/i;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);

interface Prompt {
  sessionId: string;
  startedAtMs: number;
  output: number;
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

export class AcpRelay {
  private readonly prompts = new Map<string, Prompt>();
  /** The prompt in flight for each session. */
  private readonly active = new Map<string, string>();
  private readonly now: () => number;

  constructor(private readonly opts: RelayOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  /** A line the client sent to the agent. It is never changed; a `session/prompt` request is remembered. */
  fromClient(line: string): void {
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
    this.prompts.set(key, { sessionId, startedAtMs: this.now(), output: 0 });
    this.active.set(sessionId, key);
  }

  /** A line the agent sent. Returns the lines the client gets: the same line, or the changed answer to a prompt. */
  async fromAgent(line: string): Promise<string[]> {
    if (this.prompts.size === 0) return [line];
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
      const key = this.active.get(str(params?.sessionId) ?? "");
      const prompt = key !== undefined ? this.prompts.get(key) : undefined;
      if (prompt && typeof kind === "string" && OUTPUT_UPDATES.has(kind)) prompt.output++;
      return [line];
    }
    if (msg.method !== undefined) return [line];
    const key = idKey(msg.id);
    const prompt = key !== undefined ? this.prompts.get(key) : undefined;
    if (key === undefined || !prompt) return [line];
    this.prompts.delete(key);
    if (this.active.get(prompt.sessionId) === key) this.active.delete(prompt.sessionId);

    if (msg.error !== undefined) {
      const described = describeError(msg.error);
      if (!described) return [line];
      this.opts.log?.(`acp-relay: prompt error given its reason (code ${String(described.code)})`);
      return [JSON.stringify({ ...msg, error: described })];
    }
    if (obj(msg.result)?.stopReason !== "end_turn") return [line];

    let failure: TurnFailure | undefined;
    try {
      failure = await this.opts.adapter?.turnFailure?.(prompt.sessionId, prompt.startedAtMs);
    } catch {
      failure = undefined;
    }
    if (failure) {
      this.opts.log?.(`acp-relay: failed turn reported as an error (${failure.code ?? "no code"}${failure.status !== undefined ? `, HTTP ${failure.status}` : ""})`);
      const data = { source: ERROR_SOURCE, ...(failure.code !== undefined ? { code: failure.code } : {}), ...(failure.status !== undefined ? { status: failure.status } : {}), ...(failure.retryable !== undefined ? { retryable: failure.retryable } : {}) };
      return [JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: TURN_FAILED_CODE, message: failureMessage(failure), data } })];
    }
    if (prompt.output === 0) {
      this.opts.log?.("acp-relay: empty turn, notice added");
      const notice = { jsonrpc: "2.0", method: "session/update", params: { sessionId: prompt.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: EMPTY_TURN_NOTICE } } } };
      return [JSON.stringify(notice), line];
    }
    return [line];
  }
}
