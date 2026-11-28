import type { Hono } from "hono";
import { parseResetLogQuery, type ResetLogPage } from "../gateway/reset-log.ts";
import { gatewayAdminConfig } from "./gateway-apps.ts";
import { HttpError } from "./types.ts";

export interface GatewayResetLogDeps {
  adminConfig?: typeof gatewayAdminConfig;
  fetch?: typeof fetch;
}

/** The query keys that the console passes to the gateway. Any other key is dropped. */
const QUERY_KEYS = ["identity", "provider", "trigger", "outcome", "from", "to", "limit", "before"] as const;

/**
 * GET /api/logs/resets: the reset log of the gateway (every reset attempt, newest first).
 * The console checks the query, then asks the gateway admin API (`GET /reset-log`). Without a gateway admin it answers an empty page.
 */
export function registerGatewayResetLog(app: Hono, deps: GatewayResetLogDeps = {}): void {
  app.get("/api/logs/resets", async (c) => {
    const problem = parseResetLogQuery((name) => c.req.query(name));
    if (typeof problem === "string") throw new HttpError(400, problem);
    const params = new URLSearchParams();
    for (const key of QUERY_KEYS) {
      const value = c.req.query(key)?.trim();
      if (value) params.set(key, value);
    }
    const admin = await (deps.adminConfig ?? gatewayAdminConfig)({});
    const headers = { "cache-control": "no-store" };
    if (!admin) return c.json({ rows: [], nextBefore: null, identities: [], configured: false }, 200, headers);
    let response: Response;
    try {
      response = await (deps.fetch ?? fetch)(`${admin.url}/reset-log${params.size ? `?${params}` : ""}`, {
        headers: { authorization: `Bearer ${admin.token}` },
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      });
    } catch {
      throw new HttpError(502, "gateway admin unreachable");
    }
    const body = await response.json().catch(() => undefined) as (Partial<ResetLogPage> & { error?: unknown }) | undefined;
    if (!response.ok) {
      const status = [400, 404, 503].includes(response.status) ? response.status : 502;
      throw new HttpError(status, typeof body?.error === "string" ? body.error.slice(0, 300) : `gateway admin answered ${response.status}`);
    }
    if (!body || !Array.isArray(body.rows) || !Array.isArray(body.identities)) throw new HttpError(502, "the gateway reset log answer was invalid");
    return c.json({ rows: body.rows, nextBefore: body.nextBefore ?? null, identities: body.identities, configured: true }, 200, headers);
  });
}
