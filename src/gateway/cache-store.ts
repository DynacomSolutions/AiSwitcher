import type { AgentTokenRecord, BrowserBinding, BrowserPairing } from "../browser/types.ts";
import { AppRevokedError, type GatewayStore } from "./store.ts";
import type { GatewayApp, IdentityUsageRow, TokenRecord, UsageRow } from "./types.ts";

/**
 * The proxy's view of the store. Apps and tokens are held in memory so a
 * database outage after warm-up does not stop authentication. Writes go to the
 * store first and then into the cache, so a revoke or rotation made through
 * this instance is seen by the next request. A timer re-reads the store to
 * pick up changes made by other instances; a failed re-read keeps the cache.
 * When the store can notify (PostgreSQL LISTEN), a change made by any instance
 * re-reads that one app at once, so a revoke reaches every replica in moments.
 */
export class CachedGatewayStore implements GatewayStore {
  private apps = new Map<string, GatewayApp>();
  private tokens = new Map<string, TokenRecord[]>();
  private version = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private loaded = false;
  private unlisten: (() => Promise<void>) | undefined;
  private stopped = false;

  constructor(private readonly inner: GatewayStore) {}

  /** Loads every app and its tokens. Throws when the store is unreachable. */
  async warm(): Promise<void> {
    const seen = this.version;
    const apps = await this.inner.listApps();
    const tokens = new Map<string, TokenRecord[]>();
    for (const a of apps) tokens.set(a.name, await this.inner.tokensFor(a.name));
    // A write made while we were reading is newer than this snapshot: keep it.
    if (this.version !== seen && this.loaded) return;
    // A revoked app is final in the cache too: a snapshot that says active (an older read) never undoes it.
    const nextApps = new Map(apps.map((a) => [a.name, a]));
    for (const [name, cached] of this.apps) {
      if (cached.state !== "revoked") continue;
      nextApps.set(name, cached);
      tokens.set(name, this.tokens.get(name) ?? []);
    }
    this.apps = nextApps;
    this.tokens = tokens;
    this.loaded = true;
  }

  startRefresh(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.warm().catch(() => undefined), intervalMs);
    this.timer.unref?.();
  }

  /**
   * Subscribes to app-change notices from the store, if it offers them. Throws when the subscription fails
   * (the caller may log it: the timed refresh still keeps the cache current).
   */
  async startListening(): Promise<void> {
    if (this.unlisten || this.stopped || !this.inner.listenAppChanges) return;
    const unlisten = await this.inner.listenAppChanges((name) => void this.refreshApp(name).catch(() => undefined));
    if (this.stopped) {
      await unlisten().catch(() => undefined);
      return;
    }
    this.unlisten = unlisten;
  }

  /** Re-reads one app and its tokens from the store and replaces the cache entry (drops it when the app is gone). */
  async refreshApp(name: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const seen = this.version;
      const app = await this.inner.getApp(name);
      const tokens = app ? await this.inner.tokensFor(name) : [];
      // A local write made while we were reading may be newer than this read: read again.
      if (this.version !== seen) continue;
      if (this.apps.get(name)?.state === "revoked") {
        // Final: keep the cached revoked entry and its expiries, whatever this read says.
        return;
      }
      if (app) {
        this.apps.set(name, app);
        this.tokens.set(name, tokens);
      } else {
        this.apps.delete(name);
        this.tokens.delete(name);
      }
      // Tell a warm() that is mid-read to drop its older snapshot.
      this.version++;
      return;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const unlisten = this.unlisten;
    this.unlisten = undefined;
    if (unlisten) void unlisten().catch(() => undefined);
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
    if (this.apps.get(app.name)?.state === "revoked") throw new AppRevokedError(app.name);
    try {
      await this.inner.putApp(app);
    } catch (e) {
      // This replica did not know the app was revoked: learn it now.
      if (e instanceof AppRevokedError) await this.refreshApp(app.name).catch(() => undefined);
      throw e;
    }
    this.version++;
    this.apps.set(app.name, { ...app });
    if (!this.tokens.has(app.name)) this.tokens.set(app.name, []);
  }

  async addToken(rec: TokenRecord): Promise<void> {
    if (this.apps.get(rec.app)?.state === "revoked") throw new AppRevokedError(rec.app);
    try {
      await this.inner.addToken(rec);
    } catch (e) {
      if (e instanceof AppRevokedError) await this.refreshApp(rec.app).catch(() => undefined);
      throw e;
    }
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
    // Every token stops now, as in the store.
    const at = new Date().toISOString();
    this.tokens.set(
      name,
      (this.tokens.get(name) ?? []).map((t) => (t.expiresAt === undefined || Date.parse(t.expiresAt) > Date.parse(at) ? { ...t, expiresAt: at } : t)),
    );
  }

  appendUsage(rows: UsageRow[]): Promise<void> {
    return this.inner.appendUsage(rows);
  }

  usageSince(app: string, since: Date): Promise<number> {
    return this.inner.usageSince(app, since);
  }

  usageTotalsSince(since: Date): Promise<Map<string, number>> {
    return this.inner.usageTotalsSince(since);
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
