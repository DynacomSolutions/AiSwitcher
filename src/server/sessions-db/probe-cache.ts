/**
 * In `auto` mode each scan child probes the database. A silent database costs one probe timeout per scan. The console
 * process remembers a failed probe for a short time and tells the next scan children to use the files without probing.
 * `db` mode never uses this: it has no files to fall back to.
 */
export const DB_PROBE_BACKOFF_MS = 60_000;

let downUntilMs = 0;
let failedInThisProcess = false;

/** Console process: a scan child reported a failed probe. */
export function noteDbProbeFailure(now = Date.now(), backoffMs = DB_PROBE_BACKOFF_MS): void {
  downUntilMs = now + backoffMs;
}

/** Console process: true while the last failed probe is recent. */
export function dbProbeSuspended(now = Date.now()): boolean {
  return now < downUntilMs;
}

/** Scan child: the probe failed in this process. */
export function markProbeFailedHere(): void {
  failedInThisProcess = true;
}

/** Scan child: reads and clears the flag, to send it to the console process with the result. */
export function takeProbeFailed(): boolean {
  const v = failedInThisProcess;
  failedInThisProcess = false;
  return v;
}

/** Test seam. */
export function resetProbeCacheForTest(): void {
  downUntilMs = 0;
  failedInThisProcess = false;
}
