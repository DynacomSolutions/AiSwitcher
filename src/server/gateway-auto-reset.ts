import type { Hono } from "hono";
import { AUTO_RESET_PATH, AUTO_RESET_UNSUPPORTED, isAutoResetProvider } from "../gateway/auto-reset-view.ts";
import { gatewayAdminConfig } from "./gateway-apps.ts";
import { HttpError } from "./types.ts";

export interface GatewayAutoResetDeps {
  adminConfig?: typeof gatewayAdminConfig;
  fetch?: typeof fetch;
}

/** Reads or sets automatic reset through the gateway admin API. `path` is the admin path, for example `/limits/auto-reset`. */
export function createGatewayAutoResetRequest(deps: GatewayAutoResetDeps = {}) {
  return async function request(method: "GET" | "PUT", path: string = AUTO_RESET_PATH, body?: unknown): Promise<Record<string, unknown>> {
    const admin = await (deps.adminConfig ?? gatewayAdminConfig)({});
    if (!admin) {
      if (method === "GET") return { configured: false };
      throw new HttpError(503, "gateway admin is not configured on this console");
    }
    let response: Response;
    try {
      response = await (deps.fetch ?? fetch)(`${admin.url}${path}`, {
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
      const status = [400, 404, 410, 503].includes(response.status) ? response.status : 502;
      throw new HttpError(status, typeof result?.error === "string" ? result.error.slice(0, 300) : `gateway admin answered ${response.status}`);
    }
    return method === "GET" ? { ...result, configured: true } : result;
  };
}

const knownProvider = (provider: string): boolean =>
  isAutoResetProvider(provider) || (AUTO_RESET_UNSUPPORTED as readonly string[]).includes(provider);

export function registerGatewayAutoReset(
  app: Hono,
  request: ReturnType<typeof createGatewayAutoResetRequest>,
  events: { read(): Promise<unknown>; changed(): void },
): void {
  const headers = { "cache-control": "no-store" };
  app.get(`/api${AUTO_RESET_PATH}`, async (c) => c.json(await events.read(), 200, headers));
  app.get("/api/limits/:provider/auto-reset", async (c) => {
    const provider = c.req.param("provider");
    if (!knownProvider(provider)) throw new HttpError(404, "no such provider");
    return c.json(await request("GET", `/limits/${provider}/auto-reset`), 200, headers);
  });
  app.put("/api/limits/:provider/auto-reset/:kind", async (c) => {
    const provider = c.req.param("provider");
    if (!knownProvider(provider)) throw new HttpError(404, "no such provider");
    const kind = c.req.param("kind");
    // The gateway answers an identity setting with a clear error. The console passes that answer through.
    if (kind !== "pool" && kind !== "identity") throw new HttpError(400, "scope must be pool");
    const body = await c.req.json().catch(() => undefined);
    if (typeof body?.name !== "string" || typeof body?.enabled !== "boolean") throw new HttpError(400, "name and boolean enabled are required");
    const result = await request("PUT", `/limits/${provider}/auto-reset/${kind}`, { name: body.name, enabled: body.enabled });
    events.changed();
    return c.json(result, 200, headers);
  });
}
