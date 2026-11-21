import type { AgentTokenRecord, BrowserBinding, BrowserPairing } from "../browser/types.ts";
import type { GatewayApp, IdentityUsageRow, ModelDailyUsageRow, ModelUsageRow, SessionIdentityUsageRow, TokenRecord, UsageHistoryFilter, UsageHistoryRow, UsageHistoryStored, UsageRow } from "./types.ts";
import { priceNullCostGroup } from "./usage.ts";

/** The message for any attempt to reuse or extend a revoked app. */
export function revokedMessage(name: string): string {
  return `app "${name}" is revoked; a revoked app stays revoked and its tokens never work again. Register a new name.`;
}

/** Thrown by a store when a write would revive or extend a revoked (or missing) app. A revoked app is final. */
export class AppRevokedError extends Error {
  constructor(readonly app: string) {
    super(revokedMessage(app));
    this.name = "AppRevokedError";
  }
}

/** Narrows a session read. `sessionKeys` limits it to those sessions (an empty list means all). */
export interface SessionUsageFilter {
  provider?: string;
  app?: string;
  sessionKeys?: string[];
}

export interface GatewayStore {
  getApp(name: string): Promise<GatewayApp | undefined>;
  listApps(): Promise<GatewayApp[]>;
  /** Creates or updates an app. Throws AppRevokedError when the stored app is revoked (a revoked app is never changed). */
  putApp(app: GatewayApp): Promise<void>;
  /** Adds a token only to an existing active app; throws AppRevokedError otherwise. */
  addToken(rec: TokenRecord): Promise<void>;
  tokensFor(app: string): Promise<TokenRecord[]>;
  expireTokens(app: string, at: string): Promise<void>;
  /** Marks the app revoked and stops every token of it now (expiresAt set to the revoke time). */
  revokeApp(name: string): Promise<void>;
  /** Calls `onApp` with the app name whenever any replica changes an app or its tokens. Returns an unlisten function. Optional: a store without it relies on the periodic refresh. */
  listenAppChanges?(onApp: (name: string) => void): Promise<() => Promise<void>>;
  /** Sends a control notice on the app-change channel (payload starts with "!", so no app name can equal it). A cache uses it to check that its subscription is alive. */
  pingAppChanges?(payload: string): Promise<void>;
  appendUsage(rows: UsageRow[]): Promise<void>;
  /**
   * Served requests (status ok) that carry a session key, per session key, provider, app and account, for rows at or after
   * `since` (before `until` when given). A session that changed account has one row per account.
   */
  usageBySession(since: Date, until?: Date, filter?: SessionUsageFilter): Promise<SessionIdentityUsageRow[]>;
  usageSince(app: string, since: Date): Promise<number>;
  /** usageSince for every app at once (one ledger scan), keyed by app; apps with no rows are absent. */
  usageTotalsSince(since: Date): Promise<Map<string, number>>;
  /** Counts one side or served request for the app on `day` (YYYY-MM-DD, Bangkok day) and returns the day's count so far. Shared by every replica. */
  bumpSideCount(app: string, day: string, signal?: AbortSignal): Promise<number>;
  /** Ledger totals per provider and identity for rows at or after `since` (before `until` when given). */
  usageByIdentity(since: Date, until?: Date): Promise<IdentityUsageRow[]>;
  /** Ledger totals per provider, identity, app and model for rows at or after `since` (before `until` when given). */
  usageByModel(since: Date, until?: Date): Promise<ModelUsageRow[]>;
  /** Ledger totals per day (bucketed in the IANA zone `tz`), provider, identity and model; apps are summed. Same window as usageByModel. */
  usageByModelDaily(since: Date, until: Date | undefined, tz: string): Promise<ModelDailyUsageRow[]>;
  /**
   * Imports history rows. A row with the same key (source, generation, provider, identity, day, model) is replaced
   * exactly, so importing one generation again is idempotent. A new generation adds rows. Nothing is ever deleted.
   */
  upsertUsageHistory(rows: UsageHistoryRow[]): Promise<void>;
  /** History rows, by default the latest generation of each source, optionally for one source, provider, identity or generation, sorted by provider, identity, day, model. */
  usageHistory(filter?: UsageHistoryFilter): Promise<UsageHistoryStored[]>;
  putBrowserBinding(b: BrowserBinding): Promise<void>;
  getBrowserBinding(name: string): Promise<BrowserBinding | undefined>;
  listBrowserBindings(): Promise<BrowserBinding[]>;
  revokeBrowserBinding(name: string): Promise<void>;
  /** Records the last time a browser authenticated; changes nothing else (so it cannot undo a revoke). */
  touchBrowserBinding(name: string, at: string): Promise<void>;
  /** Stores only the hash; the binding name goes in the `app` field of the returned records. */
  addBrowserToken(binding: string, prefix: string, hash: string): Promise<void>;
  /** Drops every browser token issued for a binding (used when a revoked name is reused). */
  deleteBrowserTokens(binding: string): Promise<void>;
  /** The browser token with this prefix (binding name in `app`), or undefined. */
  browserTokenByPrefix(prefix: string): Promise<TokenRecord | undefined>;
  putPairing(p: BrowserPairing): Promise<void>;
  /** Returns expired pairings too; the caller enforces expiry. */
  getPairing(code: string): Promise<BrowserPairing | undefined>;
  deletePairing(code: string): Promise<void>;
  /** Removes every pairing whose expiry is at or before `now`. */
  deleteExpiredPairings(now: Date): Promise<void>;
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

  private appListeners = new Set<(name: string) => void>();

  private changed(name: string): void {
    for (const l of [...this.appListeners]) {
      try {
        l(name);
      } catch {
        // a failing listener must not fail the write
      }
    }
  }

  async listenAppChanges(onApp: (name: string) => void): Promise<() => Promise<void>> {
    this.appListeners.add(onApp);
    return async () => {
      this.appListeners.delete(onApp);
    };
  }

  async pingAppChanges(payload: string): Promise<void> {
    this.changed(payload);
  }

  /** Drops every listener without telling it, as a lost database connection would (for tests). */
  dropListeners(): void {
    this.appListeners.clear();
  }

  async putApp(app: GatewayApp): Promise<void> {
    if (this.apps.get(app.name)?.state === "revoked") throw new AppRevokedError(app.name);
    this.apps.set(app.name, { ...app });
    this.changed(app.name);
  }

  async addToken(rec: TokenRecord): Promise<void> {
    if (this.apps.get(rec.app)?.state !== "active") throw new AppRevokedError(rec.app);
    this.tokens.push({ ...rec });
    this.changed(rec.app);
  }

  async tokensFor(app: string): Promise<TokenRecord[]> {
    return this.tokens.filter((t) => t.app === app).map((t) => ({ ...t }));
  }

  /** Sets expiresAt on every token of the app that has no expiry yet. */
  async expireTokens(app: string, at: string): Promise<void> {
    for (const t of this.tokens) {
      if (t.app === app && t.expiresAt === undefined) t.expiresAt = at;
    }
    this.changed(app);
  }

  async revokeApp(name: string): Promise<void> {
    const app = this.apps.get(name);
    if (!app) return;
    app.state = "revoked";
    const at = new Date().toISOString();
    for (const t of this.tokens) {
      if (t.app === name && (t.expiresAt === undefined || Date.parse(t.expiresAt) > Date.parse(at))) t.expiresAt = at;
    }
    this.changed(name);
  }

  async appendUsage(rows: UsageRow[]): Promise<void> {
    for (const r of rows) this.usage.push({ ...r });
  }

  private sideCounts = new Map<string, number>();

  async bumpSideCount(app: string, day: string, _signal?: AbortSignal): Promise<number> {
    const key = `${app}\u0000${day}`;
    const n = (this.sideCounts.get(key) ?? 0) + 1;
    this.sideCounts.set(key, n);
    return n;
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

  async usageTotalsSince(since: Date): Promise<Map<string, number>> {
    const cutoff = since.getTime();
    const out = new Map<string, number>();
    for (const r of this.usage) {
      if (Date.parse(r.ts) >= cutoff) out.set(r.app, (out.get(r.app) ?? 0) + r.inputTokens + r.outputTokens + r.cacheWriteTokens);
    }
    return out;
  }

  async usageBySession(since: Date, until?: Date, filter: SessionUsageFilter = {}): Promise<SessionIdentityUsageRow[]> {
    const from = since.getTime();
    const to = until?.getTime() ?? Infinity;
    const keys = filter.sessionKeys && filter.sessionKeys.length > 0 ? new Set(filter.sessionKeys) : undefined;
    const by = new Map<string, SessionIdentityUsageRow>();
    for (const r of this.usage) {
      const t = Date.parse(r.ts);
      if (t < from || t >= to || !r.sessionKey || r.status !== "ok" || r.identity === "-") continue;
      if ((filter.provider && r.provider !== filter.provider) || (filter.app && r.app !== filter.app) || (keys && !keys.has(r.sessionKey))) continue;
      const key = `${r.sessionKey}\u0000${r.provider}\u0000${r.app}\u0000${r.identity}`;
      let a = by.get(key);
      if (!a) {
        a = { sessionKey: r.sessionKey, provider: r.provider, app: r.app, client: r.client ?? null, identity: r.identity, turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, firstTs: r.ts, lastTs: r.ts };
        by.set(key, a);
      }
      a.turns += 1;
      a.inputTokens += r.inputTokens;
      a.outputTokens += r.outputTokens;
      a.cacheReadTokens += r.cacheReadTokens;
      a.cacheWriteTokens += r.cacheWriteTokens;
      if (!a.client && r.client) a.client = r.client;
      if (t < Date.parse(a.firstTs)) a.firstTs = r.ts;
      if (t > Date.parse(a.lastTs)) a.lastTs = r.ts;
    }
    return [...by.values()].sort((x, y) => x.sessionKey.localeCompare(y.sessionKey) || x.identity.localeCompare(y.identity));
  }

  async usageByIdentity(since: Date, until?: Date): Promise<IdentityUsageRow[]> {
    const from = since.getTime();
    const to = until?.getTime() ?? Infinity;
    const by = new Map<string, IdentityUsageRow>();
    for (const r of this.usage) {
      const t = Date.parse(r.ts);
      if (t < from || t >= to) continue;
      const key = `${r.provider}\u0000${r.identity}\u0000${r.app}`;
      let a = by.get(key);
      if (!a) {
        a = { provider: r.provider, identity: r.identity, app: r.app, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estCostUsd: 0, unpricedRequests: 0, requests: 0 };
        by.set(key, a);
      }
      a.inputTokens += r.inputTokens;
      a.outputTokens += r.outputTokens;
      a.cacheReadTokens += r.cacheReadTokens;
      a.cacheWriteTokens += r.cacheWriteTokens;
      a.requests += 1;
      if (r.estCostUsd !== undefined) a.estCostUsd += r.estCostUsd;
      else {
        // Stored without a cost: price from tokens and model now (the ledger is not rewritten).
        const priced = priceNullCostGroup({ provider: r.provider, identity: r.identity, app: r.app, model: r.model ?? null, inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadTokens: r.cacheReadTokens, cacheWriteTokens: r.cacheWriteTokens, requests: 1 });
        a.estCostUsd += priced.cost;
        a.unpricedRequests += priced.unpriced;
      }
    }
    return [...by.values()];
  }

  async usageByModel(since: Date, until?: Date): Promise<ModelUsageRow[]> {
    const from = since.getTime();
    const to = until?.getTime() ?? Infinity;
    const by = new Map<string, ModelUsageRow>();
    for (const r of this.usage) {
      const t = Date.parse(r.ts);
      if (t < from || t >= to) continue;
      const model = r.model ?? null;
      const key = `${r.provider}\u0000${r.identity}\u0000${r.app}\u0000${model ?? ""}`;
      let a = by.get(key);
      if (!a) {
        a = { provider: r.provider, identity: r.identity, app: r.app, model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estCostUsd: 0, unpricedRequests: 0, requests: 0, firstTs: r.ts, lastTs: r.ts };
        by.set(key, a);
      }
      a.inputTokens += r.inputTokens;
      a.outputTokens += r.outputTokens;
      a.cacheReadTokens += r.cacheReadTokens;
      a.cacheWriteTokens += r.cacheWriteTokens;
      a.requests += 1;
      if (r.estCostUsd !== undefined) a.estCostUsd += r.estCostUsd;
      else {
        // Stored without a cost: price from tokens and model now (the ledger is not rewritten).
        const priced = priceNullCostGroup({ provider: r.provider, identity: r.identity, app: r.app, model, inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadTokens: r.cacheReadTokens, cacheWriteTokens: r.cacheWriteTokens, requests: 1 });
        a.estCostUsd += priced.cost;
        a.unpricedRequests += priced.unpriced;
      }
      if (t < Date.parse(a.firstTs!)) a.firstTs = r.ts;
      if (t > Date.parse(a.lastTs!)) a.lastTs = r.ts;
    }
    return [...by.values()];
  }

  async usageByModelDaily(since: Date, until: Date | undefined, tz: string): Promise<ModelDailyUsageRow[]> {
    const from = since.getTime();
    const to = until?.getTime() ?? Infinity;
    const dayOf = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    const by = new Map<string, ModelDailyUsageRow>();
    for (const r of this.usage) {
      const t = Date.parse(r.ts);
      if (t < from || t >= to) continue;
      const model = r.model ?? null;
      const day = dayOf.format(new Date(t));
      const key = `${day}\u0000${r.provider}\u0000${r.identity}\u0000${model ?? ""}`;
      let a = by.get(key);
      if (!a) {
        a = { day, provider: r.provider, identity: r.identity, model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estCostUsd: 0, unpricedRequests: 0, requests: 0 };
        by.set(key, a);
      }
      a.inputTokens += r.inputTokens;
      a.outputTokens += r.outputTokens;
      a.cacheReadTokens += r.cacheReadTokens;
      a.cacheWriteTokens += r.cacheWriteTokens;
      a.requests += 1;
      if (r.estCostUsd !== undefined) a.estCostUsd += r.estCostUsd;
      else {
        const priced = priceNullCostGroup({ provider: r.provider, identity: r.identity, app: r.app, model, inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadTokens: r.cacheReadTokens, cacheWriteTokens: r.cacheWriteTokens, requests: 1 });
        a.estCostUsd += priced.cost;
        a.unpricedRequests += priced.unpriced;
      }
    }
    return [...by.values()].sort((x, y) => x.day.localeCompare(y.day) || x.provider.localeCompare(y.provider) || x.identity.localeCompare(y.identity) || (x.model === null ? 1 : 0) - (y.model === null ? 1 : 0) || (x.model ?? "").localeCompare(y.model ?? ""));
  }

  private history = new Map<string, UsageHistoryStored>();

  async upsertUsageHistory(rows: UsageHistoryRow[]): Promise<void> {
    const at = new Date().toISOString();
    for (const r of rows) {
      const generation = new Date(r.generation).toISOString();
      const key = [r.source, generation, r.provider, r.identity, r.day ?? "", r.model ?? ""].join("\u0000");
      this.history.set(key, { ...r, generation, importedAt: at });
    }
  }

  async usageHistory(filter: UsageHistoryFilter = {}): Promise<UsageHistoryStored[]> {
    const latest = new Map<string, string>();
    for (const r of this.history.values()) if ((latest.get(r.source) ?? "") < r.generation) latest.set(r.source, r.generation);
    const generation = filter.generation === undefined || filter.generation === "latest" ? undefined : new Date(filter.generation).toISOString();
    return [...this.history.values()]
      .filter((r) => (generation === undefined ? r.generation === latest.get(r.source) : r.generation === generation))
      .filter((r) => (filter.source === undefined || r.source === filter.source) && (filter.provider === undefined || r.provider === filter.provider) && (filter.identity === undefined || r.identity === filter.identity))
      .map((r) => ({ ...r }))
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.identity.localeCompare(b.identity) || (a.day ?? "").localeCompare(b.day ?? "") || (a.model ?? "").localeCompare(b.model ?? "") || a.source.localeCompare(b.source));
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

  async touchBrowserBinding(name: string, at: string): Promise<void> {
    const b = this.bindings.get(name);
    if (b) b.lastSeenAt = at;
  }

  async revokeBrowserBinding(name: string): Promise<void> {
    const b = this.bindings.get(name);
    if (b) b.state = "revoked";
  }

  async addBrowserToken(binding: string, prefix: string, hash: string): Promise<void> {
    this.browserTokens.push({ app: binding, prefix, hash, createdAt: new Date().toISOString() });
  }

  async deleteBrowserTokens(binding: string): Promise<void> {
    this.browserTokens = this.browserTokens.filter((x) => x.app !== binding);
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

  async deleteExpiredPairings(now: Date): Promise<void> {
    for (const [code, p] of this.pairings) if (Date.parse(p.expiresAt) <= now.getTime()) this.pairings.delete(code);
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
