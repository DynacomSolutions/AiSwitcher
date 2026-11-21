import { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readAliApiKey } from "./ali-auth.ts";
import { memberDir, memberStoreRoot, type MemberStoreTool } from "./gateway-members.ts";
import { folderHoldsGatewayEntry } from "./gateway-routed.ts";
import { expandPath } from "./match.ts";
import { credentialPathsForTool } from "./credential-paths.ts";
import { isRetired } from "./retired.ts";
import { isSwapPool } from "./pool/swap-pool.ts";
import type { Identity, ToolConfig } from "./types.ts";
import { readZaiApiKey } from "./zai-auth.ts";

/**
 * Which account an identity's login belongs to.
 *
 * Reads files only. The result never holds a token or an API key, not even a prefix:
 * only an email, a plain label, an account id and an organisation name.
 * Every function here returns undefined instead of throwing.
 */

export interface AccountLogin {
  provider: string;
  email?: string;
  label?: string;
  accountId?: string;
}

export interface AccountInfo {
  email?: string;
  /** A plain description when there is no email, for example "API key". */
  label?: string;
  accountId?: string;
  organization?: string;
  /** One entry per provider login, for tools whose file holds several (pi, opencode). */
  logins?: AccountLogin[];
  /** "gateway-member": the gateway's member copy of the login. "folder": the identity folder's own login. */
  source: "gateway-member" | "folder";
  /** The identity folder records a different account from the gateway member copy. */
  mismatch?: { folderEmail?: string; folderAccountId?: string };
}

export type AccountWithShared = AccountInfo & { sharedWith?: string[] };

type Json = Record<string, unknown>;

const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined);

async function readJson(path: string): Promise<Json | undefined> {
  try {
    const v: unknown = JSON.parse(await readFile(path, "utf8"));
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined;
  } catch {
    return undefined;
  }
}

/** Payload of a JWT, decoded without any signature check. Undefined when the value is not a JWT. */
export function decodeJwtPayload(token: unknown): Json | undefined {
  if (typeof token !== "string") return undefined;
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const b64 = parts[1]!.replaceAll("-", "+").replaceAll("_", "/");
    const v: unknown = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined;
  } catch {
    return undefined;
  }
}

function emailFromClaims(claims: Json | undefined): string | undefined {
  if (!claims) return undefined;
  const profile = claims["https://api.openai.com/profile"] as Json | undefined;
  return text(claims.email) ?? text(profile?.email);
}

function trimmed(info: Omit<AccountInfo, "source">, source: AccountInfo["source"]): AccountInfo | undefined {
  const out: AccountInfo = { source };
  if (info.email) out.email = info.email;
  if (info.label) out.label = info.label;
  if (info.accountId) out.accountId = info.accountId;
  if (info.organization) out.organization = info.organization;
  return out.email || out.label || out.accountId ? out : undefined;
}

async function readClaudeDir(dir: string, source: AccountInfo["source"]): Promise<AccountInfo | undefined> {
  const json = await readJson(join(dir, ".claude.json"));
  const acct = json?.oauthAccount as Json | undefined;
  if (!acct) return undefined;
  return trimmed({ email: text(acct.emailAddress), accountId: text(acct.accountUuid), organization: text(acct.organizationName) }, source);
}

async function readCodexDir(dir: string, source: AccountInfo["source"]): Promise<AccountInfo | undefined> {
  const json = await readJson(join(dir, "auth.json"));
  const tokens = json?.tokens as Json | undefined;
  if (!tokens) return undefined;
  const idClaims = decodeJwtPayload(tokens.id_token);
  const authClaim = idClaims?.["https://api.openai.com/auth"] as Json | undefined;
  const accessClaims = decodeJwtPayload(tokens.access_token);
  const accessAuth = accessClaims?.["https://api.openai.com/auth"] as Json | undefined;
  const accountId = text(tokens.account_id) ?? text(authClaim?.chatgpt_account_id) ?? text(accessAuth?.chatgpt_account_id);
  const email = emailFromClaims(idClaims) ?? emailFromClaims(accessClaims);
  return trimmed({ email, accountId }, source);
}

/** Looks through a credential JSON (depth limited) for an email field or an email claim inside a JWT string. */
function findEmail(value: unknown, depth = 0): string | undefined {
  if (depth > 4) return undefined;
  if (typeof value === "string") return emailFromClaims(decodeJwtPayload(value));
  if (typeof value !== "object" || value === null) return undefined;
  for (const [key, child] of Object.entries(value)) {
    if (/^(email|emailaddress|user_email|useremail)$/i.test(key)) {
      const e = text(child);
      if (e && e.includes("@")) return e;
    }
  }
  for (const child of Object.values(value)) {
    const found = findEmail(child, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** True when the credential JSON holds a static key entry (type "api" or an api key field). */
function holdsApiKey(value: unknown, depth = 0): boolean {
  if (depth > 4 || typeof value !== "object" || value === null) return false;
  for (const [key, child] of Object.entries(value)) {
    if (key === "type" && typeof child === "string" && /^(api|apikey|api_key|key)$/i.test(child)) return true;
    if (/^(api[_-]?key|key)$/i.test(key) && typeof child === "string" && child.length > 0) return true;
    if (holdsApiKey(child, depth + 1)) return true;
  }
  return false;
}

async function readGenericCredentials(tool: ToolConfig["toolName"], configDir: string): Promise<AccountInfo | undefined> {
  for (const path of credentialPathsForTool(tool, configDir)) {
    if (path.endsWith(".toml")) {
      try {
        const m = /^\s*email\s*=\s*"([^"\n]+@[^"\n]+)"/m.exec(await readFile(path, "utf8"));
        if (m?.[1]) return { source: "folder", email: m[1].trim() };
      } catch {
        // Missing file: try the next path.
      }
      continue;
    }
    const json = await readJson(path);
    if (!json) continue;
    const email = findEmail(json);
    if (email) return { source: "folder", email };
    if (holdsApiKey(json)) return { source: "folder", label: "API key" };
  }
  return undefined;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** Identity claims of an access token (JWT), or an empty login when it is opaque. Never returns the token. */
function claimsLogin(provider: string, token: unknown): AccountLogin {
  const claims = decodeJwtPayload(token);
  const login: AccountLogin = { provider };
  if (!claims) return login;
  const auth = claims["https://api.openai.com/auth"] as Json | undefined;
  const email = emailFromClaims(claims);
  const accountId = text(auth?.chatgpt_account_id) ?? text(claims.principal_id) ?? text(claims.user_id);
  if (email) login.email = email;
  if (accountId) login.accountId = accountId;
  const userId = text(claims.user_id);
  if (!email && userId && /kimi/i.test(provider)) login.label = `Kimi user ${userId}`;
  return login;
}

/** One login per provider key of a pi or opencode auth.json. Static keys give the label "API key". */
function loginsFromAuthJson(json: Json | undefined): AccountLogin[] {
  const out: AccountLogin[] = [];
  for (const [provider, v] of Object.entries(json ?? {})) {
    if (!isObj(v)) continue;
    if (/^(api|apikey|api_key|key)$/i.test(String(v.type ?? "")) || (str(v.key) && !str(v.access))) {
      out.push({ provider, label: "API key" });
      continue;
    }
    const login = claimsLogin(provider, v.access);
    if (!login.email && !login.label) login.label = provider === "xai" ? "xAI OAuth" : "OAuth";
    out.push(login);
  }
  return out;
}

/** Folds the per-provider logins into one AccountInfo: first email on top, a summary label when no email. */
function fromLogins(logins: AccountLogin[]): AccountInfo | undefined {
  if (logins.length === 0) return undefined;
  const first = logins.find((l) => l.email) ?? logins.find((l) => l.accountId);
  const out: AccountInfo = { source: "folder", logins };
  if (first?.email) out.email = first.email;
  if (first?.accountId) out.accountId = first.accountId;
  if (!first?.email) {
    const label = [...new Set(logins.map((l) => l.label).filter(Boolean))].join(", ");
    if (label) out.label = label;
  }
  return out;
}

async function readKimi(configDir: string): Promise<AccountInfo | undefined> {
  const json = await readJson(join(configDir, "credentials", "kimi-code.json"));
  const login = claimsLogin("kimi", json?.access_token);
  if (!login.accountId) return undefined;
  return { source: "folder", accountId: login.accountId, label: `Kimi user ${login.accountId}` };
}

/** Console account and credential kinds from opencode.db, read-only. Selects no token column. Missing db or tables give []. */
function opencodeDbLogins(configDir: string): AccountLogin[] {
  let db: Database;
  try {
    db = new Database(join(configDir, "data", "opencode", "opencode.db"), { readonly: true });
  } catch {
    return [];
  }
  const out: AccountLogin[] = [];
  try {
    try {
      const rows = db.query("SELECT a.email AS email FROM account_state s JOIN account a ON a.id = s.active_account_id").all() as Array<{ email: unknown }>;
      const email = str(rows[0]?.email);
      if (email) out.push({ provider: "opencode console", email });
    } catch {
      // No account tables: skip.
    }
    try {
      const rows = db.query("SELECT integration_id AS provider, json_extract(value, '$.type') AS kind FROM credential WHERE active IS NOT 0").all() as Array<{ provider: unknown; kind: unknown }>;
      for (const r of rows) {
        const provider = str(r.provider);
        if (provider) out.push({ provider, label: r.kind === "api" ? "API key" : "OAuth" });
      }
    } catch {
      // No credential table: skip.
    }
  } finally {
    db.close();
  }
  return out;
}

async function readOpencode(configDir: string): Promise<AccountInfo | undefined> {
  const logins = opencodeDbLogins(configDir);
  for (const path of credentialPathsForTool("opencode", configDir)) {
    const json = await readJson(path);
    if (!json) continue;
    for (const l of loginsFromAuthJson(json)) if (!logins.some((x) => x.provider === l.provider)) logins.push(l);
    break;
  }
  return fromLogins(logins);
}

/**
 * True when two account reads name different accounts: the ids differ or the emails differ.
 * Each part is compared only when both sides have it. A codex account id is a workspace id
 * that team seats share, so the same id with another email is another account.
 */
export function accountsDiffer(a: Pick<AccountInfo, "email" | "accountId">, b: Pick<AccountInfo, "email" | "accountId">): boolean {
  if (a.accountId && b.accountId && a.accountId !== b.accountId) return true;
  if (a.email && b.email && a.email.toLowerCase() !== b.email.toLowerCase()) return true;
  return false;
}

/**
 * The account behind one identity's login, or undefined when none can be read.
 * Claude and codex: the gateway member copy is the account in use. The folder is read too,
 * and a different account in the folder sets `mismatch`.
 */
export async function accountInfoFor(tool: ToolConfig["toolName"], identity: Identity, memberRoot: string = memberStoreRoot()): Promise<AccountInfo | undefined> {
  try {
    if (isRetired(identity) || isSwapPool(identity)) return undefined;
    const configDir = expandPath(identity.configDir);
    if (tool === "claude" || tool === "codex") {
      const read = tool === "claude" ? readClaudeDir : readCodexDir;
      const memberTool: MemberStoreTool = tool;
      // A folder that holds only the pure gateway entry has no login: a cached account in its .claude.json is a leftover, not a login.
      const gatewayFolder = folderHoldsGatewayEntry(memberTool, identity);
      const folder = gatewayFolder ? undefined : await read(configDir, "folder");
      // A missing member copy reads as undefined, so the folder login stands.
      const member = await read(memberDir(memberTool, identity.name, memberRoot), "gateway-member");
      if (!member) return folder;
      if (folder && accountsDiffer(member, folder)) {
        member.mismatch = { ...(folder.email ? { folderEmail: folder.email } : {}), ...(folder.accountId ? { folderAccountId: folder.accountId } : {}) };
      }
      return member;
    }
    if (tool === "zai") return (await readZaiApiKey(configDir).catch(() => undefined)) ? { source: "folder", label: "API key" } : undefined;
    if (tool === "ali") {
      if (await readAliApiKey(configDir).catch(() => undefined)) return { source: "folder", label: "API key" };
      return (await Bun.file(join(configDir, "console-cookie.txt")).exists().catch(() => false)) ? { source: "folder", label: "Console cookie" } : undefined;
    }
    if (tool === "kimi") return await readKimi(configDir);
    if (tool === "pi") return fromLogins(loginsFromAuthJson(await readJson(join(configDir, "auth.json"))));
    if (tool === "opencode") return await readOpencode(configDir);
    return await readGenericCredentials(tool, configDir);
  } catch {
    return undefined;
  }
}

/**
 * Adds `sharedWith` to every entry whose account is also used by another identity of the same tool.
 * With both id and email, both must match (a codex id is a workspace id that several users share).
 * With only one of them, that one must match. Emails compare without case.
 */
export function markSharedAccounts<T extends { toolName: string; identity: string; account?: AccountInfo }>(entries: T[]): Array<T & { account?: AccountWithShared }> {
  const keyOf = (e: T): string | undefined => {
    const a = e.account;
    if (!a) return undefined;
    if (!a.accountId && !a.email) return undefined;
    return `${e.toolName}\u0000${a.accountId ?? ""}\u0000${a.email?.toLowerCase() ?? ""}`;
  };
  const groups = new Map<string, string[]>();
  for (const e of entries) {
    const k = keyOf(e);
    if (k) groups.set(k, [...(groups.get(k) ?? []), e.identity]);
  }
  return entries.map((e) => {
    const k = keyOf(e);
    const names = k ? [...new Set(groups.get(k) ?? [])].filter((n) => n !== e.identity) : [];
    return names.length > 0 && e.account ? { ...e, account: { ...e.account, sharedWith: names } } : e;
  });
}

/** Accounts of every identity in the loaded registries, keyed `tool/identity`, with duplicates marked. */
export async function collectAccounts(loaded: Array<{ cfg: Pick<ToolConfig, "toolName">; file: { identities: Identity[] } }>, memberRoot?: string): Promise<Map<string, AccountWithShared>> {
  const rows: Array<{ toolName: string; identity: string; account?: AccountInfo }> = [];
  for (const { cfg, file } of loaded) {
    for (const identity of file.identities) {
      const account = await accountInfoFor(cfg.toolName, identity, memberRoot);
      rows.push({ toolName: cfg.toolName, identity: identity.name, ...(account ? { account } : {}) });
    }
  }
  const out = new Map<string, AccountWithShared>();
  for (const row of markSharedAccounts(rows)) if (row.account) out.set(accountKey(row.toolName, row.identity), row.account);
  return out;
}

export const accountKey = (tool: string, identity: string): string => `${tool}/${identity}`;
