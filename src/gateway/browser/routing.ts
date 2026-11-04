import { Hono } from "hono";
import { BROWSER_TOOLS, DEFAULT_CALL_TIMEOUT_MS, WAIT_CALL_TIMEOUT_MS, type BrowserErrorCode, type BrowserTool, type CallResult } from "../../browser/protocol.ts";
import type { BrowserBinding } from "../../browser/types.ts";
import type { GatewayMetrics } from "../metrics.ts";
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

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);


export interface CallDeps extends BrowserDeps {
  hub: BrowserHub;
  metrics?: GatewayMetrics;
}

/** Agent routes, mounted at /browser. Tool-level failures are 200 with `ok:false`; HTTP errors are for auth and malformed requests. */
export function createCallRoutes(deps: CallDeps): Hono {
  const hono = new Hono();
  const fail = (id: string, tool: string, error: BrowserErrorCode, message: string): CallResult => {
    deps.metrics?.browserCall(tool, error, 0);
    return { id, ok: false, error, message };
  };
  const poolMembers = async (pool: string): Promise<string[]> => (await deps.browserPoolMembers?.(pool)) ?? [];

  async function agent(req: Request): Promise<{ identity: string } | undefined> {
    const m = /^Bearer (.+)$/i.exec(req.headers.get("authorization") ?? "");
    return m?.[1] ? authAgentToken(deps.store, m[1].trim()) : undefined;
  }
  const summary = (b: BrowserBinding) => ({ name: b.name, profileLabel: b.profileLabel, target: b.target });

  hono.get("/list", async (c) => {
    const a = await agent(c.req.raw);
    if (!a) return c.json({ error: "unauthorised" }, 401);
    const allowed = await allowedBindings(a.identity, deps.hub.connected(), poolMembers);
    return c.json({ browsers: allowed.map(summary) });
  });

  hono.post("/call", async (c) => {
    const a = await agent(c.req.raw);
    if (!a) return c.json({ error: "unauthorised" }, 401);
    let body: unknown;
    try {
      body = JSON.parse(await c.req.text());
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    if (!isObj(body) || !isObj(body.session) || typeof body.session.id !== "string" || body.session.id === "" || body.session.id.length > 128) return c.json({ error: "session.id is required" }, 400);
    const tool = body.tool;
    if (typeof tool !== "string" || !(BROWSER_TOOLS as readonly string[]).includes(tool)) return c.json({ error: "unknown tool" }, 400);
    if (body.args !== undefined && !isObj(body.args)) return c.json({ error: "args must be an object" }, 400);
    if (body.browser !== undefined && typeof body.browser !== "string") return c.json({ error: "browser must be a string" }, 400);
    const id = crypto.randomUUID();
    const args = (body.args ?? {}) as Record<string, unknown>;
    const label = typeof body.session.label === "string" ? body.session.label.slice(0, 80) : "";

    const connected = deps.hub.connected();
    const allowed = await allowedBindings(a.identity, connected, poolMembers);
    if (tool === "list_browsers") {
      deps.metrics?.browserCall(tool, "ok", 0);
      return c.json({ id, ok: true, content: [{ type: "text", text: JSON.stringify(allowed.map(summary)) }] } satisfies CallResult);
    }
    let chosen: BrowserBinding | undefined;
    if (typeof body.browser === "string") {
      chosen = allowed.find((b) => b.name === body.browser);
      if (!chosen) {
        if (connected.some((b) => b.name === body.browser)) return c.json({ error: "browser not available to this identity" }, 403);
        return c.json(fail(id, tool, "no_browser", "That browser is not connected."));
      }
    } else if (allowed.length === 0) {
      return c.json(fail(id, tool, "no_browser", "No browser is bound to this identity and connected."));
    } else if (allowed.length > 1) {
      return c.json(fail(id, tool, "ambiguous_browser", `Several browsers are connected (${allowed.map((b) => b.name).join(", ")}); pass \`browser\`.`));
    } else chosen = allowed[0];
    if (!chosen) return c.json(fail(id, tool, "no_browser", "No browser is bound to this identity and connected."));

    const onAbort = (): void => deps.hub.abort(id);
    c.req.raw.signal.addEventListener("abort", onAbort, { once: true });
    const result = await deps.hub.call(
      chosen.name,
      { id, session: { id: body.session.id, identity: a.identity, label }, tool: tool as BrowserTool, args },
      tool === "wait" ? WAIT_CALL_TIMEOUT_MS + 5_000 : DEFAULT_CALL_TIMEOUT_MS,
    );
    c.req.raw.signal.removeEventListener("abort", onAbort);
    return c.json(result);
  });

  return hono;
}
