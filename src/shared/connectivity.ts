import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { aisCacheDir } from "./ais-home";

export interface OnlineDeps {
  probe?: (url: string, timeoutMs: number) => Promise<boolean>;
  now?: () => number;
  cachePath?: string;
  env?: NodeJS.ProcessEnv;
}

export const ONLINE_TTL_MS = 60_000;
export const OFFLINE_TTL_MS = 5_000;
export const PROBE_TIMEOUT_MS = 2_500;
export const DEFAULT_PROBE_URL = "https://github.com";
export const OFFLINE_WARNED_ENV = "AIS_LAUNCH_OFFLINE_WARNED";
export const CACHED_MAX_AGE_MS = 120_000;

interface Entry { at: number; online: boolean }

function readEntry(cachePath: string): Entry | undefined {
  try {
    const v = JSON.parse(readFileSync(cachePath, "utf8")) as Partial<Entry>;
    return typeof v.at === "number" && typeof v.online === "boolean" ? { at: v.at, online: v.online } : undefined;
  } catch {
    return undefined;
  }
}

const defaultPath = () => join(aisCacheDir(), "online.json");

async function defaultProbe(url: string, timeoutMs: number): Promise<boolean> {
  try {
    await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}

export async function isOnline(deps: OnlineDeps = {}): Promise<boolean> {
  const now = deps.now ?? Date.now;
  const cachePath = deps.cachePath ?? defaultPath();
  const hit = readEntry(cachePath);
  if (hit && hit.at <= now() && now() - hit.at < (hit.online ? ONLINE_TTL_MS : OFFLINE_TTL_MS)) return hit.online;
  const url = (deps.env ?? process.env).AIS_ONLINE_PROBE_URL || DEFAULT_PROBE_URL;
  let online = false;
  try {
    online = await (deps.probe ?? defaultProbe)(url, PROBE_TIMEOUT_MS);
  } catch {
    online = false;
  }
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify({ at: now(), online }));
  } catch {
    // cache is best effort
  }
  return online;
}

// Synchronous, cache only: the shim path must never wait on the network.
export function cachedOnline(
  deps: Pick<OnlineDeps, "now" | "cachePath"> = {},
  maxAgeMs: number = CACHED_MAX_AGE_MS,
): boolean | undefined {
  const e = readEntry(deps.cachePath ?? defaultPath());
  const t = (deps.now ?? Date.now)();
  return e && e.at <= t && t - e.at <= maxAgeMs ? e.online : undefined;
}

export function offlineWarning(subject: string, localModelAvailable: boolean): string {
  const base = `No internet connection: ${subject} needs one. Check your network and try again.`;
  return localModelAvailable ? `${base} A local model is installed: run "ais local start" for help.` : base;
}

// Shim launches: cached result only. `localModelAvailable` stays false because
// finding a model is async (discoverLocalModels) and the shim never waits.
export function shimOfflineNotice(
  deps: { cached?: () => boolean | undefined; localModelAvailable?: boolean; subject?: string } = {},
): string | undefined {
  return (deps.cached ?? (() => cachedOnline()))() === false
    ? offlineWarning(deps.subject ?? "this tool", deps.localModelAvailable ?? false)
    : undefined;
}
