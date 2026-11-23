// Starred models: the service between the store, the panels and the host daemons.
import type { ChatToExt, FavChange, FavRefusal } from "../../browser/chat-protocol.ts";
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
}

export class FavouritesService {
  private unsubscribe: (() => Promise<void>) | undefined;
  private readonly waiters = new Set<() => void>();
  /** Long polls that are held now. */
  private held = 0;
  /** The newest list version that went out to the panels of this replica. */
  private pushedSeq = -1;
  private pushing: Promise<void> | undefined;
  private again = false;

  constructor(private readonly d: FavouritesDeps) {}

  private count(event: string, reason?: string): void {
    this.d.metrics?.favourite?.(event, reason);
  }

  async start(): Promise<void> {
    if (this.unsubscribe) return;
    this.unsubscribe = await this.d.bus.subscribe((m) => {
      if (m.t === "favs") this.onNotice();
    });
    // A LISTEN that came back may have missed notices: read again.
    this.d.bus.onReconnect?.(() => this.onNotice());
  }

  async stop(): Promise<void> {
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
  async apply(changes: FavChange[], origin: string): Promise<FavouriteList & { refused: FavRefusal[] }> {
    const r = await this.d.store.apply(changes, origin, (this.d.now ?? Date.now)());
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
