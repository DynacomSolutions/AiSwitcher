import type { LimitsResponse } from "@/types/api";

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
  /** /api/usage/projects: a file read; the collector rewrites it each cycle. */
  projects: 120_000,
} as const;

export function reconcileLimits(current: LimitsResponse | undefined, incoming: LimitsResponse, now = Date.now()): LimitsResponse {
  if (!current) return incoming;
  const previousByKey = new Map(current.results.map((row) => [`${row.toolName}\u0000${row.identity.name}`, row]));
  const results = incoming.results.map((row) => {
    const key = `${row.toolName}\u0000${row.identity.name}`;
    const previous = previousByKey.get(key);
    if (!previous || row.toolName !== "codex") return row;
    const oldCaptured = previous.capturedAt ? Date.parse(previous.capturedAt) : Number.NaN;
    const newCaptured = row.capturedAt ? Date.parse(row.capturedAt) : Number.NaN;
    const expiredPending = previous.resetPendingUntil !== undefined && previous.resetPendingUntil <= now;
    const previousWithoutExpiredPending = { ...previous };
    if (expiredPending) delete previousWithoutExpiredPending.resetPendingUntil;
    if (previous.gatewayManaged && !row.gatewayManaged) return previousWithoutExpiredPending;
    if (Number.isFinite(oldCaptured) && (!Number.isFinite(newCaptured) || newCaptured < oldCaptured)) return previousWithoutExpiredPending;
    if (previous.resetPendingUntil && !expiredPending) {
      const relieved = row.status === "live" && Number.isFinite(newCaptured) && newCaptured > oldCaptured && row.windows.some((window) =>
        previous.windows.some((baseline) => baseline.label === window.label && baseline.model === window.model && window.usedPercent < baseline.usedPercent),
      );
      if (!relieved) return { ...previous, manualReset: row.manualReset ?? previous.manualReset };
    }
    return row;
  });
  return { ...incoming, results };
}

export function limitsRefetchInterval(data: LimitsResponse | undefined, now = Date.now()): number {
  const pending = data?.results.some((row) => row.toolName === "codex" && row.resetPendingUntil && row.resetPendingUntil > now);
  return pending ? 2_000 : POLL.slow;
}

/**
 * Applies the rows of manual refreshes. A refresh read the provider again, so its row replaces the row on screen even when the
 * read failed: the failure text then shows on the card. Rows the refresh did not return stay as they are.
 */
export function applyRefreshedLimits(current: LimitsResponse | undefined, refreshed: LimitsResponse[]): LimitsResponse | undefined {
  if (!current) return current;
  const byKey = new Map<string, LimitsResponse["results"][number]>();
  for (const response of refreshed) for (const row of response.results) byKey.set(`${row.toolName}\u0000${row.identity.name}`, row);
  if (byKey.size === 0) return current;
  const results = current.results.map((row) => {
    const next = byKey.get(`${row.toolName}\u0000${row.identity.name}`);
    if (!next) return row;
    const { resetPendingUntil: _pending, ...clean } = next;
    return { ...clean, identity: row.identity };
  });
  return { ...current, results, fetchedAt: refreshed.at(-1)?.fetchedAt ?? current.fetchedAt };
}
