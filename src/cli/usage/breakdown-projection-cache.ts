import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, fsyncSync } from "node:fs";
import { dirname, join } from "node:path";
import { aisCacheDir } from "../../shared/ais-home.ts";

export type BreakdownProjection = unknown[];

export interface BreakdownProjectionCacheDeps {
  cacheDir?: string;
  fingerprint?: (path: string) => string;
}

export interface BreakdownProjectionCache {
  schemaVersion: 1;
  path: string;
  fingerprint: string;
  events: BreakdownProjection[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sourceFingerprint(path: string): string {
  const value = statSync(path, { bigint: true });
  return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(":");
}

export function breakdownProjectionCachePath(
  tool: string,
  identityName: string,
  configDir: string,
  sourcePath: string,
  deps: BreakdownProjectionCacheDeps = {},
): string {
  const identityKey = sha256(`${tool}\0${identityName}\0${configDir}`);
  const fileKey = sha256(sourcePath);
  return join(deps.cacheDir ?? join(aisCacheDir(), "usage", "breakdown-source"), identityKey, `${fileKey}.json`);
}

export function readBreakdownProjectionCache(
  path: string,
  validateEvents: (events: unknown[]) => events is BreakdownProjection[],
): BreakdownProjectionCache | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<BreakdownProjectionCache>;
    if (
      value.schemaVersion !== 1 || typeof value.fingerprint !== "string" ||
      !Array.isArray(value.events) || !validateEvents(value.events)
    ) return undefined;
    return { schemaVersion: 1, path, fingerprint: value.fingerprint, events: value.events };
  } catch {
    return undefined;
  }
}

export function writeBreakdownProjectionCache(path: string, fingerprint: string, events: BreakdownProjection[]): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, JSON.stringify({ schemaVersion: 1, fingerprint, events }), "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch { /* renamed or absent */ }
  }
}
