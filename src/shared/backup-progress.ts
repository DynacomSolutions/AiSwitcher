/** Progress reporting for the backup: byte counts, percentage and an ETA from the observed rate. */

export interface BackupProgress {
  /** Bytes the backup is expected to copy; undefined while still being measured. */
  totalBytes?: number;
  doneBytes?: number;
  /** Label of a later phase (e.g. "snapshotting databases") shown once the copy itself is done. */
  phase?: string;
}

/** Samples needed, and the minimum time they must span, before an ETA is trusted. */
export const ETA_MIN_SAMPLES = 3;
export const ETA_MIN_SPAN_MS = 1000;

export interface ProgressSample {
  at: number;
  done: number;
}

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** `3.1 / 7.4 GB`: both figures in the unit that suits the total. */
export function formatBytesPair(done: number, total: number): string {
  let unit = 0;
  while (unit < UNITS.length - 1 && total >= 1024 ** (unit + 1)) unit++;
  const digits = unit === 0 ? 0 : 1;
  const scale = 1024 ** unit;
  return `${(done / scale).toFixed(digits)} / ${(total / scale).toFixed(digits)} ${UNITS[unit]}`;
}

/** Seconds left at the average rate across the samples, or undefined while there are too few. */
export function etaSeconds(samples: readonly ProgressSample[], total: number): number | undefined {
  if (samples.length < ETA_MIN_SAMPLES) return undefined;
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const span = last.at - first.at;
  const moved = last.done - first.done;
  if (span < ETA_MIN_SPAN_MS || moved <= 0) return undefined;
  return Math.max(0, total - last.done) / (moved / span) / 1000;
}

/** Heartbeat text after the "ais update:" style prefix, e.g.
 * `backing up 42% (3.1 / 7.4 GB), ETA 1m20s (elapsed 45s)`. */
export function formatProgressLine(progress: BackupProgress | undefined, samples: readonly ProgressSample[], elapsedMs: number): string {
  const elapsed = formatDuration(elapsedMs / 1000);
  if (!progress || progress.totalBytes === undefined) return `still backing up (measuring, elapsed ${elapsed})`;
  const total = progress.totalBytes;
  if (total <= 0) return `still backing up (nothing new to copy, finishing, elapsed ${elapsed})`;
  const done = Math.min(progress.doneBytes ?? 0, total);
  const pct = Math.floor((done / total) * 100);
  const eta = etaSeconds(samples, total);
  const etaText = eta === undefined ? "ETA estimating..." : `ETA ${formatDuration(eta)}`;
  if (progress.phase) return `backing up ${pct}% (${formatBytesPair(done, total)}), ${progress.phase} (elapsed ${elapsed})`;
  return `backing up ${pct}% (${formatBytesPair(done, total)}), ${etaText} (elapsed ${elapsed})`;
}

/** Collects progress reports and renders the heartbeat line. */
export function createProgressTracker(now: () => number = Date.now): {
  report: (p: BackupProgress) => void;
  line: () => string;
} {
  const started = now();
  let current: BackupProgress | undefined;
  let samples: ProgressSample[] = [];
  return {
    report(p) {
      if (current && p.doneBytes !== undefined && p.doneBytes < (current.doneBytes ?? 0)) samples = []; // the copy restarted
      current = { ...current, ...p };
      if (p.doneBytes !== undefined) samples.push({ at: now(), done: p.doneBytes });
      if (samples.length > 60) samples.splice(0, samples.length - 60);
    },
    line: () => formatProgressLine(current, samples, now() - started),
  };
}
