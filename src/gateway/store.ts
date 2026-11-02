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
}

export class MemoryGatewayStore implements GatewayStore {
  private apps = new Map<string, GatewayApp>();
  private tokens: TokenRecord[] = [];
  private usage: UsageRow[] = [];

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

  /** Sum of input and output tokens for the app at or after `since`. */
  async usageSince(app: string, since: Date): Promise<number> {
    const cutoff = since.getTime();
    let total = 0;
    for (const r of this.usage) {
      if (r.app === app && Date.parse(r.ts) >= cutoff) total += r.inputTokens + r.outputTokens;
    }
    return total;
  }
}
