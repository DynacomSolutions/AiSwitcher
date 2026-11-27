import type { Hono } from "hono";
import {
  GATEWAY_POOL_CONFIRM_MS, withPoolResetDeadline, POOL_LIMITS_ROUTE, POOL_THRESHOLDS_PATH, validPoolRoute, type PoolResetConfirmation, type PoolResetResult, type PoolResetReview, type PoolThreshold,
} from "./pool-reset-view.ts";
import type { GatewayProvider } from "./types.ts";

export interface PoolResetAdmin {
  thresholds(): Promise<PoolThreshold[]>;
  review(tool: GatewayProvider, pool: string, signal: AbortSignal): Promise<PoolResetReview | undefined>;
  confirmTimeoutMs?: number;
  confirm(pool: string, selection: PoolResetConfirmation, signal: AbortSignal, deadlineAt: number): Promise<PoolResetResult | undefined>;
}

function validConfirmation(value: unknown): value is PoolResetConfirmation {
  const input = value as Partial<PoolResetConfirmation> | null;
  const candidate = input?.candidate;
  const text = (s: unknown) => typeof s === "string" && s.trim() !== "" && s.length <= 256;
  const timestamp = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n > 0 && n <= 8.64e15;
  return !!candidate && text(candidate.identity) && text(candidate.creditId) && timestamp(candidate.creditExpiresAt) &&
    timestamp(candidate.weeklyReset) && typeof input?.redeemRequestId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.redeemRequestId);
}

export function registerPoolResetAdmin(hono: Hono, deps: PoolResetAdmin, providers: readonly GatewayProvider[]): void {
  const headers = { "cache-control": "no-store" };
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers });
  const missing = () => json({ error: "The gateway pool was not found." }, 404);

  hono.get(POOL_THRESHOLDS_PATH, async () => json({ pools: await deps.thresholds() }));
  hono.get(POOL_LIMITS_ROUTE, async (c) => {
    const tool = providers.find((provider) => provider === c.req.param("tool"));
    if (!tool || !validPoolRoute(tool, c.req.param("pool"))) return missing();
    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(15_000)]);
    const review = await deps.review(tool, c.req.param("pool"), signal);
    return review ? json(review) : missing();
  });
  hono.post(POOL_LIMITS_ROUTE, async (c) => {
    if (!validPoolRoute(c.req.param("tool"), c.req.param("pool"))) return missing();
    if (c.req.param("tool") !== "codex") return json({ error: "This provider has no supported pool reset credit." }, 404);
    const timeout = deps.confirmTimeoutMs ?? GATEWAY_POOL_CONFIRM_MS;
    const deadlineAt = performance.now() + timeout;
    return withPoolResetDeadline(timeout, async (deadline) => {
      const confirmation: unknown = await c.req.json().catch(() => undefined);
      if (!validConfirmation(confirmation)) return json({ error: "A confirmed account, credit and valid request ID are required." }, 400);
      const signal = AbortSignal.any([c.req.raw.signal, deadline]);
      try {
        signal.throwIfAborted();
        const result = await deps.confirm(c.req.param("pool"), confirmation, signal, deadlineAt);
        return result ? json(result) : missing();
      } catch (error) {
        if (signal.aborted) return json({ status: "pending" } satisfies PoolResetResult);
        if ((error as { status?: unknown })?.status === 409) {
          return json({ status: "already_attempted" } satisfies PoolResetResult);
        }
        return json({ error: "The reset outcome could not be verified. Check current limits before you consider another reset." }, 502);
      }
    }, json({ status: "pending" } satisfies PoolResetResult));
  });
}
