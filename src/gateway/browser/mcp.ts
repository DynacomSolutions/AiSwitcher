import { createHash } from "node:crypto";
import { Hono } from "hono";
import { BROWSER_TOOLS, SESSION_END_TOOL } from "../../browser/protocol.ts";
import { BROWSER_INSTRUCTIONS, LATEST_VERSION, SUPPORTED_VERSIONS, errorResult, mapCallResult, type McpContent } from "../../browser/mcp-core.ts";
import { mcpTools } from "../../browser/tool-schemas.ts";
import { agentFromRequest, createBrowserCaller, type CallDeps } from "./routing.ts";

/**
 * The shared AIS Browser MCP server: MCP Streamable HTTP with JSON replies, served by the gateway at `/browser/mcp`.
 * It is stateless. Every request carries its own bearer token and session headers, so any replica can answer it.
 * `initialize`, `ping` and `tools/list` do nothing beyond the token check. `tools/call` runs the `/browser/call` code in-process.
 */

/** Largest request body in bytes: ten files of 10 MiB in base64 plus the envelope. */
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_LABEL = 80;
const MAX_LABEL_HEADER = 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const POOL = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/;

interface RpcMessage { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }

export interface McpHeaders {
  /** `X-AIS-Session-Id`, else the client's `Mcp-Session-Id`. Undefined when the client sent neither. */
  sessionId?: string;
  /** True when `sessionId` came from `Mcp-Session-Id`. */
  fromMcpSession: boolean;
  label: string;
  pool?: string;
}

export type ParsedMcpHeaders = { ok: true; value: McpHeaders } | { ok: false; error: string };

/** A readable label from a header value: percent-decoded, control characters dropped, white space collapsed, capped at 80 characters. */
export function cleanSessionLabel(raw: string): string {
  return raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_LABEL);
}

/** Validates the session headers. Never throws. */
export function parseMcpHeaders(get: (name: string) => string | null): ParsedMcpHeaders {
  const raw = (name: string): string | undefined => get(name)?.trim() || undefined;
  const xid = raw("x-ais-session-id");
  if (xid !== undefined && !ID.test(xid)) return { ok: false, error: "x-ais-session-id: invalid id" };
  const mid = raw("mcp-session-id");
  if (mid !== undefined && !ID.test(mid)) return { ok: false, error: "mcp-session-id: invalid id" };
  let label = "";
  const rawLabel = raw("x-ais-session-label");
  if (rawLabel !== undefined) {
    if (rawLabel.length > MAX_LABEL_HEADER) return { ok: false, error: "x-ais-session-label: too long" };
    try {
      label = cleanSessionLabel(decodeURIComponent(rawLabel));
    } catch {
      return { ok: false, error: "x-ais-session-label: bad encoding" };
    }
  }
  const pool = raw("x-ais-pool");
  if (pool !== undefined && !POOL.test(pool)) return { ok: false, error: "x-ais-pool: invalid name" };
  const sessionId = xid ?? mid;
  return { ok: true, value: { ...(sessionId ? { sessionId } : {}), fromMcpSession: xid === undefined && mid !== undefined, label, ...(pool ? { pool } : {}) } };
}

const shellQuote = (s: string): string => (/^[A-Za-z0-9_./:=@%+,-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);

/** The tool error for `upload_file` with `paths`: the gateway cannot read the agent's files, so the agent runs the CLI in its own shell. */
export function uploadPathsError(sessionId: string, args: Record<string, unknown>, label = ""): string {
  const tab = typeof args.tabId === "number" && Number.isInteger(args.tabId) ? String(args.tabId) : "<tabId>";
  const target = typeof args.ref === "string" && args.ref !== "" ? `--ref ${shellQuote(args.ref)}`
    : Array.isArray(args.coordinate) && args.coordinate.length === 2 && args.coordinate.every((n) => typeof n === "number") ? `--coordinate ${args.coordinate.join(",")}`
    : "(--ref <ref> | --coordinate <x,y>)";
  const browser = typeof args.browser === "string" && args.browser !== "" ? ` --browser ${shellQuote(args.browser)}` : "";
  const paths = Array.isArray(args.paths) && args.paths.length > 0 && args.paths.every((p) => typeof p === "string" && p !== "") ? (args.paths as string[]).map(shellQuote).join(" ") : "<paths...>";
  const name = label ? ` --label ${shellQuote(label)}` : "";
  return `bad_args: this server cannot read files on your machine, so it does not take paths. Run this command in your shell, then go on: ais browser upload --session ${shellQuote(sessionId)}${name} --tab ${tab} ${target}${browser} ${paths}`;
}

/** The launch fixes its token at start: a revoked or replaced token needs a new session. */
const UNAUTHORISED = "unauthorised: the agent token is unknown, revoked or replaced. Restart the session to pick up the new token.";

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** Key of an in-flight call. A hash, so it can travel between replicas without naming the identity or session. The identity is part of it: a cancel from another identity never matches. */
export function cancelKey(identity: string, sessionId: string, requestId: string | number): string {
  return createHash("sha256").update(JSON.stringify([identity, sessionId, requestId])).digest("hex");
}

function methodLabel(m: RpcMessage): string {
  if (typeof m.method !== "string") return "other";
  if (m.id === undefined || m.id === null) return "notification";
  return m.method === "initialize" || m.method === "ping" || m.method === "tools/list" || m.method === "tools/call" ? m.method : "other";
}

/** Routes mounted at /browser: `POST|DELETE /mcp`. `GET /mcp` is 405 (no event stream). */
export function createMcpRoutes(deps: CallDeps): Hono {
  const hono = new Hono();
  const caller = createBrowserCaller(deps);
  const count = (method: string, outcome: string): void => deps.metrics?.browserMcpRequest(method, outcome);
  /** In-flight tools/call requests on this replica, by cancel key. */
  const inflight = new Map<string, AbortController>();
  deps.hub.onCancel?.((key) => inflight.get(key)?.abort());

  /** The pool named in `X-AIS-Pool` must list the token's identity as a live member, as for `/browser/call` bindings. */
  async function poolAllows(pool: string | undefined, identity: string): Promise<boolean> {
    if (!pool) return true;
    return ((await deps.browserPoolMembers?.(pool)) ?? []).includes(identity);
  }

  async function toolCall(identity: string, h: McpHeaders, sessionId: string | undefined, p: Record<string, unknown>, signal: AbortSignal): Promise<{ isError?: true; content: McpContent[] }> {
    const name = String(p.name ?? "");
    if (!(BROWSER_TOOLS as readonly string[]).includes(name)) return errorResult(`bad_args: unknown tool ${name}`);
    if (!sessionId) return errorResult("bad_args: no session id. Send the X-AIS-Session-Id header or the Mcp-Session-Id header.");
    if (!(await poolAllows(h.pool, identity))) return errorResult(`forbidden: this token is not a member of pool ${h.pool}. The launch uses the token it started with: if the member was removed, retired or got a new token, restart the session to pick up the new token.`);
    const { browser, ...args } = (typeof p.arguments === "object" && p.arguments !== null && !Array.isArray(p.arguments) ? p.arguments : {}) as Record<string, unknown>;
    if (name === "upload_file" && args.paths !== undefined) return errorResult(uploadPathsError(sessionId, { ...args, ...(typeof browser === "string" ? { browser } : {}) }, h.label));
    const out = await caller(identity, { ...(typeof browser === "string" ? { browser } : {}), session: { id: sessionId, identity, label: h.label }, tool: name, args }, signal);
    if ("error" in out.body && !("ok" in out.body)) return errorResult(`${out.status === 400 ? "bad_args" : out.status === 403 ? "forbidden" : "internal"}: ${out.body.error}`);
    return mapCallResult(out.body as Parameters<typeof mapCallResult>[0]);
  }

  /** Handles one JSON-RPC message; undefined for notifications. `outcome` is set for the metric. */
  async function rpc(msg: RpcMessage, identity: string, h: McpHeaders, sessionId: string | undefined, signal: AbortSignal): Promise<{ reply?: object; outcome: string }> {
    const reply = (result: unknown): object => ({ jsonrpc: "2.0", id: msg.id ?? null, result });
    if (msg.method === "notifications/cancelled") {
      const rid = msg.params?.requestId;
      if (sessionId && (typeof rid === "string" || typeof rid === "number")) {
        const key = cancelKey(identity, sessionId, rid);
        inflight.get(key)?.abort();
        // The call may run on another replica.
        deps.hub.broadcastCancel?.(key);
      }
      return { outcome: "ok" };
    }
    if (typeof msg.method !== "string" || msg.id === undefined || msg.id === null) return { outcome: "ok" };
    switch (msg.method) {
      case "initialize":
        return { outcome: "ok", reply: reply({ protocolVersion: SUPPORTED_VERSIONS.includes(String(msg.params?.protocolVersion)) ? msg.params?.protocolVersion : LATEST_VERSION, capabilities: { tools: {} }, serverInfo: { name: "ais-browser", version: "1" }, instructions: BROWSER_INSTRUCTIONS }) };
      case "ping":
        return { outcome: "ok", reply: reply({}) };
      case "tools/list":
        return { outcome: "ok", reply: reply({ tools: mcpTools() }) };
      case "tools/call": {
        // A client cancels with a separate `notifications/cancelled`, so the call is registered under (identity, session, request id).
        const ac = new AbortController();
        const key = sessionId ? cancelKey(identity, sessionId, msg.id) : undefined;
        if (key) inflight.set(key, ac);
        try {
          const result = await toolCall(identity, h, sessionId, msg.params ?? {}, AbortSignal.any([signal, ac.signal]));
          return { outcome: result.isError ? "tool_error" : "ok", reply: reply(result) };
        } finally {
          if (key && inflight.get(key) === ac) inflight.delete(key);
        }
      }
      default:
        return { outcome: "bad_request", reply: { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } } };
    }
  }

  hono.get("/mcp", (c) => {
    count("get", "bad_request");
    return c.json({ error: "this server has no event stream" }, 405, { allow: "POST, DELETE" });
  });

  hono.post("/mcp", async (c) => {
    const req = c.req.raw;
    const a = await agentFromRequest(deps, req);
    if (!a) {
      count("other", "unauthorised");
      return json(401, { error: UNAUTHORISED }, { "www-authenticate": "Bearer" });
    }
    const parsedHeaders = parseMcpHeaders((n) => req.headers.get(n));
    if (!parsedHeaders.ok) {
      count("other", "bad_request");
      return json(400, { error: parsedHeaders.error });
    }
    const h = parsedHeaders.value;
    // Refuse on the declared length before reading, then count bytes (not characters) of what was read.
    const declared = Number(req.headers.get("content-length"));
    const text = declared > MAX_BODY_BYTES ? undefined : await req.text();
    if (text === undefined || Buffer.byteLength(text) > MAX_BODY_BYTES) {
      count("other", "bad_request");
      return json(413, { error: "request too large" });
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      count("other", "bad_request");
      return json(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    }
    const messages = Array.isArray(body) ? body : [body];
    if (messages.length === 0 || messages.some((m) => typeof m !== "object" || m === null || Array.isArray(m))) {
      count("other", "bad_request");
      return json(400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } });
    }
    // The client has no session id: an initialize reply issues one. The client sends it back as `Mcp-Session-Id` from then on.
    const issued = h.sessionId === undefined && (messages as RpcMessage[]).some((m) => m.method === "initialize") ? crypto.randomUUID() : undefined;
    const sessionId = h.sessionId ?? issued;
    const replies: object[] = [];
    await Promise.all((messages as RpcMessage[]).map(async (msg) => {
      const out = await rpc(msg, a.identity, h, sessionId, req.signal).catch((e: unknown) => ({ outcome: "error", reply: { jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } } }));
      count(methodLabel(msg), out.outcome);
      if (out.reply) replies.push(out.reply);
    }));
    // `initialize` always names the session, so the client sends it back as `Mcp-Session-Id` and its `DELETE` ends the right session.
    const extra: Record<string, string> = sessionId && (messages as RpcMessage[]).some((m) => m.method === "initialize") ? { "mcp-session-id": sessionId } : {};
    if (replies.length === 0) return new Response(null, { status: 202, headers: extra });
    return json(200, Array.isArray(body) ? replies : replies[0], extra);
  });

  hono.delete("/mcp", async (c) => {
    const req = c.req.raw;
    const a = await agentFromRequest(deps, req);
    if (!a) {
      count("delete", "unauthorised");
      return json(401, { error: UNAUTHORISED }, { "www-authenticate": "Bearer" });
    }
    const parsedHeaders = parseMcpHeaders((n) => req.headers.get(n));
    if (!parsedHeaders.ok || !parsedHeaders.value.sessionId) {
      count("delete", "bad_request");
      return json(400, { error: parsedHeaders.ok ? "no session id: send X-AIS-Session-Id or Mcp-Session-Id" : parsedHeaders.error });
    }
    const h = parsedHeaders.value;
    if (!(await poolAllows(h.pool, a.identity))) {
      count("delete", "forbidden");
      return json(403, { error: "not a member of that pool. Restart the session to pick up the new token." });
    }
    // The extension closes the tabs this session created. The notice is best-effort, as the stdio shim's end notice was.
    await caller(a.identity, { session: { id: h.sessionId, identity: a.identity, label: h.label }, tool: SESSION_END_TOOL, args: {} }, req.signal).catch(() => undefined);
    count("delete", "ok");
    return new Response(null, { status: 204 });
  });

  hono.all("/mcp", (c) => {
    count("other", "bad_request");
    return c.json({ error: "method not allowed" }, 405, { allow: "POST, DELETE" });
  });

  return hono;
}
