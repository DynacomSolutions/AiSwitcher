import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { codexAccountOf, jwtAccountId, parseCodexAuth, readCodexAuthText } from "../identities/codex-auth.ts";
import { readAliApiKey } from "../identities/ali-auth.ts";
import { nativeStorePathFor } from "../identities/oauth-reconcile.ts";
import { effectiveGrantPaths, readEffectiveGrant, refreshIdentityOAuthGrant, type RefreshableTool } from "../identities/oauth-refresh.ts";
import { SwapLockError } from "../identities/claude-swap-lock.ts";
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

/** Generic credential failure; `code` is a stable reason, the message never carries paths or token values. */
export class GatewayCredentialError extends Error {
  constructor(readonly code: "refresh-failed" | "refresh-lock-timeout" | "token-unchanged" | "no-credential" | "unknown-identity" | "retired", provider: GatewayProvider, identity: string, cause?: unknown) {
    super(`gateway: ${provider} identity "${identity}" credential unavailable (${code})`, cause === undefined ? undefined : { cause });
    this.name = "GatewayCredentialError";
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

async function newestMtime(provider: GatewayProvider, dir: string, name: string, registry?: string): Promise<number | undefined> {
  const files = OAUTH_PROVIDERS.has(provider)
    ? await effectiveGrantPaths(provider as RefreshableTool, { name, label: name, configDir: dir }, { claudeRegistryPath: registry }).catch(() => watchedFiles(provider, dir))
    : watchedFiles(provider, dir);
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

async function readCredential(provider: GatewayProvider, identity: string, dir: string, registry?: string): Promise<ProviderCredential | undefined> {
  switch (provider) {
    case "claude":
    case "codex":
    case "grok":
    case "kimi": {
      // The very selection AIS's refresh uses (native vs pi vs pool vs kimi stores), read-only.
      const found = await readEffectiveGrant(provider, { name: identity, label: identity, configDir: dir }, { claudeRegistryPath: registry });
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
    const id = await this.resolve(provider, identity);
    const key = `${provider}\u0000${identity}`;
    const mtimeMs = await newestMtime(provider, id.configDir, identity, this.deps.claudeRegistryPath);
    const cached = this.entries.get(key);
    if (cached && mtimeMs !== undefined && cached.mtimeMs === mtimeMs) return cached.cred;
    return this.load(provider, identity, id.configDir, mtimeMs);
  }

  /**
   * Called after the upstream answered 401 for `staleToken`. Concurrent callers
   * for one identity share a single refresh. The refresh runs only if the file
   * still holds the stale token (another process may already have rotated it).
   */
  refreshAfter401(provider: GatewayProvider, identity: string, staleToken: string): Promise<ProviderCredential> {
    if (!adapterFor(provider).refreshable) return Promise.reject(new NotRefreshableError(provider, identity));
    const key = `${provider}\u0000${identity}`;
    const running = this.inflight.get(key);
    if (running) return running;
    const run = this.doRefresh(provider, identity, staleToken).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, run);
    return run;
  }

  private async doRefresh(provider: GatewayProvider, identity: string, staleToken: string): Promise<ProviderCredential> {
    const id = await this.resolve(provider, identity);
    const current = await this.reload(provider, identity, id.configDir);
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
      throw new GatewayCredentialError(err instanceof SwapLockError ? "refresh-lock-timeout" : "refresh-failed", provider, identity, err);
    }
    if (result.outcome === "refreshed") this.lastRefreshAt.set(key, now);
    const next = await this.reload(provider, identity, id.configDir);
    if (next.accessToken !== staleToken) return next;
    // Detail from the refresher may carry local paths: surface only a reason code.
    throw new GatewayCredentialError(result.outcome === "failed" || result.outcome === "no-grant" || result.outcome === "skipped-revoked" ? "refresh-failed" : "token-unchanged", provider, identity);
  }

  private async reload(provider: GatewayProvider, identity: string, dir: string): Promise<ProviderCredential> {
    const mtimeMs = await newestMtime(provider, dir, identity, this.deps.claudeRegistryPath);
    return this.load(provider, identity, dir, mtimeMs);
  }

  private async load(provider: GatewayProvider, identity: string, dir: string, mtimeMs: number | undefined): Promise<ProviderCredential> {
    const cred = await readCredential(provider, identity, dir, this.deps.claudeRegistryPath);
    if (!cred) throw new GatewayCredentialError("no-credential", provider, identity);
    if (mtimeMs !== undefined) this.entries.set(`${provider}\u0000${identity}`, { mtimeMs, cred });
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
