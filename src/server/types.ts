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
  directories?: string[];
  aliases?: string[];
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
export type AuthState = "ok" | "expiring" | "expired" | "missing" | "unknown";

export interface AuthEntryDto {
  toolName: ToolConfig["toolName"];
  identity: string;
  kind: AuthKind;
  state: AuthState;
  detail?: string;
  fixable: string[];
}

export interface AuthDto {
  entries: AuthEntryDto[];
}

export interface LoginResultDto {
  spawned: boolean;
  command: string;
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

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
