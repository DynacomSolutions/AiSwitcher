/** Shared API types for the AIS console server. Mirrors docs/API.md plus the
 * underlying CLI result shapes (limits/usage/resume) it forwards verbatim. */

export type ToolName = "claude" | "codex" | "grok" | "kimi" | "zai" | "ali" | "pi" | "opencode";

export interface Identity {
  name: string;
  label: string;
  description?: string;
  configDir: string;
  directories?: string[];
  aliases?: string[];
}

/* Status */

export interface ToolStatus {
  toolName: string;
  realBinaryName: string;
  registryPath: string;
  registryExists: boolean;
  binaryPath: string | null;
}

export interface StatusResponse {
  ok: boolean;
  version: string;
  uptimeS: number;
  home: string;
  aisHome: string;
  tools: ToolStatus[];
}

/* Processes */

export interface ProcessInfo {
  pid: number;
  tool: string | null;
  identity: string | null;
  cwd: string | null;
  startedAt: string | null;
  command: string;
  /** True when the process carries the wrapper's session marker (a wrapped
   * session; the spend guard's kill candidates are exclusively these). */
  wrapped?: boolean;
  identityEnv?: Record<string, string>;
}

export interface ProcessesResponse {
  processes: ProcessInfo[];
  scannedAt: string;
}

/* Spend guard */

export interface SpendGuardAccountState {
  accountId: string;
  profile: string;
  region?: string;
  budgetName?: string;
  budgetLimitUsd?: number;
  budgetActualUsd?: number;
  budgetTimeUnit?: string;
  periodStart?: string;
  periodEnd?: string;
  localEstimateUsd: number;
  realReportedUsd?: number;
  effectiveUsd: number;
  breached: boolean;
  enforced: boolean;
  degraded: boolean;
  reason?: string;
  identities: string[];
  computedAt: string;
}

export interface SpendGuardKillRecord {
  pid: number;
  tool: string;
  identity: string;
  accountId: string;
  command: string;
  signal: "SIGTERM" | "SIGKILL" | "ALREADY-GONE";
  reason: string;
  at: string;
}

export interface SpendGuardResponse {
  ok: true;
  running: boolean;
  config: { intervalS: number; killGraceS: number };
  lastCycleAt: string | null;
  lastError: string | null;
  accounts: SpendGuardAccountState[];
  recentKills: SpendGuardKillRecord[];
}

/* herdr metadata bridge */

export interface HerdrBridgePane {
  paneId: string;
  agent?: string;
  agentStatus?: string;
  tool?: string;
  identity?: string;
  title?: string;
  session?: number;
  week?: number;
  month?: number;
  summary?: string;
}

export type HerdrBridgeState = "disabled" | "idle" | "pending" | "active";

export interface HerdrBridgeResponse {
  ok: true;
  state: HerdrBridgeState;
  running: boolean;
  config: { enabled: boolean; intervalS: number; categories: string[]; push: boolean };
  herdrVersion?: string;
  pendingReason?: string;
  panes: HerdrBridgePane[];
  lastCycleAt: string | null;
  lastPushAt: string | null;
  lastError: string | null;
}

/* Identities */

export interface IdentityDto extends Identity {
  configDirExists: boolean;
}

export interface ChromeProfileOverrideDto {
  directories: string[];
  targetIdentity: string;
  label?: string;
}

export interface RegistryDto {
  toolName: ToolName;
  path: string;
  identities: IdentityDto[];
  chromeProfileOverrides?: ChromeProfileOverrideDto[];
}

export interface RegistriesResponse {
  registries: RegistryDto[];
}

export interface CreateIdentityBody {
  name: string;
  label: string;
  description?: string;
  configDir: string;
  directories?: string[];
  aliases?: string[];
  apiKey?: string;
}

export interface PatchIdentityBody {
  label?: string;
  description?: string;
  configDir?: string;
}

/* Limits */

export type LimitCategory = "session" | "week" | "month" | "other";

export interface LimitWindow {
  label: string;
  category: LimitCategory;
  usedPercent: number;
  /** Already human-formatted by each adapter; render as-is. */
  resetsAt?: string;
  note?: string;
}

export interface OverageInfo {
  active: boolean;
  label: string;
  spentUsd?: number;
  limitUsd?: number;
}

/** A manually-spendable reset the provider grants the account (e.g. codex's
 * "Full reset (Weekly + 5 hr)"). Present only when at least one is usable
 * right now. */
export interface ManualResetInfo {
  availableCount: number;
  label?: string;
  expiresAt?: string;
}

export type LimitFetchStatus = "live" | "cached" | "unavailable" | "pending";

export interface ToolLimitResult {
  toolName: ToolName;
  /** The upstream provider these windows belong to — the grouping key for
   * provider-first views. A multi-provider client (pi, opencode) answers for
   * several providers from one identity, one result per provider. */
  provider: string;
  identity: Identity;
  windows: LimitWindow[];
  status: LimitFetchStatus;
  error?: string;
  capturedAt?: string;
  overage?: OverageInfo;
  manualReset?: ManualResetInfo;
}

export interface LimitsResponse {
  results: ToolLimitResult[];
  cached: boolean;
  fetchedAt: string;
}

/* Usage */

export interface TokscaleEntry {
  client: string;
  model: string;
  provider: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  messageCount: number;
  cost: number;
}

export interface TokscaleReport {
  entries: TokscaleEntry[];
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  totalMessages: number;
  totalCost: number;
}

export interface DateSpan {
  firstMs: number;
  lastMs: number;
}

/** REAL AWS-reported spend for a Bedrock row, deliberately separate from
 * the report's token-estimate cost: every dollar here comes from AWS's own
 * billing plane, never an estimate. Rendered as a dimmed sub-line under the
 * provider row. */
export interface RealCostInfo {
  label: string;
  /** Cost Explorer month-to-date; absent exactly when the query failed. */
  monthToDateUsd?: number;
  /** UnblendedCost over the full trailing window (three calendar months). */
  windowUsd?: number;
  /** The enforced COST budget's actual/limit, when the Budgets fetch answered. */
  budgetActualUsd?: number;
  budgetLimitUsd?: number;
  /** e.g. "reported lag" when AWS's real figure trails the local estimate. */
  note?: string;
  /** Present when the Cost Explorer query failed: unavailable, not zero. */
  error?: string;
}

export interface UsageResult {
  provider: string;
  identity: Identity;
  /** The wrapper the usage came through (claude/codex/pi/...), distinct from
   * the upstream provider the tokens were billed to. */
  sourceTool?: string;
  report?: TokscaleReport;
  error?: string;
  extraCost?: OverageInfo;
  realCost?: RealCostInfo;
  dateSpan?: DateSpan;
  dailyUsage?: Record<string, number>;
  pending?: true;
}

export interface UsageResponse {
  results: UsageResult[];
  generatedAt: string;
}

/* Sessions (resume) */

export interface ResumableSession {
  toolName: ToolName;
  identity: Identity;
  sessionId: string;
  cwd: string;
  label: string;
  lastActiveAt: string;
}

export interface ToolResumeResult {
  toolName: ToolName;
  identity: Identity;
  sessions: ResumableSession[];
  /** Set on a genuine read failure; may coexist with a non-empty list. */
  error?: string;
}

export interface SessionsResponse {
  results: ToolResumeResult[];
}

/* Auth */

export type AuthKind = "oauth" | "apikey" | "cookie" | "none";
export type AuthState = "ok" | "expiring" | "expired" | "missing" | "unknown";

export interface AuthEntry {
  toolName: ToolName;
  identity: string;
  kind: AuthKind;
  state: AuthState;
  detail?: string;
  fixable: string[];
  /** ISO timestamp when the stored credential expires, when known. */
  expiresAt?: string;
  /** ali only: last successful daemon-side console-cookie refresh. */
  lastRefreshAt?: string;
  /** ali only: last daemon-side refresh error, if any. */
  refreshError?: string;
}

export interface AuthResponse {
  entries: AuthEntry[];
}

/* Login flows (daemon-managed per-identity logins) */

export type LoginFlowStatus =
  | "starting"
  | "waiting"
  | "callback"
  | "completed"
  | "failed"
  | "cancelled";

export interface LoginFlow {
  flowId: string;
  toolName: ToolName;
  identity: string;
  status: LoginFlowStatus;
  mode: "pty" | "pipes";
  authUrl?: string;
  deviceCode?: string;
  instruction?: string;
  acceptsPaste: boolean;
  error?: string;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
}

export interface LoginFlowsResponse {
  flows: LoginFlow[];
}

export type LoginStartResult =
  | { kind: "managed"; flow: LoginFlow }
  | { kind: "terminal"; spawned: boolean; command: string };

/* Credential renewal (daemon scheduler) */

export interface AuthRefreshStatus {
  tool: string;
  identity: string;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  running: boolean;
}

export interface AuthRefreshResponse {
  results: AuthRefreshStatus[];
}

/* Files */

export interface FileRoot {
  /** Opaque root identifier, passed back as the tree's `root` parameter. */
  root: string;
  label: string;
  exists: boolean;
  /** Absolute base directory of this root, when the server reports it. */
  path?: string;
}

export interface FileTreeEntry {
  name: string;
  kind: "file" | "directory";
  size?: number;
  mtime?: string;
}

export interface FileTreeResponse {
  path?: string;
  entries: FileTreeEntry[];
}

export interface FileContentResponse {
  path: string;
  content: string;
  size: number;
  mtime?: string;
  binary: boolean;
}
