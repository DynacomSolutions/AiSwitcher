import type { AgentTokenRecord, BrowserBinding, BrowserPairing } from "../browser/types.ts";
import { AppRevokedError, type GatewayStore } from "./store.ts";
import type { GatewayApp, IdentityUsageRow, ModelDailyUsageRow, ModelUsageRow, TokenRecord, UsageHistoryRow, UsageHistoryStored, UsageRow } from "./types.ts";

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
  /** Per-app write counters, so a refresh of one app is not starved by changes to others. */
  private appVersions = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private loaded = false;
  private unlisten: (() => Promise<void>) | undefined;
  private subscribing: Promise<void> | undefined;
  /** Counts subscriptions, so a notice from a dropped one is ignored. */
  private listenGen = 0;
  /** Our own ping went out and has not come back yet. */
  private pingPending = false;
  private probing = false;
  private noticeWarned = false;
  private stopped = false;
  private readonly replicaId = crypto.randomUUID();

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
    this.timer = setInterval(() => {
      void this.warm().catch(() => undefined);
      void this.checkListener().catch(() => undefined);
    }, intervalMs);
    this.timer.unref?.();
  }

  /** True while the change-notice subscription is up (a store without notices is never listening). */
  get listening(): boolean {
    return this.unlisten !== undefined && !this.stopped;
  }

  private bump(name: string): void {
    this.version++;
    this.appVersions.set(name, (this.appVersions.get(name) ?? 0) + 1);
  }

  private appVersion(name: string): number {
    return this.appVersions.get(name) ?? 0;
  }

  /**
   * Subscribes to app-change notices from the store, if it offers them. Throws when the subscription fails
   * (the timed refresh still keeps the cache current, and every tick tries again).
   */
  async startListening(): Promise<void> {
    if (this.unlisten || this.stopped || !this.inner.listenAppChanges) return;
    if (this.subscribing) return this.subscribing;
    const listen = this.inner.listenAppChanges.bind(this.inner);
    this.subscribing = (async () => {
      const gen = ++this.listenGen;
      const unlisten = await listen((payload) => this.onNotice(gen, payload));
      if (this.stopped) {
        await unlisten().catch(() => undefined);
        return;
      }
      this.unlisten = unlisten;
      this.pingPending = false;
    })().finally(() => {
      this.subscribing = undefined;
    });
    return this.subscribing;
  }

  private onNotice(gen: number, payload: string): void {
    if (gen !== this.listenGen) return;
    // Payloads starting with "!" are control notices (no app name can start with one).
    if (payload.startsWith("!")) {
      if (payload === `!ping:${this.replicaId}`) {
        // Our own ping came back: the subscription works, so the next failure streak warns again.
        this.pingPending = false;
        this.noticeWarned = false;
      }
      return;
    }
    void this.refreshApp(payload).catch(() => undefined);
  }

  /**
   * Runs on every refresh tick. Subscribes again when the subscription is missing, and probes a live one with a ping
   * notice: if our last ping has not come back by this tick, the subscription is dead and is replaced.
   */
  private async checkListener(): Promise<void> {
    if (this.stopped || !this.inner.listenAppChanges || this.probing) return;
    this.probing = true;
    try {
      if (this.unlisten && this.pingPending) {
        const dead = this.unlisten;
        this.unlisten = undefined;
        this.listenGen++;
        await dead().catch(() => undefined);
        this.warnOnce("the change-notice subscription stopped answering");
      }
      if (!this.unlisten) {
        try {
          await this.startListening();
        } catch (err) {
          this.warnOnce(err instanceof Error ? err.message : String(err));
          return;
        }
      }
      if (this.inner.pingAppChanges) {
        this.pingPending = true;
        // A failed ping stays pending, so the next tick replaces the subscription.
        await this.inner.pingAppChanges(`!ping:${this.replicaId}`).catch(() => undefined);
      }
    } finally {
      this.probing = false;
    }
  }

  /** One warning per failure streak, not one per tick. */
  private warnOnce(reason: string): void {
    if (this.noticeWarned) return;
    this.noticeWarned = true;
    console.warn(`gateway: app change notices unavailable (${reason}); resubscribing on each refresh tick`);
  }

  /** Re-reads one app and its tokens from the store and replaces the cache entry (drops it when the app is gone). */
  async refreshApp(name: string): Promise<void> {
    let last: { app: GatewayApp | undefined; tokens: TokenRecord[] } | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      const seen = this.appVersion(name);
      const app = await this.inner.getApp(name);
      const tokens = app ? await this.inner.tokensFor(name) : [];
      last = { app, tokens };
      // A local write to this app made while we were reading may be newer than this read: read again.
      if (this.appVersion(name) !== seen) continue;
      this.applyRead(name, app, tokens);
      return;
    }
    // Still racing local writes: a revoked read is always safe to apply.
    if (last?.app?.state === "revoked") this.applyRead(name, last.app, last.tokens);
  }

  private applyRead(name: string, app: GatewayApp | undefined, tokens: TokenRecord[]): void {
    // Final: a cached revoked entry and its expiries stay, whatever this read says.
    if (this.apps.get(name)?.state === "revoked") return;
    if (app) {
      this.apps.set(name, app);
      this.tokens.set(name, tokens);
    } else {
      this.apps.delete(name);
      this.tokens.delete(name);
    }
    // Tell a warm() that is mid-read to drop its older snapshot.
    this.version++;
  }

  stop(): void {
    this.stopped = true;
    this.listenGen++;
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
    // A revoke notice that arrived during the write wins: never put "active" over it.
    if (this.apps.get(app.name)?.state === "revoked") throw new AppRevokedError(app.name);
    this.bump(app.name);
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
    if (this.apps.get(rec.app)?.state === "revoked") throw new AppRevokedError(rec.app);
    this.bump(rec.app);
    this.tokens.set(rec.app, [...(this.tokens.get(rec.app) ?? []), { ...rec }]);
  }

  async expireTokens(app: string, at: string): Promise<void> {
    await this.inner.expireTokens(app, at);
    this.bump(app);
    this.tokens.set(
      app,
      (this.tokens.get(app) ?? []).map((t) => (t.expiresAt === undefined ? { ...t, expiresAt: at } : t)),
    );
  }

  async revokeApp(name: string): Promise<void> {
    await this.inner.revokeApp(name);
    this.bump(name);
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

  usageByModel(since: Date, until?: Date): Promise<ModelUsageRow[]> {
    return this.inner.usageByModel(since, until);
  }

  usageByModelDaily(since: Date, until: Date | undefined, tz: string): Promise<ModelDailyUsageRow[]> {
    return this.inner.usageByModelDaily(since, until, tz);
  }

  upsertUsageHistory(rows: UsageHistoryRow[]): Promise<void> {
    return this.inner.upsertUsageHistory(rows);
  }

  usageHistory(filter?: { source?: string; provider?: string; identity?: string }): Promise<UsageHistoryStored[]> {
    return this.inner.usageHistory(filter);
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
