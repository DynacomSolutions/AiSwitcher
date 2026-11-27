import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/lib/api";
import { adjustRefreshCounts, applyRefreshedLimits, isIdentityRefreshing, limitsRefetchInterval, POLL, reconcileLimits } from "@/lib/limits-reconciliation";
import type { LimitsResponse, LoginFlowStatus } from "@/types/api";

export { POLL, reconcileLimits, limitsRefetchInterval } from "@/lib/limits-reconciliation";

export const qk = {
  status: ["status"] as const,
  processes: ["processes"] as const,
  identities: ["identities"] as const,
  permissions: ["permissions"] as const,
  limits: ["limits"] as const,
  autoReset: ["codex-auto-reset"] as const,
  localModels: ["local-models"] as const,
  usage: ["usage"] as const,
  poolsUsage: ["pools-usage"] as const,
  browsers: ["browsers"] as const,
  gatewayUsage: (days: number) => ["gateway-usage", days] as const,
  gatewayApps: ["gateway-apps"] as const,
  breakdown: (identity: string, tool: string, days: number) => ["breakdown", identity, tool, days] as const,
  usageProjects: ["usage", "projects"] as const,
  sessions: (cwd: string) => ["sessions", cwd] as const,
  sessionTree: (tool: string, identity: string, days: number, active: boolean) =>
    ["sessions", "tree", tool, identity, days, active] as const,
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

export function usePermissionsQuery() {
  return useQuery({
    queryKey: qk.permissions,
    queryFn: () => api.getPermissions(),
    refetchInterval: POLL.slow,
  });
}

export function useLocalModelsQuery() {
  return useQuery({
    queryKey: qk.localModels,
    queryFn: api.getLocalModels,
    refetchInterval: POLL.registry,
  });
}

export function useAutoResetQuery() {
  return useQuery({ queryKey: qk.autoReset, queryFn: ({ signal }) => api.getAutoReset(signal) });
}

export function useLimitsQuery() {
  const client = useQueryClient();
  return useQuery({
    queryKey: qk.limits,
    queryFn: async ({ signal }) => {
      const current = client.getQueryData<LimitsResponse>(qk.limits);
      const pending = current?.results.find((row) => row.toolName === "codex" && row.resetPendingUntil && row.resetPendingUntil > Date.now());
      if (pending) {
        const scoped = await api.getLimits(pending.identity.name, signal);
        const authoritative = scoped.results.find((row) => row.toolName === "codex" && row.identity.name === pending.identity.name && row.gatewayManaged);
        const latest = client.getQueryData<LimitsResponse>(qk.limits) ?? current;
        if (!latest) return api.getLimits(undefined, signal);
        if (!authoritative) return latest;
        const results = latest.results.map((row) => row.toolName === "codex" && row.identity.name === pending.identity.name
          ? { ...authoritative, identity: row.identity } : row);
        return reconcileLimits(latest, { ...latest, results });
      }
      const incoming = await api.getLimits(undefined, signal);
      return reconcileLimits(client.getQueryData<LimitsResponse>(qk.limits), incoming);
    },
    refetchInterval: (query) => limitsRefetchInterval(query.state.data),
  });
}

export interface LimitsRefreshTarget {
  tool: string;
  /** Absent: every identity of the tool. */
  identity?: string;
}

export interface LimitsRefreshFailure {
  target: LimitsRefreshTarget;
  message: string;
}

/**
 * Manual refresh of limits. Each target reads the provider again on the server, past its 45 second caches. A target that fails
 * does not stop the others: `refresh` answers with the failures, and the rows that did read replace the rows on screen.
 *
 * Each call keeps its own state. Calls may overlap: a card spins until every call that covers it has ended, and each call
 * answers with its own failures (a shared mutation would lose them).
 */
export function useRefreshLimits() {
  const client = useQueryClient();
  const [pending, setPending] = useState<ReadonlyMap<string, number>>(() => new Map());
  const change = (targets: LimitsRefreshTarget[], delta: 1 | -1): void => setPending((current) => adjustRefreshCounts(current, targets, delta));
  const refresh = async (targets: LimitsRefreshTarget[]): Promise<{ failures: LimitsRefreshFailure[] }> => {
    change(targets, 1);
    try {
      const settled = await Promise.allSettled(targets.map((target) => api.refreshLimits(target.tool, target.identity)));
      const responses = settled.flatMap((entry) => (entry.status === "fulfilled" ? [entry.value] : []));
      const failures = settled.flatMap((entry, index) => (entry.status === "rejected"
        ? [{ target: targets[index]!, message: entry.reason instanceof Error ? entry.reason.message : String(entry.reason) }]
        : []));
      // Drop older poll work first, so it cannot overwrite the fresh rows.
      await client.cancelQueries({ queryKey: qk.limits });
      client.setQueryData<LimitsResponse>(qk.limits, (current) => applyRefreshedLimits(current, responses));
      return { failures };
    } finally {
      change(targets, -1);
    }
  };
  /** True while a call that covers this identity runs: its own target, or a target for the whole tool. */
  const isRefreshing = (tool: string, identity: string): boolean => isIdentityRefreshing(pending, tool, identity);
  return { refresh, isRefreshing, anyRefreshing: pending.size > 0 };
}

export function useUsageQuery() {
  return useQuery({
    queryKey: qk.usage,
    queryFn: ({ signal }) => api.getUsage(signal),
  });
}

export function usePoolsUsageQuery() {
  return useQuery({ queryKey: qk.poolsUsage, queryFn: ({ signal }) => api.getPoolsUsage(signal) });
}

export function useBrowsersQuery() {
  return useQuery({ queryKey: qk.browsers, queryFn: api.getBrowsers, refetchInterval: POLL.registry });
}

export function useGatewayAppsQuery() {
  return useQuery({ queryKey: qk.gatewayApps, queryFn: api.getGatewayApps, refetchInterval: POLL.slow });
}

export function useGatewayUsageQuery(days: number) {
  return useQuery({
    queryKey: qk.gatewayUsage(days),
    queryFn: ({ signal }) => api.getGatewayUsage(days, signal),
    refetchInterval: days === 7 ? false : POLL.slow,
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
    refetchInterval: (q) => (q.state.data?.pending ? 3000 : POLL.breakdown),
    placeholderData: keepPreviousData,
  });
}

/** The server reads the host collector's aggregate. The page filters by provider, identity and period. */
export function useUsageProjectsQuery(enabled: boolean) {
  return useQuery({
    queryKey: qk.usageProjects,
    queryFn: ({ signal }) => api.getUsageProjects(signal),
    enabled,
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
export function useSessionTreeQuery(tool: string, identity: string, days: number, active: boolean) {
  return useQuery({
    queryKey: qk.sessionTree(tool, identity, days, active),
    queryFn: () =>
      api.getSessionTree(
        tool.length > 0 ? tool : undefined,
        identity.length > 0 ? identity : undefined,
        days,
        active,
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
