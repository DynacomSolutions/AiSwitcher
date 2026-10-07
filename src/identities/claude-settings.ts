import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expandPath } from "./match.ts";

/**
 * Claude Code deletes transcripts older than `cleanupPeriodDays` (default
 * 30) at startup, which silently destroys the local history `ais usage`
 * reads. New claude identities therefore get a ten-year retention.
 */
export const CLAUDE_CLEANUP_PERIOD_DAYS = 3650;

/**
 * Seeds `<configDir>/settings.json` with `cleanupPeriodDays` unless the key
 * is already present (an existing value is never overwritten and other keys
 * are preserved). Creates the file when absent; leaves an unparsable or
 * non-object file untouched rather than clobbering it.
 */
export async function ensureClaudeTranscriptRetention(configDir: string): Promise<void> {
  const dir = expandPath(configDir);
  const path = join(dir, "settings.json");
  let existing: Record<string, unknown> = {};
  const file = Bun.file(path);
  if (await file.exists()) {
    try {
      const parsed: unknown = await file.json();
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
      existing = parsed as Record<string, unknown>;
    } catch {
      return;
    }
  }
  if ("cleanupPeriodDays" in existing) return;

  await mkdir(dir, { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify({ ...existing, cleanupPeriodDays: CLAUDE_CLEANUP_PERIOD_DAYS }, null, 2)}\n`);
  await rename(tmp, path);
}
