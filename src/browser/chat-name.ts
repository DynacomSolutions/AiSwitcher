import { claudeSessionTitle } from "../cli/sessions/claude.ts";
import { codexSessionTitle } from "../cli/sessions/codex.ts";
import { shortSessionId } from "./session-label.ts";

export const CHAT_NAME_TTL_MS = 30_000;
const MAX_NAME = 60;

export type ChatTool = "claude" | "codex";
export interface ChatNameSource {
  tool: ChatTool;
  configDirs: string[];
  id: string;
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
  let cached: { at: number; name: string } | undefined;
  const fallback = () => clean(env.AIS_SESSION_NAME) || shortSessionId(src.id);
  return async () => {
    if (cached && now() - cached.at < ttl) return cached.name;
    let found = "";
    for (const dir of src.configDirs) {
      try {
        found = clean(src.tool === "codex" ? await codexSessionTitle(dir, src.id) : await claudeSessionTitle(dir, src.id));
      } catch { /* unreadable transcript: try the next dir, then the fallback */ }
      if (found) break;
    }
    const name = found || fallback();
    cached = { at: now(), name };
    return name;
  };
}
