/** Shared resilient fetch for the limits adapters' live API reads.
 *
 * These are ONE cheap GET per (identity, provider) — but the machine's
 * external connectivity blips under report load (observed live 2026-09-03:
 * Kimi's usages endpoint answered a bare curl in 518ms, then timed out at
 * 10s twice inside a full report; the same run showed chatgpt.com
 * unreachable for codex; bare curl afterwards showed a ~400ms baseline with
 * multi-second spikes). A single short timeout turns every blip into an
 * error row, and the user has been explicit that transient failures must
 * not become rows. So: a GENEROUS per-attempt timeout (30s — these
 * endpoints answer in well under a second when healthy) and retries with
 * BACKOFF (3s, 8s — an immediate retry hits the same spike). HTTP error
 * STATUSES are never retried — auth failures and rate limits mean exactly
 * what they say. */

const FETCH_TIMEOUT_MS = 30_000;
const RETRY_PAUSES_MS = [3_000, 8_000];

/** Performs the request with a per-attempt timeout, retrying only when the
 * fetch itself throws (timeout, connection reset, DNS failure). The final
 * error names the attempts so a still-failing endpoint is diagnosable in
 * the report. */
export async function fetchWithRetry(url: string, init: RequestInit = {}): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_PAUSES_MS.length; attempt++) {
    if (attempt > 0) await Bun.sleep(RETRY_PAUSES_MS[attempt - 1]);
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (err) {
      lastError = err;
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`${message} (still failing after ${RETRY_PAUSES_MS.length + 1} attempts, ${FETCH_TIMEOUT_MS / 1000}s timeout each)`);
}
