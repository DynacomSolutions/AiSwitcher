import { basename } from "node:path";
import { t3ThreadTitle } from "./t3-thread-title.ts";

const MAX_LABEL = 60;

/** Random UUIDs keep 6 chars; human-chosen ids show up to 12. */
export function shortSessionId(id: string): string {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id) ? id.slice(0, 6) : id.slice(0, 12);
}

/** Collapses whitespace and caps the length. */
export function cleanLabel(s: string | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_LABEL);
}

/** A readable label that is never an id: `<Tool> in <folder>`. */
export function fallbackLabel(tool: "claude" | "codex" | undefined, cwd: string = process.cwd()): string {
  const name = tool === "claude" ? "Claude" : tool === "codex" ? "Codex" : "Agent";
  const dir = basename(cwd);
  return cleanLabel(dir ? `${name} in ${dir}` : name);
}

/**
 * The name an agent session shows in its tab group and on the page pill. Order: T3 Code thread title,
 * then the name the launcher passes in AIS_SESSION_NAME, then `<Tool> in <folder>`. The shim adds the
 * transcript chat title between the first two. Never an id, never the identity.
 */
export function sessionName(env: NodeJS.ProcessEnv = process.env, tool?: "claude" | "codex", cwd?: string): string {
  return t3ThreadTitle(env) || cleanLabel(env.AIS_SESSION_NAME) || fallbackLabel(tool, cwd);
}

/** Longest wait for the T3 thread title at launch. */
export const LAUNCH_LABEL_WAIT_MS = 200;

/**
 * The session name a launch sends to the gateway: T3 thread title (read-only lookup, given at most 200 ms), else `<Tool> in <folder>`.
 * Never throws and never delays the launch by more than the wait. `lookup` is injectable for tests.
 */
export async function launchSessionLabel(env: NodeJS.ProcessEnv, tool: "claude" | "codex", cwd: string, lookup: (env: NodeJS.ProcessEnv) => string | undefined | Promise<string | undefined> = t3ThreadTitle, waitMs = LAUNCH_LABEL_WAIT_MS): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const slow = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), waitMs); timer.unref?.(); });
  try {
    const title = await Promise.race([Promise.resolve().then(() => lookup(env)).catch(() => undefined), slow]);
    return cleanLabel(title) || cleanLabel(env.AIS_SESSION_NAME) || fallbackLabel(tool, cwd);
  } finally {
    clearTimeout(timer);
  }
}
