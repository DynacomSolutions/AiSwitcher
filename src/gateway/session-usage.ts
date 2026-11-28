import type { SessionIdentityUsageRow, SessionUsage } from "./types.ts";

/**
 * Folds the per-account rows of the store into one record per session: the account that served the latest request is the
 * active identity, and every account keeps its own turns and tokens, so the split of a session over accounts is exact.
 * A session is keyed by the client session id and the provider (two tools never share an id in practice, but the key
 * must not merge them if they did). Sessions come out newest first.
 */
export function foldSessionUsage(rows: SessionIdentityUsageRow[]): SessionUsage[] {
  const by = new Map<string, SessionUsage>();
  for (const r of rows) {
    const key = `${r.provider}\u0000${r.sessionKey}`;
    let s = by.get(key);
    if (!s) {
      s = { sessionKey: r.sessionKey, provider: r.provider, app: r.app, client: r.client, activeIdentity: r.identity, identities: [], turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estCostUsd: 0, unpricedRequests: 0, failedRequests: 0, toolCalls: 0, toolErrors: 0, models: [], firstTs: r.firstTs, lastTs: r.lastTs };
      by.set(key, s);
    }
    s.identities.push({ identity: r.identity, turns: r.turns, inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadTokens: r.cacheReadTokens, cacheWriteTokens: r.cacheWriteTokens, estCostUsd: r.estCostUsd, unpricedRequests: r.unpricedRequests, failedRequests: r.failedRequests, toolCalls: r.toolCalls, toolErrors: r.toolErrors, models: r.models, firstTs: r.firstTs, lastTs: r.lastTs });
    s.turns += r.turns;
    s.inputTokens += r.inputTokens;
    s.outputTokens += r.outputTokens;
    s.cacheReadTokens += r.cacheReadTokens;
    s.cacheWriteTokens += r.cacheWriteTokens;
    s.estCostUsd += r.estCostUsd;
    s.unpricedRequests += r.unpricedRequests;
    s.failedRequests += r.failedRequests;
    s.toolCalls += r.toolCalls;
    s.toolErrors += r.toolErrors;
    for (const m of r.models) if (!s.models.includes(m)) s.models.push(m);
    if (!s.client && r.client) s.client = r.client;
    if (Date.parse(r.firstTs) < Date.parse(s.firstTs)) s.firstTs = r.firstTs;
    if (Date.parse(r.lastTs) > Date.parse(s.lastTs)) {
      s.lastTs = r.lastTs;
      s.app = r.app;
    }
  }
  for (const s of by.values()) {
    s.models.sort();
    // Newest use first; a tie (two accounts in the same instant) falls to the name so the answer is stable.
    s.identities.sort((a, b) => Date.parse(b.lastTs) - Date.parse(a.lastTs) || a.identity.localeCompare(b.identity));
    s.activeIdentity = s.identities[0]!.identity;
  }
  return [...by.values()].sort((a, b) => Date.parse(b.lastTs) - Date.parse(a.lastTs) || a.sessionKey.localeCompare(b.sessionKey));
}
