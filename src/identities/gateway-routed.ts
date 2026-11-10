import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isGatewayAccessToken } from "./claude-gateway-entry.ts";
import { memberLoginFile, type MemberStoreTool } from "./gateway-members.ts";
import { expandPath } from "./match.ts";
import { createFileDurable } from "./pool/fs.ts";
import type { Identity } from "./types.ts";

/**
 * What a claude or codex identity folder's login file holds after `ais identities route-all-via-gateway`.
 *
 * Only that command writes the gateway entry into a plain (not swap pool) identity folder. So a plain folder that holds the
 * gateway entry is routed: on this host, or on another host whose sync carried the entry here. Either way the login itself
 * belongs to a gateway, and no process on this host may refresh or reconcile it (gateway-managed.ts), and no sync may put a
 * real login back over the entry (sync/gateway-guard.ts).
 */

export type LoginKind = "login" | "gateway" | "none";

function parseObject(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/** What a folder's login file holds: a real refreshable login, the gateway entry, or neither (logged out, API key, Bedrock). */
export function classifyLogin(tool: MemberStoreTool, text: string | undefined): LoginKind {
  const json = parseObject(text);
  if (!json) return "none";
  if (tool === "claude") {
    const oauth = json.claudeAiOauth as { accessToken?: unknown; refreshToken?: unknown } | undefined;
    if (isGatewayAccessToken(oauth?.accessToken)) return "gateway";
    return nonEmpty(oauth?.accessToken) && nonEmpty(oauth?.refreshToken) ? "login" : "none";
  }
  if (isGatewayAccessToken(json.OPENAI_API_KEY)) return "gateway";
  const tokens = json.tokens as { access_token?: unknown; refresh_token?: unknown } | undefined;
  return nonEmpty(tokens?.access_token) && nonEmpty(tokens?.refresh_token) ? "login" : "none";
}

/** True for the pure gateway entry: an app token and no refresh token (a damaged file, app token beside a refresh token, is not). */
export function isPureGatewayEntry(tool: MemberStoreTool, text: string | undefined): boolean {
  if (classifyLogin(tool, text) !== "gateway") return false;
  const json = parseObject(text)!;
  const refresh = tool === "claude" ? (json.claudeAiOauth as { refreshToken?: unknown } | undefined)?.refreshToken : (json.tokens as { refresh_token?: unknown } | undefined)?.refresh_token;
  return !nonEmpty(refresh);
}

/** True when a plain identity's own folder holds the pure gateway entry (see the module comment). Swap pools never count. */
export function folderHoldsGatewayEntry(tool: MemberStoreTool, identity: Identity): boolean {
  if (identity.swapPool) return false;
  let text: string | undefined;
  try {
    text = readFileSync(join(expandPath(identity.configDir), memberLoginFile(tool)), "utf8");
  } catch {
    return false;
  }
  return isPureGatewayEntry(tool, text);
}

/**
 * `<file>.pre-gateway.<timestamp>[-n].bak`, created exclusively with mode 0600, flushed to disk and read back: an existing
 * backup is never overwritten or removed. Undefined when the file does not exist.
 */
export async function backupUnique(path: string, now: () => number = Date.now): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, "-");
  for (let n = 0; ; n++) {
    const target = `${path}.pre-gateway.${stamp}${n === 0 ? "" : `-${n}`}.bak`;
    try {
      await createFileDurable(target, text);
      return target;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || n > 1000) throw err;
    }
  }
}
