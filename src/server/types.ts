import type { ToolConfig } from "../identities/types.ts";

/** Shared response/body types for the console API. docs/API.md is the
 * human-readable contract; this is the implementation-side mirror. The two
 * frontends (apps/web, apps/tui) carry their own tolerant copies. */

export interface ToolStatusDto {
  toolName: ToolConfig["toolName"];
  realBinaryName: ToolConfig["realBinaryName"];
  registryPath: string;
  registryExists: boolean;
  binaryPath: string | null;
}

export interface StatusDto {
  ok: true;
  version: string;
  uptimeS: number;
  home: string;
  aisHome: string;
  tools: ToolStatusDto[];
}

export interface ProcessInfoDto {
  pid: number;
  tool: string | null;
  identity: string | null;
  cwd: string | null;
  startedAt: string | null;
  command: string;
  /** True when the process carries the wrapper's IDENTITY_SESSION_MARKER:
   * a session the AIS wrapper actually launched (as opposed to a bare agent
   * binary someone ran directly). Additive; the spend guard's kill
   * candidates are exclusively wrapped sessions. */
  wrapped?: boolean;
  /** The recognised per-identity tool config-dir env vars found in the
   * process environment (CLAUDE_CONFIG_DIR, CODEX_HOME, ...). Present only
   * when at least one was found; lets callers attribute a session to a
   * registry identity beyond the marker's bare name. */
  identityEnv?: Record<string, string>;
}

export interface ProcessesDto {
  processes: ProcessInfoDto[];
  scannedAt: string;
}

export interface IdentityDto {
  name: string;
  label: string;
  description?: string;
  configDir: string;
  configDirExists: boolean;
  /** Explicit session colour (normalised #rrggbb) when the identity sets one. */
  colour?: string;
  /** Always present: `colour` when set, otherwise the stable auto palette
   * colour for (tool, name) — see identities/colour.ts. */
  effectiveColour: string;
  directories?: string[];
  aliases?: string[];
  /** Present (true) only for a retired identity. */
  retired?: true;
  /** ISO timestamp of the retirement, when recorded. */
  retiredAt?: string;
}

export interface RegistryDto {
  toolName: ToolConfig["toolName"];
  path: string;
  identities: IdentityDto[];
  chromeProfileOverrides?: Array<{ directories: string[]; targetIdentity: string; label?: string }>;
}

export interface RegistriesDto {
  registries: RegistryDto[];
}

export interface LimitsEnvelope {
  results: unknown[];
  cached: boolean;
  fetchedAt: string;
}

export interface UsageEnvelope {
  results: unknown[];
  generatedAt: string;
}

export interface SessionsEnvelope {
  results: unknown[];
}

export type AuthKind = "oauth" | "apikey" | "cookie" | "none";
/** "retired" is reported without probing: the identity's credentials were
 * deleted on purpose and nothing may touch it until it is unretired. */
export type AuthState = "ok" | "expiring" | "expired" | "missing" | "unknown" | "retired";

export interface AuthEntryDto {
  toolName: ToolConfig["toolName"];
  identity: string;
  kind: AuthKind;
  state: AuthState;
  detail?: string;
  fixable: string[];
  /** ISO timestamp when the stored credential expires, when its shape
   * exposes one. Absent for static keys and unreadable shapes. */
  expiresAt?: string;
  /** ali only: last successful daemon-side console-cookie refresh. */
  lastRefreshAt?: string;
  /** ali only: last daemon-side refresh error, if any. */
  refreshError?: string;
}

export interface AuthDto {
  entries: AuthEntryDto[];
}

export interface LoginResultDto {
  spawned: boolean;
  command: string;
}

export type LoginFlowStatus =
  | "starting"
  | "waiting"
  | "callback"
  | "completed"
  | "failed"
  | "cancelled";

/** A daemon-managed login: the real CLI's own flow spawned with piped
 * stdio (or a script-allocated PTY for TUI-based logins), its auth URL
 * surfaced for a remote browser, and a paste path for redirect-code
 * fallbacks. Device codes are NOT secrets: the CLI displays them and the
 * user types them into the provider's web UI. */
export interface LoginFlowDto {
  flowId: string;
  toolName: ToolConfig["toolName"];
  identity: string;
  status: LoginFlowStatus;
  /** "pty" = script-allocated pseudo-terminal (TUI login), "pipes" = plain
   * piped stdio. Flows only exist for tools with a managed spec. */
  mode: "pty" | "pipes";
  /** The authorize/device URL parsed from the CLI's output, when seen. */
  authUrl?: string;
  /** One-time device code parsed from the CLI's output, when seen. */
  deviceCode?: string;
  /** Human instruction for the paste path, when the flow accepts one. */
  instruction?: string;
  /** Whether POST /flows/:id/submit can inject a pasted code/URL. */
  acceptsPaste: boolean;
  error?: string;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
}

/** POST /api/auth/login result: a managed flow when the tool has one, or a
 * best-effort handoff to a terminal emulator (headless daemons return
 * spawned: false plus the command to run by hand). */
export type LoginStartResultDto =
  | { kind: "managed"; flow: LoginFlowDto }
  | { kind: "terminal"; spawned: boolean; command: string };

/** Structural surface of LoginFlowManager that app.ts/auth.ts rely on,
 * declared here so auth.ts does not have to import the manager class
 * (login-flows.ts already imports credentialPathsForTool from auth.ts). */
export interface LoginFlowManagerLike {
  start(toolName: ToolConfig["toolName"], identityName: string): Promise<LoginFlowDto>;
  list(): LoginFlowDto[];
  get(flowId: string): LoginFlowDto;
  submit(flowId: string, code: string): LoginFlowDto;
  cancel(flowId: string): LoginFlowDto;
}

export interface FileRootDto {
  root: string;
  label: string;
  exists: boolean;
  path?: string;
}

export interface FileTreeEntryDto {
  name: string;
  kind: "file" | "directory";
  size?: number;
  mtime?: string;
}

export interface FileTreeDto {
  path?: string;
  entries: FileTreeEntryDto[];
}

export interface FileContentDto {
  path: string;
  content: string;
  size: number;
  mtime?: string;
  binary: boolean;
}

/* Permissions tree (GET /api/permissions). Read-only view of generated files. */

export type PermissionGroup = "allow" | "ask" | "deny";

export interface PermissionRulesDto {
  allow: string[];
  ask: string[];
  deny: string[];
}

export interface PermissionCountsDto {
  allow: number;
  ask: number;
  deny: number;
  total: number;
}

export interface PermissionCacheStatsDto {
  hits: number;
  misses: number;
}

export interface PermissionSourceDto {
  /** Absolute path as read inside this process. */
  path: string;
  label: string;
  exists: boolean;
  /** "hit" = served from the cache, "miss" = (re)read; absent when the file does not exist. */
  cache?: "hit" | "miss";
  rules: PermissionRulesDto;
  error?: string;
}

/** Fields shared by every node of the tree. */
export interface PermissionNodeBase {
  counts: PermissionCountsDto;
  cache: PermissionCacheStatsDto;
}

export interface PermissionWorktreeNode extends PermissionNodeBase {
  path: string;
  kind: "base" | "task";
  /** Task name for task worktrees. */
  task?: string;
  sources: PermissionSourceDto[];
  rules: PermissionRulesDto;
}

export interface PermissionRepoNode extends PermissionNodeBase {
  owner: string;
  repo: string;
  worktrees: PermissionWorktreeNode[];
}

export interface PermissionIdentityNode extends PermissionNodeBase {
  name: string;
  label: string;
  configDir: string;
  retired?: true;
  /** Identity-level rules (the tool's own config in the identity's config dir). */
  sources: PermissionSourceDto[];
  rules: PermissionRulesDto;
  /** Set when the tool has no readable permission concept. */
  reason?: string;
  repos: PermissionRepoNode[];
}

export interface PermissionToolNode extends PermissionNodeBase {
  toolName: ToolConfig["toolName"];
  identities: PermissionIdentityNode[];
}

export interface PermissionsDto {
  generatedAt: string;
  refreshed: boolean;
  cachePath: string;
  reposRoot: string;
  counts: PermissionCountsDto;
  cache: PermissionCacheStatsDto;
  tools: PermissionToolNode[];
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
