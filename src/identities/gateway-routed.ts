import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isGatewayAccessToken } from "./claude-gateway-entry.ts";
import { codexAccountOf, codexRecency, parseCodexAuth } from "./codex-auth.ts";
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
  // `ais gateway codex-home` writes a placeholder ChatGPT login whose access token is the app token (codex-gateway-home.ts).
  if (isGatewayAccessToken(tokens?.access_token)) return "gateway";
  return nonEmpty(tokens?.access_token) && nonEmpty(tokens?.refresh_token) ? "login" : "none";
}

/** True for the pure gateway entry: an app token and no refresh token (a damaged file, app token beside a refresh token, is not). */
export function isPureGatewayEntry(tool: MemberStoreTool, text: string | undefined): boolean {
  if (classifyLogin(tool, text) !== "gateway") return false;
  const json = parseObject(text)!;
  const refresh = tool === "claude" ? (json.claudeAiOauth as { refreshToken?: unknown } | undefined)?.refreshToken : (json.tokens as { refresh_token?: unknown } | undefined)?.refresh_token;
  // The codex placeholder login carries the literal refresh token "none" (codex-gateway-home.ts): no login.
  return !nonEmpty(refresh) || (tool === "codex" && refresh === "none");
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

/** The refresh token of a claude or codex login file text, or undefined. */
export function refreshOf(tool: MemberStoreTool, text: string | undefined): string | undefined {
  const json = parseObject(text);
  const rt = tool === "claude" ? (json?.claudeAiOauth as { refreshToken?: unknown } | undefined)?.refreshToken : (json?.tokens as { refresh_token?: unknown } | undefined)?.refresh_token;
  return nonEmpty(rt) ? rt : undefined;
}

/** How fresh a login is (larger is fresher), or undefined: claude its access token expiry, codex its last refresh. */
export function loginFreshness(tool: MemberStoreTool, text: string): number | undefined {
  if (tool === "codex") {
    const at = codexRecency(parseCodexAuth(text));
    return at > 0 ? at : undefined;
  }
  const expiresAt = (parseObject(text)?.claudeAiOauth as { expiresAt?: unknown } | undefined)?.expiresAt;
  return typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : undefined;
}

/** The account of a login: codex the token's account id; claude the `.claude.json` account uuid in `claudeJsonText`. */
export function loginAccount(tool: MemberStoreTool, loginText: string | undefined, claudeJsonText?: string): string | undefined {
  if (tool === "codex") return codexAccountOf(parseCodexAuth(loginText)).id;
  const account = parseObject(claudeJsonText)?.oauthAccount as { accountUuid?: unknown } | undefined;
  return nonEmpty(account?.accountUuid) ? account.accountUuid : undefined;
}

/** A non-secret fingerprint of a refresh token: the first 16 hex digits of its sha256. */
export const refreshFingerprint = (refreshToken: string): string => createHash("sha256").update(refreshToken).digest("hex").slice(0, 16);

/**
 * What the gateway entry records about the login it replaced (the `aisGatewayRouting` key of the entry file; nothing in it is
 * secret). Another host uses it to tell its own copy of that login (the same refresh token, or an older login of the same
 * account), which the entry replaces, from a fresh sign-in made there after the routing, which it keeps (sync/gateway-guard.ts).
 */
export interface GatewayRouting {
  /** os.hostname() of the host that routed the identity. */
  host: string;
  /** When it was routed (ms). */
  at: number;
  /** Fingerprints of the refresh tokens the routed login had (the folder's and the member store's). */
  fingerprints: string[];
  /** loginFreshness of the freshest routed copy. */
  freshness?: number;
  /** Account of the routed login. */
  account?: string;
}

export const ROUTING_KEY = "aisGatewayRouting";

/** The routing record of a gateway entry text, or undefined (not an entry, or one written before the record existed). */
export function routingOf(text: string | undefined): GatewayRouting | undefined {
  const r = parseObject(text)?.[ROUTING_KEY] as Partial<GatewayRouting> | undefined;
  if (typeof r !== "object" || r === null || typeof r.host !== "string" || typeof r.at !== "number" || !Array.isArray(r.fingerprints)) return undefined;
  return {
    host: r.host,
    at: r.at,
    fingerprints: r.fingerprints.filter((f): f is string => typeof f === "string"),
    ...(typeof r.freshness === "number" ? { freshness: r.freshness } : {}),
    ...(nonEmpty(r.account) ? { account: r.account } : {}),
  };
}

/** The entry text with the routing record added (the entry's own keys unchanged). */
export function withRouting(entryText: string, routing: GatewayRouting): string {
  const json = parseObject(entryText);
  if (!json) throw new Error("gateway entry is not a JSON object");
  return `${JSON.stringify({ ...json, [ROUTING_KEY]: routing })}\n`;
}

/** The routing record for login copies `texts` (folder and member store), routed now by this host. */
export function routingFor(tool: MemberStoreTool, texts: Array<string | undefined>, account: string | undefined, host: string, at: number): GatewayRouting {
  const fingerprints = [...new Set(texts.map((t) => refreshOf(tool, t)).filter((t): t is string => t !== undefined).map(refreshFingerprint))];
  const fresh = texts.map((t) => (t === undefined ? undefined : loginFreshness(tool, t))).filter((f): f is number => f !== undefined);
  return { host, at, fingerprints, ...(fresh.length > 0 ? { freshness: Math.max(...fresh) } : {}), ...(account ? { account } : {}) };
}

/**
 * How a real login relates to a routing: `routed` when it is that login (a routed refresh token) or provably an older login
 * of the same account (not fresher than the routed copy, and not a different account); `separate` when it is a different
 * account or provably fresher (a sign-in made after the routing: a new refresh token family the gateway never held);
 * `unknown` when neither can be shown.
 */
export function relateToRouting(tool: MemberStoreTool, loginText: string | undefined, account: string | undefined, routing: GatewayRouting): "routed" | "separate" | "unknown" {
  const rt = refreshOf(tool, loginText);
  if (rt !== undefined && routing.fingerprints.includes(refreshFingerprint(rt))) return "routed";
  if (account !== undefined && routing.account !== undefined && account !== routing.account) return "separate";
  const fresh = loginText === undefined ? undefined : loginFreshness(tool, loginText);
  if (fresh === undefined || routing.freshness === undefined) return "unknown";
  return fresh <= routing.freshness ? "routed" : "separate";
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
