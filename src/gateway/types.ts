export type GatewayProvider = "claude" | "codex" | "kimi" | "grok" | "zai" | "ali" | "opencode";

/** Kimi and Z.AI choose one style; the other providers have a fixed style. */
export type ApiStyle = "anthropic" | "openai";

export interface GatewayApp {
  name: string;
  owner: string;
  namespace: string;
  provider: GatewayProvider;
  style: ApiStyle;
  target: { kind: "pin"; identity: string } | { kind: "pool" };
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

/** Ledger totals for one provider, identity and app over a window (the admin `GET /usage/identities` row). */
export interface IdentityUsageRow {
  provider: string;
  identity: string;
  app: string;
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

/** Ledger totals for one provider, identity, app and model over a window (the admin `GET /usage/models` row). */
export interface ModelUsageRow extends IdentityUsageRow {
  /** The model the requests used; null when the proxy recorded no model. Never dropped: its tokens still count. */
  model: string | null;
  /** Earliest and latest ledger timestamp in the group (ISO instants), for the report's date span. */
  firstTs?: string;
  lastTs?: string;
}

/** Served requests of one client session on one account (the store's `usageBySession` row). A session on several accounts has one row per account. */
export interface SessionIdentityUsageRow {
  sessionKey: string;
  provider: string;
  app: string;
  /** The client tool family, or null when no request named one. */
  client: string | null;
  identity: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  firstTs: string;
  lastTs: string;
}

/** One account a session used: its share of the session (the admin `GET /usage/sessions` `identities` entry). */
export interface SessionIdentityUse {
  identity: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  firstTs: string;
  lastTs: string;
}

/** One client session with the split of its served requests over accounts (the admin `GET /usage/sessions` row). */
export interface SessionUsage {
  sessionKey: string;
  provider: string;
  app: string;
  client: string | null;
  /** The account that served the session's latest request. */
  activeIdentity: string;
  /** Every account the session used, newest first. */
  identities: SessionIdentityUse[];
  turns: number;
  firstTs: string;
  lastTs: string;
}

/** Ledger totals for one day, provider, identity and model (the admin `GET /usage/models/daily` row). Apps are summed. */
export interface ModelDailyUsageRow {
  /** Calendar day "YYYY-MM-DD" in the zone the request named. */
  day: string;
  provider: string;
  identity: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estCostUsd: number;
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
  /** The client's own session id (Claude Code `x-claude-code-session-id`, Codex `session-id`), when the request carried one. See `session-key.ts`. */
  sessionKey?: string;
  /** The client tool family from its user agent, for example `claude-cli` or `codex_exec`. */
  client?: string;
  /** Milliseconds from the request's arrival to the first upstream body byte. Absent when no upstream body byte arrived. */
  ttfbMs?: number;
  /** Why the model stopped: Anthropic `stop_reason`, Chat Completions `finish_reason`, or the Responses terminal `status` (the reason when `incomplete`). */
  stopReason?: string;
  /** Tool calls in the answer. Absent when the response was not read; 0 when it held none. */
  toolCalls?: number;
  /** Distinct tool names of the answer: at most 32, each at most 64 characters. Names only, never tool input or output. */
  toolNames?: string[];
  /** `tool_result` blocks with `is_error: true` in the last message of the request (Anthropic Messages only). */
  toolErrors?: number;
}

/** One imported history figure. A null `day` is an all-time figure; a null `model` covers every model of the day. */
export interface UsageHistoryRow {
  /** Where the figures came from, for example "host-snapshot-models". Part of the key, so two sources never overwrite each other. Never add the figures of two sources together. */
  source: string;
  /** The import generation as an ISO instant (the snapshot's generation time). Part of the key: a new generation adds rows, the same generation replaces its own rows. */
  generation: string;
  provider: string;
  identity: string;
  /** Calendar day "YYYY-MM-DD", or null for an all-time figure. */
  day: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  messages: number;
  estCostUsd: number;
  /** First and last day (YYYY-MM-DD, in `zone`) the imported result covers, so a reader can trim the overlap with the ledger. Null when unknown. */
  firstDay: string | null;
  lastDay: string | null;
  /** The IANA zone the days of the host figures are bucketed in. */
  zone: string;
}

/** Which history rows to read. `generation` is "latest" (the newest generation of each source, the default) or one exact generation instant. */
export interface UsageHistoryFilter {
  source?: string;
  provider?: string;
  identity?: string;
  generation?: string;
}

/** A stored history row, with the time of its latest import. */
export interface UsageHistoryStored extends UsageHistoryRow {
  importedAt: string;
}
