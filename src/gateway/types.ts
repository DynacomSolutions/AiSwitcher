export type GatewayProvider = "claude" | "codex" | "kimi" | "grok" | "zai" | "ali" | "opencode";

/** Kimi and Z.AI choose one style; the other providers have a fixed style. */
export type ApiStyle = "anthropic" | "openai";

export interface GatewayApp {
  name: string;
  owner: string;
  namespace: string;
  provider: GatewayProvider;
  style: ApiStyle;
  target: { kind: "pin"; identity: string } | { kind: "pool"; identities?: string[] };
  models?: string[];
  dailyTokens?: number;
  reservePercent?: number;
  state: "active" | "revoked";
  createdAt: string;
  lastUsedAt?: string;
}

export interface TokenRecord {
  app: string;
  prefix: string;
  hash: string;
  createdAt: string;
  /** Set on the previous token when it is rotated. */
  expiresAt?: string;
}

/** Ledger totals for one provider and identity over a window (the admin `GET /usage/identities` row). */
export interface IdentityUsageRow {
  provider: string;
  identity: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Sum of the rows that carry an estimate. */
  estCostUsd: number;
  /** Rows with tokens but no estimate (unpriced model); the cost figure is a floor when above zero. */
  unpricedRequests: number;
  requests: number;
}

export interface UsageRow {
  ts: string;
  app: string;
  provider: GatewayProvider;
  identity: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estCostUsd?: number;
  status: string;
  httpStatus: number;
  latencyMs: number;
  streamed: boolean;
}
