// Starred models: the service between the store, the panels and the host daemons.
import type { ChatToExt, FavChange } from "../../browser/chat-protocol.ts";
import type { BrowserHub } from "../browser/hub.ts";
import type { GatewayMetrics } from "../metrics.ts";
import type { ChatBus } from "./bus.ts";
import type { FavouriteList, FavouriteStore } from "./favourites-store.ts";

/** A waiting HTTP call looks at the store at least this often, so a lost bus notice delays an update by this much at most. */
const FALLBACK_POLL_MS = 4_000;

export interface FavouritesDeps {
  store: FavouriteStore;
  bus: ChatBus;
  hub: Pick<BrowserHub, "sendTo" | "connected">;
  metrics?: Pick<GatewayMetrics, "favourite">;
  now?: () => number;
  /** Tests shorten it. */
  fallbackPollMs?: number;
}

export class FavouritesService {
  private unsubscribe: (() => Promise<void>) | undefined;
  private readonly waiters = new Set<() => void>();
  /** The newest list version that went out to the panels of this replica. */
  private pushedSeq = -1;
  private pushing: Promise<void> | undefined;
  private again = false;

  constructor(private readonly d: FavouritesDeps) {}

  private count(event: string): void {
    this.d.metrics?.favourite?.(event);
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
  frame(l: FavouriteList): Extract<ChatToExt, { t: "chat.fav.list" }> {
    return { t: "chat.fav.list", seq: l.seq, ...(l.epoch ? { epoch: l.epoch } : {}), items: l.items.map(({ provider, identity, model }) => ({ provider, identity, model })) };
  }

  /** Applies changes and tells every replica. Returns the list after the call. */
  async apply(changes: FavChange[], origin: string): Promise<FavouriteList> {
    const r = await this.d.store.apply(changes, origin, (this.d.now ?? Date.now)());
    if (r.changed) {
      this.count("change");
      // The bus delivers to this replica too. When the bus fails the local panels and waiters still hear of it.
      await this.d.bus.publish({ t: "favs", seq: r.seq }).catch(() => this.onNotice());
    }
    return this.d.store.list();
  }

  /** A panel attached: it gets the list at once. */
  async sendTo(binding: string): Promise<void> {
    const l = await this.d.store.list();
    this.d.hub.sendTo(binding, this.frame(l));
  }

  /** Long poll. Answers at once when the list version differs from `since`, else when it changes or after `ms`. */
  async wait(since: number | undefined, ms: number, signal?: AbortSignal): Promise<FavouriteList & { changed: boolean }> {
    const now = this.d.now ?? Date.now;
    const deadline = now() + ms;
    const poll = this.d.fallbackPollMs ?? FALLBACK_POLL_MS;
    for (;;) {
      const l = await this.d.store.list();
      if (since === undefined) return { ...l, changed: true };
      if (l.seq !== since) return { ...l, changed: true };
      const left = deadline - now();
      if (left <= 0 || signal?.aborted) return { ...l, changed: false };
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
