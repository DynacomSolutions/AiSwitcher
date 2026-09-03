import type {
  AuthEntry,
  AuthRefreshResponse,
  AuthResponse,
  CreateIdentityBody,
  FileContentResponse,
  FileRoot,
  FileTreeResponse,
  LimitsResponse,
  LoginResult,
  PatchIdentityBody,
  ProcessesResponse,
  RegistriesResponse,
  SessionsResponse,
  StatusResponse,
  ToolName,
  UsageResponse,
} from "@/types/api";

const TOKEN_STORAGE_KEY = "ais_console_token";

/** Optional bearer token for advanced setups; the loopback Host guard makes
 * this unnecessary for normal local use. */
export function getStoredToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? "GET";
  const headers = new Headers();
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  const token = getStoredToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  // CSRF guard required by the server on every mutating request.
  if (method !== "GET" && method !== "HEAD") headers.set("X-AIS-Console", "1");

  const response = await fetch(path, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`.trim();
    try {
      const data = (await response.json()) as { error?: unknown };
      if (typeof data.error === "string" && data.error.length > 0) message = data.error;
    } catch {
      // Non-JSON body: keep the status-based message.
    }
    throw new ApiError(response.status, message);
  }

  return (await response.json()) as T;
}

function withParams(path: string, params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value.length > 0) search.set(key, value);
  }
  const query = search.toString();
  return query.length > 0 ? `${path}?${query}` : path;
}

export const api = {
  getStatus: () => request<StatusResponse>("/api/status"),

  getProcesses: () => request<ProcessesResponse>("/api/processes"),

  getIdentities: () => request<RegistriesResponse>("/api/identities"),
  createIdentity: (tool: ToolName, body: CreateIdentityBody) =>
    request<unknown>(`/api/identities/${tool}`, { method: "POST", body }),
  patchIdentity: (tool: ToolName, name: string, body: PatchIdentityBody) =>
    request<unknown>(`/api/identities/${encodeURIComponent(tool)}/${encodeURIComponent(name)}`, {
      method: "PATCH",
      body,
    }),
  deleteIdentity: (tool: ToolName, name: string) =>
    request<unknown>(`/api/identities/${encodeURIComponent(tool)}/${encodeURIComponent(name)}`, {
      method: "DELETE",
    }),
  addDirectoryPattern: (tool: ToolName, name: string, pattern: string) =>
    request<unknown>(`/api/identities/${encodeURIComponent(tool)}/${encodeURIComponent(name)}/directories`, {
      method: "POST",
      body: { pattern },
    }),
  removeDirectoryPattern: (tool: ToolName, name: string, pattern: string) =>
    request<unknown>(`/api/identities/${encodeURIComponent(tool)}/${encodeURIComponent(name)}/directories`, {
      method: "DELETE",
      body: { pattern },
    }),
  addAlias: (tool: ToolName, name: string, alias: string) =>
    request<unknown>(`/api/identities/${encodeURIComponent(tool)}/${encodeURIComponent(name)}/aliases`, {
      method: "POST",
      body: { alias },
    }),
  removeAlias: (tool: ToolName, name: string, alias: string) =>
    request<unknown>(`/api/identities/${encodeURIComponent(tool)}/${encodeURIComponent(name)}/aliases`, {
      method: "DELETE",
      body: { alias },
    }),

  getLimits: () => request<LimitsResponse>("/api/limits?maxAge=45"),

  getUsage: () => request<UsageResponse>("/api/usage"),

  getSessions: (cwd?: string) => request<SessionsResponse>(withParams("/api/sessions", { cwd })),

  getAuth: () => request<AuthResponse>("/api/auth"),
  getAuthRefresh: () => request<AuthRefreshResponse>("/api/auth/refresh"),
  refreshCredential: (tool: string, identity: string) =>
    request<{ ok: boolean }>("/api/auth/refresh", { method: "POST", body: { tool, identity } }),
  refreshKimiToken: (identity: string) =>
    request<unknown>("/api/auth/kimi-refresh", { method: "POST", body: { identity } }),
  loginIdentity: (tool: string, identity: string) =>
    request<LoginResult>("/api/auth/login", { method: "POST", body: { tool, identity } }),
  setZaiKey: (tool: "zai" | "ali", identity: string, apiKey: string) =>
    request<unknown>("/api/auth/zai-key", { method: "POST", body: { tool, identity, apiKey } }),
  setAliCookie: (identity: string, cookie: string) =>
    request<unknown>("/api/auth/ali-cookie", { method: "POST", body: { identity, cookie } }),

  getFileRoots: () => request<{ roots: FileRoot[] }>("/api/files/roots"),
  getFileTree: (root: string, path?: string) =>
    request<FileTreeResponse>(withParams("/api/files/tree", { root, path })),
  getFileContent: (path: string) =>
    request<FileContentResponse>(withParams("/api/files/file", { path })),
  saveFile: (path: string, content: string) =>
    request<unknown>("/api/files/file", { method: "PUT", body: { path, content } }),
  runBackup: () => request<{ summary?: string }>("/api/files/backup", { method: "POST" }),
};

/** Narrow helper for auth fix actions that only some entries support. */
export function supportsFix(entry: AuthEntry, fix: string): boolean {
  return entry.fixable.some((f) => f.toLowerCase() === fix);
}
