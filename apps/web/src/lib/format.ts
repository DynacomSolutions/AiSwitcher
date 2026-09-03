/** Display formatting helpers. Pure functions, no React dependencies. */

export function relSeconds(seconds: number): string {
  if (seconds < 3) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Relative time for an ISO timestamp in the past (or near future). */
export function relTime(iso: string, nowMs: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  return relSeconds(Math.round((nowMs - then) / 1000));
}

/** Elapsed duration between an ISO timestamp and now, e.g. "3h 12m". */
export function durationSince(iso: string, nowMs: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";
  let seconds = Math.max(0, Math.round((nowMs - then) / 1000));
  const days = Math.floor(seconds / 86400);
  seconds -= days * 86400;
  const hours = Math.floor(seconds / 3600);
  seconds -= hours * 3600;
  const minutes = Math.floor(seconds / 60);
  seconds -= minutes * 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 && days === 0) parts.push(`${minutes}m`);
  if (parts.length === 0) parts.push(`${Math.max(seconds, 1)}s`);
  return parts.join(" ");
}

/** Server uptime, e.g. "2d 4h", "12m", "42s". */
export function formatUptime(totalSeconds: number): string {
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

const TOKEN_UNITS = ["", "k", "M", "B", "T"] as const;

/** Compact token counts: 950, 12.4k, 3.1M. */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const sign = value < 0 ? "-" : "";
  let v = Math.abs(value);
  let unit = 0;
  while (v >= 1000 && unit < TOKEN_UNITS.length - 1) {
    v /= 1000;
    unit += 1;
  }
  const text = v >= 100 || unit === 0 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
  return `${sign}${text}${TOKEN_UNITS[unit]}`;
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return "-";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let v = bytes;
  let unit = -1;
  do {
    v /= 1024;
    unit += 1;
  } while (v >= 1024 && unit < units.length - 1);
  return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)} ${units[unit]}`;
}

export function formatMoney(value: number): string {
  return `$${value.toFixed(value < 100 ? 2 : 0)}`;
}

/** Local YYYY-MM-DD from an epoch-milliseconds value. */
export function formatDateMs(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(ms);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

export function formatDateTime(iso: string | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function shortId(id: string): string {
  return id.length <= 12 ? id : id.slice(0, 8);
}

/** Join two path segments with exactly one separator; tolerates "~/" roots
 * and existing trailing slashes. Purely lexical: no filesystem access. */
export function joinPath(base: string, segment: string): string {
  const left = base.endsWith("/") ? base.slice(0, -1) : base;
  const right = segment.startsWith("/") ? segment : `/${segment}`;
  return `${left}${right}`;
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}
