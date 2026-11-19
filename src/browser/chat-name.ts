import { claudeSessionTitle } from "../cli/sessions/claude.ts";
import { codexSessionTitle } from "../cli/sessions/codex.ts";
import { cleanLabel as clean, fallbackLabel } from "./session-label.ts";
import { t3ThreadTitle } from "./t3-thread-title.ts";

export const CHAT_NAME_TTL_MS = 30_000;

export type ChatTool = "claude" | "codex";
export interface ChatNameSource {
  /** Absent (shell bridge): only the T3 title, AIS_SESSION_NAME and the readable fallback are used. */
  tool?: ChatTool;
  configDirs: string[];
  /** The session id, or a lookup for it (Codex: derived from the parent process; undefined until the thread exists). */
  id?: string | (() => Promise<string | undefined>);
  /** Folder for the `<Tool> in <folder>` fallback; defaults to the working directory. */
  cwd?: string;
  /** Test hook: path of the T3 database. */
  t3DbPath?: string;
  now?: () => number;
  ttlMs?: number;
}

/**
 * Looks the session's chat name up with the same readers the console Sessions page uses. The name
 * appears after the first prompt and changes on /rename, so the result is cached for a short while
 * and then looked up again. Order: T3 Code thread title, transcript chat name, AIS_SESSION_NAME, then `<Tool> in <folder>`. Never an id or the identity.
 */
export function chatNameResolver(src: ChatNameSource, env: NodeJS.ProcessEnv = process.env): () => Promise<string> {
  const now = src.now ?? Date.now;
  const ttl = src.ttlMs ?? CHAT_NAME_TTL_MS;
  let threadId: string | undefined;
  let cached: { at: number; name: string } | undefined;
  const fallback = () => clean(env.AIS_SESSION_NAME) || fallbackLabel(src.tool, src.cwd);
  let inflight: Promise<string> | undefined;
  return () => {
    if (cached && now() - cached.at < ttl) return Promise.resolve(cached.name);
    // One lookup at a time: callers that give up waiting do not pile up scans.
    inflight ??= lookup().finally(() => { inflight = undefined; });
    return inflight;
  };
  async function lookup(): Promise<string> {
    let found = t3ThreadTitle(env, src.t3DbPath);
    if (found) return remember(found);
    let id = typeof src.id === "string" ? src.id : undefined;
    if (!id && typeof src.id === "function") {
      try { id = threadId ??= await (src.id as () => Promise<string | undefined>)(); } catch { /* retry on the next lookup */ }
    }
    for (const dir of id && src.tool ? src.configDirs : []) {
      try {
        found = clean(src.tool === "codex" ? await codexSessionTitle(dir, id!) : await claudeSessionTitle(dir, id!));
      } catch { /* unreadable transcript: try the next dir, then the fallback */ }
      if (found) break;
    }
    return remember(found || fallback());
  }
  function remember(name: string): string {
    cached = { at: now(), name };
    return name;
  }
}
