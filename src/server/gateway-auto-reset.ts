import type { Hono } from "hono";
import { CODEX_AUTO_RESET_PATH } from "../gateway/auto-reset-view.ts";
import { gatewayAdminConfig } from "./gateway-apps.ts";
import { HttpError } from "./types.ts";

export interface GatewayAutoResetDeps {
  adminConfig?: typeof gatewayAdminConfig;
  fetch?: typeof fetch;
}

export function createGatewayAutoResetRequest(deps: GatewayAutoResetDeps = {}) {
  return async function request(method: "GET" | "PUT", body?: { name: string; enabled: boolean }): Promise<Record<string, unknown>> {
    const admin = await (deps.adminConfig ?? gatewayAdminConfig)({});
    if (!admin) {
      if (method === "GET") return { configured: false };
      throw new HttpError(503, "gateway admin is not configured on this console");
    }
    let response: Response;
    try {
      response = await (deps.fetch ?? fetch)(`${admin.url}${CODEX_AUTO_RESET_PATH}${method === "PUT" ? "/pool" : ""}`, {
        method,
        headers: { authorization: `Bearer ${admin.token}`, "content-type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      });
    } catch {
      throw new HttpError(502, "gateway admin unreachable");
    }
    if (response.status === 404 && method === "GET") return { configured: false };
    const result = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
    if (!response.ok || !result) {
      const status = [400, 404, 503].includes(response.status) ? response.status : 502;
      throw new HttpError(status, typeof result?.error === "string" ? result.error.slice(0, 300) : `gateway admin answered ${response.status}`);
    }
    return method === "GET" ? { pools: result.pools, configured: true } : result;
  };
}

export function registerGatewayAutoReset(
  app: Hono,
  request: ReturnType<typeof createGatewayAutoResetRequest>,
  events: { read(): Promise<unknown>; changed(): void },
): void {
  const headers = { "cache-control": "no-store" };
  app.get(`/api${CODEX_AUTO_RESET_PATH}`, async (c) => c.json(await events.read(), 200, headers));
  app.put(`/api${CODEX_AUTO_RESET_PATH}/pool`, async (c) => {
    const body = await c.req.json().catch(() => undefined);
    if (typeof body?.name !== "string" || typeof body?.enabled !== "boolean") throw new HttpError(400, "name and boolean enabled are required");
    const result = await request("PUT", { name: body.name, enabled: body.enabled });
    events.changed();
    return c.json(result, 200, headers);
  });
}
