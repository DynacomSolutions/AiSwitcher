import { randomUUID } from "node:crypto";
import { mkdir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { aisConfigDir } from "../shared/ais-home.ts";
import type { SyncConfig } from "./types.ts";

const HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;

export function syncConfigPath(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  return env.AIS_SYNC_CONFIG || join(aisConfigDir(home), "sync-v2.json");
}

export function validateRemoteHost(host: string): string {
  if (!HOST_PATTERN.test(host)) {
    throw new Error(
      `Invalid SSH host alias "${host}" — use an SSH config host (or user@host) containing only ` +
        `letters, digits, dots, underscores, hyphens, or @.`,
    );
  }
  return host;
}

export function parseSyncConfig(raw: unknown): SyncConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("AIS sync config is not a JSON object");
  }
  const rec = raw as Record<string, unknown>;
  // Version 2 is the ownership-safe, stable-session-ID merge protocol. Read
  // version 1 so the management CLI can migrate it, but always return/save 2.
  // Already-running v1 wrappers reject a v2 file, deliberately quarantining
  // stale in-memory transports after an upgrade.
  if (rec.version !== 1 && rec.version !== 2) {
    throw new Error(`AIS sync config has unsupported "version" (expected 1 or 2)`);
  }
  if (!Array.isArray(rec.remotes) || rec.remotes.some((host) => typeof host !== "string")) {
    throw new Error(`AIS sync config has a non-string[] "remotes" value`);
  }

  const remotes: string[] = [];
  for (const host of rec.remotes as string[]) {
    validateRemoteHost(host);
    if (!remotes.includes(host)) remotes.push(host);
  }
  return { version: 2, remotes };
}

export async function loadSyncConfig(path: string = syncConfigPath()): Promise<SyncConfig> {
  const file = Bun.file(path);
  if (!(await file.exists())) return { version: 2, remotes: [] };
  return parseSyncConfig(await file.json());
}

export async function saveSyncConfig(config: SyncConfig, path: string = syncConfigPath()): Promise<void> {
  const parsed = parseSyncConfig(config);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmpPath = join(dir, `.sync.${randomUUID()}.tmp`);
  await Bun.write(tmpPath, `${JSON.stringify(parsed, null, 2)}\n`);
  await rename(tmpPath, path);
}

export function addRemote(config: SyncConfig, host: string): boolean {
  validateRemoteHost(host);
  if (config.remotes.includes(host)) return false;
  config.remotes.push(host);
  return true;
}

export function removeRemote(config: SyncConfig, host: string): boolean {
  const index = config.remotes.indexOf(host);
  if (index === -1) return false;
  config.remotes.splice(index, 1);
  return true;
}
