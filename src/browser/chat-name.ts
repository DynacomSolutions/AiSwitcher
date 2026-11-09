import { claudeSessionTitle } from "../cli/sessions/claude.ts";
import { codexSessionTitle } from "../cli/sessions/codex.ts";
import { shortSessionId } from "./session-label.ts";

export const CHAT_NAME_TTL_MS = 30_000;
const MAX_NAME = 60;

export type ChatTool = "claude" | "codex";
export interface ChatNameSource {
  tool: ChatTool;
  configDirs: string[];
  /** The session id, or a lookup for it (Codex: derived from the parent process; undefined until the thread exists). */
  id: string | (() => Promise<string | undefined>);
  /** Id for the short fallback label; defaults to `id` when that is a string. */
  fallbackId?: string;
  now?: () => number;
  ttlMs?: number;
}

const clean = (s: string | undefined): string => (s ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);

/**
 * Looks the session's chat name up with the same readers the console Sessions page uses. The name
 * appears after the first prompt and changes on /rename, so the result is cached for a short while
 * and then looked up again. Falls back to the short session id while no name exists. Never the identity.
 */
export function chatNameResolver(src: ChatNameSource, env: NodeJS.ProcessEnv = process.env): () => Promise<string> {
  const now = src.now ?? Date.now;
  const ttl = src.ttlMs ?? CHAT_NAME_TTL_MS;
  let threadId: string | undefined;
  let cached: { at: number; name: string } | undefined;
  const fallback = () => clean(env.AIS_SESSION_NAME) || shortSessionId(src.fallbackId ?? (typeof src.id === "string" ? src.id : ""));
  let inflight: Promise<string> | undefined;
  return () => {
    if (cached && now() - cached.at < ttl) return Promise.resolve(cached.name);
    // One lookup at a time: callers that give up waiting do not pile up scans.
    inflight ??= lookup().finally(() => { inflight = undefined; });
    return inflight;
  };
  async function lookup(): Promise<string> {
    let found = "";
    let id = typeof src.id === "string" ? src.id : undefined;
    if (!id) {
      try { id = threadId ??= await (src.id as () => Promise<string | undefined>)(); } catch { /* retry on the next lookup */ }
    }
    for (const dir of id ? src.configDirs : []) {
      try {
        found = clean(src.tool === "codex" ? await codexSessionTitle(dir, id!) : await claudeSessionTitle(dir, id!));
      } catch { /* unreadable transcript: try the next dir, then the fallback */ }
      if (found) break;
    }
    const name = found || fallback();
    cached = { at: now(), name };
    return name;
  }
}
