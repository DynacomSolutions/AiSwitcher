// Starred models: the service between the store, the panels and the host daemons.
import { POOL_IDENTITY, type ChatProvider, type ChatToExt, type FavChange, type FavRefusal } from "../../browser/chat-protocol.ts";
import type { BrowserHub } from "../browser/hub.ts";
import type { GatewayMetrics } from "../metrics.ts";
import type { ChatBus } from "./bus.ts";
import type { FavouriteList, FavouriteStore } from "./favourites-store.ts";

/** A waiting HTTP call looks at the store at least this often, so a lost bus notice delays an update by this much at most. */
const FALLBACK_POLL_MS = 4_000;

/** Long polls one gateway holds at the same time, by default. Each holds a timer and a request, so the number is bounded. */
export const MAX_FAVOURITE_WAITERS = 32;

/** The gateway holds as many long polls as it may. The caller should wait and ask again. */
export class FavouritesBusyError extends Error {
  constructor() {
    super("too many waiting favourites requests");
  }
}

export interface FavouritesDeps {
  store: FavouriteStore;
  bus: ChatBus;
  hub: Pick<BrowserHub, "sendTo" | "connected">;
  metrics?: Pick<GatewayMetrics, "favourite">;
  now?: () => number;
  /** Tests shorten it. */
  fallbackPollMs?: number;
  /** Most long polls held at once. Default 32. A call that needs no wait is never counted. */
  maxWaiters?: number;
  /** The real names of the pools. A star kept under a pool's name is the old form of the pool key (POOL_IDENTITY): the gateway moves it. Throws when the names are not known yet. */
  pools?: () => Promise<Array<{ provider: ChatProvider; name: string }>>;
  /** Wait before the pool migration runs again after a failure. Default 60 s. */
  migrateRetryMs?: number;
}

/** The origin the gateway writes with when it moves a star to the pool key. */
export const POOL_MIGRATION_ORIGIN = "gateway:pool-key";

export class FavouritesService {
  private unsubscribe: (() => Promise<void>) | undefined;
  private readonly waiters = new Set<() => void>();
  /** Long polls that are held now. */
  private held = 0;
  /** The newest list version that went out to the panels of this replica. */
  private pushedSeq = -1;
  private pushing: Promise<void> | undefined;
  private again = false;
  private migrateTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(private readonly d: FavouritesDeps) {}

  private count(event: string, reason?: string): void {
    this.d.metrics?.favourite?.(event, reason);
  }

  async start(): Promise<void> {
    if (this.unsubscribe) return;
    this.stopped = false;
    this.unsubscribe = await this.d.bus.subscribe((m) => {
      if (m.t === "favs") this.onNotice();
    });
    // A LISTEN that came back may have missed notices: read again.
    this.d.bus.onReconnect?.(() => this.onNotice());
    void this.migratePools();
  }

  /**
   * Moves the stars that are kept under a pool's real name to the pool key (POOL_IDENTITY), in one store call per round: the new key is added with the
   * time of the old star and the old key is removed, so no star is lost and the list version moves once. It runs again after a failure (the pool names
   * are not known yet) until it works. A second replica that runs it too changes nothing.
   */
  async migratePools(): Promise<void> {
    if (!this.d.pools || this.stopped) return;
    try {
      const pools = await this.d.pools();
      const now = (this.d.now ?? Date.now)();
      const changes: FavChange[] = [];
      for (const i of (await this.d.store.list()).items) {
        if (!pools.some((p) => p.provider === i.provider && p.name === i.identity)) continue;
        changes.push({ provider: i.provider, identity: POOL_IDENTITY, model: i.model, op: "add", at: i.at }, { provider: i.provider, identity: i.identity, model: i.model, op: "remove", at: Math.max(now, i.at) });
      }
      if (changes.length > 0) await this.apply(changes, POOL_MIGRATION_ORIGIN, false);
      this.count("pool_migrated");
    } catch {
      this.count("error");
      if (this.stopped) return;
      this.migrateTimer = setTimeout(() => void this.migratePools(), this.d.migrateRetryMs ?? 60_000);
      this.migrateTimer.unref?.();
    }
  }

  /** A change under a pool's real name (an older host or panel) is made under the pool key. The names come from the catalogue: when they are not known the change goes through as it is, and the migration moves it later. */
  private async normalise(changes: FavChange[]): Promise<FavChange[]> {
    if (!this.d.pools) return changes;
    let pools: Awaited<ReturnType<NonNullable<FavouritesDeps["pools"]>>>;
    try {
      pools = await this.d.pools();
    } catch {
      return changes;
    }
    return changes.map((c) => (pools.some((p) => p.provider === c.provider && p.name === c.identity) ? { ...c, identity: POOL_IDENTITY } : c));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.migrateTimer) clearTimeout(this.migrateTimer);
    this.migrateTimer = undefined;
    await this.unsubscribe?.().catch(() => undefined);
    this.unsubscribe = undefined;
    this.onNotice();
  }

  list(): Promise<FavouriteList> {
    return this.d.store.list();
  }

  /** The frame a panel gets. The time of each star stays inside the gateway. */
  frame(l: FavouriteList, refused: FavRefusal[] = []): Extract<ChatToExt, { t: "chat.fav.list" }> {
    return {
      t: "chat.fav.list", seq: l.seq, ...(l.epoch ? { epoch: l.epoch } : {}), items: l.items.map(({ provider, identity, model }) => ({ provider, identity, model })),
      ...(refused.length > 0 ? { refused: refused.map(({ provider, identity, model, reason }) => ({ provider, identity, model, reason })) } : {}),
    };
  }

  /** Applies changes and tells every replica. Returns the list after the call and the changes the store refused, each with its reason. */
  async apply(changes: FavChange[], origin: string, normalise = true): Promise<FavouriteList & { refused: FavRefusal[] }> {
    const r = await this.d.store.apply(normalise ? await this.normalise(changes) : changes, origin, (this.d.now ?? Date.now)());
    if (r.changed) {
      this.count("change");
      // The bus delivers to this replica too. When the bus fails the local panels and waiters still hear of it.
      await this.d.bus.publish({ t: "favs", seq: r.seq }).catch(() => this.onNotice());
    }
    for (const x of r.refused) this.count("refused", x.reason);
    return { ...(await this.d.store.list()), refused: r.refused };
  }

  /** A panel attached: it gets the list at once. */
  async sendTo(binding: string): Promise<void> {
    const l = await this.d.store.list();
    this.d.hub.sendTo(binding, this.frame(l));
  }

  /**
   * Long poll. Answers at once when the list version differs from `since`, else when it changes or after `ms`.
   * It throws `FavouritesBusyError` when it would have to be held and the gateway already holds `maxWaiters` of them.
   */
  async wait(since: number | undefined, ms: number, signal?: AbortSignal): Promise<FavouriteList & { changed: boolean }> {
    let admitted = false;
    try {
      return await this.waitInner(since, ms, signal, () => {
        if (admitted) return;
        if (this.held >= (this.d.maxWaiters ?? MAX_FAVOURITE_WAITERS)) {
          this.count("rate_limited");
          throw new FavouritesBusyError();
        }
        this.held += 1;
        admitted = true;
      });
    } finally {
      if (admitted) this.held -= 1;
    }
  }

  private async waitInner(since: number | undefined, ms: number, signal: AbortSignal | undefined, admit: () => void): Promise<FavouriteList & { changed: boolean }> {
    const now = this.d.now ?? Date.now;
    const deadline = now() + ms;
    const poll = this.d.fallbackPollMs ?? FALLBACK_POLL_MS;
    for (;;) {
      const l = await this.d.store.list();
      if (since === undefined) return { ...l, changed: true };
      if (l.seq !== since) return { ...l, changed: true };
      const left = deadline - now();
      if (left <= 0 || signal?.aborted) return { ...l, changed: false };
      admit();
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          this.waiters.delete(done);
          signal?.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, Math.min(poll, left));
        this.waiters.add(done);
        signal?.addEventListener("abort", done, { once: true });
      });
    }
  }

  /** The list changed somewhere. Wake the waiters and send the new list to the panels of this replica. */
  private onNotice(): void {
    for (const w of [...this.waiters]) w();
    this.again = true;
    if (this.pushing) return;
    this.pushing = (async () => {
      try {
        while (this.again) {
          this.again = false;
          const l = await this.d.store.list();
          if (l.seq === this.pushedSeq) continue;
          this.pushedSeq = l.seq;
          const f = this.frame(l);
          for (const b of this.d.hub.connected()) {
            if (this.d.hub.sendTo(b.name, f)) this.count("push");
          }
        }
      } catch {
        this.count("error");
      } finally {
        this.pushing = undefined;
      }
    })();
  }
}
