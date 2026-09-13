import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { LoginFlowStatus } from "@/types/api";

/** Polling intervals from docs/API.md. Files endpoints are on demand. */
export const POLL = {
  live: 3_000,
  flow: 1_500,
  registry: 10_000,
  sessions: 15_000,
  /** /api/sessions/tree: heavy unscoped scans, server caches 15s. */
  tree: 30_000,
  /** An open transcript, polled only while the chat is in progress. */
  transcript: 3_000,
  slow: 60_000,
  breakdown: 300_000,
} as const;

export const qk = {
  status: ["status"] as const,
  processes: ["processes"] as const,
  identities: ["identities"] as const,
  limits: ["limits"] as const,
  usage: ["usage"] as const,
  breakdown: (identity: string, tool: string, days: number) => ["breakdown", identity, tool, days] as const,
  sessions: (cwd: string) => ["sessions", cwd] as const,
  sessionTree: (tool: string, identity: string, days: number) =>
    ["sessions", "tree", tool, identity, days] as const,
  sessionTranscript: (tool: string, identity: string, id: string, tail: number) =>
    ["sessions", "transcript", tool, identity, id, tail] as const,
  auth: ["auth"] as const,
  authRefresh: ["auth", "refresh"] as const,
  spendGuard: ["spend-guard"] as const,
  herdrBridge: ["herdr-bridge"] as const,
  loginFlows: ["auth", "flows"] as const,
  loginFlow: (flowId: string) => ["auth", "flows", flowId] as const,
  fileRoots: ["files", "roots"] as const,
  fileTree: (root: string, path: string) => ["files", "tree", root, path] as const,
  fileContent: (root: string, path: string) => ["files", "file", root, path] as const,
};

/** A flow consumes attention while it can still move on its own. */
export function flowIsLive(status: LoginFlowStatus | undefined): boolean {
  return status === "starting" || status === "waiting" || status === "callback";
}

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

export function useSpendGuardQuery() {
  return useQuery({
    queryKey: qk.spendGuard,
    queryFn: api.getSpendGuard,
    refetchInterval: POLL.slow,
  });
}

export function useHerdrBridgeQuery() {
  return useQuery({
    queryKey: qk.herdrBridge,
    queryFn: api.getHerdrBridge,
    refetchInterval: POLL.slow,
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

/** Per-call breakdown streams raw session JSONL server-side: much heavier
 * than the other polls, so it refreshes every 5 minutes and only once an
 * identity is actually selected (never an unscoped scan by accident). */
export function useBreakdownQuery(identity: string, tool: string, days: number) {
  return useQuery({
    queryKey: qk.breakdown(identity, tool, days),
    queryFn: () => api.getBreakdown(identity, tool, days),
    enabled: identity !== "" && tool !== "",
    refetchInterval: POLL.breakdown,
    placeholderData: keepPreviousData,
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

/** The what-spawned-what tree. Polls lightly while the page is open so new
 * roots appear on their own; the server caches for 15s. */
export function useSessionTreeQuery(tool: string, identity: string, days: number) {
  return useQuery({
    queryKey: qk.sessionTree(tool, identity, days),
    queryFn: () =>
      api.getSessionTree(
        tool.length > 0 ? tool : undefined,
        identity.length > 0 ? identity : undefined,
        days,
      ),
    refetchInterval: POLL.tree,
    placeholderData: keepPreviousData,
  });
}

/** One session's chat. Polls every 3s ONLY while the session is in progress
 * (the server caches 4s, so appended lines appear within one interval);
 * finished sessions stop polling entirely. */
export function useSessionTranscriptQuery(
  tool: string,
  identity: string,
  id: string,
  tail: number,
  enabled: boolean,
) {
  return useQuery({
    queryKey: qk.sessionTranscript(tool, identity, id, tail),
    queryFn: () => api.getSessionTranscript(tool, identity, id, tail),
    enabled: enabled && tool !== "" && identity !== "" && id !== "",
    refetchInterval: (query) => (query.state.data?.transcript.inProgress ? POLL.transcript : false),
    placeholderData: keepPreviousData,
    // A mid-flight tail change races the refetchInterval probe; ignore it.
    retry: 1,
  });
}

export function useAuthQuery() {
  return useQuery({
    queryKey: qk.auth,
    queryFn: api.getAuth,
    refetchInterval: POLL.registry,
  });
}

export function useAuthRefreshQuery() {
  return useQuery({
    queryKey: qk.authRefresh,
    queryFn: api.getAuthRefresh,
    refetchInterval: POLL.registry,
  });
}

export function useLoginFlowQuery(flowId: string | null) {
  return useQuery({
    queryKey: qk.loginFlow(flowId ?? ""),
    queryFn: () => api.getLoginFlow(flowId as string),
    enabled: flowId !== null,
    refetchInterval: (query) => (flowIsLive(query.state.data?.status) ? POLL.flow : false),
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

export function useFileContentQuery(root: string, path: string | null) {
  return useQuery({
    queryKey: qk.fileContent(root, path ?? ""),
    queryFn: () => api.getFileContent(root, path as string),
    enabled: root !== "" && path !== null,
  });
}
