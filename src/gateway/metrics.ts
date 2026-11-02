/** Counters the proxy reports. Task 6 supplies the Prometheus implementation behind this interface. */
export interface GatewayMetrics {
  request(e: { app: string; provider: string; identity: string; status: string; httpStatus: number; latencyMs: number }): void;
  authFailure(reason: "unknown-app" | "bad-token"): void;
  failover(app: string): void;
}

export const noopMetrics: GatewayMetrics = {
  request() {},
  authFailure() {},
  failover() {},
};
