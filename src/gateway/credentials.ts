import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { codexAccountOf, jwtAccountId, parseCodexAuth, readCodexAuthText } from "../identities/codex-auth.ts";
import { readAliApiKey } from "../identities/ali-auth.ts";
import { nativeStorePathFor } from "../identities/oauth-reconcile.ts";
import { DEAD_REFRESH_CODES, effectiveGrantPaths, OAuthRefreshError, readEffectiveGrant, refreshIdentityOAuthGrant, type RefreshableTool } from "../identities/oauth-refresh.ts";
import { SwapLockError } from "../identities/claude-swap-lock.ts";
import { isSwapPool } from "../identities/pool/swap-pool.ts";
import { isRetired } from "../identities/retired.ts";
import { readOpencodeAuth, readOpencodeV2Credentials } from "../cli/limits/opencode-limits.ts";
import { findIdentityByNameOrAlias, loadIdentitiesFile } from "../identities/store.ts";
import {
  ALI_CONFIG,
  CLAUDE_CONFIG,
  CODEX_CONFIG,
  GROK_CONFIG,
  KIMI_CONFIG,
  OPENCODE_CONFIG,
  ZAI_CONFIG,
} from "../identities/tool-configs.ts";
import type { Identity, ToolConfig } from "../identities/types.ts";
import { readZaiApiKey } from "../identities/zai-auth.ts";
import { adapterFor } from "./providers/index.ts";
import type { ProviderCredential } from "./providers/index.ts";
import type { GatewayProvider } from "./types.ts";

export type RefreshFn = typeof refreshIdentityOAuthGrant;

export interface CredentialCacheDeps {
  /** Test hook: skip the identity registry and use this directory. */
  resolveConfigDir?: (provider: GatewayProvider, identity: string) => Promise<string | undefined>;
  /** Test hook: like resolveConfigDir but returns the whole identity (for retired checks). */
  resolveIdentity?: (provider: GatewayProvider, identity: string) => Promise<Identity | undefined>;
  /** Test hook: registry listing claude swap pools. */
  claudeRegistryPath?: string;
  /** Test hook: clock in ms. */
  now?: () => number;
  /** Test hook: defaults to refreshIdentityOAuthGrant, which holds AIS's locks. */
  refresh?: RefreshFn;
}

/** Raised when a 401 hits a provider whose credential is a static API key. */
export class NotRefreshableError extends Error {
  constructor(provider: GatewayProvider, identity: string) {
    super(`gateway: ${provider} identity "${identity}" uses a static API key and cannot be refreshed; replace the key with ais`);
    this.name = "NotRefreshableError";
  }
}

/** A further 401 for the same identity this soon after a 401-triggered refresh is not refreshed again. */
export const REFRESH_COOLDOWN_MS = 60_000;

/** The proxy should pass the upstream 401 through to the client when it sees this. */
export class RefreshCooldownError extends Error {
  readonly code = "refresh-cooldown";
  constructor(provider: GatewayProvider, identity: string) {
    super(`gateway: ${provider} identity "${identity}" was refreshed less than ${REFRESH_COOLDOWN_MS / 1000}s ago (refresh-cooldown); not refreshing again`);
    this.name = "RefreshCooldownError";
  }
}

/**
 * The normal AIS way to log an identity back in. Verified against the code:
 * - `<tool> --identity=<name>` launches the tool under that identity (src/shared/cli-args.ts IDENTITY_PREFIXES,
 *   src/cli/launch.ts shimLaunchArgs); the login step inside it comes from REFRESH_HINTS in
 *   src/identities/oauth-refresh.ts (claude: `/login`; codex and grok: `<tool> login`; kimi: just run it).
 * - ali is the only tool with `ais auth login` (src/cli/auth/dispatch.ts, src/cli/identities/retire.ts).
 * - zai: docs/agents/history.md (`zai --identity=<name> auth login`).
 */
export function loginCommand(provider: GatewayProvider, identity: string): string {
  switch (provider) {
    case "claude":
      return `claude --identity=${identity}, then run /login inside it`;
    case "codex":
    case "grok":
      return `${provider} --identity=${identity} login`;
    case "kimi":
      return `kimi --identity=${identity}, then sign in when it asks`;
    case "ali":
      return `ais auth login ${identity} --tool=ali`;
    case "zai":
      return `zai --identity=${identity} auth login`;
    case "opencode":
      return `opencode --identity=${identity}, then sign in when it asks`;
  }
}

/** Generic credential failure; `code` is a stable reason, the message never carries paths or token values. */
export class GatewayCredentialError extends Error {
  constructor(readonly code: "refresh-failed" | "refresh-lock-timeout" | "token-unchanged" | "no-credential" | "unknown-identity" | "retired" | "login-dead", readonly provider: GatewayProvider, readonly identity: string, cause?: unknown) {
    super(`gateway: ${provider} identity "${identity}" credential unavailable (${code})`, cause === undefined ? undefined : { cause });
    this.name = "GatewayCredentialError";
  }

  /** True when only a person can fix it: the login is gone or revoked. */
  get loggedOut(): boolean {
    return this.code === "login-dead";
  }

  /** Text for the client: plain about a dead login, a bare reason code otherwise. */
  get clientMessage(): string {
    if (this.loggedOut) return `${this.provider} identity "${this.identity}" is logged out (its saved login cannot be refreshed). Log back in with: ${loginCommand(this.provider, this.identity)}`;
    return `upstream credential unavailable (${this.code})`;
  }
}

const TOOL_CONFIGS: Record<GatewayProvider, ToolConfig> = {
  claude: CLAUDE_CONFIG,
  codex: CODEX_CONFIG,
  grok: GROK_CONFIG,
  kimi: KIMI_CONFIG,
  zai: ZAI_CONFIG,
  ali: ALI_CONFIG,
  opencode: OPENCODE_CONFIG,
};

/** Files whose newest mtime decides a reload. */
function watchedFiles(provider: GatewayProvider, dir: string): string[] {
  if (provider === "opencode") {
    const base = join(dir, "data", "opencode");
    return [join(base, "opencode.db"), join(base, "opencode.db-wal"), join(base, "auth.json")];
  }
  return [primaryFile(provider, dir)];
}

const OAUTH_PROVIDERS: ReadonlySet<GatewayProvider> = new Set(["claude", "codex", "grok", "kimi"]);

async function newestMtime(provider: GatewayProvider, id: Identity, registry?: string): Promise<number | undefined> {
  const files = OAUTH_PROVIDERS.has(provider)
    ? await effectiveGrantPaths(provider as RefreshableTool, id, { claudeRegistryPath: registry }).catch(() => watchedFiles(provider, id.configDir))
    : watchedFiles(provider, id.configDir);
  const times = await Promise.all(files.map((f) => stat(f).then((x) => x.mtimeMs, () => undefined)));
  const present = times.filter((t): t is number => t !== undefined);
  return present.length === 0 ? undefined : Math.max(...present);
}

/** The main credential file (paths from credential-paths.ts and the readers below). */
function primaryFile(provider: GatewayProvider, dir: string): string {
  switch (provider) {
    case "claude":
    case "codex":
    case "grok":
      return nativeStorePathFor(provider, dir);
    case "kimi":
      return join(dir, "credentials", "kimi-code.json");
    case "zai":
    case "ali":
      return join(dir, "crush.json");
    case "opencode":
      return join(dir, "data", "opencode", "auth.json");
  }
}

async function readJsonObject(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

async function readCredential(provider: GatewayProvider, id: Identity, registry?: string): Promise<ProviderCredential | undefined> {
  const identity = id.name;
  const dir = id.configDir;
  switch (provider) {
    case "claude":
    case "codex":
    case "grok":
    case "kimi": {
      // The very selection AIS's refresh uses (native vs pi vs pool vs kimi stores), read-only.
      const found = await readEffectiveGrant(provider, id, { claudeRegistryPath: registry });
      if (!found) return undefined;
      const { grant } = found;
      let accountId: string | undefined;
      if (provider === "codex") accountId = jwtAccountId(grant.access_token) ?? codexAccountOf(parseCodexAuth(await readCodexAuthText(dir))).id;
      return {
        identity,
        accessToken: grant.access_token,
        ...(accountId ? { accountId } : {}),
        ...(grant.expires_at !== undefined ? { expiresAtMs: grant.expires_at * 1000 } : {}),
      };
    }
    case "zai": {
      const key = await readZaiApiKey(dir);
      return key ? { identity, accessToken: key } : undefined;
    }
    case "ali": {
      const key = await readAliApiKey(dir);
      return key ? { identity, accessToken: key } : undefined;
    }
    case "opencode": {
      const v2 = (await readOpencodeV2Credentials(dir))?.find((c) => c.provider === "opencode-go")?.entry.key;
      if (nonEmpty(v2)) return { identity, accessToken: v2 };
      const legacy = (await readOpencodeAuth(dir))?.["opencode-go"]?.key;
      return nonEmpty(legacy) ? { identity, accessToken: legacy } : undefined;
    }
  }
}

interface Entry {
  mtimeMs: number;
  cred: ProviderCredential;
}

/**
 * Reads provider credentials from AIS's own identity stores. Cached per
 * (provider, identity) and reloaded when the credential file's mtime changes.
 * Credentials are never serialised, logged or put in error messages.
 */
export class CredentialCache {
  private readonly entries = new Map<string, Entry>();
  private readonly lastRefreshAt = new Map<string, number>();
  private readonly inflight = new Map<string, Promise<ProviderCredential>>();
  private readonly refresh: RefreshFn;

  constructor(private readonly deps: CredentialCacheDeps = {}) {
    this.refresh = deps.refresh ?? refreshIdentityOAuthGrant;
  }

  async get(provider: GatewayProvider, identity: string): Promise<ProviderCredential> {
    // Everything below uses the RESOLVED identity (canonical name), never the raw request string:
    // pool, pi and kimi store lookups go by name, and an alias would miss them.
    const id = await this.resolve(provider, identity);
    const key = `${provider}\u0000${id.name}`;
    const mtimeMs = await newestMtime(provider, id, this.deps.claudeRegistryPath);
    const cached = this.entries.get(key);
    if (cached && mtimeMs !== undefined && cached.mtimeMs === mtimeMs) return cached.cred;
    return this.load(provider, id, mtimeMs);
  }

  /**
   * Called after the upstream answered 401 for `staleToken`. Concurrent callers
   * for one identity share a single refresh. The refresh runs only if the file
   * still holds the stale token (another process may already have rotated it).
   */
  async refreshAfter401(provider: GatewayProvider, identity: string, staleToken: string): Promise<ProviderCredential> {
    if (!adapterFor(provider).refreshable) throw new NotRefreshableError(provider, identity);
    const id = await this.resolve(provider, identity);
    const key = `${provider}\u0000${id.name}`;
    const running = this.inflight.get(key);
    if (running) return running;
    const run = this.doRefresh(provider, id, staleToken).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, run);
    return run;
  }

  private async doRefresh(provider: GatewayProvider, id: Identity, staleToken: string): Promise<ProviderCredential> {
    const identity = id.name;
    const current = await this.reload(provider, id);
    if (current.accessToken !== staleToken) return current;
    const key = `${provider}\u0000${identity}`;
    const now = (this.deps.now ?? Date.now)();
    const last = this.lastRefreshAt.get(key);
    if (last !== undefined && now - last < REFRESH_COOLDOWN_MS) throw new RefreshCooldownError(provider, identity);
    // force skips the expiry window (a 401 is the evidence); expectedAccessToken makes the
    // refresh a compare-and-swap under AIS's locks, so a rotation elsewhere is never repeated.
    let result: Awaited<ReturnType<RefreshFn>>;
    try {
      result = await this.refresh(provider as RefreshableTool, id, { force: true, expectedAccessToken: staleToken });
    } catch (err) {
      // Raw errors can carry lock paths or provider text: keep them as `cause` only.
      // Only a dead-grant OAuth code (invalid_grant, refresh_token_expired/reused/invalidated) in the token endpoint's body proves the login is gone; any other 400/401 is not enough.
      const revoked = err instanceof OAuthRefreshError && err.revoked && err.oauthCode !== undefined && DEAD_REFRESH_CODES.has(err.oauthCode);
      throw new GatewayCredentialError(err instanceof SwapLockError ? "refresh-lock-timeout" : revoked ? "login-dead" : "refresh-failed", provider, identity, err);
    }
    if (result.outcome === "refreshed") this.lastRefreshAt.set(key, now);
    const next = await this.reload(provider, id);
    if (next.accessToken !== staleToken) return next;
    // Detail from the refresher may carry local paths: surface only a reason code.
    // A swap pool's no-grant and any failed refresh are transient here; only a revoked diagnosis or a plain identity with no grant is a dead login.
    const code = result.outcome === "skipped-revoked" || (result.outcome === "no-grant" && !isSwapPool(id) && !result.readError) ? "login-dead" : result.outcome === "failed" || result.outcome === "no-grant" ? "refresh-failed" : "token-unchanged";
    throw new GatewayCredentialError(code, provider, identity);
  }

  private async reload(provider: GatewayProvider, id: Identity): Promise<ProviderCredential> {
    const mtimeMs = await newestMtime(provider, id, this.deps.claudeRegistryPath);
    return this.load(provider, id, mtimeMs);
  }

  private async load(provider: GatewayProvider, id: Identity, mtimeMs: number | undefined): Promise<ProviderCredential> {
    let cred = await readCredential(provider, id, this.deps.claudeRegistryPath);
    // Absent once could be a store mid-rewrite: only a second clean read that is also empty confirms a logged-out identity.
    if (!cred) {
      await new Promise((r) => setTimeout(r, 50));
      cred = await readCredential(provider, id, this.deps.claudeRegistryPath);
    }
    if (!cred) throw new GatewayCredentialError(isSwapPool(id) ? "no-credential" : "login-dead", provider, id.name);
    if (mtimeMs !== undefined) this.entries.set(`${provider}\u0000${id.name}`, { mtimeMs, cred });
    return cred;
  }

  private async resolve(provider: GatewayProvider, identity: string): Promise<Identity> {
    let found: Identity | undefined;
    if (this.deps.resolveIdentity) {
      found = await this.deps.resolveIdentity(provider, identity);
    } else if (this.deps.resolveConfigDir) {
      const configDir = await this.deps.resolveConfigDir(provider, identity);
      if (configDir) found = { name: identity, label: identity, configDir };
    } else {
      const file = await loadIdentitiesFile(TOOL_CONFIGS[provider].identitiesJsonPath);
      found = findIdentityByNameOrAlias(file.identities, identity);
    }
    if (!found) throw new GatewayCredentialError("unknown-identity", provider, identity);
    if (isRetired(found)) throw new GatewayCredentialError("retired", provider, identity);
    return found;
  }
}
