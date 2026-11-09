import type { AgentTokenRecord, BrowserBinding, BrowserPairing } from "../browser/types.ts";
import type { GatewayStore } from "./store.ts";
import type { GatewayApp, IdentityUsageRow, TokenRecord, UsageRow } from "./types.ts";

/**
 * The proxy's view of the store. Apps and tokens are held in memory so a
 * database outage after warm-up does not stop authentication. Writes go to the
 * store first and then into the cache, so a revoke or rotation made through
 * this instance is seen by the next request. A timer re-reads the store to
 * pick up changes made by other instances; a failed re-read keeps the cache.
 */
export class CachedGatewayStore implements GatewayStore {
  private apps = new Map<string, GatewayApp>();
  private tokens = new Map<string, TokenRecord[]>();
  private version = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private loaded = false;

  constructor(private readonly inner: GatewayStore) {}

  /** Loads every app and its tokens. Throws when the store is unreachable. */
  async warm(): Promise<void> {
    const seen = this.version;
    const apps = await this.inner.listApps();
    const tokens = new Map<string, TokenRecord[]>();
    for (const a of apps) tokens.set(a.name, await this.inner.tokensFor(a.name));
    // A write made while we were reading is newer than this snapshot: keep it.
    if (this.version !== seen && this.loaded) return;
    this.apps = new Map(apps.map((a) => [a.name, a]));
    this.tokens = tokens;
    this.loaded = true;
  }

  startRefresh(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.warm().catch(() => undefined), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async getApp(name: string): Promise<GatewayApp | undefined> {
    const a = this.apps.get(name);
    return a ? { ...a } : undefined;
  }

  async listApps(): Promise<GatewayApp[]> {
    return [...this.apps.values()].map((a) => ({ ...a }));
  }

  async tokensFor(app: string): Promise<TokenRecord[]> {
    return (this.tokens.get(app) ?? []).map((t) => ({ ...t }));
  }

  async putApp(app: GatewayApp): Promise<void> {
    await this.inner.putApp(app);
    this.version++;
    this.apps.set(app.name, { ...app });
    if (!this.tokens.has(app.name)) this.tokens.set(app.name, []);
  }

  async addToken(rec: TokenRecord): Promise<void> {
    await this.inner.addToken(rec);
    this.version++;
    this.tokens.set(rec.app, [...(this.tokens.get(rec.app) ?? []), { ...rec }]);
  }

  async expireTokens(app: string, at: string): Promise<void> {
    await this.inner.expireTokens(app, at);
    this.version++;
    this.tokens.set(
      app,
      (this.tokens.get(app) ?? []).map((t) => (t.expiresAt === undefined ? { ...t, expiresAt: at } : t)),
    );
  }

  async revokeApp(name: string): Promise<void> {
    await this.inner.revokeApp(name);
    this.version++;
    const a = this.apps.get(name);
    if (a) this.apps.set(name, { ...a, state: "revoked" });
  }

  appendUsage(rows: UsageRow[]): Promise<void> {
    return this.inner.appendUsage(rows);
  }

  usageSince(app: string, since: Date): Promise<number> {
    return this.inner.usageSince(app, since);
  }

  bumpSideCount(app: string, day: string, signal?: AbortSignal): Promise<number> {
    return this.inner.bumpSideCount(app, day, signal);
  }

  usageByIdentity(since: Date, until?: Date): Promise<IdentityUsageRow[]> {
    return this.inner.usageByIdentity(since, until);
  }

  // Browser records are not on the proxy's hot path: pass straight through to the store.
  putBrowserBinding(b: BrowserBinding): Promise<void> {
    return this.inner.putBrowserBinding(b);
  }

  getBrowserBinding(name: string): Promise<BrowserBinding | undefined> {
    return this.inner.getBrowserBinding(name);
  }

  listBrowserBindings(): Promise<BrowserBinding[]> {
    return this.inner.listBrowserBindings();
  }

  revokeBrowserBinding(name: string): Promise<void> {
    return this.inner.revokeBrowserBinding(name);
  }

  touchBrowserBinding(name: string, at: string): Promise<void> {
    return this.inner.touchBrowserBinding(name, at);
  }

  addBrowserToken(binding: string, prefix: string, hash: string): Promise<void> {
    return this.inner.addBrowserToken(binding, prefix, hash);
  }

  deleteBrowserTokens(binding: string): Promise<void> {
    return this.inner.deleteBrowserTokens(binding);
  }

  browserTokenByPrefix(prefix: string): Promise<TokenRecord | undefined> {
    return this.inner.browserTokenByPrefix(prefix);
  }

  putPairing(p: BrowserPairing): Promise<void> {
    return this.inner.putPairing(p);
  }

  getPairing(code: string): Promise<BrowserPairing | undefined> {
    return this.inner.getPairing(code);
  }

  claimPairing(code: string): Promise<BrowserPairing | undefined> {
    return this.inner.claimPairing(code);
  }

  deletePairing(code: string): Promise<void> {
    return this.inner.deletePairing(code);
  }

  deleteExpiredPairings(now: Date): Promise<void> {
    return this.inner.deleteExpiredPairings(now);
  }

  addAgentToken(r: AgentTokenRecord): Promise<void> {
    return this.inner.addAgentToken(r);
  }

  agentTokenByPrefix(prefix: string): Promise<AgentTokenRecord | undefined> {
    return this.inner.agentTokenByPrefix(prefix);
  }

  revokeAgentTokens(identity: string): Promise<void> {
    return this.inner.revokeAgentTokens(identity);
  }
}
