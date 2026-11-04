import type { AgentTokenRecord, BrowserBinding, BrowserPairing } from "../browser/types.ts";
import type { GatewayApp, TokenRecord, UsageRow } from "./types.ts";

export interface GatewayStore {
  getApp(name: string): Promise<GatewayApp | undefined>;
  listApps(): Promise<GatewayApp[]>;
  putApp(app: GatewayApp): Promise<void>;
  addToken(rec: TokenRecord): Promise<void>;
  tokensFor(app: string): Promise<TokenRecord[]>;
  expireTokens(app: string, at: string): Promise<void>;
  revokeApp(name: string): Promise<void>;
  appendUsage(rows: UsageRow[]): Promise<void>;
  usageSince(app: string, since: Date): Promise<number>;
  putBrowserBinding(b: BrowserBinding): Promise<void>;
  getBrowserBinding(name: string): Promise<BrowserBinding | undefined>;
  listBrowserBindings(): Promise<BrowserBinding[]>;
  revokeBrowserBinding(name: string): Promise<void>;
  /** Stores only the hash; the binding name goes in the `app` field of the returned records. */
  addBrowserToken(binding: string, prefix: string, hash: string): Promise<void>;
  browserTokensFor(binding: string): Promise<TokenRecord[]>;
  /** The browser token with this prefix (binding name in `app`), or undefined. */
  browserTokenByPrefix(prefix: string): Promise<TokenRecord | undefined>;
  putPairing(p: BrowserPairing): Promise<void>;
  /** Returns expired pairings too; the caller enforces expiry. */
  getPairing(code: string): Promise<BrowserPairing | undefined>;
  deletePairing(code: string): Promise<void>;
  /** Atomically deletes the pairing and returns it; undefined if it was already gone (so only one caller wins). */
  claimPairing(code: string): Promise<BrowserPairing | undefined>;
  addAgentToken(r: AgentTokenRecord): Promise<void>;
  /** Returns undefined once the identity's agent tokens are revoked. */
  agentTokenByPrefix(prefix: string): Promise<AgentTokenRecord | undefined>;
  revokeAgentTokens(identity: string): Promise<void>;
}

export class MemoryGatewayStore implements GatewayStore {
  private apps = new Map<string, GatewayApp>();
  private tokens: TokenRecord[] = [];
  private usage: UsageRow[] = [];
  private bindings = new Map<string, BrowserBinding>();
  private browserTokens: TokenRecord[] = [];
  private pairings = new Map<string, BrowserPairing>();
  private agentTokens: AgentTokenRecord[] = [];

  async getApp(name: string): Promise<GatewayApp | undefined> {
    const app = this.apps.get(name);
    return app ? { ...app } : undefined;
  }

  async listApps(): Promise<GatewayApp[]> {
    return [...this.apps.values()].map((a) => ({ ...a }));
  }

  async putApp(app: GatewayApp): Promise<void> {
    this.apps.set(app.name, { ...app });
  }

  async addToken(rec: TokenRecord): Promise<void> {
    this.tokens.push({ ...rec });
  }

  async tokensFor(app: string): Promise<TokenRecord[]> {
    return this.tokens.filter((t) => t.app === app).map((t) => ({ ...t }));
  }

  /** Sets expiresAt on every token of the app that has no expiry yet. */
  async expireTokens(app: string, at: string): Promise<void> {
    for (const t of this.tokens) {
      if (t.app === app && t.expiresAt === undefined) t.expiresAt = at;
    }
  }

  async revokeApp(name: string): Promise<void> {
    const app = this.apps.get(name);
    if (app) app.state = "revoked";
  }

  async appendUsage(rows: UsageRow[]): Promise<void> {
    for (const r of rows) this.usage.push({ ...r });
  }

  /** Sum of input, output and cache-write tokens for the app at or after `since` (the daily-cap rule). */
  async usageSince(app: string, since: Date): Promise<number> {
    const cutoff = since.getTime();
    let total = 0;
    for (const r of this.usage) {
      if (r.app === app && Date.parse(r.ts) >= cutoff) total += r.inputTokens + r.outputTokens + r.cacheWriteTokens;
    }
    return total;
  }

  async putBrowserBinding(b: BrowserBinding): Promise<void> {
    this.bindings.set(b.name, { ...b, target: { ...b.target } });
  }

  async getBrowserBinding(name: string): Promise<BrowserBinding | undefined> {
    const b = this.bindings.get(name);
    return b ? { ...b, target: { ...b.target } } : undefined;
  }

  async listBrowserBindings(): Promise<BrowserBinding[]> {
    return [...this.bindings.values()].map((b) => ({ ...b, target: { ...b.target } }));
  }

  async revokeBrowserBinding(name: string): Promise<void> {
    const b = this.bindings.get(name);
    if (b) b.state = "revoked";
  }

  async addBrowserToken(binding: string, prefix: string, hash: string): Promise<void> {
    this.browserTokens.push({ app: binding, prefix, hash, createdAt: new Date().toISOString() });
  }

  async browserTokensFor(binding: string): Promise<TokenRecord[]> {
    return this.browserTokens.filter((t) => t.app === binding).map((t) => ({ ...t }));
  }

  async browserTokenByPrefix(prefix: string): Promise<TokenRecord | undefined> {
    const t = this.browserTokens.find((x) => x.prefix === prefix);
    return t ? { ...t } : undefined;
  }

  async putPairing(p: BrowserPairing): Promise<void> {
    this.pairings.set(p.code, { ...p });
  }

  async getPairing(code: string): Promise<BrowserPairing | undefined> {
    const p = this.pairings.get(code);
    return p ? { ...p } : undefined;
  }

  async claimPairing(code: string): Promise<BrowserPairing | undefined> {
    const p = this.pairings.get(code);
    this.pairings.delete(code);
    return p ? { ...p } : undefined;
  }

  async deletePairing(code: string): Promise<void> {
    this.pairings.delete(code);
  }

  async addAgentToken(r: AgentTokenRecord): Promise<void> {
    this.agentTokens.push({ ...r });
  }

  async agentTokenByPrefix(prefix: string): Promise<AgentTokenRecord | undefined> {
    const r = this.agentTokens.find((t) => t.prefix === prefix && t.revokedAt === undefined);
    return r ? { ...r } : undefined;
  }

  async revokeAgentTokens(identity: string): Promise<void> {
    const at = new Date().toISOString();
    for (const t of this.agentTokens) {
      if (t.identity === identity && t.revokedAt === undefined) t.revokedAt = at;
    }
  }
}
