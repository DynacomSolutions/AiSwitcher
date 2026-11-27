import type { GatewayProvider } from "./types.ts";

export const POOL_RESET_THRESHOLD = 90;
export const POOL_THRESHOLDS_PATH = "/limits/pool-thresholds";
export const POOL_LIMITS_ROUTE = "/limits/pools/:tool/:pool";

export const GATEWAY_POOL_CONFIRM_MS = 24_000;
export const CONSOLE_POOL_CONFIRM_MS = 27_000;

export function withPoolResetDeadline<T>(
  ms: number,
  operation: (signal: AbortSignal) => Promise<T>,
  pending: T,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(pending);
    }, ms);
  });
  return Promise.race([deadline, operation(controller.signal)]).finally(() => clearTimeout(timer));
}

const gatewayProviders: ReadonlyArray<GatewayProvider> = ["claude", "codex", "kimi", "grok", "zai", "ali", "opencode"];

export function validPoolRoute(tool: string, pool: string): boolean {
  return gatewayProviders.some((provider) => provider === tool) &&
    Boolean(pool.trim()) && pool.length <= 256 && pool !== "." && pool !== ".." && !/[\/\\%\x00-\x1f\x7f]/.test(pool);
}

export function poolLimitsPath(tool: string, pool: string): string {
  return `/limits/pools/${encodeURIComponent(tool)}/${encodeURIComponent(pool)}`;
}

export interface PoolThreshold {
  tool: GatewayProvider;
  pool: string;
  observedAt: number;
  percent?: number;
  /** Every observed window has a reading from every member. */
  complete: boolean;
  verifiedResetAt?: number;
}

export interface PoolResetCandidate {
  identity: string;
  creditId: string;
  creditExpiresAt: number;
  weeklyReset: number;
}

export interface PoolResetReview extends PoolThreshold {
  members: string[];
  availability: "available" | "below_threshold" | "unavailable" | "no_credit" | "unsupported";
  candidate?: PoolResetCandidate;
}

export interface PoolResetConfirmation {
  candidate: PoolResetCandidate;
  redeemRequestId: string;
}

export type PoolResetResult =
  | { status: "changed"; review: PoolResetReview }
  | { status: "already_attempted" }
  | { status: "pending" | "confirmed" | "declined" };
