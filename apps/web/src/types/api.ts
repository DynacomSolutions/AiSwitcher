/** Shared API types for the AIS console server. Mirrors docs/API.md plus the
 * underlying CLI result shapes (limits/usage/resume) it forwards verbatim. */

export type ToolName = "claude" | "codex" | "grok" | "kimi" | "zai" | "ali" | "pi";

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
}

export interface ProcessesResponse {
  processes: ProcessInfo[];
  scannedAt: string;
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

export interface UsageResult {
  provider: string;
  identity: Identity;
  /** The wrapper the usage came through (claude/codex/pi/...), distinct from
   * the upstream provider the tokens were billed to. */
  sourceTool?: string;
  report?: TokscaleReport;
  error?: string;
  extraCost?: OverageInfo;
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
}

export interface AuthResponse {
  entries: AuthEntry[];
}

/* Credential renewal (daemon scheduler) */

export interface AuthRefreshStatus {
  tool: string;
  identity: string;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  running: boolean;
}

export interface AuthRefreshResponse {
  results: AuthRefreshStatus[];
}

export interface LoginResult {
  spawned: boolean;
  command: string;
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
