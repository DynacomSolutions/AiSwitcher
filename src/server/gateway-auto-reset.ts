import type { Hono } from "hono";
import { CODEX_AUTO_RESET_PATH } from "../gateway/auto-reset-view.ts";
import { gatewayAdminConfig } from "./gateway-apps.ts";
import { HttpError } from "./types.ts";

export interface GatewayAutoResetDeps {
  adminConfig?: typeof gatewayAdminConfig;
  fetch?: typeof fetch;
}

export function registerGatewayAutoReset(app: Hono, deps: GatewayAutoResetDeps = {}): void {
  const noCache = { headers: { "cache-control": "no-store" } };
  async function request(method: "GET" | "PUT", kind?: string, body?: unknown): Promise<Response> {
    const admin = await (deps.adminConfig ?? gatewayAdminConfig)({});
    if (!admin) {
      if (method === "GET") return Response.json({ configured: false }, noCache);
      throw new HttpError(503, "gateway admin is not configured on this console");
    }
    let response: Response;
    try {
      response = await (deps.fetch ?? fetch)(`${admin.url}${CODEX_AUTO_RESET_PATH}${kind !== undefined ? `/${kind}` : ""}`, {
        method,
        headers: { authorization: `Bearer ${admin.token}`, "content-type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      });
    } catch {
      throw new HttpError(502, "gateway admin unreachable");
    }
    if (response.status === 404 && method === "GET") return Response.json({ configured: false }, noCache);
    const result = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
    if (!response.ok || !result) {
      const status = [400, 404, 503].includes(response.status) ? response.status : 502;
      throw new HttpError(status, typeof result?.error === "string" ? result.error.slice(0, 300) : `gateway admin answered ${response.status}`);
    }
    return Response.json(method === "GET" ? { ...result, configured: true } : result, noCache);
  }

  app.get(`/api${CODEX_AUTO_RESET_PATH}`, () => request("GET"));
  app.put(`/api${CODEX_AUTO_RESET_PATH}/:kind`, async (c) => {
    const kind = c.req.param("kind");
    if (kind !== "pool" && kind !== "identity") throw new HttpError(400, "scope must be pool or identity");
    const body = await c.req.json().catch(() => undefined);
    if (typeof body?.name !== "string" || typeof body?.enabled !== "boolean") throw new HttpError(400, "name and boolean enabled are required");
    return request("PUT", kind, { name: body.name, enabled: body.enabled });
  });
}
