import type { Hono } from "hono";
import { CONSOLE_POOL_CONFIRM_MS, withPoolResetDeadline, POOL_LIMITS_ROUTE, POOL_THRESHOLDS_PATH, poolLimitsPath, validPoolRoute, type PoolResetResult, type PoolResetReview, type PoolThreshold } from "../gateway/pool-reset-view.ts";
import { gatewayAdminConfig } from "./gateway-apps.ts";
import { HttpError } from "./types.ts";

type GatewayPoolDeps = { adminConfig?: typeof gatewayAdminConfig; fetch?: typeof fetch; confirmTimeoutMs?: number };

async function request(path: string, deps: GatewayPoolDeps, body?: unknown, signal = AbortSignal.timeout(18_000)): Promise<Response | undefined> {
  const admin = await (deps.adminConfig ?? gatewayAdminConfig)({});
  if (!admin) return undefined;
  try {
    signal.throwIfAborted();
    return await (deps.fetch ?? fetch)(`${admin.url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${admin.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      redirect: "error",
    });
  } catch {
    throw new HttpError(502, body === undefined
      ? "The gateway is unreachable."
      : "The reset outcome could not be verified. Check current limits before you consider another reset.");
  }
}

export async function readPoolThresholds(deps: GatewayPoolDeps = {}): Promise<PoolThreshold[]> {
  const response = await request(POOL_THRESHOLDS_PATH, deps);
  if (!response || response.status === 404) return [];
  if (!response.ok) throw new Error("The gateway could not verify pool usage.");
  return (await response.json() as { pools: PoolThreshold[] }).pools;
}

export async function readPoolResetReview(tool: string, pool: string, deps: GatewayPoolDeps = {}): Promise<PoolResetReview | undefined> {
  if (!validPoolRoute(tool, pool)) return undefined;
  const response = await request(poolLimitsPath(tool, pool), deps);
  if (!response || response.status === 404) return undefined;
  if (!response.ok) throw new Error("The gateway could not verify the pool reset.");
  return await response.json() as PoolResetReview;
}

export function registerGatewayPoolReset(app: Hono, deps: GatewayPoolDeps = {}, onReset?: (status: "confirmed" | "pending") => void): void {
  const route = `/api${POOL_LIMITS_ROUTE}`;
  app.on(["GET", "POST"], route, async (c) => {
    const tool = c.req.param("tool");
    const pool = c.req.param("pool");
    if (!validPoolRoute(tool, pool)) throw new HttpError(404, "The gateway pool was not found.");
    const path = poolLimitsPath(tool, pool);
    const isPost = c.req.method === "POST";
    const roundTrip = async (signal?: AbortSignal) => {
      const body = isPost ? await c.req.json().catch(() => null) : undefined;
      if (isPost && (!body || typeof body !== "object")) throw new HttpError(400, "A reset confirmation is required.");
      const response = await request(path, deps, body, signal).catch((error) => {
        if (!isPost) throw error;
        return Response.json({ status: "pending" } satisfies PoolResetResult);
      });
      if (!response) throw new HttpError(503, "The gateway admin API is unavailable.");
      if (isPost && response.status >= 500) return { result: { status: "pending" } satisfies PoolResetResult, status: 200 };
      const result = await response.json().catch(() => undefined) as { status?: unknown } | undefined;
      if (!result && !isPost) throw new HttpError(502, "The gateway response was invalid.");
      return { result: result ?? { status: "pending" } satisfies PoolResetResult, status: result ? response.status : 200 };
    };
    const { result, status } = isPost
      ? await withPoolResetDeadline(
        deps.confirmTimeoutMs ?? CONSOLE_POOL_CONFIRM_MS,
        (deadline) => roundTrip(AbortSignal.any([c.req.raw.signal, deadline])),
        { result: { status: "pending" }, status: 200 },
      )
      : await roundTrip();
    if (isPost && status === 200 && (result.status === "confirmed" || result.status === "pending")) onReset?.(result.status);
    return Response.json(result, { status, headers: { "cache-control": "no-store" } });
  });
}
