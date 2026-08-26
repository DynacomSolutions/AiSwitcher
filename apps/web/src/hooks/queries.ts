import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

/** Polling intervals from docs/API.md. Files endpoints are on demand. */
export const POLL = {
  live: 3_000,
  registry: 10_000,
  sessions: 15_000,
  slow: 60_000,
} as const;

export const qk = {
  status: ["status"] as const,
  processes: ["processes"] as const,
  identities: ["identities"] as const,
  limits: ["limits"] as const,
  usage: ["usage"] as const,
  sessions: (cwd: string) => ["sessions", cwd] as const,
  auth: ["auth"] as const,
  fileRoots: ["files", "roots"] as const,
  fileTree: (root: string, path: string) => ["files", "tree", root, path] as const,
  fileContent: (path: string) => ["files", "file", path] as const,
};

export function useStatusQuery() {
  return useQuery({
    queryKey: qk.status,
    queryFn: api.getStatus,
    refetchInterval: POLL.live,
  });
}

export function useProcessesQuery() {
  return useQuery({
    queryKey: qk.processes,
    queryFn: api.getProcesses,
    refetchInterval: POLL.live,
  });
}

export function useIdentitiesQuery() {
  return useQuery({
    queryKey: qk.identities,
    queryFn: api.getIdentities,
    refetchInterval: POLL.registry,
  });
}

export function useLimitsQuery() {
  return useQuery({
    queryKey: qk.limits,
    queryFn: api.getLimits,
    refetchInterval: POLL.slow,
  });
}

export function useUsageQuery() {
  return useQuery({
    queryKey: qk.usage,
    queryFn: api.getUsage,
    refetchInterval: POLL.slow,
  });
}

export function useSessionsQuery(cwd: string) {
  return useQuery({
    queryKey: qk.sessions(cwd),
    queryFn: () => api.getSessions(cwd.trim().length > 0 ? cwd.trim() : undefined),
    refetchInterval: POLL.sessions,
    placeholderData: keepPreviousData,
  });
}

export function useAuthQuery() {
  return useQuery({
    queryKey: qk.auth,
    queryFn: api.getAuth,
    refetchInterval: POLL.registry,
  });
}

export function useFileRootsQuery() {
  return useQuery({
    queryKey: qk.fileRoots,
    queryFn: api.getFileRoots,
  });
}

export function useFileTreeQuery(root: string, path: string, enabled: boolean) {
  return useQuery({
    queryKey: qk.fileTree(root, path),
    queryFn: () => api.getFileTree(root, path),
    enabled,
    placeholderData: keepPreviousData,
  });
}

export function useFileContentQuery(path: string | null) {
  return useQuery({
    queryKey: qk.fileContent(path ?? ""),
    queryFn: () => api.getFileContent(path as string),
    enabled: path !== null,
  });
}
