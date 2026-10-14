import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeJwtPayload } from "./oauth-reconcile.ts";
import { expandPath } from "./match.ts";

/**
 * Helpers for Codex's `auth.json` as seen by swap pools. The account of a
 * ChatGPT login is recorded twice: `tokens.account_id` and the
 * `https://api.openai.com/auth`.chatgpt_account_id claim of the access (or id)
 * token. A healthy file has both and they agree; a file where they differ is
 * "hybrid" (tokens of one account, account_id of another) and is never trusted.
 */

export interface CodexAuthFile {
  tokens?: Record<string, unknown>;
  last_refresh?: unknown;
  [key: string]: unknown;
}

export const codexAuthPath = (configDir: string): string => join(expandPath(configDir), "auth.json");

export function parseCodexAuth(text: string | undefined): CodexAuthFile | undefined {
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as CodexAuthFile) : undefined;
  } catch {
    return undefined;
  }
}

export async function readCodexAuthText(configDir: string): Promise<string | undefined> {
  try {
    return await readFile(codexAuthPath(configDir), "utf8");
  } catch {
    return undefined;
  }
}

const str = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value : undefined);

/** chatgpt_account_id claim of a JWT, when present. */
export function jwtAccountId(token: unknown): string | undefined {
  const claims = typeof token === "string" ? decodeJwtPayload(token) : undefined;
  const auth = claims?.["https://api.openai.com/auth"];
  return typeof auth === "object" && auth !== null ? str((auth as Record<string, unknown>).chatgpt_account_id) : undefined;
}

export interface CodexAccount {
  /** tokens.account_id as written in the file. */
  fileId?: string;
  /** Account id claimed by the access token (id_token as fallback). */
  jwtId?: string;
  /** Both known and different. */
  hybrid: boolean;
  /** The trustworthy id: undefined when hybrid or nothing is recorded. */
  id?: string;
}

export function codexAccountOf(auth: CodexAuthFile | undefined): CodexAccount {
  const tokens = auth?.tokens;
  const fileId = str(tokens?.account_id);
  const jwtId = jwtAccountId(tokens?.access_token) ?? jwtAccountId(tokens?.id_token);
  const hybrid = fileId !== undefined && jwtId !== undefined && fileId !== jwtId;
  const id = hybrid ? undefined : (fileId ?? jwtId);
  return { ...(fileId ? { fileId } : {}), ...(jwtId ? { jwtId } : {}), hybrid, ...(id ? { id } : {}) };
}

/** Unix seconds of the file's last refresh (`last_refresh`, else the access token's iat/exp). */
export function codexRecency(auth: CodexAuthFile | undefined): number {
  const lastRefresh = typeof auth?.last_refresh === "string" ? Date.parse(auth.last_refresh) / 1000 : NaN;
  if (Number.isFinite(lastRefresh)) return lastRefresh;
  const claims = typeof auth?.tokens?.access_token === "string" ? decodeJwtPayload(auth.tokens.access_token) : undefined;
  return typeof claims?.iat === "number" ? claims.iat : typeof claims?.exp === "number" ? claims.exp : -1;
}

/** True when the file carries a usable ChatGPT login (access token present). */
export const hasCodexTokens = (auth: CodexAuthFile | undefined): boolean => str(auth?.tokens?.access_token) !== undefined;

export async function codexAccountIdOfDir(configDir: string): Promise<string | undefined> {
  return codexAccountOf(parseCodexAuth(await readCodexAuthText(configDir))).id;
}
