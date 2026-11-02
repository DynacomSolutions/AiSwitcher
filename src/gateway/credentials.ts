import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { codexAccountOf, parseCodexAuth, readCodexAuthText } from "../identities/codex-auth.ts";
import { readAliApiKey } from "../identities/ali-auth.ts";
import { readProviderGrantCopy, nativeStorePathFor } from "../identities/oauth-reconcile.ts";
import { refreshIdentityOAuthGrant, type RefreshableTool } from "../identities/oauth-refresh.ts";
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

const TOOL_CONFIGS: Record<GatewayProvider, ToolConfig> = {
  claude: CLAUDE_CONFIG,
  codex: CODEX_CONFIG,
  grok: GROK_CONFIG,
  kimi: KIMI_CONFIG,
  zai: ZAI_CONFIG,
  ali: ALI_CONFIG,
  opencode: OPENCODE_CONFIG,
};

/** The file whose mtime decides a reload (paths from credential-paths.ts and the readers below). */
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

async function readCredential(provider: GatewayProvider, identity: string, dir: string): Promise<ProviderCredential | undefined> {
  switch (provider) {
    case "claude":
    case "grok": {
      const copy = await readProviderGrantCopy(provider, dir);
      if (!copy) return undefined;
      return { identity, accessToken: copy.grant.access_token, ...(copy.grant.expires_at !== undefined ? { expiresAtMs: copy.grant.expires_at * 1000 } : {}) };
    }
    case "codex": {
      const copy = await readProviderGrantCopy("codex", dir);
      if (!copy) return undefined;
      const accountId = codexAccountOf(parseCodexAuth(await readCodexAuthText(dir))).id;
      return {
        identity,
        accessToken: copy.grant.access_token,
        ...(accountId ? { accountId } : {}),
        ...(copy.grant.expires_at !== undefined ? { expiresAtMs: copy.grant.expires_at * 1000 } : {}),
      };
    }
    case "kimi": {
      const raw = await readJsonObject(primaryFile("kimi", dir));
      if (!raw || !nonEmpty(raw.access_token)) return undefined;
      return { identity, accessToken: raw.access_token, ...(typeof raw.expires_at === "number" ? { expiresAtMs: raw.expires_at * 1000 } : {}) };
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
      const raw = await readJsonObject(primaryFile("opencode", dir));
      const entry = raw?.["opencode-go"];
      const key = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>).key : undefined;
      return nonEmpty(key) ? { identity, accessToken: key } : undefined;
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
  private readonly inflight = new Map<string, Promise<ProviderCredential>>();
  private readonly refresh: RefreshFn;

  constructor(private readonly deps: CredentialCacheDeps = {}) {
    this.refresh = deps.refresh ?? refreshIdentityOAuthGrant;
  }

  async get(provider: GatewayProvider, identity: string): Promise<ProviderCredential> {
    const id = await this.resolve(provider, identity);
    const key = `${provider}\u0000${identity}`;
    const mtimeMs = await stat(primaryFile(provider, id.configDir)).then((s) => s.mtimeMs, () => undefined);
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
    const result = await this.refresh(provider as RefreshableTool, id, { force: true });
    if (result.outcome === "failed" || result.outcome === "no-grant" || result.outcome === "skipped-revoked") {
      throw new Error(`gateway: ${provider} identity "${identity}" refresh ${result.outcome}: ${result.detail}`);
    }
    const next = await this.reload(provider, identity, id.configDir);
    if (next.accessToken === staleToken) {
      throw new Error(`gateway: ${provider} identity "${identity}" credential file still holds the rejected token after refresh (${result.outcome})`);
    }
    return next;
  }

  private async reload(provider: GatewayProvider, identity: string, dir: string): Promise<ProviderCredential> {
    const mtimeMs = await stat(primaryFile(provider, dir)).then((s) => s.mtimeMs, () => undefined);
    return this.load(provider, identity, dir, mtimeMs);
  }

  private async load(provider: GatewayProvider, identity: string, dir: string, mtimeMs: number | undefined): Promise<ProviderCredential> {
    const cred = await readCredential(provider, identity, dir);
    if (!cred) throw new Error(`gateway: no usable ${provider} credential for identity "${identity}"`);
    if (mtimeMs !== undefined) this.entries.set(`${provider}\u0000${identity}`, { mtimeMs, cred });
    return cred;
  }

  private async resolve(provider: GatewayProvider, identity: string): Promise<Identity> {
    if (this.deps.resolveConfigDir) {
      const configDir = await this.deps.resolveConfigDir(provider, identity);
      if (!configDir) throw new Error(`gateway: unknown ${provider} identity "${identity}"`);
      return { name: identity, label: identity, configDir };
    }
    const file = await loadIdentitiesFile(TOOL_CONFIGS[provider].identitiesJsonPath);
    const found = findIdentityByNameOrAlias(file.identities, identity);
    if (!found) throw new Error(`gateway: unknown ${provider} identity "${identity}"`);
    return found;
  }
}
