import { Hono } from "hono";
import { BROWSER_TOOLS, SESSION_END_TOOL, DEFAULT_CALL_TIMEOUT_MS, UPLOAD_CALL_TIMEOUT_MS, WAIT_CALL_TIMEOUT_MS, type BrowserErrorCode, type BrowserTool, type CallRequest, type CallResult } from "../../browser/protocol.ts";
import { shortSessionId } from "../../browser/session-label.ts";
import { validateToolArgs } from "../../browser/tool-args.ts";
import type { BrowserBinding } from "../../browser/types.ts";
import type { GatewayMetrics } from "../metrics.ts";
import type { ChatAuth } from "./chat-auth.ts";
import { authAgentToken } from "./auth.ts";
import type { BrowserHub } from "./hub.ts";
import type { BrowserDeps } from "./deps.ts";

/** Connected bindings an identity may use: pinned to it, or bound to a pool it currently belongs to. */
export async function allowedBindings(identity: string, connected: BrowserBinding[], poolMembers: (pool: string) => Promise<string[]>): Promise<BrowserBinding[]> {
  const out: BrowserBinding[] = [];
  for (const b of connected) {
    if (b.target.kind === "identity") {
      if (b.target.identity === identity) out.push(b);
    } else if ((await poolMembers(b.target.pool)).includes(identity)) out.push(b);
  }
  return out;
}

/**
 * Session sent to the extension. Identity bindings keep the caller's real identity. A pool
 * binding owns tabs per pool, not per member (the active member changes on every swap), so the
 * identity is `pool:<P>` and the tab group title is the session name alone; the caller was already checked
 * to be a live member of P.
 */
export function forwardedSession(b: BrowserBinding, identity: string, id: string, label: string): { id: string; identity: string; label: string } {
  if (b.target.kind !== "pool") return { id, identity, label };
  return { id, identity: `pool:${b.target.pool}`, label: (label || shortSessionId(id)).slice(0, 80) };
}

/** A chat call may use one binding and the tabs linked to the chat. Nothing else. */
export interface CallScope { binding: string; color: string; linked: ReadonlySet<number> }

/** Session ids that start with this belong to chats. Only a chat token may use them. */
const RESERVED_SESSION_PREFIX = "chat:";
export const usesReservedSessionId = (id: string): boolean => id.toLowerCase().startsWith(RESERVED_SESSION_PREFIX);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);


/** The hub surface the call routes need. The cluster hub adds cancel fan-out between replicas. */
export type CallHub = Pick<BrowserHub, "connected" | "call" | "abort" | "revoke" | "extensionVersion"> & {
  /** Tells the other replicas to abort the in-flight MCP call with this key (the call may run on any replica). */
  broadcastCancel?(key: string): void;
  /** Registers the handler for cancels that arrive from other replicas. */
  onCancel?(handler: (key: string) => void): void;
};

export interface CallDeps extends BrowserDeps {
  hub: CallHub;
  metrics?: GatewayMetrics;
  /** Resolves per-chat tokens. Without it, every chat token is refused. */
  chat?: ChatAuth;
}

/** An HTTP-shaped answer: `/browser/call` returns it as is, the MCP endpoint reads the `CallResult` out of it. */
export interface CallOutcome { status: number; body: CallResult | { error: string } }

/** The identity behind `Authorization: Bearer <agent token>`, or undefined. Shared by `/browser/call` and `/browser/mcp`. */
export async function agentFromRequest(deps: Pick<BrowserDeps, "store">, req: Request): Promise<{ identity: string } | undefined> {
  const m = /^Bearer (.+)$/i.exec(req.headers.get("authorization") ?? "");
  return m?.[1] ? authAgentToken(deps.store, m[1].trim()) : undefined;
}

/**
 * The call path behind `POST /browser/call`, as a function: the MCP endpoint runs the same code in-process.
 * `body` is the untrusted `{browser?, session, tool, args}` object. Tool-level failures are status 200 with `ok:false`.
 */
export function createBrowserCaller(deps: CallDeps): (identity: string, body: unknown, signal?: AbortSignal, scope?: CallScope) => Promise<CallOutcome> {
  const fail = (id: string, tool: string, error: BrowserErrorCode, message: string): CallOutcome => {
    deps.metrics?.browserCall(tool, error, 0);
    return { status: 200, body: { id, ok: false, error, message } };
  };
  const reject = (status: number, error: string): CallOutcome => ({ status, body: { error } });
  const poolMembers = async (pool: string): Promise<string[]> => (await deps.browserPoolMembers?.(pool)) ?? [];

  return async (identity, body, signal, scope) => {
    if (!isObj(body) || !isObj(body.session) || typeof body.session.id !== "string" || body.session.id === "" || body.session.id.length > 128) return reject(400, "session.id is required");
    if (!scope && usesReservedSessionId(body.session.id)) return reject(400, "reserved session id prefix");
    const tool = body.tool;
    if (typeof tool !== "string" || (tool !== SESSION_END_TOOL && !(BROWSER_TOOLS as readonly string[]).includes(tool))) return reject(400, "unknown tool");
    if (body.args !== undefined && !isObj(body.args)) return reject(400, "args must be an object");
    if (body.browser !== undefined && typeof body.browser !== "string") return reject(400, "browser must be a string");
    const id = crypto.randomUUID();
    const args = (body.args ?? {}) as Record<string, unknown>;
    // An upload carries file content only. A path (or anything else outside the schema) and an oversized upload stop here, before any browser sees them.
    if (tool === "upload_file") {
      const invalid = validateToolArgs("upload_file", args);
      if (invalid) return reject(400, invalid);
    }
    const label = typeof body.session.label === "string" ? body.session.label.slice(0, 80) : "";

    const connected = deps.hub.connected();
    // A chat scope replaces the identity rules: the one binding that made the chat, and only if it is connected.
    const allowed = scope ? connected.filter((b) => b.name === scope.binding) : await allowedBindings(identity, connected, poolMembers);
    if (scope && tool !== "list_browsers" && tool !== SESSION_END_TOOL) {
      if (tool === "tabs_create" && args.groupId !== undefined) return fail(id, tool, "forbidden_tab", "A chat cannot open a tab in a granted group.");
      if ("tabId" in args) {
        const t = args.tabId;
        if (typeof t !== "number" || !scope.linked.has(t)) return fail(id, tool, "forbidden_tab", `Tab ${typeof t === "number" || typeof t === "string" ? String(t).slice(0, 40) : "(invalid)"} is not linked to this chat.`);
      }
    }
    const session = (b: BrowserBinding, sid: string): CallRequest["session"] => ({ ...forwardedSession(b, identity, sid, label), ...(scope ? { color: scope.color, chat: true as const } : {}) });
    if (tool === "list_browsers") {
      deps.metrics?.browserCall(tool, "ok", 0);
      return { status: 200, body: { id, ok: true, content: [{ type: "text", text: JSON.stringify(allowed.map(summary)) }] } satisfies CallResult };
    }
    if (tool === SESSION_END_TOOL) {
      const sessionId = body.session.id;
      // Best-effort notice: tell the named browser, else every browser this identity may drive (the caller cannot know which one holds the session's tabs).
      const targets = !scope && typeof body.browser === "string" ? allowed.filter((b) => b.name === body.browser) : allowed;
      await Promise.all(targets.map((b) => deps.hub.call(b.name, { id: crypto.randomUUID(), session: session(b, sessionId), tool: SESSION_END_TOOL, args }, 5_000).catch(() => undefined)));
      deps.metrics?.browserCall(tool, "ok", 0);
      return { status: 200, body: { id, ok: true, content: [{ type: "text", text: "ok" }] } satisfies CallResult };
    }
    let chosen: BrowserBinding | undefined;
    if (scope) {
      // The `browser` argument is ignored: a chat has one browser.
      chosen = allowed[0];
      if (!chosen) return fail(id, tool, "no_browser", "The browser of this chat is not connected.");
    } else if (typeof body.browser === "string") {
      chosen = allowed.find((b) => b.name === body.browser);
      if (!chosen) {
        if (connected.some((b) => b.name === body.browser)) return reject(403, "browser not available to this identity");
        return fail(id, tool, "no_browser", "That browser is not connected.");
      }
    } else if (allowed.length === 0) {
      return fail(id, tool, "no_browser", "No browser is bound to this identity and connected.");
    } else if (allowed.length > 1) {
      return fail(id, tool, "ambiguous_browser", `Several browsers are connected (${allowed.map((b) => b.name).join(", ")}); pass \`browser\`.`);
    } else chosen = allowed[0];
    if (!chosen) return fail(id, tool, "no_browser", "No browser is bound to this identity and connected.");

    const onAbort = (): void => deps.hub.abort(id);
    signal?.addEventListener("abort", onAbort, { once: true });
    const result = await deps.hub.call(
      chosen.name,
      { id, session: session(chosen, body.session.id), tool: tool as BrowserTool, args },
      tool === "wait" ? WAIT_CALL_TIMEOUT_MS + 5_000 : tool === "upload_file" ? UPLOAD_CALL_TIMEOUT_MS : DEFAULT_CALL_TIMEOUT_MS,
    );
    signal?.removeEventListener("abort", onAbort);
    return { status: 200, body: result };
  };
}

const summary = (b: BrowserBinding) => ({ name: b.name, profileLabel: b.profileLabel, target: b.target });

/** Agent routes, mounted at /browser. Tool-level failures are 200 with `ok:false`; HTTP errors are for auth and malformed requests. */
export function createCallRoutes(deps: CallDeps): Hono {
  const hono = new Hono();
  const caller = createBrowserCaller(deps);
  hono.post("/call", async (c) => {
    const a = await agentFromRequest(deps, c.req.raw);
    if (!a) return c.json({ error: "unauthorised" }, 401);
    let body: unknown;
    try {
      body = JSON.parse(await c.req.text());
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    const out = await caller(a.identity, body, c.req.raw.signal);
    return c.json(out.body, out.status as 200);
  });
  return hono;
}
