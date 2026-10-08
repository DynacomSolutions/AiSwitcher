import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Optional in-session trigger: a Claude Code StopFailure hook (matcher
 * "rate_limit", present in Claude Code 2.1.29x) in the POOL's settings.json
 * that runs `ais claude-swap next --if-limited`, so a hard 429 swaps the
 * credentials immediately instead of waiting for the daemon poll. A running
 * session re-reads .credentials.json on its next turn, so the retry uses the
 * new account.
 */

const MARK = "ais claude-swap next --if-limited";

export function hookCommand(pool: string): string {
  return `${MARK} --assume-limited --reason=auto --pool=${pool}`;
}

type HookGroup = { matcher?: string; hooks?: Array<{ type?: string; command?: string }> };

function isOurs(group: HookGroup): boolean {
  return (group.hooks ?? []).some((h) => typeof h.command === "string" && h.command.startsWith(MARK));
}

async function readSettings(configDir: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(configDir, "settings.json"), "utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // absent or unreadable: start fresh
  }
  return {};
}

async function writeSettings(configDir: string, settings: Record<string, unknown>): Promise<void> {
  await mkdir(configDir, { recursive: true });
  const path = join(configDir, "settings.json");
  const temp = `${path}.tmp-${process.pid}`;
  await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`);
  await rename(temp, path);
}

/** Adds (or replaces) the StopFailure hook; every other setting and hook is preserved. */
export async function installSwapHook(configDir: string, pool: string): Promise<void> {
  const settings = await readSettings(configDir);
  const hooks = (typeof settings.hooks === "object" && settings.hooks !== null ? settings.hooks : {}) as Record<string, unknown>;
  const groups = ((hooks.StopFailure as HookGroup[] | undefined) ?? []).filter((g) => !isOurs(g));
  groups.push({ matcher: "rate_limit", hooks: [{ type: "command", command: hookCommand(pool) }] });
  await writeSettings(configDir, { ...settings, hooks: { ...hooks, StopFailure: groups } });
}

export async function removeSwapHook(configDir: string): Promise<boolean> {
  const settings = await readSettings(configDir);
  const hooks = settings.hooks as Record<string, unknown> | undefined;
  const groups = hooks?.StopFailure as HookGroup[] | undefined;
  if (!hooks || !groups || !groups.some(isOurs)) return false;
  const rest = groups.filter((g) => !isOurs(g));
  const nextHooks = { ...hooks };
  if (rest.length > 0) nextHooks.StopFailure = rest;
  else delete nextHooks.StopFailure;
  const next = { ...settings, hooks: nextHooks };
  if (Object.keys(nextHooks).length === 0) delete (next as Record<string, unknown>).hooks;
  await writeSettings(configDir, next);
  return true;
}
