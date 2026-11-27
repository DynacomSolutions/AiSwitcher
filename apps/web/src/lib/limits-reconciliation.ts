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
} as const;

type LimitRow = LimitsResponse["results"][number];

/** The server never sends `spentAt` (local state of a spend). A row from the server keeps the one the row on screen holds. */
function keepSpentAt(row: LimitRow, previous: LimitRow | undefined): LimitRow {
  const spentAt = previous?.manualReset?.spentAt;
  if (spentAt === undefined || !row.manualReset || row.manualReset.spentAt !== undefined) return row;
  return { ...row, manualReset: { ...row.manualReset, spentAt } };
}

function reconcileRow(row: LimitRow, previous: LimitRow | undefined, now: number): LimitRow {
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
}

export function reconcileLimits(current: LimitsResponse | undefined, incoming: LimitsResponse, now = Date.now()): LimitsResponse {
  if (!current) return incoming;
  const previousByKey = new Map(current.results.map((row) => [`${row.toolName}\u0000${row.identity.name}`, row]));
  const results = incoming.results.map((row) => {
    const previous = previousByKey.get(`${row.toolName}\u0000${row.identity.name}`);
    return keepSpentAt(reconcileRow(row, previous, now), previous);
  });
  return { ...incoming, results };
}

export function limitsRefetchInterval(data: LimitsResponse | undefined, now = Date.now()): number | false {
  const pending = data?.results.some((row) => row.toolName === "codex" && row.resetPendingUntil && row.resetPendingUntil > now);
  return pending ? 2_000 : false;
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
    // A gateway card stays when the refresh brings a host-scan row (the gateway was down or the read timed out): the host row has no reset button and no credits.
    if (row.gatewayManaged && !next.gatewayManaged) return row;
    const { resetPendingUntil: _pending, ...clean } = next;
    return keepSpentAt({ ...clean, identity: row.identity }, row);
  });
  return { ...current, results, fetchedAt: refreshed.at(-1)?.fetchedAt ?? current.fetchedAt };
}

/** A refresh target: one identity of a tool, or (no identity) every identity of the tool. */
export interface RefreshTarget {
  tool: string;
  identity?: string;
}

const targetKey = (target: RefreshTarget): string => `${target.tool}\u0000${target.identity ?? ""}`;

/**
 * The count of refresh calls in flight per target. Calls overlap, so a count (not a flag) tells when the last call that covers
 * a card has ended: an earlier call that ends first must not stop the spinner of a later one.
 */
export function adjustRefreshCounts(current: ReadonlyMap<string, number>, targets: RefreshTarget[], delta: 1 | -1): Map<string, number> {
  const next = new Map(current);
  for (const target of targets) {
    const key = targetKey(target);
    const count = (next.get(key) ?? 0) + delta;
    if (count <= 0) next.delete(key);
    else next.set(key, count);
  }
  return next;
}

/** Whether a refresh call that covers this identity runs: its own target, or a target for the whole tool. */
export function isIdentityRefreshing(counts: ReadonlyMap<string, number>, tool: string, identity: string): boolean {
  return counts.has(targetKey({ tool, identity })) || counts.has(targetKey({ tool }));
}
